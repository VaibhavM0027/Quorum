import { describe, expect, it } from "vitest";
import {
  buildParticipation,
  classifyParticipantResponse,
  INVITATION_COOLDOWN_MS,
  invitationEligibility,
  isTechnicalIssue,
  isTranscribing,
  participationScore,
  PASS_COOLDOWN_MS,
  pickInviteCandidate,
  rankInviteCandidates,
  speakingRate,
  TECHNICAL_COOLDOWN_MS,
  TRANSCRIBING_FRESH_MS,
  type ParticipationContext,
  type ParticipationRow,
} from "@/lib/participation";

const NOW = new Date("2026-01-01T10:00:00.000Z").getTime();
const ago = (ms: number) => new Date(NOW - ms);

/** A row that is present, silent, and eligible. Tests override one thing at a time. */
function row(overrides: Partial<ParticipationRow> = {}): ParticipationRow {
  return {
    participantId: "p1",
    displayName: "Participant",
    isHost: false,
    seatNumber: 1,
    present: true,
    micLocked: false,
    audioIssue: false,
    joinedAt: ago(600_000),
    presentMs: 600_000,
    speakingMs: 0,
    words: 0,
    contributions: 0,
    meaningfulContributions: 0,
    averageTurnMs: 0,
    averageRelevance: null,
    lastSpokeAt: null,
    lastAudioAt: null,
    speaking: false,
    invitedCount: 0,
    answeredInvites: 0,
    unansweredInvites: 0,
    passCount: 0,
    lastInvitedAt: null,
    transcribing: false,
    score: 0,
    ...overrides,
  };
}

/** A context with no talking at all, so scoring tests isolate the responsiveness term. */
const emptyContext: ParticipationContext = { totalSpeakingMs: 0, speakerCount: 0, maxMeaningful: 0 };

