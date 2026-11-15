import { prisma } from "./prisma";
import { env } from "./env";
import { AiUnavailableError, callGemini, geminiAvailable, parseJsonReply } from "./gemini";
import {
  RUBRIC_DIMENSIONS,
  clampScore,
  weightedOverall,
  type DimensionScore,
} from "./rubric";

/**
 * The evaluation engine.
 *
 * Evaluation is deliberately two-layered:
 *
 *   1. Statistics are computed from the transcript — speaking time, number of
 *      contributions, words, and the relevance verdicts produced live. These
 *      numbers are objective and reproducible.
 *   2. The AI scores the six rubric dimensions, but it is given those statistics
 *      and told to justify each score. The final weighted overall score is
 *      always calculated here, from the rubric weights, never taken from the
 *      model.
 *
 * Participants who barely spoke are flagged `incomplete` rather than being
 * given an invented score.
 */

/** Below this many words there is not enough evidence to grade reliably. */
export const MIN_WORDS_FOR_EVALUATION = 20;

/** Cap how much transcript is sent per participant, to bound token usage. */
const MAX_UTTERANCES_PER_PARTICIPANT = 60;
const MAX_CHARS_PER_PARTICIPANT = 12_000;

const EVALUATOR_SYSTEM =
  "You are a fair, experienced examiner of group discussions. You judge only the substance of " +
  "what was said. You never penalise accent, grammar, fluency, speaking speed or hesitation. " +
  "You give lower scores for absence of evidence, not for brevity: a short, precise contribution " +
  "can score highly. When evidence is thin, you say so in the rationale instead of guessing. " +
  "You never penalise absence caused by circumstance: a microphone or connection failure, a " +
  "retracted or unused invitation, a late arrival, attentive listening or thinking time are not " +
  "failures to participate. The only participation-shortfall signal you may weigh, and only " +
  "lightly, is a repeated failure to answer invitations when the participant was able to speak.";

export type Utterance = {
  text: string;
  relevance: string;
  relevanceScore: number | null;
  startedAt: Date;
};

export type ParticipantStats = {
  participantId: string;
  userId: string;
  displayName: string;
  isHost: boolean;
  joinedAt: Date | null;
  leftAt: Date | null;
  removed: boolean;
  speakingMs: number;
  contributions: number;
  wordCount: number;
  /** Share of total speaking time in the room, 0–100. */
  speakingPct: number;
  highlyRelevantCount: number;
  relevantCount: number;
  partialCount: number;
  irrelevantCount: number;
  averageRelevance: number | null;
  firstSpokeAt: Date | null;
  lastSpokeAt: Date | null;
  /** How long the participant was in the discussion, in milliseconds. */
  presentMs: number;
  /** How many times the moderator offered them the floor. */
  invitedCount: number;
  /** Invitations the participant took up. */
  answeredInvites: number;
  /** Invitations met with silence — the only participation shortfall that counts. */
  unansweredInvites: number;
  /** Invitations politely declined. Respected, and never penalised. */
  passCount: number;
  /** A recent, unrecovered microphone or connection failure. Never penalised. */
  audioIssue: boolean;
  utterances: Utterance[];
};

export type DiscussionStats = {
  participants: ParticipantStats[];
  totalSpeakingMs: number;
  totalWords: number;
  totalContributions: number;
  /** Mean share of speaking time if everyone spoke equally (0–100). */
  fairSharePct: number;
};

