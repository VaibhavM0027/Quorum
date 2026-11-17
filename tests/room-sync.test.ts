import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>();
  return {
    ...actual,
    prisma: actual.createInMemoryPrisma(),
  };
});

const authState = vi.hoisted(() => ({
  user: {
    id: "user-p1",
    name: "Alice",
    email: "alice@example.com",
    role: "PARTICIPANT" as const,
  },
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireSession: vi.fn(async () => authState.user),
    getSession: vi.fn(async () => authState.user),
  };
});

import { prisma as mockPrisma } from "@/lib/prisma";
import { POST as micPost } from "@/app/api/discussions/[id]/mic/route";
import { POST as transcriptPost } from "@/app/api/discussions/[id]/transcript/route";
import { beginAiSpeaking, endAiSpeaking, syncRoomStateSnapshot } from "@/lib/room-sync";
import { getSttProvider, setSttProvider } from "@/lib/stt/provider";
import {
  computeInt16Rms,
  concatInt16Frames,
  encodeInt16PcmWav,
  isHumanIdentity,
} from "@/lib/livekit-stt-worker";

describe("room synchronization, authoritative mic gating & STT pipeline", () => {
  let discussionId: string;
  let discussionBId: string;

  beforeEach(async () => {
    authState.user = {
      id: "user-p1",
      name: "Alice",
      email: "alice@example.com",
      role: "PARTICIPANT",
    };

    const host = await mockPrisma.user.create({
      data: {
        name: "Moderator",
        email: `host-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: "hash",
        role: "HOST",
      },
    });
    const participantUser = await mockPrisma.user.create({
      data: {
        id: "user-p1",
        name: "Alice",
        email: `alice-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: "hash",
        role: "PARTICIPANT",
      },
    });

    const d = await mockPrisma.discussion.create({
      data: {
        title: "Room Sync Test",
        topic: "How should AI moderate round-table conversations?",
        joinCode: `RS-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        hostId: host.id,
        status: "LIVE",
        aiEnabled: true,
        transcriptionEnabled: true,
        conversationState: "WAITING_FOR_PARTICIPANT",
        scheduledAt: new Date(),
        startedAt: new Date(),
      },
    });
    discussionId = d.id;

    await mockPrisma.discussionParticipant.create({
      data: {
        discussionId: d.id,
        userId: host.id,
        displayName: "Moderator",
        isHost: true,
        joinedAt: new Date(),
        transcriptionConsent: true,
      },
    });
    await mockPrisma.discussionParticipant.create({
      data: {
        discussionId: d.id,
        userId: participantUser.id,
        displayName: "Alice",
        isHost: false,
        seatNumber: 1,
        joinedAt: new Date(),
        transcriptionConsent: true,
      },
    });

    const dB = await mockPrisma.discussion.create({
      data: {
        title: "Isolated Room B",
        topic: "Separate room should stay unlocked",
        joinCode: `RB-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        hostId: host.id,
        status: "LIVE",
        aiEnabled: true,
        transcriptionEnabled: true,
        conversationState: "WAITING_FOR_PARTICIPANT",
        scheduledAt: new Date(),
        startedAt: new Date(),
      },
    });
    discussionBId = dB.id;
    await mockPrisma.discussionParticipant.create({
      data: {
        discussionId: dB.id,
        userId: participantUser.id,
        displayName: "Alice",
        isHost: false,
        seatNumber: 1,
        joinedAt: new Date(),
        transcriptionConsent: true,
      },
    });
  });

  it("enforces authoritative mic lock during AI_SPEAKING, pause, and host lock, rejecting client unmute bypasses with 403", async () => {
    const req = (enabled: boolean) =>
      new Request(`http://localhost/api/discussions/${discussionId}/mic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });

    // Normal unmute allowed when AI is quiet.
    const openRes = await micPost(req(true), { params: Promise.resolve({ id: discussionId }) });
    expect(openRes.status).toBe(200);
    const openBody = (await openRes.json()) as { allowed?: boolean; canPublish?: boolean };
    expect(openBody.allowed).toBe(true);
    expect(openBody.canPublish).toBe(true);

    // Begin AI speaking -> must lock this room while leaving Room B untouched.
    const aiSnap = await beginAiSpeaking(discussionId, 10_000);
    expect(aiSnap?.conversationState).toBe("AI_SPEAKING");
    expect(aiSnap?.aiSpeaking).toBe(true);

    // Participant attempt to bypass via another tab/console -> rejected 403.
    const blockedAi = await micPost(req(true), { params: Promise.resolve({ id: discussionId }) });
    expect(blockedAi.status).toBe(403);
    const blockedJson = (await blockedAi.json()) as { error?: string };
    expect(blockedJson.error).toMatch(/AI moderator is speaking/i);

    // Verify multi-room isolation: Room B remains unmuted.
    const roomBRes = await micPost(
      new Request(`http://localhost/api/discussions/${discussionBId}/mic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      { params: Promise.resolve({ id: discussionBId }) },
    );
    expect(roomBRes.status).toBe(200);

    // AI finishes speaking -> microphone permission restored.
    const endSnap = await endAiSpeaking(discussionId);
    expect(endSnap?.aiSpeaking).toBe(false);
    expect(endSnap?.conversationState).toBe("WAITING_FOR_PARTICIPANT");

    const restoredRes = await micPost(req(true), { params: Promise.resolve({ id: discussionId }) });
    expect(restoredRes.status).toBe(200);

    // Meeting paused -> rejects unmute with 403.
    await mockPrisma.discussion.update({
      where: { id: discussionId },
      data: { pausedAt: new Date(), conversationState: "MEETING_PAUSED" },
    });
    const pausedRes = await micPost(req(true), { params: Promise.resolve({ id: discussionId }) });
    expect(pausedRes.status).toBe(403);

    // Resume, then apply host micLock -> still rejects unmute with 403.
    await mockPrisma.discussion.update({
      where: { id: discussionId },
      data: { pausedAt: null, conversationState: "WAITING_FOR_PARTICIPANT" },
    });
    await mockPrisma.discussionParticipant.update({
      where: { discussionId_userId: { discussionId, userId: "user-p1" } },
      data: { micLocked: true },
    });
    const hostLockedRes = await micPost(req(true), { params: Promise.resolve({ id: discussionId }) });
    expect(hostLockedRes.status).toBe(403);
  });

  it("supports pluggable SttProvider partial-to-final continuous stream transcription and skips audio captured while AI speaks", async () => {
    const previousProvider = getSttProvider();
    let callCount = 0;
    setSttProvider({
      name: "test-stt",
      isAvailable: () => true,
      transcribe: async () => {
        callCount += 1;
        return callCount === 1
          ? "I believe circular round-table seating helps"
          : "I believe circular round-table seating helps everyone contribute equally.";
      },
    });

    try {
      const streamId = "11111111-1111-4111-8111-111111111111";
      const wav = encodeInt16PcmWav(new Int16Array([400, -400, 800, -800]), 16_000);
      const t0 = new Date(Date.now() - 5000);
      const tMid = new Date(Date.now() - 2500);
      const tEnd = new Date();

      const partialRes = await transcriptPost(
        new Request(`http://localhost/api/discussions/${discussionId}/transcript`, {
          method: "POST",
          headers: {
            "content-type": "audio/wav",
            "x-transcript-started-at": t0.toISOString(),
            "x-transcript-ended-at": tMid.toISOString(),
            "x-transcript-duration-ms": "2500",
            "x-transcript-stream-id": streamId,
            "x-transcript-revision": "1",
            "x-transcript-mode": "partial",
          },
          body: new Uint8Array(wav),
        }),
        { params: Promise.resolve({ id: discussionId }) },
      );
      expect(partialRes.status).toBe(200);
      const partialBody = (await partialRes.json()) as { status?: string; text?: string };
      expect(partialBody.status).toBe("PARTIAL");
      expect(partialBody.text).toContain("circular round-table seating helps");

      const finalRes = await transcriptPost(
        new Request(`http://localhost/api/discussions/${discussionId}/transcript`, {
          method: "POST",
          headers: {
            "content-type": "audio/wav",
            "x-transcript-started-at": t0.toISOString(),
            "x-transcript-ended-at": tEnd.toISOString(),
            "x-transcript-duration-ms": "5000",
            "x-transcript-stream-id": streamId,
            "x-transcript-revision": "2",
            "x-transcript-mode": "final",
          },
          body: new Uint8Array(wav),
        }),
        { params: Promise.resolve({ id: discussionId }) },
      );
      expect(finalRes.status).toBe(201);
      const finalBody = (await finalRes.json()) as {
        segment?: { status?: string; text?: string };
      };
      expect(finalBody.segment?.status).toBe("FINAL");
      expect(finalBody.segment?.text).toContain("contribute equally.");

      // Verify audio sent while AI is speaking is discarded instead of attributed to a human.
      await beginAiSpeaking(discussionId, 10_000);
      const aiTimeStart = new Date();
      const aiTimeEnd = new Date(aiTimeStart.getTime() + 1000);
      const skippedRes = await transcriptPost(
        new Request(`http://localhost/api/discussions/${discussionId}/transcript`, {
          method: "POST",
          headers: {
            "content-type": "audio/wav",
            "x-transcript-started-at": aiTimeStart.toISOString(),
            "x-transcript-ended-at": aiTimeEnd.toISOString(),
            "x-transcript-duration-ms": "1000",
            "x-transcript-mode": "final",
          },
          body: new Uint8Array(wav),
        }),
        { params: Promise.resolve({ id: discussionId }) },
      );
      expect(skippedRes.status).toBe(200);
      const skippedBody = (await skippedRes.json()) as { skipped?: string };
      expect(skippedBody.skipped).toBe("ai-speaking");
    } finally {
      setSttProvider(previousProvider);
    }
  });

  it("synchronizes active speaker turn order and encodes valid 16kHz mono PCM WAV frames", async () => {
    const snap = await syncRoomStateSnapshot(discussionId, { broadcast: false, syncMics: false });
    expect(snap).not.toBeNull();
    expect(snap?.discussionId).toBe(discussionId);

    const f1 = new Int16Array([1000, -1000]);
    const f2 = new Int16Array([2000, -2000]);
    const combined = concatInt16Frames([f1, f2], 4);
    expect(Array.from(combined)).toEqual([1000, -1000, 2000, -2000]);
    expect(computeInt16Rms(combined)).toBeGreaterThan(0.04);

    const wav = encodeInt16PcmWav(combined, 16_000);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.byteLength).toBe(44 + combined.length * 2);

    expect(isHumanIdentity("__quorum_stt__0")).toBe(false);
    expect(isHumanIdentity("quorum-ai-moderator")).toBe(false);
    expect(isHumanIdentity("user-p1")).toBe(true);
  });
});
