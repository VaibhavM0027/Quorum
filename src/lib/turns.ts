import {
  AiSpeechReceiptStatus,
  Prisma,
  TurnRequestSource,
  TurnRequestStatus,
  TurnState,
} from "@prisma/client";
import { RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { env } from "@/lib/env";
import { livekitReady, livekitServerUrl, roomNameFor } from "@/lib/livekit";
import { prisma } from "@/lib/prisma";

const AI_SPEECH_FALLBACK_MIN_MS = 8_000;
const AI_SPEECH_FALLBACK_MAX_MS = 35_000;

export function canPublishDuringTurn(input: {
  state: TurnState;
  activeParticipantId: string | null;
  participantId: string;
  micLocked: boolean;
  removed: boolean;
  leftAt: Date | null;
}): boolean {
  return (
    input.state === TurnState.PARTICIPANT_SPEAKING &&
    input.activeParticipantId === input.participantId &&
    !input.micLocked &&
    !input.removed &&
    input.leftAt === null
  );
}

export function aiSpeechFallbackDeadline(message: string, now = Date.now()): Date {
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  const expectedMs = words * 450 + 5_000;
  const boundedMs = Math.max(
    AI_SPEECH_FALLBACK_MIN_MS,
    Math.min(AI_SPEECH_FALLBACK_MAX_MS, expectedMs),
  );
  return new Date(now + boundedMs);
}

type SpeechEventInput = {
  discussionId: string;
  participantId?: string | null;
  kind: "WELCOME" | "QUESTION" | "NUDGE" | "SILENCE" | "RELEVANCE";
  message: string;
  source: string;
  dueAt?: Date | null;
  now?: Date;
};

/** Creates the event and the playback barrier in the same transaction. */
export async function createAiSpeechEvent(
  tx: Prisma.TransactionClient,
  input: SpeechEventInput,
) {
  const now = input.now ?? new Date();
  const event = await tx.aiEvent.create({
    data: {
      discussionId: input.discussionId,
      participantId: input.participantId ?? null,
      kind: input.kind,
      message: input.message,
      source: input.source,
      dueAt: input.dueAt ?? null,
    },
  });
  const listeners = await tx.discussionParticipant.findMany({
    where: {
      discussionId: input.discussionId,
      joinedAt: { not: null },
      leftAt: null,
      removed: false,
    },
    select: { id: true },
  });

  if (listeners.length > 0) {
    await tx.aiSpeechReceipt.createMany({
      data: listeners.map((participant) => ({
        aiEventId: event.id,
        participantId: participant.id,
      })),
    });
  }

  await tx.turnRequest.updateMany({
    where: { discussionId: input.discussionId, status: TurnRequestStatus.GRANTED },
    data: { status: TurnRequestStatus.REQUESTED, grantedAt: null },
  });

  await tx.discussion.update({
    where: { id: input.discussionId },
    data: {
      turnState: TurnState.AI_SPEAKING,
      activeTurnParticipantId: null,
      turnStartedAt: null,
      turnEndsAt: null,
      activeAiSpeechEventId: event.id,
      aiSpeechDeadlineAt: aiSpeechFallbackDeadline(input.message, now.getTime()),
    },
  });

  return event;
}

export async function syncRoomPermissions(discussionId: string): Promise<{
  configured: boolean;
  connectedParticipants: number;
}> {
  if (!livekitReady()) return { configured: false, connectedParticipants: 0 };

  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      id: true,
      turnState: true,
      activeTurnParticipantId: true,
      participants: {
        select: {
          id: true,
          userId: true,
          micLocked: true,
          removed: true,
          leftAt: true,
        },
      },
    },
  });
  if (!discussion) throw new Error("Discussion not found while synchronizing microphone access.");

  const roomName = roomNameFor(discussion.id, null);
  const roomService = new RoomServiceClient(
    livekitServerUrl(),
    env.livekitApiKey,
    env.livekitApiSecret,
  );
  const rooms = await roomService.listRooms([roomName]);
  if (!rooms.some((room) => room.name === roomName)) {
    return { configured: true, connectedParticipants: 0 };
  }

  const connected = await roomService.listParticipants(roomName);
  const membersByUserId = new Map(discussion.participants.map((member) => [member.userId, member]));
  for (const participant of connected) {
    const member = membersByUserId.get(participant.identity);
    const canPublish =
      member !== undefined &&
      canPublishDuringTurn({
        state: discussion.turnState,
        activeParticipantId: discussion.activeTurnParticipantId,
        participantId: member.id,
        micLocked: member.micLocked,
        removed: member.removed,
        leftAt: member.leftAt,
      });

    try {
      await roomService.updateParticipant(roomName, participant.identity, {
        permission: { canPublish, canSubscribe: true, canPublishData: true },
      });
      if (!canPublish) {
        const microphoneTracks = participant.tracks.filter(
          (track) => track.source === TrackSource.MICROPHONE && !track.muted,
        );
        await Promise.all(
          microphoneTracks.map((track) =>
            roomService.mutePublishedTrack(roomName, participant.identity, track.sid, true),
          ),
        );
      }
    } catch (error) {
      const current = await roomService.listParticipants(roomName);
      if (current.some((entry) => entry.identity === participant.identity)) throw error;
    }
  }

  return { configured: true, connectedParticipants: connected.length };
}