/** Builds objective per-participant statistics from the transcript. */
export async function computeDiscussionStats(discussionId: string): Promise<DiscussionStats> {
  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      participants: {
        orderBy: [{ isHost: "desc" }, { createdAt: "asc" }],
        select: {
          id: true,
          userId: true,
          displayName: true,
          isHost: true,
          joinedAt: true,
          leftAt: true,
          removed: true,
          invitedCount: true,
          answeredInviteCount: true,
          unansweredInviteCount: true,
          passCount: true,
          audioIssueAt: true,
        },
      },
      segments: {
        where: { status: "FINAL" },
        orderBy: { startedAt: "asc" },
        select: {
          participantId: true,
          text: true,
          startedAt: true,
          durationMs: true,
          wordCount: true,
          relevance: true,
          relevanceScore: true,
        },
      },
    },
  });

  if (!discussion) throw Object.assign(new Error("Discussion not found."), { status: 404 });

  const totalSpeakingMs = discussion.segments.reduce((sum, s) => sum + s.durationMs, 0);
  const present = discussion.participants.filter((p) => !p.removed);
  const fairSharePct = present.length > 0 ? 100 / present.length : 0;

  const participants: ParticipantStats[] = discussion.participants.map((participant) => {
    const mine = discussion.segments.filter((s) => s.participantId === participant.id);
    const speakingMs = mine.reduce((sum, s) => sum + s.durationMs, 0);
    const scored = mine.filter((s) => typeof s.relevanceScore === "number");

    return {
      participantId: participant.id,
      userId: participant.userId,
      displayName: participant.displayName,
      isHost: participant.isHost,
      joinedAt: participant.joinedAt,
      leftAt: participant.leftAt,
      removed: participant.removed,
      speakingMs,
      contributions: mine.length,
      wordCount: mine.reduce((sum, s) => sum + s.wordCount, 0),
      speakingPct: totalSpeakingMs > 0 ? Math.round((speakingMs / totalSpeakingMs) * 1000) / 10 : 0,
      highlyRelevantCount: mine.filter((s) => s.relevance === "HIGHLY_RELEVANT").length,
      relevantCount: mine.filter((s) => s.relevance === "RELEVANT").length,
      partialCount: mine.filter((s) => s.relevance === "PARTIALLY_RELEVANT").length,
      irrelevantCount: mine.filter((s) => s.relevance === "IRRELEVANT").length,
      averageRelevance:
        scored.length > 0
          ? Math.round(
              (scored.reduce((sum, s) => sum + (s.relevanceScore ?? 0), 0) / scored.length) * 10,
            ) / 10
          : null,
      firstSpokeAt: mine[0]?.startedAt ?? null,
      lastSpokeAt: mine.at(-1)?.startedAt ?? null,
      presentMs: participant.joinedAt
        ? Math.max(0, (participant.leftAt ?? new Date()).getTime() - participant.joinedAt.getTime())
        : 0,
      invitedCount: participant.invitedCount,
      answeredInvites: participant.answeredInviteCount,
      unansweredInvites: participant.unansweredInviteCount,
      passCount: participant.passCount,
      audioIssue: participant.audioIssueAt !== null,
      utterances: mine.map((s) => ({
        text: s.text,
        relevance: s.relevance,
        relevanceScore: s.relevanceScore,
        startedAt: s.startedAt,
      })),
    };
  });

  return {
    participants,
    totalSpeakingMs,
    totalWords: discussion.segments.reduce((sum, s) => sum + s.wordCount, 0),
    totalContributions: discussion.segments.length,
    fairSharePct: Math.round(fairSharePct * 10) / 10,
  };
}

export type ParticipantEvaluation = {
  participantId: string;
  overallScore: number | null;
  dimensions: DimensionScore[];
  summary: string;
  notes: { strengths: string[]; improvements: string[]; evidence: string[] };
  incomplete: boolean;
  incompleteReason: string | null;
};

type AiParticipantReply = {
  dimensions?: Array<{ key?: string; score?: unknown; rationale?: unknown }>;
  strengths?: unknown;
  improvements?: unknown;
  evidence?: unknown;
  summary?: unknown;
};

function asStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

/** Trims a participant's transcript so prompts stay within sensible limits. */
function transcriptForPrompt(utterances: Utterance[]): string {
  const recent = utterances.slice(-MAX_UTTERANCES_PER_PARTICIPANT);
  const lines = recent.map(
    (u) => `- [${u.relevance.toLowerCase().replace(/_/g, " ")}] ${u.text}`,
  );
  let text = lines.join("\n");
  if (text.length > MAX_CHARS_PER_PARTICIPANT) {
    text = `${text.slice(0, MAX_CHARS_PER_PARTICIPANT)}…`;
  }
  return text;
}

