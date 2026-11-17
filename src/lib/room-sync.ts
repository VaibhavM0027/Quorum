import { prisma } from "./prisma";
import {
  AI_SPEAKING_STALE_MS,
  MAX_AI_SPEAKING_LOCK_MS,
  coerceConversationState,
  isAudioActive,
  resolveTurnOrder,
  type ConversationState,
} from "./conversation";
import {
  broadcastRoomState,
  syncAllRoomMicPermissions,
  type RoomStateBroadcast,
} from "./livekit";

type SttRegistry = Map<string, { connected: boolean }>;

function getSttRegistry(): SttRegistry | null {
  const g = globalThis as unknown as { __quorumSttWorkers?: SttRegistry };
  return g.__quorumSttWorkers ?? null;
}

/** True when a server-side LiveKit STT subscriber worker is connected for this discussion. */
export function isRoomSttActive(discussionId: string): boolean {
  const reg = getSttRegistry();
  if (!reg) return false;
  for (const [key, worker] of reg.entries()) {
    if (key.startsWith(`${discussionId}:`) && worker.connected) {
      return true;
    }
  }
  return false;
}

/**
 * True while the AI moderator holds the speaking floor and participant
 * microphones must stay authoritatively locked.
 */
export function isAiSpeakingLocked(
  discussion: {
    conversationState?: string | null;
    aiSpeakingUntil?: Date | null;
    lastAiSpokeAt?: Date | null;
    pausedAt?: Date | null;
    status?: string | null;
  },
  now: number = Date.now(),
): boolean {
  if (discussion.status && discussion.status !== "LIVE") return false;
  if (discussion.pausedAt) return false;
  if (discussion.aiSpeakingUntil && discussion.aiSpeakingUntil.getTime() > now) {
    return true;
  }
  if (
    discussion.conversationState === "AI_SPEAKING" &&
    discussion.lastAiSpokeAt &&
    now - discussion.lastAiSpokeAt.getTime() <= AI_SPEAKING_STALE_MS
  ) {
    return true;
  }
  return false;
}

export function isMeetingPaused(discussion: {
  conversationState?: string | null;
  pausedAt?: Date | null;
}): boolean {
  return Boolean(discussion.pausedAt) || discussion.conversationState === "MEETING_PAUSED";
}

/** Estimates how long TTS will read a message aloud (bounded for safety). */
export function estimateAiSpeechDurationMs(message: string): number {
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  // ~155 wpm ≈ 385ms/word + 1.8s buffer for TTS start & network propagation
  return Math.max(3500, Math.min(MAX_AI_SPEAKING_LOCK_MS, words * 400 + 1800));
}

/**
 * Transitions the discussion into `AI_SPEAKING`, locks every participant's
 * microphone on LiveKit (`canPublish: false` + `mutePublishedTrack`), and
 * broadcasts the synchronized state packet to all connected browsers.
 */
export async function beginAiSpeaking(
  discussionId: string,
  estimatedDurationMs: number = 9000,
): Promise<RoomStateBroadcast | null> {
  const now = new Date();
  const clampedMs = Math.max(2000, Math.min(MAX_AI_SPEAKING_LOCK_MS, Math.round(estimatedDurationMs)));
  const until = new Date(now.getTime() + clampedMs);

  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      id: true,
      status: true,
      pausedAt: true,
      breakoutEnabled: true,
      participants: {
        select: {
          id: true,
          userId: true,
          isHost: true,
          micLocked: true,
          removed: true,
          breakoutRoom: true,
        },
      },
    },
  });
  if (!discussion || discussion.status !== "LIVE" || discussion.pausedAt) return null;

  await prisma.discussion.update({
    where: { id: discussionId },
    data: {
      conversationState: "AI_SPEAKING",
      conversationStateAt: now,
      lastAiSpokeAt: now,
      aiSpeakingUntil: until,
      activeSpeakerId: null,
    },
  });

  // Clear any human speaking claims while AI takes the floor.
  await prisma.discussionParticipant.updateMany({
    where: { discussionId, speakingSince: { not: null } },
    data: { speakingSince: null },
  });

  const lockedIdentities = await syncAllRoomMicPermissions({
    discussionId,
    aiSpeaking: true,
    meetingPaused: false,
    breakoutEnabled: discussion.breakoutEnabled,
    participants: discussion.participants,
  });

  const snapshot: RoomStateBroadcast = {
    type: "room-state",
    discussionId,
    status: discussion.status,
    conversationState: "AI_SPEAKING",
    aiSpeaking: true,
    aiSpeakingUntil: until.toISOString(),
    paused: false,
    activeSpeakerId: null,
    turnQueue: [],
    lockedIdentities,
    serverSttActive: isRoomSttActive(discussionId),
    updatedAt: now.toISOString(),
  };

  await broadcastRoomState(
    discussionId,
    discussion.breakoutEnabled ? discussion.participants.map((p) => p.breakoutRoom) : [],
    snapshot,
  );

  return snapshot;
}

/**
 * Ends the `AI_SPEAKING` window, restores participant microphone permissions
 * (respecting individual host locks), and broadcasts the updated room state.
 */