type TurnTransaction = Prisma.TransactionClient;

export async function grantParticipantTx(
  tx: TurnTransaction,
  input: {
    discussionId: string;
    participantId: string;
    source: TurnRequestSource;
    now: Date;
    turnDurationSec: number;
  },
): Promise<boolean> {
  const current = await tx.turnRequest.findFirst({
    where: {
      discussionId: input.discussionId,
      participantId: input.participantId,
      status: TurnRequestStatus.REQUESTED,
    },
    orderBy: { requestedAt: "asc" },
    select: { id: true },
  });
  const requestId =
    current?.id ??
    (
      await tx.turnRequest.create({
        data: {
          discussionId: input.discussionId,
          participantId: input.participantId,
          status: TurnRequestStatus.REQUESTED,
          source: input.source,
          requestedAt: input.now,
        },
        select: { id: true },
      })
    ).id;

  const claimed = await tx.discussion.updateMany({
    where: {
      id: input.discussionId,
      turnState: { in: [TurnState.OPEN, TurnState.AI_SPEAKING] },
      activeTurnParticipantId: null,
    },
    data: {
      turnState: TurnState.PARTICIPANT_SPEAKING,
      activeTurnParticipantId: input.participantId,
      turnStartedAt: input.now,
      turnEndsAt: new Date(input.now.getTime() + input.turnDurationSec * 1000),
      activeAiSpeechEventId: null,
      aiSpeechDeadlineAt: null,
    },
  });
  if (claimed.count === 0) return false;

  await tx.turnRequest.update({
    where: { id: requestId },
    data: {
      status: TurnRequestStatus.GRANTED,
      source: input.source,
      grantedAt: input.now,
    },
  });
  return true;
}

export async function nextRequestedParticipant(
  tx: TurnTransaction,
  discussionId: string,
  preferredParticipantId?: string | null,
): Promise<{ id: string; turnDurationSec: number } | null> {
  const discussion = await tx.discussion.findUnique({
    where: { id: discussionId },
    select: { turnDurationSec: true },
  });
  if (!discussion) return null;

  const pending = await tx.turnRequest.findMany({
    where: { discussionId, status: TurnRequestStatus.REQUESTED },
    orderBy: { requestedAt: "asc" },
    select: { id: true, participantId: true, source: true },
  });
  const preferred = preferredParticipantId
    ? pending.find((request) => request.participantId === preferredParticipantId)
    : undefined;
  const next = preferred ?? pending[0];
  if (!next) return null;

  const member = await tx.discussionParticipant.findUnique({
    where: { id: next.participantId },
    select: { id: true, micLocked: true, removed: true, leftAt: true },
  });
  if (!member || member.micLocked || member.removed || member.leftAt) {
    await tx.turnRequest.update({
      where: { id: next.id },
      data: { status: TurnRequestStatus.CANCELLED, finishedAt: new Date() },
    });
    return nextRequestedParticipant(tx, discussionId, preferredParticipantId);
  }

  return { id: next.participantId, turnDurationSec: discussion.turnDurationSec };
}

