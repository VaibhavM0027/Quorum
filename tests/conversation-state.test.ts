import { describe, expect, it } from "vitest";
import {
  AI_SPEAKING_STALE_MS,
  coerceConversationState,
  CONVERSATION_STATES,
  decideConversationState,
  isAudioActive,
  isWithinSpeechEndGrace,
  mayModeratorSpeak,
  resolveTurnOrder,
  SPEAKING_STALE_MS,
  SPEECH_END_GRACE_MS,
  type ConversationInput,
} from "@/lib/conversation-state";

/** A quiet, established room: somebody has spoken, nobody is speaking now. */
const base: ConversationInput = {
  participantSpeaking: false,
  aiSpeaking: false,
  quietMs: 0,
  silenceMs: 6000,
  countdownRunning: false,
  awaitingResponse: false,
  heardSomeone: true,
};

const input = (overrides: Partial<ConversationInput> = {}): ConversationInput => ({
  ...base,
  ...overrides,
});

describe("conversation state", () => {
  describe("decideConversationState", () => {
    it("never interrupts a speaking participant", () => {
      expect(
        decideConversationState(
          input({
            participantSpeaking: true,
            aiSpeaking: true,
            processingResponse: true,
            aiThinking: true,
            awaitingResponse: true,
            quietMs: 60_000,
          }),
        ),
      ).toBe("PARTICIPANT_SPEAKING");
    });

    it("respects meeting lifecycle states MEETING_ENDED and MEETING_PAUSED", () => {
      expect(decideConversationState(input({ meetingEnded: true, participantSpeaking: true }))).toBe(
        "MEETING_ENDED",
      );
      expect(decideConversationState(input({ meetingPaused: true, participantSpeaking: true }))).toBe(
        "MEETING_PAUSED",
      );
    });

    it("holds the moderator back while its own voice is playing", () => {
      expect(
        decideConversationState(input({ aiSpeaking: true, quietMs: 60_000, silenceMs: 6000 })),
      ).toBe("AI_SPEAKING");
    });

    it("tracks PROCESSING_RESPONSE, AI_THINKING, and WAITING_FOR_PARTICIPANT cleanly", () => {
      expect(decideConversationState(input({ processingResponse: true }))).toBe("PROCESSING_RESPONSE");
      expect(decideConversationState(input({ aiThinking: true }))).toBe("AI_THINKING");
      expect(
        decideConversationState(input({ heardSomeone: false, waitingForParticipant: true })),
      ).toBe("WAITING_FOR_PARTICIPANT");
    });

    it("waits rather than nagging while an invitation is outstanding", () => {
      expect(
        decideConversationState(input({ awaitingResponse: true, quietMs: 60_000 })),
      ).toBe("WAITING_FOR_RESPONSE");
    });

    it("treats a running countdown as silence already detected", () => {
      expect(decideConversationState(input({ countdownRunning: true }))).toBe("SILENCE_DETECTED");
    });

    it("detects silence only after the configured window", () => {
      expect(decideConversationState(input({ quietMs: 5999, silenceMs: 6000 }))).not.toBe(
        "SILENCE_DETECTED",
      );
      expect(decideConversationState(input({ quietMs: 6000, silenceMs: 6000 }))).toBe(
        "SILENCE_DETECTED",
      );
    });

    it("treats a short gap between sentences as normal momentum", () => {
      expect(decideConversationState(input({ quietMs: 2000, silenceMs: 6000 }))).toBe(
        "DISCUSSION_CONTINUATION",
      );
    });

    it("stays idle until somebody has taken the floor", () => {
      expect(decideConversationState(input({ heardSomeone: false, quietMs: 60_000 }))).toBe("IDLE");
    });

    it("ignores elapsed time while the room has never been heard from", () => {
      // A brand-new room is not "in silence"; there is nothing to moderate yet.
      expect(decideConversationState(input({ heardSomeone: false, quietMs: 30_000 }))).toBe("IDLE");
    });

    it("prefers an outstanding invitation over a detected silence", () => {
      expect(
        decideConversationState(input({ awaitingResponse: true, quietMs: 30_000 })),
      ).toBe("WAITING_FOR_RESPONSE");
    });
  });

  describe("mayModeratorSpeak", () => {
    it("permits speech only in genuine silence", () => {
      expect(mayModeratorSpeak("SILENCE_DETECTED")).toBe(true);
    });

    it("forbids speech in every other state", () => {
      const forbidden = CONVERSATION_STATES.filter((state) => state !== "SILENCE_DETECTED");
      for (const state of forbidden) {
        expect(mayModeratorSpeak(state)).toBe(false);
      }
    });

    it("does not treat ordinary momentum or an idle room as an opening", () => {
      expect(mayModeratorSpeak("DISCUSSION_CONTINUATION")).toBe(false);
      expect(mayModeratorSpeak("IDLE")).toBe(false);
    });
  });

  describe("isAudioActive & isWithinSpeechEndGrace", () => {
    const now = new Date("2026-01-01T10:00:00.000Z").getTime();
    const at = (offsetMs: number) => new Date(now + offsetMs);

    it("is false without a speaking marker", () => {
      expect(isAudioActive(null, at(0), now)).toBe(false);
      expect(isAudioActive(undefined, at(0), now)).toBe(false);
    });

    it("is false without a recent audio report", () => {
      expect(isAudioActive(at(-1000), null, now)).toBe(false);
    });

    it("is true while the report is fresh", () => {
      expect(isAudioActive(at(-1000), at(-1000), now)).toBe(true);
      expect(isAudioActive(at(-1000), at(-SPEAKING_STALE_MS), now)).toBe(true);
    });

    it("is false once the report has gone stale", () => {
      expect(isAudioActive(at(-1000), at(-(SPEAKING_STALE_MS + 1)), now)).toBe(false);
    });

    it("accepts a custom staleness window for the moderator's own voice", () => {
      const lastAudioAt = at(-(AI_SPEAKING_STALE_MS + 500));
      expect(isAudioActive(at(-1000), lastAudioAt, now, AI_SPEAKING_STALE_MS)).toBe(false);
      expect(isAudioActive(at(-1000), lastAudioAt, now, AI_SPEAKING_STALE_MS * 2)).toBe(true);
    });

    it("holds grace period for natural breathing pauses and short drops", () => {
      expect(isWithinSpeechEndGrace(null, now)).toBe(false);
      expect(isWithinSpeechEndGrace(at(-1000), now)).toBe(true);
      expect(isWithinSpeechEndGrace(at(-SPEECH_END_GRACE_MS), now)).toBe(true);
      expect(isWithinSpeechEndGrace(at(-(SPEECH_END_GRACE_MS + 1)), now)).toBe(false);
    });
  });

  describe("resolveTurnOrder", () => {
    const t0 = new Date("2026-01-01T10:00:00.000Z");
    const t1 = new Date("2026-01-01T10:00:02.000Z");

    it("selects the earliest speaker and queues subsequent contenders by timestamp and seat", () => {
      const result = resolveTurnOrder([
        { participantId: "p3", displayName: "Carol", speaking: true, speakingSince: t1, seatNumber: 3 },
        { participantId: "p1", displayName: "Alice", speaking: false, speakingSince: null, seatNumber: 1 },
        { participantId: "p2", displayName: "Bob", speaking: true, speakingSince: t0, seatNumber: 2 },
        { participantId: "p4", displayName: "Dave", speaking: true, speakingSince: t1, seatNumber: 1 },
      ]);
      expect(result.activeSpeaker?.participantId).toBe("p2");
      expect(result.queuedSpeakers.map((s) => s.participantId)).toEqual(["p4", "p3"]);
    });

    it("returns null activeSpeaker when nobody is speaking", () => {
      const result = resolveTurnOrder([
        { participantId: "p1", displayName: "Alice", speaking: false, speakingSince: null, seatNumber: 1 },
      ]);
      expect(result.activeSpeaker).toBeNull();
      expect(result.queuedSpeakers).toEqual([]);
    });
  });

  describe("coerceConversationState", () => {
    it("keeps a known state", () => {
      expect(coerceConversationState("WAITING_FOR_RESPONSE")).toBe("WAITING_FOR_RESPONSE");
      expect(coerceConversationState("MEETING_PAUSED")).toBe("MEETING_PAUSED");
      expect(coerceConversationState("PROCESSING_RESPONSE")).toBe("PROCESSING_RESPONSE");
    });

    it("falls back to IDLE for anything unrecognised", () => {
      expect(coerceConversationState("NONSENSE")).toBe("IDLE");
      expect(coerceConversationState(null)).toBe("IDLE");
      expect(coerceConversationState(undefined)).toBe("IDLE");
      expect(coerceConversationState("")).toBe("IDLE");
    });

    it("covers every declared state", () => {
      for (const state of CONVERSATION_STATES) {
        expect(coerceConversationState(state)).toBe(state);
      }
    });
  });
});
