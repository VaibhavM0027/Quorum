/**
 * The centralized conversation-state policy.
 *
 * This is the part of the moderator that decides *whether it is allowed to
 * speak at all* and keeps human-AI turn-taking synchronized across every
 * connected participant.
 *
 * Everything here is pure and free of server-only imports, so the same policy
 * that steers the moderator can also be read by the room's UI. Storage of the
 * state lives in `conversation.ts`, which re-exports this module.
 */

export const CONVERSATION_STATES = [
  /** Nothing is happening yet: the room is open but nobody has spoken. */
  "IDLE",
  /** The meeting is live and waiting for the next participant contribution. */
  "WAITING_FOR_PARTICIPANT",
  /** Somebody has the floor. The moderator never speaks in this state. */
  "PARTICIPANT_SPEAKING",
  /** A participant finished speaking and their transcript/audio is being finalized. */
  "PROCESSING_RESPONSE",
  /** The AI moderator is formulating a response or follow-up question. */
  "AI_THINKING",
  /** The moderator's own voice is playing; participant mics are muted on LiveKit. */
  "AI_SPEAKING",
  /** The room has been quiet long enough for the moderator to act on it. */
  "SILENCE_DETECTED",
  /** The floor has just been handed to a participant. */
  "PARTICIPANT_INVITED",
  /** An invitation is outstanding and inside its response window. */
  "WAITING_FOR_RESPONSE",
  /** The discussion is running normally under its own momentum. */
  "DISCUSSION_CONTINUATION",
  /** The host paused the meeting. */
  "MEETING_PAUSED",
  /** The meeting has ended. */
  "MEETING_ENDED",
] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];

/**
 * How long a speech activity report stays valid.
 *
 * A speaking browser pings while it talks, so a report older than this means
 * the participant has stopped (or their connection dropped mid-sentence).
 */
export const SPEAKING_STALE_MS = 4000;

/** Grace window after a participant pauses mid-thought before AI treats turn as complete. */
export const SPEECH_END_GRACE_MS = 2500;

/** The same window for the moderator's own voice. */
export const AI_SPEAKING_STALE_MS = 4000;

/** Maximum duration a single AI speaking lock can remain active without renewal. */
export const MAX_AI_SPEAKING_LOCK_MS = 25_000;

/** True while the audio report is fresh enough to mean "still speaking". */
export function isAudioActive(
  speakingSince: Date | null | undefined,
  lastAudioAt: Date | null | undefined,
  now: number,
  staleMs: number = SPEAKING_STALE_MS,
): boolean {
  if (!speakingSince) return false;
  if (!lastAudioAt) return false;
  return now - lastAudioAt.getTime() <= staleMs;
}

/**
 * True while a participant has recently spoken within the grace window,
 * preventing short breathing pauses or brief network hiccups from triggering
 * premature AI interruption.
 */
export function isWithinSpeechEndGrace(
  lastAudioAt: Date | null | undefined,
  now: number,
  graceMs: number = SPEECH_END_GRACE_MS,
): boolean {
  if (!lastAudioAt) return false;
  return now - lastAudioAt.getTime() <= graceMs;
}

export type ConversationInput = {
  /** A participant has the floor right now, according to audio activity. */
  participantSpeaking: boolean;
  /** The moderator's voice is being played in the room right now. */
  aiSpeaking: boolean;
  /** Milliseconds since the room was last heard from, by any means. */
  quietMs: number;
  /** The configured silence threshold, in milliseconds. */
  silenceMs: number;
  /** The moderator has announced an action and is counting down to it. */
  countdownRunning: boolean;
  /** An invitation is outstanding and inside its response window. */
  awaitingResponse: boolean;
  /** The room has heard from at least one participant at some point. */
  heardSomeone: boolean;
  /** Optional lifecycle overrides for full meeting state machine. */
  meetingEnded?: boolean;
  meetingPaused?: boolean;
  processingResponse?: boolean;
  aiThinking?: boolean;
  waitingForParticipant?: boolean;
};

