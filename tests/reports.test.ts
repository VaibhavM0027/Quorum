import { describe, expect, it } from "vitest";
import { needsMoreEvidence, orderedDimensions, type ReportParticipant } from "@/lib/reports";
import { RUBRIC_DIMENSIONS } from "@/lib/rubric";

function participant(overrides: Partial<ReportParticipant> = {}): ReportParticipant {
  return {
    participantId: "p1",
    name: "Asha",
    isHost: false,
    removed: false,
    evaluated: true,
    incomplete: false,
    incompleteReason: null,
    overallScore: 72,
    band: { label: "Strong", tone: "good" },
    speakingMs: 60_000,
    contributions: 6,
    wordCount: 240,
    participationPct: 40,
    relevantCount: 5,
    partialCount: 1,
    irrelevantCount: 0,
    averageRelevance: 78,
    dimensions: [],
    summary: "Solid contribution.",
    notes: { strengths: [], improvements: [], evidence: [] },
    ...overrides,
  };
}

describe("report read model helpers", () => {
  describe("needsMoreEvidence", () => {
    it("is false when a participant was scored with enough words", () => {
      expect(needsMoreEvidence(participant())).toBe(false);
    });

    it("is true when the evaluation was flagged incomplete", () => {
      expect(needsMoreEvidence(participant({ incomplete: true, overallScore: null }))).toBe(true);
    });

    it("is true when there are too few words even if not flagged", () => {
      expect(needsMoreEvidence(participant({ wordCount: 3 }))).toBe(true);
    });
  });

  describe("orderedDimensions", () => {
    it("always returns a row per rubric dimension in rubric order", () => {
      const rows = orderedDimensions(participant());
      expect(rows.map((r) => r.key)).toEqual(RUBRIC_DIMENSIONS.map((d) => d.key));
    });

    it("fills missing dimensions with zero so a partial result cannot inflate a score", () => {
      const rows = orderedDimensions(
        participant({
          dimensions: [
            { key: "topic_relevance", label: "Topic relevance", weight: 25, score: 80, rationale: "on topic" },
          ],
        }),
      );
      const topic = rows.find((r) => r.key === "topic_relevance");
      const missing = rows.find((r) => r.key === "listening");
      expect(topic?.score).toBe(80);
      expect(missing?.score).toBe(0);
    });

    it("carries each dimension's configured weight through", () => {
      const rows = orderedDimensions(participant());
      expect(rows.find((r) => r.key === "topic_relevance")?.weight).toBe(25);
      expect(rows.find((r) => r.key === "listening")?.weight).toBe(10);
    });
  });
});