/**
 * Scores one participant. Returns an `incomplete` evaluation when there is not
 * enough evidence, so a quiet participant gets an honest "not assessed" rather
 * than a fabricated grade.
 */
export async function evaluateParticipant(params: {
  topic: string;
  context: string;
  discussionMode: string;
  durationMin: number;
  stats: ParticipantStats;
  fairSharePct: number;
  roomAverageRelevance: number | null;
}): Promise<ParticipantEvaluation> {
  const { stats } = params;

  if (stats.wordCount < MIN_WORDS_FOR_EVALUATION) {
    return {
      participantId: stats.participantId,
      overallScore: null,
      dimensions: [],
      summary:
        stats.contributions === 0
          ? "No contributions were recorded for this participant, so no assessment was made."
          : "There was too little spoken content to assess reliably.",
      notes: {
        strengths: [],
        improvements: [
          stats.contributions === 0
            ? "Aim to contribute at least a few points in the discussion."
            : "Speak in fuller sentences so your reasoning can be assessed.",
        ],
        evidence: [],
      },
      incomplete: true,
      incompleteReason:
        stats.contributions === 0
          ? "Participant did not speak."
          : `Only ${stats.wordCount} words recorded (minimum ${MIN_WORDS_FOR_EVALUATION}).`,
    };
  }

  const rubricList = RUBRIC_DIMENSIONS.map(
    (d) => `- ${d.key} ("${d.label}", weight ${d.weight}%): ${d.description}`,
  ).join("\n");

  const prompt = [
    `Discussion topic: ${params.topic}`,
    params.context ? `Background given to participants: ${params.context}` : "",
    `Format: ${params.discussionMode === "AI_MODERATED" ? "AI-moderated" : "free-flowing"} group discussion, ${params.durationMin} minutes.`,
    "",
    "Objective statistics for the participant you are assessing:",
    `- Speaking time: ${(stats.speakingMs / 1000).toFixed(1)}s (${stats.speakingPct}% of the room's talking time; an equal share would be ${params.fairSharePct}%).`,
    `- Contributions: ${stats.contributions}; total words: ${stats.wordCount}.`,
    `- Topic-relevance verdicts recorded live: ${stats.highlyRelevantCount} highly relevant, ${stats.relevantCount} relevant, ${stats.partialCount} partially relevant, ${stats.irrelevantCount} irrelevant.`,
    stats.averageRelevance !== null
      ? `- Average relevance score: ${stats.averageRelevance}/100 (room average: ${params.roomAverageRelevance ?? "n/a"}).`
      : "",
    `- Time present in the discussion: ${(stats.presentMs / 60000).toFixed(1)} minutes.`,
    `- Moderator invitations: ${stats.invitedCount} offered, ${stats.answeredInvites} taken up, ${stats.passCount} politely declined, ${stats.unansweredInvites} met with silence.`,
    stats.audioIssue
      ? "- A microphone or connection failure was recorded for this participant; treat any resulting silence as circumstantial, not as disengagement."
      : "",
    "",
    "Score the following rubric dimensions from 0 to 100:",
    rubricList,
    "",
    "Rules:",
    "- Ground every score in the transcript. Cite specific moments in the rationale.",
    "- Do not reward long speaking time on its own; participation is only one dimension.",
    "- Judge the content, never the delivery style.",
    "- A declined invitation, a recorded microphone or connection failure, a late arrival, attentive listening and thinking time are never grounds for a lower score.",
    "- Only a repeated failure to answer an invitation, when the participant was able to speak, may weigh lightly against Active Participation. Even then, the reduction must be small.",
    "",
    'Return JSON only: {"dimensions":[{"key":"topic_relevance","score":78,"rationale":"..."}],"strengths":["..."],"improvements":["..."],"evidence":["<short direct quote>"],"summary":"<2-3 sentences>"}',
    "",
    "Participant's contributions (chronological):",
    transcriptForPrompt(stats.utterances) || "(none)",
  ]
    .filter(Boolean)
    .join("\n");

  let reply: AiParticipantReply;
  try {
    const raw = await callGemini({
      prompt,
      system: EVALUATOR_SYSTEM,
      tier: "smart",
      json: true,
      temperature: 0.2,
      maxOutputTokens: 4096,
    });
    reply = parseJsonReply<AiParticipantReply>(raw);
  } catch (error) {
    if (error instanceof AiUnavailableError) throw error;
    // A failed AI pass still yields an honest, statistics-only record.
    return {
      participantId: stats.participantId,
      overallScore: null,
      dimensions: [],
      summary: "The assessment could not be completed because the AI service was unavailable.",
      notes: {
        strengths: [],
        improvements: [],
        evidence: [],
      },
      incomplete: true,
      incompleteReason: "AI scoring failed.",
    };
  }

  const aiByKey = new Map(
    (Array.isArray(reply.dimensions) ? reply.dimensions : []).map((d) => [String(d.key ?? ""), d]),
  );

  const dimensions: DimensionScore[] = RUBRIC_DIMENSIONS.map((dimension) => {
    const ai = aiByKey.get(dimension.key);
    return {
      key: dimension.key,
      label: dimension.label,
      weight: dimension.weight,
      score: clampScore(ai?.score),
      rationale: String(ai?.rationale ?? "").slice(0, 500) || "No rationale returned.",
    };
  });

  const scores = Object.fromEntries(dimensions.map((d) => [d.key, d.score]));

  return {
    participantId: stats.participantId,
    overallScore: weightedOverall(scores),
    dimensions,
    summary: String(reply.summary ?? "").slice(0, 1500) || "No narrative summary was produced.",
    notes: {
      strengths: asStringList(reply.strengths, 6),
      improvements: asStringList(reply.improvements, 6),
      evidence: asStringList(reply.evidence, 8),
    },
    incomplete: false,
    incompleteReason: null,
  };
}