describe("participation tracker", () => {
  describe("classifyParticipantResponse", () => {
    it("recognises a polite pass", () => {
      expect(classifyParticipantResponse("I'd like to pass on this one")).toBe("pass");
      expect(classifyParticipantResponse("I'll sit this out")).toBe("pass");
      expect(classifyParticipantResponse("Nothing more to add from me")).toBe("pass");
    });

    it("recognises a technical report", () => {
      expect(classifyParticipantResponse("Sorry, my mic isn't working")).toBe("technical");
      expect(classifyParticipantResponse("I can't hear you")).toBe("technical");
      expect(classifyParticipantResponse("you're frozen, I think the connection dropped")).toBe(
        "technical",
      );
    });

    it("reads a broken microphone as a technical issue, never as a pass", () => {
      expect(classifyParticipantResponse("my audio is not working so I'll pass")).toBe("technical");
    });

    it("returns null for ordinary speech", () => {
      expect(classifyParticipantResponse("I think the motion is sound")).toBeNull();
      expect(classifyParticipantResponse("   ")).toBeNull();
    });
  });

  describe("isTechnicalIssue", () => {
    it("is true only while the failure is recent", () => {
      expect(isTechnicalIssue(ago(1000), NOW)).toBe(true);
      expect(isTechnicalIssue(ago(TECHNICAL_COOLDOWN_MS), NOW)).toBe(true);
      expect(isTechnicalIssue(ago(TECHNICAL_COOLDOWN_MS + 1), NOW)).toBe(false);
    });

    it("is false when there was never a failure", () => {
      expect(isTechnicalIssue(null, NOW)).toBe(false);
    });
  });

  describe("buildParticipation", () => {
    const participant = (id: string, overrides: Partial<Parameters<typeof buildParticipation>[0]["participants"][number]> = {}) => ({
      id,
      displayName: id.toUpperCase(),
      isHost: false,
      seatNumber: 1,
      joinedAt: ago(300_000),
      leftAt: null as Date | null,
      removed: false,
      micLocked: false,
      lastAudioAt: null as Date | null,
      speakingSince: null as Date | null,
      invitedCount: 0,
      answeredInviteCount: 0,
      unansweredInviteCount: 0,
      passCount: 0,
      lastInvitedAt: null as Date | null,
      audioIssueAt: null as Date | null,
      transcribingAt: null as Date | null,
      ...overrides,
    });

    const segment = (participantId: string, relevance: string, overrides: Partial<Parameters<typeof buildParticipation>[0]["segments"][number]> = {}) => ({
      participantId,
      durationMs: 2000,
      wordCount: 5,
      relevance,
      relevanceScore: 70 as number | null,
      startedAt: ago(1000),
      ...overrides,
    });

    it("counts only relevant contributions as meaningful", () => {
      const snapshot = buildParticipation(
        {
          participants: [participant("a")],
          segments: [
            segment("a", "HIGHLY_RELEVANT"),
            segment("a", "RELEVANT"),
            segment("a", "PARTIALLY_RELEVANT"),
            segment("a", "IRRELEVANT"),
          ],
        },
        NOW,
      );
      expect(snapshot.rows[0].meaningfulContributions).toBe(2);
      expect(snapshot.rows[0].contributions).toBe(4);
    });

    it("marks a participant present only when joined, not left, not removed", () => {
      const snapshot = buildParticipation(
        {
          participants: [
            participant("a"),
            participant("b", { leftAt: ago(1000) }),
            participant("c", { joinedAt: null }),
            participant("d", { removed: true }),
          ],
          segments: [],
        },
        NOW,
      );
      const present = Object.fromEntries(snapshot.rows.map((r) => [r.participantId, r.present]));
      expect(present).toEqual({ a: true, b: false, c: false, d: false });
    });

    it("reports speaking from live audio activity, not from the transcript", () => {
      const snapshot = buildParticipation(
        {
          participants: [
            participant("a", { speakingSince: ago(1000), lastAudioAt: ago(1000) }),
            participant("b", { speakingSince: ago(1000), lastAudioAt: ago(60_000) }),
          ],
          segments: [],
        },
        NOW,
      );
      expect(snapshot.rows[0].speaking).toBe(true);
      expect(snapshot.rows[1].speaking).toBe(false);
    });

    it("flags a technical issue while it is recent", () => {
      const snapshot = buildParticipation(
        {
          participants: [
            participant("a", { audioIssueAt: ago(1000) }),
            participant("b", { audioIssueAt: ago(TECHNICAL_COOLDOWN_MS + 1000) }),
          ],
          segments: [],
        },
        NOW,
      );
      expect(snapshot.rows[0].audioIssue).toBe(true);
      expect(snapshot.rows[1].audioIssue).toBe(false);
    });

    it("treats a participant as transcribing only while their report is fresh", () => {
      const snapshot = buildParticipation(
        {
          participants: [
            participant("a", { transcribingAt: ago(1000) }),
            participant("b", { transcribingAt: ago(TRANSCRIBING_FRESH_MS + 1000) }),
            participant("c", { transcribingAt: null }),
          ],
          segments: [],
        },
        NOW,
      );
      expect(snapshot.rows.map((r) => r.transcribing)).toEqual([true, false, false]);
    });

    it("expires a transcribing claim that is not refreshed", () => {
      expect(isTranscribing(ago(1000), NOW)).toBe(true);
      expect(isTranscribing(ago(TRANSCRIBING_FRESH_MS + 1), NOW)).toBe(false);
      expect(isTranscribing(null, NOW)).toBe(false);
    });

    it("builds the context from the room's actual talking", () => {
      const snapshot = buildParticipation(
        {
          participants: [participant("a"), participant("b")],
          segments: [
            segment("a", "RELEVANT", { durationMs: 3000 }),
            segment("b", "IRRELEVANT", { durationMs: 1000, relevanceScore: null }),
          ],
        },
        NOW,
      );
      expect(snapshot.context.totalSpeakingMs).toBe(4000);
      expect(snapshot.context.speakerCount).toBe(2);
      expect(snapshot.context.maxMeaningful).toBe(1);
    });
  });

  describe("invitationEligibility", () => {
    it("allows an ordinary present participant", () => {
      expect(invitationEligibility(row(), { now: NOW })).toEqual({
        eligible: true,
        reason: "eligible",
      });
    });

    it("never invites the host", () => {
      expect(invitationEligibility(row({ isHost: true }), { now: NOW }).reason).toBe("host");
    });

    it("never invites somebody who is not present", () => {
      expect(invitationEligibility(row({ present: false }), { now: NOW }).reason).toBe(
        "not-present",
      );
    });

    it("never presses somebody who is speaking", () => {
      expect(invitationEligibility(row({ speaking: true }), { now: NOW }).reason).toBe(
        "currently-speaking",
      );
    });

    it("leaves a locked or broken microphone alone", () => {
      expect(invitationEligibility(row({ micLocked: true }), { now: NOW }).reason).toBe(
        "microphone-locked",
      );
      expect(invitationEligibility(row({ audioIssue: true }), { now: NOW }).reason).toBe(
        "technical-issue",
      );
    });

    it("skips somebody already invited this round", () => {
      const excludeIds = new Set(["p1"]);
      expect(invitationEligibility(row(), { now: NOW, excludeIds }).reason).toBe(
        "already-invited-this-round",
      );
    });

    it("lets a recent invitation cool down", () => {
      const recently = row({ invitedCount: 1, answeredInvites: 1, lastInvitedAt: ago(1000) });
      expect(invitationEligibility(recently, { now: NOW }).reason).toBe("recently-invited");

      const cooled = row({
        invitedCount: 1,
        answeredInvites: 1,
        lastInvitedAt: ago(INVITATION_COOLDOWN_MS + 1),
      });
      expect(invitationEligibility(cooled, { now: NOW }).eligible).toBe(true);
    });

    it("leaves somebody who declined alone for longer than an ordinary cooldown", () => {
      const declined = row({ invitedCount: 1, passCount: 1, lastInvitedAt: ago(60_000) });
      expect(invitationEligibility(declined, { now: NOW }).reason).toBe("passed-recently");

      // Still inside the longer pass cooldown.
      expect(NOW - ago(60_000).getTime()).toBeLessThan(PASS_COOLDOWN_MS);

      // Past the pass cooldown they become eligible again.
      const later = row({ invitedCount: 1, passCount: 1, lastInvitedAt: ago(PASS_COOLDOWN_MS + 1) });
      expect(invitationEligibility(later, { now: NOW }).eligible).toBe(true);
    });
  });

  describe("speakingRate", () => {
    it("measures talking per minute present, with a floor on time present", () => {
      expect(speakingRate(row({ speakingMs: 6000, presentMs: 600_000 }))).toBeCloseTo(0.01);
      // Below the floor, the floor is used: 6000 / 60000.
      expect(speakingRate(row({ speakingMs: 6000, presentMs: 10_000 }))).toBeCloseTo(0.1);
    });
  });

  describe("rankInviteCandidates", () => {
    it("picks the participant who has contributed least per minute present", () => {
      const quiet = row({ participantId: "quiet", speakingMs: 0, presentMs: 600_000 });
      const talker = row({ participantId: "talker", speakingMs: 60_000, presentMs: 600_000 });
      const ranked = rankInviteCandidates([talker, quiet], { now: NOW });
      expect(ranked.map((r) => r.participantId)).toEqual(["quiet", "talker"]);
    });

    it("does not penalise a late arrival who has been contributing", () => {
      const veteran = row({ participantId: "veteran", speakingMs: 5000, presentMs: 600_000 });
      const latecomer = row({ participantId: "late", speakingMs: 3000, presentMs: 30_000 });
      // The latecomer has spoken less in total, but far more per minute, so the
      // veteran — who has been quiet throughout — is asked first.
      const ranked = rankInviteCandidates([latecomer, veteran], { now: NOW });
      expect(ranked[0].participantId).toBe("veteran");
    });

    it("leaves out hosts, absentees, speakers and excluded ids", () => {
      const rows = [
        row({ participantId: "host", isHost: true }),
        row({ participantId: "gone", present: false }),
        row({ participantId: "talking", speaking: true }),
        row({ participantId: "broken", audioIssue: true }),
        row({ participantId: "ok" }),
      ];
      const ranked = rankInviteCandidates(rows, { now: NOW, excludeIds: new Set(["ok"]) });
      expect(ranked).toEqual([]);
    });

    it("breaks a rate tie on fewer meaningful contributions", () => {
      const few = row({ participantId: "few", speakingMs: 3000, meaningfulContributions: 0 });
      const many = row({ participantId: "many", speakingMs: 3000, meaningfulContributions: 3 });
      const ranked = rankInviteCandidates([many, few], { now: NOW });
      expect(ranked.map((r) => r.participantId)).toEqual(["few", "many"]);
    });

    it("prefers whoever has been invited fewest times when everything else ties", () => {
      const asked = row({ participantId: "asked", invitedCount: 2 });
      const fresh = row({ participantId: "fresh", invitedCount: 0 });
      const ranked = rankInviteCandidates([asked, fresh], { now: NOW });
      expect(ranked[0].participantId).toBe("fresh");
    });

    it("falls back to seat order for a complete tie", () => {
      const late = row({ participantId: "late", seatNumber: 5 });
      const first = row({ participantId: "first", seatNumber: 2 });
      expect(pickInviteCandidate([late, first], { now: NOW })?.participantId).toBe("first");
    });

    it("returns null when nobody may be asked", () => {
      expect(pickInviteCandidate([row({ isHost: true })], { now: NOW })).toBeNull();
    });
  });

  describe("participationScore", () => {
    it("gives a full responsiveness credit when nobody has been invited", () => {
      // relevance defaults to the neutral midpoint: 0.5 * 25 = 12.5; + 15 = 27.5
      expect(participationScore(row(), emptyContext)).toBe(27.5);
    });

    it("counts a taken-up invitation as answering", () => {
      const answered = row({ invitedCount: 2, answeredInvites: 2 });
      expect(participationScore(answered, emptyContext)).toBe(27.5);
    });

    it("counts a polite pass as answering, and never penalises it", () => {
      const passed = row({ invitedCount: 2, answeredInvites: 1, passCount: 1 });
      expect(participationScore(passed, emptyContext)).toBe(27.5);
    });

    it("forgives the first silence", () => {
      const once = row({ invitedCount: 1, unansweredInvites: 1 });
      expect(participationScore(once, emptyContext)).toBe(12.5);
    });

    it("deducts a small amount only for repeated silence", () => {
      const twice = row({ invitedCount: 2, unansweredInvites: 2 });
      // 12.5 - 3 = 9.5
      expect(participationScore(twice, emptyContext)).toBe(9.5);
    });

    it("caps the silence penalty", () => {
      const repeated = row({ invitedCount: 10, unansweredInvites: 10 });
      // 12.5 - 10 (capped) = 2.5
      expect(participationScore(repeated, emptyContext)).toBe(2.5);
    });

    it("rewards relevant content over talking time", () => {
      const context: ParticipationContext = {
        totalSpeakingMs: 20_000,
        speakerCount: 2,
        maxMeaningful: 4,
      };
      const concise = row({ meaningfulContributions: 4, averageRelevance: 90, speakingMs: 2000 });
      const rambling = row({
        meaningfulContributions: 0,
        averageRelevance: 40,
        speakingMs: 18_000,
      });
      expect(participationScore(concise, context)).toBeGreaterThan(
        participationScore(rambling, context),
      );
    });

    it("never returns a negative score", () => {
      const worst = row({
        meaningfulContributions: 0,
        averageRelevance: 0,
        speakingMs: 0,
        invitedCount: 10,
        unansweredInvites: 10,
      });
      expect(participationScore(worst, emptyContext)).toBeGreaterThanOrEqual(0);
    });
  });
});