async function finishAiSpeechTx(
  tx: TurnTransaction,
  eventId: string,
  discussionId: string,
  preferredParticipantId: string | null,
  now: Date,
): Promise<void> {
  const discussion = await tx.discussion.findUnique({
    where: { id: discussionId },
    select: { turnState: true, activeAiSpeechEventId: true, turnDurationSec: true },
  });
  if (
    !discussion ||
    discussion.turnState !== TurnState.AI_SPEAKING ||
    discussion.activeAiSpeechEventId !== eventId
  ) {
    return;
  }

  const invitation = preferredParticipantId
    ? await tx.invitation.findFirst({
        where: {
          discussionId,
          participantId: preferredParticipantId,
          status: "PENDING",
        },
        select: { participantId: true },
      })
    : null;
  const next = await nextRequestedParticipant(
    tx,
    discussionId,
    invitation?.participantId ?? preferredParticipantId,
  );
  if (
    next &&
    (await grantParticipantTx(tx, {
      discussionId,
      participantId: next.id,
      source:
        invitation?.participantId === next.id
          ? TurnRequestSource.AI
          : TurnRequestSource.PARTICIPANT,
      now,
      turnDurationSec: discussion.turnDurationSec,
    }))
  ) {
    return;
  }

  await tx.discussion.updateMany({
    where: { id: discussionId, activeAiSpeechEventId: eventId },
    data: {
      turnState: TurnState.OPEN,
      activeTurnParticipantId: null,
      turnStartedAt: null,
      turnEndsAt: null,
      activeAiSpeechEventId: null,
      aiSpeechDeadlineAt: null,
    },
  });
}