export type EvaluationRunResult = {
  evaluated: number;
  skipped: number;
  incomplete: number;
  model: string;
};

/**
 * Runs (or re-runs) the full evaluation for a discussion and persists it.
 * Existing evaluations for the discussion are replaced so a re-run is clean.
 */
export async function evaluateDiscussion(discussionId: string): Promise<EvaluationRunResult> {
  if (!geminiAvailable()) throw new AiUnavailableError();

  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: { id: true, topic: true, context: true, mode: true, durationMin: true, hostId: true },
  });
  if (!discussion) throw Object.assign(new Error("Discussion not found."), { status: 404 });

  const stats = await computeDiscussionStats(discussionId);

  const scoredAverages = stats.participants
    .map((p) => p.averageRelevance)
    .filter((value): value is number => value !== null);
  const roomAverageRelevance =
    scoredAverages.length > 0
      ? Math.round((scoredAverages.reduce((a, b) => a + b, 0) / scoredAverages.length) * 10) / 10
      : null;

  // Only members who actually produced speech get evaluated.
  const targets = stats.participants.filter((p) => !p.removed && p.contributions > 0);
  let incomplete = 0;

  for (const target of targets) {
    const evaluation = await evaluateParticipant({
      topic: discussion.topic,
      context: discussion.context,
      discussionMode: discussion.mode,
      durationMin: discussion.durationMin,
      stats: target,
      fairSharePct: stats.fairSharePct,
      roomAverageRelevance,
    });

    if (evaluation.incomplete) incomplete += 1;

    await prisma.evaluation.upsert({
      where: { participantId: target.participantId },
      create: {
        discussionId,
        participantId: target.participantId,
        overallScore: evaluation.overallScore,
        speakingMs: target.speakingMs,
        contributions: target.contributions,
        wordCount: target.wordCount,
        participationPct: target.speakingPct,
        relevantCount: target.highlyRelevantCount + target.relevantCount,
        partialCount: target.partialCount,
        irrelevantCount: target.irrelevantCount,
        averageRelevance: target.averageRelevance,
        dimensions: evaluation.dimensions,
        notes: evaluation.notes,
        summary: evaluation.summary,
        incomplete: evaluation.incomplete,
        incompleteReason: evaluation.incompleteReason,
        source: "gemini",
        model: env.geminiSmartModel,
      },
      update: {
        overallScore: evaluation.overallScore,
        speakingMs: target.speakingMs,
        contributions: target.contributions,
        wordCount: target.wordCount,
        participationPct: target.speakingPct,
        relevantCount: target.highlyRelevantCount + target.relevantCount,
        partialCount: target.partialCount,
        irrelevantCount: target.irrelevantCount,
        averageRelevance: target.averageRelevance,
        dimensions: evaluation.dimensions,
        notes: evaluation.notes,
        summary: evaluation.summary,
        incomplete: evaluation.incomplete,
        incompleteReason: evaluation.incompleteReason,
        source: "gemini",
        model: env.geminiSmartModel,
      },
    });
  }

  return {
    evaluated: targets.length,
    skipped: stats.participants.length - targets.length,
    incomplete,
    model: env.geminiSmartModel,
  };
}