/**
 * Decides what the room is doing. Ordering is the whole point of this function:
 * a speaking participant outranks AI thinking/speaking decisions so a single
 * stray audio event holds the moderator back.
 */
export function decideConversationState(input: ConversationInput): ConversationState {
  if (input.meetingEnded) return "MEETING_ENDED";
  if (input.meetingPaused) return "MEETING_PAUSED";

  // 1. Never interrupt. Somebody has the floor.
  if (input.participantSpeaking) return "PARTICIPANT_SPEAKING";

  // 2. The moderator is already talking; participant mics are locked.
  if (input.aiSpeaking) return "AI_SPEAKING";

  // 3. A participant just stopped speaking and response/STT is still settling.
  if (input.processingResponse) return "PROCESSING_RESPONSE";

  // 4. The AI moderator is generating its turn.
  if (input.aiThinking) return "AI_THINKING";

  // 5. An invitation is out. The moderator waits rather than nagging.
  if (input.awaitingResponse) return "WAITING_FOR_RESPONSE";

  // 6. An announced action is counting down.
  if (input.countdownRunning) return "SILENCE_DETECTED";

  // 7. Genuine silence: nobody has been heard for the configured window.
  if (input.heardSomeone && input.quietMs >= input.silenceMs) return "SILENCE_DETECTED";

  // 8. Explicitly waiting for participants after an AI prompt/welcome.
  if (input.waitingForParticipant) return "WAITING_FOR_PARTICIPANT";

  // 9. Under its own momentum.
  return input.heardSomeone ? "DISCUSSION_CONTINUATION" : "IDLE";
}

/**
 * Whether the moderator may put a new sentence into the room.
 *
 * Only genuine, sustained silence earns a remark.
 */
export function mayModeratorSpeak(state: ConversationState): boolean {
  return state === "SILENCE_DETECTED";
}

/**
 * Turn-taking helper when multiple participants attempt to speak simultaneously.
 * Picks the participant who took the floor earliest (or lowest seat number on tie)
 * and lists others in order as waiting in the turn queue.
 */
export type TurnSpeakerCandidate = {
  participantId: string;
  displayName: string;
  speaking: boolean;
  speakingSince: Date | null;
  seatNumber: number | null;
};

export function resolveTurnOrder(speakers: TurnSpeakerCandidate[]): {
  activeSpeaker: TurnSpeakerCandidate | null;
  queuedSpeakers: TurnSpeakerCandidate[];
} {
  const active = speakers
    .filter((s) => s.speaking)
    .sort((a, b) => {
      const aTime = a.speakingSince?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bTime = b.speakingSince?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) return aTime - bTime;
      return (a.seatNumber ?? Number.MAX_SAFE_INTEGER) - (b.seatNumber ?? Number.MAX_SAFE_INTEGER);
    });

  return {
    activeSpeaker: active[0] ?? null,
    queuedSpeakers: active.slice(1),
  };
}

/** Human-readable label for the room UI. */
export const CONVERSATION_STATE_LABEL: Record<ConversationState, string> = {
  IDLE: "waiting to begin",
  WAITING_FOR_PARTICIPANT: "waiting for participant",
  PARTICIPANT_SPEAKING: "participant speaking",
  PROCESSING_RESPONSE: "processing response",
  AI_THINKING: "AI thinking",
  AI_SPEAKING: "AI speaking",
  SILENCE_DETECTED: "silence detected",
  PARTICIPANT_INVITED: "floor offered",
  WAITING_FOR_RESPONSE: "waiting for a reply",
  DISCUSSION_CONTINUATION: "discussion running",
  MEETING_PAUSED: "meeting paused",
  MEETING_ENDED: "meeting ended",
};

/** Narrows a stored string back to a known state (older rows may hold anything). */
export function coerceConversationState(value: string | null | undefined): ConversationState {
  return (CONVERSATION_STATES as readonly string[]).includes(value ?? "")
    ? (value as ConversationState)
    : "IDLE";
}