export async function recordAiSpeechReceipt(input: {
  discussionId: string;
  participantId: string;
  userId: string;
  eventId: string;
  status: Exclude<AiSpeechReceiptStatus, "PENDING">;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await prisma.$transaction(async (tx) => {
    const member = await tx.discussionParticipant.findFirst({
      where: { id: input.participantId, discussionId: input.discussionId, userId: input.userId },
      select: { id: true, removed: true, leftAt: true },
    });
    if (!member || member.removed || member.leftAt) {
      throw new Error("You are not an active member of this discussion.");
    }

    const receipt = await tx.aiSpeechReceipt.findUnique({
      where: {
        aiEventId_participantId: {
          aiEventId: input.eventId,
          participantId: member.id,
        },
      },
      select: { id: true, status: true },
    });
    if (!receipt || receipt.status !== AiSpeechReceiptStatus.PENDING) return;

    await tx.aiSpeechReceipt.update({
      where: { id: receipt.id },
      data: { status: input.status, completedAt: now },
    });

    const discussion = await tx.discussion.findUnique({
      where: { id: input.discussionId },
      select: { turnState: true, activeAiSpeechEventId: true, aiSpeechDeadlineAt: true },
    });
    if (
      !discussion ||
      discussion.turnState !== TurnState.AI_SPEAKING ||
      discussion.activeAiSpeechEventId !== input.eventId
    ) {
      return;
    }

    const pending = await tx.aiSpeechReceipt.count({
      where: {
        aiEventId: input.eventId,
        status: AiSpeechReceiptStatus.PENDING,
        participant: { removed: false, leftAt: null },
      },
    });
    if (pending === 0 || (discussion.aiSpeechDeadlineAt && discussion.aiSpeechDeadlineAt <= now)) {
      await tx.aiSpeechReceipt.updateMany({
        where: { aiEventId: input.eventId, status: AiSpeechReceiptStatus.PENDING },
        data: { status: AiSpeechReceiptStatus.FAILED, completedAt: now },
      });
      const event = await tx.aiEvent.findUnique({
        where: { id: input.eventId },
        select: { participantId: true },
      });
      await finishAiSpeechTx(tx, input.eventId, input.discussionId, event?.participantId ?? null, now);
    }
  });

  await syncRoomPermissions(input.discussionId);
}

export async function expireTurnIfNeeded(discussionId: string, now = new Date()): Promise<boolean> {
  let changed = false;
  await prisma.$transaction(async (tx) => {
    const discussion = await tx.discussion.findUnique({
      where: { id: discussionId },
      select: {
        turnState: true,
        activeTurnParticipantId: true,
        turnEndsAt: true,
        activeAiSpeechEventId: true,
        aiSpeechDeadlineAt: true,
        turnDurationSec: true,
      },
    });
    if (!discussion) return;

    if (
      discussion.turnState === TurnState.AI_SPEAKING &&
      discussion.activeAiSpeechEventId &&
      discussion.aiSpeechDeadlineAt &&
      discussion.aiSpeechDeadlineAt <= now
    ) {
      await tx.aiSpeechReceipt.updateMany({
        where: { aiEventId: discussion.activeAiSpeechEventId, status: AiSpeechReceiptStatus.PENDING },
        data: { status: AiSpeechReceiptStatus.FAILED, completedAt: now },
      });
      const event = await tx.aiEvent.findUnique({
        where: { id: discussion.activeAiSpeechEventId },
        select: { participantId: true },
      });
      await finishAiSpeechTx(
        tx,
        discussion.activeAiSpeechEventId,
        discussionId,
        event?.participantId ?? null,
        now,
      );
      changed = true;
      return;
    }

    if (
      discussion.turnState !== TurnState.PARTICIPANT_SPEAKING ||
      !discussion.activeTurnParticipantId ||
      !discussion.turnEndsAt ||
      discussion.turnEndsAt > now
    ) {
      return;
    }

    await tx.turnRequest.updateMany({
      where: {
        discussionId,
        participantId: discussion.activeTurnParticipantId,
        status: TurnRequestStatus.GRANTED,
      },
      data: { status: TurnRequestStatus.COMPLETED, finishedAt: now },
    });
    const next = await nextRequestedParticipant(tx, discussionId);
    if (
      next &&
      (await grantParticipantTx(tx, {
        discussionId,
        participantId: next.id,
        source: TurnRequestSource.PARTICIPANT,
        now,
        turnDurationSec: discussion.turnDurationSec,
      }))
    ) {
      changed = true;
      return;
    }
    await tx.discussion.update({
      where: { id: discussionId },
      data: {
        turnState: TurnState.OPEN,
        activeTurnParticipantId: null,
        turnStartedAt: null,
        turnEndsAt: null,
      },
    });
    changed = true;
  });

  if (changed) await syncRoomPermissions(discussionId);
  return changed;
}

export async function requestParticipantTurn(input: {
  discussionId: string;
  participantId: string;
  requestId: string;
  now?: Date;
}): Promise<{ requestId: string; status: TurnRequestStatus; granted: boolean }> {
  const now = input.now ?? new Date();
  const result = await prisma.$transaction(async (tx) => {
    const member = await tx.discussionParticipant.findUnique({
      where: { id: input.participantId },
      select: { discussionId: true, micLocked: true, removed: true, leftAt: true },
    });
    if (
      !member ||
      member.discussionId !== input.discussionId ||
      member.removed ||
      member.leftAt
    ) {
      throw Object.assign(new Error("Join the live discussion before requesting a turn."), {
        status: 403,
      });
    }
    if (member.micLocked) {
      throw Object.assign(new Error("Your microphone is locked by the host."), { status: 409 });
    }

    const discussion = await tx.discussion.findUnique({
      where: { id: input.discussionId },
      select: {
        status: true,
        turnState: true,
        activeTurnParticipantId: true,
        turnDurationSec: true,
      },
    });
    if (!discussion || discussion.status !== "LIVE") {
      throw Object.assign(new Error("Turn requests are available only in a live discussion."), {
        status: 409,
      });
    }
    if (
      discussion.activeTurnParticipantId === input.participantId &&
      discussion.turnState === TurnState.PARTICIPANT_SPEAKING
    ) {
      return { requestId: "", status: TurnRequestStatus.GRANTED, granted: false };
    }

    const sameRequest = await tx.turnRequest.findFirst({
      where: {
        discussionId: input.discussionId,
        participantId: input.participantId,
        requestId: input.requestId,
      },
      select: { id: true, status: true },
    });
    if (sameRequest) {
      return { requestId: sameRequest.id, status: sameRequest.status, granted: false };
    }

    const existing = await tx.turnRequest.findFirst({
      where: {
        discussionId: input.discussionId,
        participantId: input.participantId,
        status: TurnRequestStatus.REQUESTED,
      },
      orderBy: { requestedAt: "asc" },
      select: { id: true, status: true },
    });
    if (existing) {
      return { requestId: existing.id, status: existing.status, granted: false };
    }

    const request = await tx.turnRequest.create({
      data: {
        discussionId: input.discussionId,
        participantId: input.participantId,
        requestId: input.requestId,
        source: TurnRequestSource.PARTICIPANT,
      },
      select: { id: true, status: true },
    });

    const granted =
      discussion.turnState === TurnState.OPEN &&
      discussion.activeTurnParticipantId === null &&
      (await grantParticipantTx(tx, {
        discussionId: input.discussionId,
        participantId: input.participantId,
        source: TurnRequestSource.PARTICIPANT,
        now,
        turnDurationSec: discussion.turnDurationSec,
      }));

    return {
      requestId: request.id,
      status: granted ? TurnRequestStatus.GRANTED : request.status,
      granted,
    };
  });

  if (result.granted || result.status === TurnRequestStatus.GRANTED) {
    await syncRoomPermissions(input.discussionId);
  }
  return result;
}

export async function finishParticipantTurn(input: {
  discussionId: string;
  participantId: string;
  actorIsHost: boolean;
  action: "finish" | "pass" | "cancel-request";
  now?: Date;
}): Promise<{ changed: boolean; activeParticipantId: string | null }> {
  const now = input.now ?? new Date();
  const result = await prisma.$transaction(async (tx) => {
    const discussion = await tx.discussion.findUnique({
      where: { id: input.discussionId },
      select: {
        turnState: true,
        activeTurnParticipantId: true,
        activeAiSpeechEventId: true,
        turnDurationSec: true,
      },
    });
    if (!discussion) {
      throw Object.assign(new Error("Discussion not found."), { status: 404 });
    }

    if (input.action === "cancel-request") {
      const request = await tx.turnRequest.findFirst({
        where: {
          discussionId: input.discussionId,
          participantId: input.participantId,
          status: TurnRequestStatus.REQUESTED,
        },
        select: { id: true },
      });
      if (!request) return { changed: false, activeParticipantId: discussion.activeTurnParticipantId };
      await tx.turnRequest.update({
        where: { id: request.id },
        data: { status: TurnRequestStatus.CANCELLED, finishedAt: now },
      });
      return { changed: true, activeParticipantId: discussion.activeTurnParticipantId };
    }

    if (discussion.turnState === TurnState.AI_SPEAKING && input.action === "pass") {
      if (!discussion.activeAiSpeechEventId) {
        return { changed: false, activeParticipantId: null };
      }
      const event = await tx.aiEvent.findFirst({
        where: {
          id: discussion.activeAiSpeechEventId,
          discussionId: input.discussionId,
          participantId: input.participantId,
        },
        select: { id: true },
      });
      if (!event) {
        throw Object.assign(new Error("There is no AI invitation for you to pass."), {
          status: 409,
        });
      }
      await tx.invitation.updateMany({
        where: {
          discussionId: input.discussionId,
          participantId: input.participantId,
          status: "PENDING",
        },
        data: { status: "PASSED", respondedAt: now },
      });
      await tx.aiEvent.update({
        where: { id: event.id },
        data: { dueAt: null },
      });
      await tx.discussionParticipant.update({
        where: { id: input.participantId },
        data: { passCount: { increment: 1 } },
      });
      await tx.turnRequest.updateMany({
        where: {
          discussionId: input.discussionId,
          participantId: input.participantId,
          status: TurnRequestStatus.REQUESTED,
        },
        data: { status: TurnRequestStatus.PASSED, finishedAt: now },
      });
      return { changed: true, activeParticipantId: null };
    }

    const activeId = discussion.activeTurnParticipantId;
    if (
      discussion.turnState !== TurnState.PARTICIPANT_SPEAKING ||
      !activeId ||
      (activeId !== input.participantId && !input.actorIsHost)
    ) {
      throw Object.assign(new Error("Only the active speaker or host can end this turn."), {
        status: 403,
      });
    }

    await tx.turnRequest.updateMany({
      where: {
        discussionId: input.discussionId,
        participantId: activeId,
        status: TurnRequestStatus.GRANTED,
      },
      data: {
        status: input.action === "pass" ? TurnRequestStatus.PASSED : TurnRequestStatus.COMPLETED,
        finishedAt: now,
      },
    });
    if (input.action === "pass") {
      const invitation = await tx.invitation.findFirst({
        where: {
          discussionId: input.discussionId,
          participantId: activeId,
          status: "PENDING",
        },
        select: { aiEventId: true },
      });
      await tx.invitation.updateMany({
        where: {
          discussionId: input.discussionId,
          participantId: activeId,
          status: "PENDING",
        },
        data: { status: "PASSED", respondedAt: now },
      });
      if (invitation?.aiEventId) {
        await tx.aiEvent.update({
          where: { id: invitation.aiEventId },
          data: { dueAt: null },
        });
      }
      await tx.discussionParticipant.update({
        where: { id: activeId },
        data: { passCount: { increment: 1 } },
      });
    }
    await tx.discussion.update({
      where: { id: input.discussionId },
      data: {
        turnState: TurnState.OPEN,
        activeTurnParticipantId: null,
        turnStartedAt: null,
        turnEndsAt: null,
      },
    });

    const next = await nextRequestedParticipant(tx, input.discussionId);
    if (next) {
      await grantParticipantTx(tx, {
        discussionId: input.discussionId,
        participantId: next.id,
        source: TurnRequestSource.PARTICIPANT,
        now,
        turnDurationSec: discussion.turnDurationSec,
      });
    }
    return { changed: true, activeParticipantId: next?.id ?? null };
  });

  if (result.changed && input.action !== "cancel-request") {
    await syncRoomPermissions(input.discussionId);
  }
  return result;
}

export async function hostGrantTurn(input: {
  discussionId: string;
  participantId?: string;
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  const grantedParticipant = await prisma.$transaction(async (tx) => {
    const discussion = await tx.discussion.findUnique({
      where: { id: input.discussionId },
      select: {
        status: true,
        turnState: true,
        activeTurnParticipantId: true,
        turnDurationSec: true,
      },
    });
    if (!discussion || discussion.status !== "LIVE") {
      throw Object.assign(new Error("The discussion is not live."), { status: 409 });
    }
    if (discussion.turnState !== TurnState.OPEN || discussion.activeTurnParticipantId) {
      throw Object.assign(new Error("Wait until the current speaker or AI has finished."), {
        status: 409,
      });
    }
    const selected =
      input.participantId ??
      (await nextRequestedParticipant(tx, input.discussionId))?.id;
    if (!selected) {
      throw Object.assign(new Error("Nobody has requested a turn yet."), { status: 409 });
    }
    const member = await tx.discussionParticipant.findFirst({
      where: {
        id: selected,
        discussionId: input.discussionId,
        removed: false,
        leftAt: null,
        micLocked: false,
      },
      select: { id: true },
    });
    if (!member) {
      throw Object.assign(new Error("That participant cannot take a turn right now."), {
        status: 409,
      });
    }
    if (
      !(await grantParticipantTx(tx, {
        discussionId: input.discussionId,
        participantId: member.id,
        source: TurnRequestSource.HOST,
        now,
        turnDurationSec: discussion.turnDurationSec,
      }))
    ) {
      throw Object.assign(new Error("Another turn was granted at the same time. Refresh and retry."), {
        status: 409,
      });
    }
    return member.id;
  });

  await syncRoomPermissions(input.discussionId);
  return grantedParticipant;
}

