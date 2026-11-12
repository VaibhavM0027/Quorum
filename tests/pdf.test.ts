import { describe, expect, it } from "vitest";
import { renderIndividualReport, renderOverallReport } from "@/lib/pdf";
import type { DiscussionReport, ReportParticipant } from "@/lib/reports";

/**
 * PDF generation smoke tests. They render both report kinds end to end from the
 * same read model the HTML page uses and assert that a real PDF document comes
 * back — nothing here talks to the database or the AI service.
 */

function participant(overrides: Partial<ReportParticipant> = {}): ReportParticipant {
  return {
    participantId: "p1",
    name: "Asha Verma",
    isHost: false,
    removed: false,
    evaluated: true,
    incomplete: false,
    incompleteReason: null,
    overallScore: 78.5,
    band: { label: "Strong", tone: "good" },
    speakingMs: 90_000,
    contributions: 8,
    wordCount: 320,
    participationPct: 45.2,
    relevantCount: 6,
    partialCount: 2,
    irrelevantCount: 0,
    averageRelevance: 80,
    dimensions: [
      { key: "topic_relevance", label: "Topic relevance", weight: 25, score: 82, rationale: "Stays on topic." },
      { key: "communication", label: "Communication", weight: 20, score: 75, rationale: "Clear structure." },
      { key: "knowledge", label: "Content & knowledge", weight: 20, score: 70, rationale: "Some examples." },
      { key: "participation", label: "Participation", weight: 15, score: 88, rationale: "Frequent." },
      { key: "reasoning", label: "Reasoning", weight: 10, score: 74, rationale: "Cause & effect." },
      { key: "listening", label: "Listening & teamwork", weight: 10, score: 72, rationale: "Builds on others." },
    ],
    summary: "A strong contributor who kept the discussion on topic.",
    notes: {
      strengths: ["Consistent on-topic arguments"],
      improvements: ["Could cite more evidence"],
      evidence: ["AI should be regulated carefully"],
    },
    ...overrides,
  };
}

function sampleReport(overrides: Partial<DiscussionReport> = {}): DiscussionReport {
  const participants = [participant(), participant({ participantId: "p2", name: "Quiet One", incomplete: true, overallScore: null, wordCount: 2, band: null })];
  return {
    discussion: {
      id: "d1",
      title: "Should AI be regulated?",
      topic: "AI regulation",
      context: "A short context paragraph.",
      mode: "AI_MODERATED",
      status: "COMPLETED",
      scheduledAt: new Date("2026-01-01T10:00:00Z"),
      startedAt: new Date("2026-01-01T10:05:00Z"),
      endedAt: new Date("2026-01-01T10:35:00Z"),
      durationMin: 30,
      hostName: "Discussion Host",
    },
    viewer: { id: "u1", name: "Discussion Host", isHost: true, seesEveryone: true },
    aggregate: {
      participantCount: 2,
      evaluatedCount: 1,
      averageOverall: 78.5,
      dimensionAverages: [
        { key: "topic_relevance", label: "Topic relevance", weight: 25, score: 82 },
        { key: "communication", label: "Communication", weight: 20, score: 75 },
      ],
      totalSpeakingMs: 90_000,
      totalWords: 322,
      totalContributions: 8,
      fairnessIndex: 55.5,
      relevanceMix: { highly: 2, relevant: 4, partial: 2, irrelevant: 0 },
    },
    participants,
    transcript: [
      {
        id: "s1",
        speaker: "Asha Verma",
        speakerIsHost: false,
        text: "I think regulation should be gradual.",
        startedAt: new Date("2026-01-01T10:06:00Z"),
        relevance: "RELEVANT",
      },
    ],
    generatedAt: new Date("2026-01-01T11:00:00Z"),
    ...overrides,
  };
}

function isPdf(buffer: Buffer): boolean {
  return buffer.length > 0 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

describe("PDF report rendering", () => {
  it("renders a whole-room report as a PDF", async () => {
    const pdf = await renderOverallReport(sampleReport());
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1_000);
  });

  it("renders an individual report as a PDF", async () => {
    const report = sampleReport();
    const pdf = await renderIndividualReport(report, report.participants[0]);
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1_000);
  });

  it("still renders when nobody could be assessed", async () => {
    const report = sampleReport({
      participants: [participant({ incomplete: true, overallScore: null, band: null, wordCount: 1 })],
      aggregate: {
        participantCount: 1,
        evaluatedCount: 0,
        averageOverall: null,
        dimensionAverages: [],
        totalSpeakingMs: 0,
        totalWords: 1,
        totalContributions: 1,
        fairnessIndex: null,
        relevanceMix: { highly: 0, relevant: 0, partial: 0, irrelevant: 0 },
      },
      transcript: [],
    });
    const pdf = await renderOverallReport(report);
    expect(isPdf(pdf)).toBe(true);
  });
});