export async function endAiSpeaking(discussionId: string): Promise<RoomStateBroadcast | null> {
  const now = new Date();
  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      id: true,
      status: true,
      pausedAt: true,
      conversationState: true,
      breakoutEnabled: true,
      participants: {
        select: {
          id: true,
          userId: true,
          isHost: true,
          micLocked: true,
          removed: true,
          breakoutRoom: true,
        },
      },
    },
  });
  if (!discussion) return null;

  const pendingInvite = await prisma.invitation.findFirst({
    where: { discussionId, status: "PENDING" },
    select: { id: true },
  });

  const nextState: ConversationState =
    discussion.status === "COMPLETED" || discussion.status === "CANCELLED"
      ? "MEETING_ENDED"
      : discussion.pausedAt
        ? "MEETING_PAUSED"
        : pendingInvite
          ? "WAITING_FOR_RESPONSE"
          : "WAITING_FOR_PARTICIPANT";

  await prisma.discussion.update({
    where: { id: discussionId },
    data: {
      conversationState: nextState,
      conversationStateAt: now,
      aiSpeakingUntil: null,
    },
  });

  const meetingPaused = nextState === "MEETING_PAUSED" || nextState === "MEETING_ENDED";
  const lockedIdentities = await syncAllRoomMicPermissions({
    discussionId,
    aiSpeaking: false,
    meetingPaused,
    breakoutEnabled: discussion.breakoutEnabled,
    participants: discussion.participants,
  });

  const snapshot: RoomStateBroadcast = {
    type: "room-state",
    discussionId,
    status: discussion.status,
    conversationState: nextState,
    aiSpeaking: false,
    aiSpeakingUntil: null,
    paused: Boolean(discussion.pausedAt),
    activeSpeakerId: null,
    turnQueue: [],
    lockedIdentities,
    serverSttActive: isRoomSttActive(discussionId),
    updatedAt: now.toISOString(),
  };

  await broadcastRoomState(
    discussionId,
    discussion.breakoutEnabled ? discussion.participants.map((p) => p.breakoutRoom) : [],
    snapshot,
  );

  return snapshot;
}

/**
 * Releases a stale `AI_SPEAKING` lock if its `aiSpeakingUntil` window expired
 * (for example, if all browsers disconnected mid-speech).
 */
export async function expireStaleAiSpeakingLock(discussionId: string): Promise<boolean> {
  const now = Date.now();
  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      id: true,
      status: true,
      pausedAt: true,
      conversationState: true,
      aiSpeakingUntil: true,
      lastAiSpokeAt: true,
    },
  });
  if (!discussion) return false;
  if (discussion.conversationState !== "AI_SPEAKING" && !discussion.aiSpeakingUntil) {
    return false;
  }
  if (isAiSpeakingLocked(discussion, now)) {
    return false;
  }
  await endAiSpeaking(discussionId);
  return true;
}

/**
 * Computes the authoritative current room snapshot (speaker floor, turn queue,
 * AI speaking lock, mic locks), syncs SFU permissions if requested, and
 * broadcasts the state to all connected LiveKit participants.
 */
export async function syncRoomStateSnapshot(
  discussionId: string,
  options: { broadcast?: boolean; syncMics?: boolean } = {},
): Promise<RoomStateBroadcast | null> {
  const now = Date.now();
  await expireStaleAiSpeakingLock(discussionId);

  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      id: true,
      status: true,
      pausedAt: true,
      conversationState: true,
      aiSpeakingUntil: true,
      lastAiSpokeAt: true,
      activeSpeakerId: true,
      breakoutEnabled: true,
      participants: {
        select: {
          id: true,
          userId: true,
          displayName: true,
          isHost: true,
          micLocked: true,
          removed: true,
          leftAt: true,
          joinedAt: true,
          breakoutRoom: true,
          seatNumber: true,
          speakingSince: true,
          lastAudioAt: true,
        },
      },
    },
  });
  if (!discussion) return null;

  const paused = isMeetingPaused(discussion);
  const aiSpeaking = isAiSpeakingLocked(discussion, now);

  const turnCandidates = discussion.participants
    .filter((p) => !p.removed && p.leftAt === null && p.joinedAt !== null)
    .map((p) => ({
      participantId: p.id,
      displayName: p.displayName,
      speaking: !aiSpeaking && !paused && !p.micLocked && isAudioActive(p.speakingSince, p.lastAudioAt, now),
      speakingSince: p.speakingSince,
      seatNumber: p.seatNumber,
    }));

  const { activeSpeaker, queuedSpeakers } = resolveTurnOrder(turnCandidates);
  const activeSpeakerId = activeSpeaker?.participantId ?? null;
  const turnQueue = queuedSpeakers.map((s) => s.participantId);

  if (activeSpeakerId !== discussion.activeSpeakerId) {
    await prisma.discussion.update({
      where: { id: discussionId },
      data: { activeSpeakerId },
    });
  }

  let lockedIdentities: string[];
  if (options.syncMics) {
    lockedIdentities = await syncAllRoomMicPermissions({
      discussionId,
      aiSpeaking,
      meetingPaused: paused || discussion.status !== "LIVE",
      breakoutEnabled: discussion.breakoutEnabled,
      participants: discussion.participants,
    });
  } else {
    lockedIdentities = discussion.participants
      .filter((p) => p.removed || aiSpeaking || paused || p.micLocked || discussion.status !== "LIVE")
      .map((p) => p.userId);
  }

  const snapshot: RoomStateBroadcast = {
    type: "room-state",
    discussionId,
    status: discussion.status,
    conversationState: coerceConversationState(discussion.conversationState),
    aiSpeaking,
    aiSpeakingUntil: discussion.aiSpeakingUntil?.toISOString() ?? null,
    paused,
    activeSpeakerId,
    turnQueue,
    lockedIdentities,
    serverSttActive: isRoomSttActive(discussionId),
    updatedAt: new Date(now).toISOString(),
  };

  if (options.broadcast !== false) {
    await broadcastRoomState(
      discussionId,
      discussion.breakoutEnabled ? discussion.participants.map((p) => p.breakoutRoom) : [],
      snapshot,
    );
  }

  return snapshot;
}
