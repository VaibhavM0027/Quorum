/**
 * The conversation-state policy.
 *
 * This is the part of the moderator that decides *whether it is allowed to
 * speak at all*. Every other piece of the assistant — the silence detector, the
 * participation tracker, the question writer — is a suggestion fed into this
 * decision; none of them may talk over the room.
 *
 * The state is decided from real audio activity rather than from the transcript
 * alone. A browser knows that somebody has the floor the moment LiveKit reports
 * speech activity, whereas a transcript sentence only exists once the
 * recogniser has committed it, which can be several seconds later. Deciding from
 * transcript events alone is exactly how an automated moderator ends up talking
 * over a participant mid-sentence.
 *
 * Everything here is pure and free of server-only imports, so the same policy
 * that steers the moderator can also be read by the room's UI. Storage of the
 * state lives in `conversation.ts`, which re-exports this module.
 */

export const CONVERSATION_STATES = [
  /** Nothing is happening yet: the room is open but nobody has spoken. */
  "IDLE",
  /** Somebody has the floor. The moderator never speaks in this state. */
  "PARTICIPANT_SPEAKING",
  /** The moderator's own voice is being played back. It does not talk over itself. */
  "AI_SPEAKING",
  /** The room has been quiet long enough for the moderator to act on it. */
  "SILENCE_DETECTED",
  /** The floor has just been handed to a participant. */
  "PARTICIPANT_INVITED",
  /** An invitation is outstanding and inside its response window. */
  "WAITING_FOR_RESPONSE",
  /** The discussion is running normally under its own momentum. */
  "DISCUSSION_CONTINUATION",
] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];

/**
 * How long a speech activity report stays valid.
 *
 * A speaking browser pings while it talks, so a report older than this means
 * the participant has stopped (or their connection dropped mid-sentence).
 */
export const SPEAKING_STALE_MS = 4000;

/** The same window for the moderator's own voice. */
export const AI_SPEAKING_STALE_MS = 4000;

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
};

/**
 * Decides what the room is doing. Ordering is the whole point of this function:
 * a speaking participant outranks everything else, so a single stray audio
 * event is enough to hold the moderator back.
 */
export function decideConversationState(input: ConversationInput): ConversationState {
  // 1. Never interrupt. Somebody has the floor.
  if (input.participantSpeaking) return "PARTICIPANT_SPEAKING";

  // 2. The moderator is already talking; it must not start a second sentence.
  if (input.aiSpeaking) return "AI_SPEAKING";

  // 3. An invitation is out. The moderator waits rather than nagging.
  if (input.awaitingResponse) return "WAITING_FOR_RESPONSE";

  // 4. An announced action is counting down.
  if (input.countdownRunning) return "SILENCE_DETECTED";

  // 5. Genuine silence: nobody has been heard for the configured window.
  if (input.heardSomeone && input.quietMs >= input.silenceMs) return "SILENCE_DETECTED";

  // 6. Under its own momentum.
  return input.heardSomeone ? "DISCUSSION_CONTINUATION" : "IDLE";
}

/**
 * Whether the moderator may put a new sentence into the room.
 *
 * Only genuine, sustained silence earns a remark. `DISCUSSION_CONTINUATION` is
 * deliberately excluded: the room is between sentences, not stalled, and a gap
 * of a second or two mid-discussion is a participant thinking, not an opening.
 * `IDLE` is excluded too — nobody has taken the floor yet, and starting the
 * conversation is the host's job, not the moderator's.
 */
export function mayModeratorSpeak(state: ConversationState): boolean {
  return state === "SILENCE_DETECTED";
}

/** Human-readable label for the room UI. */
export const CONVERSATION_STATE_LABEL: Record<ConversationState, string> = {
  IDLE: "waiting to begin",
  PARTICIPANT_SPEAKING: "participant speaking",
  AI_SPEAKING: "moderator speaking",
  SILENCE_DETECTED: "silence detected",
  PARTICIPANT_INVITED: "floor offered",
  WAITING_FOR_RESPONSE: "waiting for a reply",
  DISCUSSION_CONTINUATION: "discussion running",
};

/** Narrows a stored string back to a known state (older rows may hold anything). */
export function coerceConversationState(value: string | null | undefined): ConversationState {
  return (CONVERSATION_STATES as readonly string[]).includes(value ?? "")
    ? (value as ConversationState)
    : "IDLE";
}
