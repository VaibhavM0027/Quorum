import { TurnState } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { aiSpeechFallbackDeadline, canPublishDuringTurn } from "@/lib/turns";

const eligibleSpeaker = {
  state: TurnState.PARTICIPANT_SPEAKING,
  activeParticipantId: "speaker-1",
  participantId: "speaker-1",
  micLocked: false,
  removed: false,
  leftAt: null,
};

describe("server-managed speaking turns", () => {
  it("allows publishing only for the active, eligible participant", () => {
    expect(canPublishDuringTurn(eligibleSpeaker)).toBe(true);
    expect(canPublishDuringTurn({ ...eligibleSpeaker, state: TurnState.AI_SPEAKING })).toBe(false);
    expect(canPublishDuringTurn({ ...eligibleSpeaker, participantId: "speaker-2" })).toBe(false);
    expect(canPublishDuringTurn({ ...eligibleSpeaker, micLocked: true })).toBe(false);
    expect(canPublishDuringTurn({ ...eligibleSpeaker, removed: true })).toBe(false);
    expect(canPublishDuringTurn({ ...eligibleSpeaker, leftAt: new Date() })).toBe(false);
  });

  it("bounds the AI speech fallback so a stalled browser cannot hold the floor forever", () => {
    const now = 1_000;
    expect(aiSpeechFallbackDeadline("A short prompt.", now).getTime()).toBe(now + 8_000);
    expect(aiSpeechFallbackDeadline("word ".repeat(100), now).getTime()).toBe(now + 35_000);
  });
});
