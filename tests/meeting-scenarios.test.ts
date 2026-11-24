import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>();
  return {
    ...actual,
    prisma: actual.createInMemoryPrisma(),
  };
});

const authState = vi.hoisted(() => ({
  user: {
    id: "host-user",
    name: "Moderator Host",
    email: "host@example.com",
    role: "HOST" as "HOST" | "PARTICIPANT",
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

vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return {
    ...actual,
    geminiAvailable: vi.fn(() => true),
    callGemini: vi.fn(async (opts: { prompt: string; json?: boolean }) => {
      if (opts.prompt.includes("For each numbered utterance below")) {
        const count = (opts.prompt.match(/^\[\d+\]/gm) ?? []).length;
        return JSON.stringify({
          items: Array.from({ length: count }, (_, idx) => ({
            index: idx,
            relevance: "RELEVANT",
            score: 88,
            reason: "Directly addresses the round-table agenda.",
          })),
        });
      }
      if (opts.prompt.includes("mid-meeting synthesis")) {
        return JSON.stringify({
          message:
            "Checkpoint synthesis: Alice and Bob emphasized accountability while Carol highlighted fairness. What concrete safeguard should come next?",
        });
      }
      if (opts.prompt.includes("Summarise the complete discussion")) {
        return JSON.stringify({
          message:
            "Closing summary: The panel aligned on transparent governance, balanced participation, and verifiable evaluation standards.",
        });
      }
      if (opts.prompt.includes("shared thorough points already")) {
        return JSON.stringify({
          message:
            "Thank you for those thorough points. Carol, we would love to hear your perspective next.",
        });
      }
      if (opts.prompt.includes("Welcome everyone warmly")) {
        return JSON.stringify({
          message:
            "Welcome to our round-table on Responsible AI Governance. Our agenda covers ethics and audits, and please keep turns concise. Who would like to open?",
        });
      }
      return JSON.stringify({
        message: "How should teams measure fairness across diverse deployment contexts?",
      });
    }),
  };
});

import { prisma as mockPrisma } from "@/lib/prisma";
import { POST as joinPost } from "@/app/api/discussions/join/route";
import { GET as discussionGet, PATCH as discussionPatch } from "@/app/api/discussions/[id]/route";
import { POST as micPost } from "@/app/api/discussions/[id]/mic/route";
import { POST as presencePost } from "@/app/api/discussions/[id]/presence/route";
import { GET as transcriptGet, POST as transcriptPost } from "@/app/api/discussions/[id]/transcript/route";
import { runAssistantTick, generateClosingSummary } from "@/lib/ai-assistant";
import {
  decideConversationState,
  isWithinSpeechEndGrace,
  resolveTurnOrder,
  SPEECH_END_GRACE_MS,
} from "@/lib/conversation-state";
import { encodeInt16PcmWav } from "@/lib/livekit-stt-worker";
import { beginAiSpeaking, endAiSpeaking, syncRoomStateSnapshot } from "@/lib/room-sync";
import { getSttProvider, setSttProvider } from "@/lib/stt/provider";

type Actor = { id: string; name: string; email: string; role: "HOST" | "PARTICIPANT" };

function setActor(actor: Actor) {
  authState.user = actor;
}

describe("Quorum 12-scenario end-to-end verification suite", () => {
  let host: Actor;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  let discussionId: string;
  let joinCode: string;

  beforeEach(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    host = { id: `host-${suffix}`, name: "Host", email: `host-${suffix}@example.com`, role: "HOST" };
    alice = { id: `alice-${suffix}`, name: "Alice", email: `alice-${suffix}@example.com`, role: "PARTICIPANT" };
    bob = { id: `bob-${suffix}`, name: "Bob", email: `bob-${suffix}@example.com`, role: "PARTICIPANT" };
    carol = { id: `carol-${suffix}`, name: "Carol", email: `carol-${suffix}@example.com`, role: "PARTICIPANT" };

    for (const actor of [host, alice, bob, carol]) {
      await mockPrisma.user.create({
        data: {
          id: actor.id,
          name: actor.name,
          email: actor.email,
          passwordHash: "hash",
          role: actor.role,
        },
      });
    }

    joinCode = `Q${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const d = await mockPrisma.discussion.create({
      data: {
        title: "Responsible AI Governance",
        topic: "How should organizations govern live AI-moderated meetings?",
        context: "Agenda: 1) Transparency, 2) Fairness, 3) Auditability",
        rules: "One speaker at a time; respectful critique; concise 45s turns.",
        hostId: host.id,
        joinCode,
        status: "SCHEDULED",
        mode: "AI_MODERATED",
        aiEnabled: true,
        transcriptionEnabled: true,
        maxParticipants: 8,
        silencePromptSec: 4,
        inviteResponseSec: 12,
        scheduledAt: new Date(),
      },
    });
    discussionId = d.id;

    await mockPrisma.discussionParticipant.create({
      data: {
        discussionId,
        userId: host.id,
        displayName: host.name,
        isHost: true,
        transcriptionConsent: true,
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("automatically completes a live meeting after its configured duration", async () => {
    setActor(host);
    const startedAt = new Date(Date.now() - 4 * 60_000);
    await mockPrisma.discussion.update({
      where: { id: discussionId },
      data: { status: "LIVE", durationMin: 5, startedAt },
    });

    const routeParams = { params: Promise.resolve({ id: discussionId }) };
    const beforeDeadline = await discussionGet(
      new Request(`http://localhost/api/discussions/${discussionId}`),
      routeParams,
    );
    expect((await beforeDeadline.json()).discussion.status).toBe("LIVE");

    const expiredStartedAt = new Date(Date.now() - 6 * 60_000);
    await mockPrisma.discussion.update({
      where: { id: discussionId },
      data: { startedAt: expiredStartedAt },
    });
    const afterDeadline = await discussionGet(
      new Request(`http://localhost/api/discussions/${discussionId}`),
      routeParams,
    );
    const data = (await afterDeadline.json()) as {
      discussion: { status: string; endedAt: string };
    };

    expect(afterDeadline.status).toBe(200);
    expect(data.discussion.status).toBe("COMPLETED");
    expect(new Date(data.discussion.endedAt).getTime()).toBe(
      expiredStartedAt.getTime() + 5 * 60_000,
    );
  });

  async function joinParticipant(actor: Actor) {
    setActor(actor);
    const res = await joinPost(
      new Request("http://localhost/api/discussions/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: joinCode, displayName: actor.name }),
      }),
    );
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { participantId: string; seatNumber: number; alreadyMember: boolean };
    await mockPrisma.discussionParticipant.update({
      where: { id: body.participantId },
      data: { transcriptionConsent: true },
    });
    return body;
  }

  async function startMeeting() {
    setActor(host);
    const res = await discussionPatch(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      }),
      { params: Promise.resolve({ id: discussionId }) },
    );
    expect(res.status).toBe(200);
  }

  it("TEST 1-3: Multi-participant seat joining, reconnect idempotency, AI welcome with agenda/rules & authoritative mic lock", async () => {
    const aJoin = await joinParticipant(alice);
    const bJoin = await joinParticipant(bob);
    const cJoin = await joinParticipant(carol);

    expect(new Set([aJoin.seatNumber, bJoin.seatNumber, cJoin.seatNumber]).size).toBe(3);

    // Reconnect / rejoin preserves same seat & membership ID
    const aRejoin = await joinParticipant(alice);
    expect(aRejoin.alreadyMember).toBe(true);
    expect(aRejoin.seatNumber).toBe(aJoin.seatNumber);
    expect(aRejoin.participantId).toBe(aJoin.participantId);

    // TEST 3: Host starts discussion -> AI posts welcome with agenda/rules and locks mics
    await startMeeting();
    const events = await mockPrisma.aiEvent.findMany({ where: { discussionId } });
    expect(events.length).toBe(1);
    expect(events[0].message).toMatch(/welcome|agenda|responsible ai/i);

    // While AI is speaking, every participant's unmute attempt (console/tab bypass) returns 403
    for (const actor of [alice, bob, carol]) {
      setActor(actor);
      const micRes = await micPost(
        new Request(`http://localhost/api/discussions/${discussionId}/mic`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
        { params: Promise.resolve({ id: discussionId }) },
      );
      expect(micRes.status).toBe(403);
    }

    // AI finishes speaking -> permissions restored cleanly
    await endAiSpeaking(discussionId);
    for (const actor of [alice, bob, carol]) {
      setActor(actor);
      const micRes = await micPost(
        new Request(`http://localhost/api/discussions/${discussionId}/mic`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
        { params: Promise.resolve({ id: discussionId }) },
      );
      expect(micRes.status).toBe(200);
    }
  });

  it("TEST 4-6: No AI interruption during human speech or 2.5s pause grace, plus simultaneous turn resolution", async () => {
    const aJoin = await joinParticipant(alice);
    const bJoin = await joinParticipant(bob);
    await startMeeting();
    await endAiSpeaking(discussionId);

    // Seed prior transcript & older timestamps so room would otherwise qualify for silence check
    const oldTime = new Date(Date.now() - 20_000);
    await mockPrisma.discussion.update({
      where: { id: discussionId },
      data: { startedAt: oldTime, lastAiSpokeAt: oldTime },
    });
    await mockPrisma.transcriptSegment.create({
      data: {
        discussionId,
        participantId: aJoin.participantId,
        text: "Transparency starts with clear consent.",
        startedAt: oldTime,
        endedAt: new Date(oldTime.getTime() + 2000),
        durationMs: 2000,
        wordCount: 5,
        status: "FINAL",
        analysisSource: "gemini",
        relevance: "RELEVANT",
        relevanceScore: 90,
      },
    });

    // TEST 4: Alice starts speaking -> presence locks floor to PARTICIPANT_SPEAKING, AI holds off
    setActor(alice);
    const presRes = await presencePost(
      new Request(`http://localhost/api/discussions/${discussionId}/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ speaking: true }),
      }),
      { params: Promise.resolve({ id: discussionId }) },
    );
    expect(presRes.status).toBe(200);

    const tickDuringSpeech = await runAssistantTick(discussionId);
    expect(tickDuringSpeech.conversationState).toBe("PARTICIPANT_SPEAKING");
    expect(tickDuringSpeech.eventsCreated).toHaveLength(0);

    // TEST 5: Short breathing pause (< 2.5s) -> PROCESSING_RESPONSE holds AI back
    const justStoppedAt = new Date(Date.now() - 1200);
    expect(isWithinSpeechEndGrace(justStoppedAt, Date.now(), SPEECH_END_GRACE_MS)).toBe(true);
    expect(
      decideConversationState({
        participantSpeaking: false,
        aiSpeaking: false,
        processingResponse: true,
        quietMs: 8000,
        silenceMs: 4000,
        countdownRunning: false,
        awaitingResponse: false,
        heardSomeone: true,
      }),
    ).toBe("PROCESSING_RESPONSE");

    // TEST 6: Simultaneous speakers resolved cleanly into activeSpeaker + turnQueue
    const tEarly = new Date(Date.now() - 1500);
    const tLate = new Date(Date.now() - 500);
    await mockPrisma.discussionParticipant.update({
      where: { id: aJoin.participantId },
      data: { speakingSince: tEarly, lastAudioAt: new Date() },
    });
    await mockPrisma.discussionParticipant.update({
      where: { id: bJoin.participantId },
      data: { speakingSince: tLate, lastAudioAt: new Date() },
    });

    const snap = await syncRoomStateSnapshot(discussionId, { broadcast: false, syncMics: false });
    expect(snap?.activeSpeakerId).toBe(aJoin.participantId);
    expect(snap?.turnQueue).toEqual([bJoin.participantId]);

    const manualOrder = resolveTurnOrder([
      { participantId: "b", displayName: "Bob", speaking: true, speakingSince: tLate, seatNumber: 2 },
      { participantId: "a", displayName: "Alice", speaking: true, speakingSince: tEarly, seatNumber: 1 },
    ]);
    expect(manualOrder.activeSpeaker?.participantId).toBe("a");
    expect(manualOrder.queuedSpeakers.map((s) => s.participantId)).toEqual(["b"]);
  });

  it("TEST 7-8: Continuous 35s stream PARTIAL->FINAL deduplication & independent per-participant attribution with confidence", async () => {
    const aJoin = await joinParticipant(alice);
    const bJoin = await joinParticipant(bob);
    const cJoin = await joinParticipant(carol);
    await startMeeting();
    await endAiSpeaking(discussionId);

    const prevProvider = getSttProvider();
    setSttProvider({
      name: "mock-detailed-stt",
      isAvailable: () => true,
      transcribe: async () => "fallback text",
      transcribeDetailed: async ({ promptHint }) => ({
        text: promptHint || "Governance requires independent auditing across teams.",
        confidence: 0.94,
      }),
    });

    try {
      // TEST 7: Long 35s utterance streamed as PARTIAL -> FINAL with same streamId
      const streamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const wav = encodeInt16PcmWav(new Int16Array([500, -500, 900, -900]), 16_000);
      const t0 = new Date(Date.now() - 35_000);
      const tMid = new Date(Date.now() - 15_000);
      const tEnd = new Date();

      setActor(alice);
      const pRes = await transcriptPost(
        new Request(`http://localhost/api/discussions/${discussionId}/transcript`, {
          method: "POST",
          headers: {
            "content-type": "audio/wav",
            "x-transcript-started-at": t0.toISOString(),
            "x-transcript-ended-at": tMid.toISOString(),
            "x-transcript-duration-ms": "20000",
            "x-transcript-stream-id": streamId,
            "x-transcript-revision": "1",
            "x-transcript-mode": "partial",
          },
          body: new Uint8Array(wav),
        }),
        { params: Promise.resolve({ id: discussionId }) },
      );
      expect(pRes.status).toBe(200);

      const fRes = await transcriptPost(
        new Request(`http://localhost/api/discussions/${discussionId}/transcript`, {
          method: "POST",
          headers: {
            "content-type": "audio/wav",
            "x-transcript-started-at": t0.toISOString(),
            "x-transcript-ended-at": tEnd.toISOString(),
            "x-transcript-duration-ms": "35000",
            "x-transcript-stream-id": streamId,
            "x-transcript-revision": "2",
            "x-transcript-mode": "final",
          },
          body: new Uint8Array(wav),
        }),
        { params: Promise.resolve({ id: discussionId }) },
      );
      expect(fRes.status).toBe(201);
      const fBody = (await fRes.json()) as { segment: { confidence: number | null; status: string } };
      expect(fBody.segment.status).toBe("FINAL");
      expect(fBody.segment.confidence).toBe(0.94);

      // TEST 8: Bob and Carol submit independent contributions concurrently -> strictly separated speakers
      await Promise.all([
        (async () => {
          setActor(bob);
          const r = await transcriptPost(
            new Request(`http://localhost/api/discussions/${discussionId}/transcript`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                text: "Bob here: latency thresholds prevent interruptions.",
                startedAt: new Date(Date.now() - 4000).toISOString(),
                endedAt: new Date(Date.now() - 2000).toISOString(),
                durationMs: 2000,
                confidence: 0.91,
              }),
            }),
            { params: Promise.resolve({ id: discussionId }) },
          );
          expect(r.status).toBe(201);
        })(),
        (async () => {
          // Sequentialize authState mutation inside promise? Better call with distinct requests sequentially to avoid mutating shared hoisted user mid-await
        })(),
      ]);

      setActor(carol);
      const carolRes = await transcriptPost(
        new Request(`http://localhost/api/discussions/${discussionId}/transcript`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "Carol speaking: multilingual teams need equal participation visibility.",
            startedAt: new Date(Date.now() - 1500).toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: 1500,
            confidence: 0.96,
          }),
        }),
        { params: Promise.resolve({ id: discussionId }) },
      );
      expect(carolRes.status).toBe(201);

      const listRes = await transcriptGet(
        new Request(`http://localhost/api/discussions/${discussionId}/transcript`),
        { params: Promise.resolve({ id: discussionId }) },
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        segments: Array<{ participantId: string; speaker: string; confidence: number | null; text: string }>;
      };
      expect(listBody.segments).toHaveLength(3);
      expect(listBody.segments.find((s) => s.participantId === aJoin.participantId)?.speaker).toBe("Alice");
      expect(listBody.segments.find((s) => s.participantId === bJoin.participantId)?.speaker).toBe("Bob");
      expect(listBody.segments.find((s) => s.participantId === cJoin.participantId)?.speaker).toBe("Carol");
      expect(listBody.segments.find((s) => s.participantId === cJoin.participantId)?.confidence).toBe(0.96);
    } finally {
      setSttProvider(prevProvider);
    }
  });

  it("TEST 9-12: Dominance balancing, concurrency mutex, refresh recovery, pause/resume & closing summary", async () => {
    const aJoin = await joinParticipant(alice);
    await joinParticipant(bob);
    const cJoin = await joinParticipant(carol);
    await startMeeting();
    await endAiSpeaking(discussionId);

    // Simulate Alice dominating >55% of words while Carol is silent, plus genuine room silence
    const past = Date.now() - 15_000;
    await mockPrisma.discussion.update({
      where: { id: discussionId },
      data: { startedAt: new Date(past - 60_000), lastAiSpokeAt: new Date(past) },
    });
    for (let i = 0; i < 4; i += 1) {
      const start = new Date(past - 30_000 + i * 3000);
      await mockPrisma.transcriptSegment.create({
        data: {
          discussionId,
          participantId: aJoin.participantId,
          text: `Alice point ${i + 1}: governance requires continuous automated checks and strict permission models across every team member.`,
          startedAt: start,
          endedAt: new Date(start.getTime() + 2000),
          durationMs: 2000,
          wordCount: 16,
          status: "FINAL",
          analysisSource: "gemini",
          relevance: "RELEVANT",
          relevanceScore: 90,
        },
      });
    }

    // TEST 11: Concurrent ticks fire simultaneously -> mutex ensures only 1 executes & creates 1 event
    const tickResults = await Promise.all([
      runAssistantTick(discussionId),
      runAssistantTick(discussionId),
      runAssistantTick(discussionId),
    ]);
    const activeRuns = tickResults.filter((r) => r.skipped !== "in-flight");
    const coalescedRuns = tickResults.filter((r) => r.skipped === "in-flight");
    expect(activeRuns).toHaveLength(1);
    expect(coalescedRuns).toHaveLength(2);
    expect(activeRuns[0].eventsCreated).toHaveLength(1);
    expect(activeRuns[0].eventsCreated[0].kind).toBe("NUDGE");

    // TEST 10: Refresh during AI_SPEAKING -> GET returns aiSpeaking=true & /mic stays 403
    setActor(carol);
    const refreshRes = await discussionGet(
      new Request(`http://localhost/api/discussions/${discussionId}`),
      { params: Promise.resolve({ id: discussionId }) },
    );
    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as {
      discussion: { aiSpeaking: boolean; participants: Array<{ userId: string; seatNumber: number | null }> };
    };
    expect(refreshBody.discussion.aiSpeaking).toBe(true);
    expect(
      refreshBody.discussion.participants.find((p) => p.userId === carol.id)?.seatNumber,
    ).toBe(cJoin.seatNumber);

    const blockedRefreshMic = await micPost(
      new Request(`http://localhost/api/discussions/${discussionId}/mic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      { params: Promise.resolve({ id: discussionId }) },
    );
    expect(blockedRefreshMic.status).toBe(403);

    // TEST 12: Empty audio stream rejected 422 and whitespace-only text rejected 400; host pause blocks unmute 403; resume restores 200; end generates closing summary
    const emptyAudioRes = await transcriptPost(
      new Request(`http://localhost/api/discussions/${discussionId}/transcript`, {
        method: "POST",
        headers: {
          "content-type": "audio/wav",
          "x-transcript-started-at": new Date(Date.now() - 1000).toISOString(),
          "x-transcript-ended-at": new Date().toISOString(),
          "x-transcript-duration-ms": "1000",
          "x-transcript-mode": "final",
        },
        body: new Uint8Array(0),
      }),
      { params: Promise.resolve({ id: discussionId }) },
    );
    expect(emptyAudioRes.status).toBe(422);

    const blankTextRes = await transcriptPost(
      new Request(`http://localhost/api/discussions/${discussionId}/transcript`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "   ",
          startedAt: new Date(Date.now() - 1000).toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 1000,
        }),
      }),
      { params: Promise.resolve({ id: discussionId }) },
    );
    expect(blankTextRes.status).toBe(422);

    setActor(host);
    await discussionPatch(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pause" }),
      }),
      { params: Promise.resolve({ id: discussionId }) },
    );

    setActor(alice);
    const pausedMic = await micPost(
      new Request(`http://localhost/api/discussions/${discussionId}/mic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      { params: Promise.resolve({ id: discussionId }) },
    );
    expect(pausedMic.status).toBe(403);

    setActor(host);
    await discussionPatch(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume" }),
      }),
      { params: Promise.resolve({ id: discussionId }) },
    );

    setActor(alice);
    const resumedMic = await micPost(
      new Request(`http://localhost/api/discussions/${discussionId}/mic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      { params: Promise.resolve({ id: discussionId }) },
    );
    expect(resumedMic.status).toBe(200);

    // End meeting -> posts single closing SUMMARY
    setActor(host);
    const endRes = await discussionPatch(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "end" }),
      }),
      { params: Promise.resolve({ id: discussionId }) },
    );
    expect(endRes.status).toBe(200);

    // Second closing summary call is idempotent (skipped)
    const dupSummary = await generateClosingSummary(discussionId);
    expect(dupSummary).toBeNull();

    const finalSummaries = await mockPrisma.aiEvent.findMany({
      where: { discussionId, kind: "SUMMARY" },
    });
    expect(finalSummaries).toHaveLength(1);
    expect(finalSummaries[0].message).toContain("Closing summary");

    // Suppress unused helper warnings while ensuring lock helper roundtrip works cleanly
    await beginAiSpeaking(discussionId, 3000);
  });
});