export type OverallAggregate = {
  participantCount: number;
  evaluatedCount: number;
  averageOverall: number | null;
  dimensionAverages: Array<{ key: string; label: string; weight: number; score: number }>;
  totalSpeakingMs: number;
  totalWords: number;
  totalContributions: number;
  fairnessIndex: number | null;
  relevanceMix: { highly: number; relevant: number; partial: number; irrelevant: number };
};

/**
 * Deterministic room-level aggregate. Everything here is computed from stored
 * numbers so the overall report never depends on a fresh model call.
 */
export async function computeOverallAggregate(discussionId: string): Promise<OverallAggregate> {
  const stats = await computeDiscussionStats(discussionId);
  const evaluations = await prisma.evaluation.findMany({
    where: { discussionId },
    select: { overallScore: true, dimensions: true, incomplete: true },
  });

  const scored = evaluations.filter((e) => !e.incomplete && typeof e.overallScore === "number");
  const averageOverall =
    scored.length > 0
      ? Math.round((scored.reduce((sum, e) => sum + (e.overallScore ?? 0), 0) / scored.length) * 10) / 10
      : null;

  const dimensionAverages = RUBRIC_DIMENSIONS.map((dimension) => {
    const values = scored
      .map((evaluation) => {
        const list = Array.isArray(evaluation.dimensions)
          ? (evaluation.dimensions as Array<{ key?: string; score?: number }>)
          : [];
        const match = list.find((d) => d.key === dimension.key);
        return typeof match?.score === "number" ? match.score : null;
      })
      .filter((value): value is number => value !== null);

    return {
      key: dimension.key,
      label: dimension.label,
      weight: dimension.weight,
      score:
        values.length > 0
          ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
          : 0,
    };
  });

  const speakers = stats.participants.filter((p) => p.speakingMs > 0 && !p.removed);

  // Fairness index: 100 = everyone spoke equally, approaching 0 = one voice dominates.
  let fairnessIndex: number | null = null;
  if (speakers.length > 1 && stats.totalSpeakingMs > 0) {
    const shares = speakers.map((p) => p.speakingMs / stats.totalSpeakingMs);
    const ideal = 1 / speakers.length;
    const deviation = shares.reduce((sum, share) => sum + Math.abs(share - ideal), 0);
    const maxDeviation = 2 * (1 - ideal);
    fairnessIndex =
      maxDeviation > 0 ? Math.round((1 - deviation / maxDeviation) * 1000) / 10 : null;
  }

  return {
    participantCount: stats.participants.filter((p) => !p.removed).length,
    evaluatedCount: scored.length,
    averageOverall,
    dimensionAverages,
    totalSpeakingMs: stats.totalSpeakingMs,
    totalWords: stats.totalWords,
    totalContributions: stats.totalContributions,
    fairnessIndex,
    relevanceMix: {
      highly: stats.participants.reduce((sum, p) => sum + p.highlyRelevantCount, 0),
      relevant: stats.participants.reduce((sum, p) => sum + p.relevantCount, 0),
      partial: stats.participants.reduce((sum, p) => sum + p.partialCount, 0),
      irrelevant: stats.participants.reduce((sum, p) => sum + p.irrelevantCount, 0),
    },
  };
}
