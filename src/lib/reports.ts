import { prisma } from "./prisma";
import { env } from "./env";
import { MIN_WORDS_FOR_EVALUATION, computeOverallAggregate, type OverallAggregate } from "./evaluation";
import { RUBRIC_DIMENSIONS, scoreBand } from "./rubric";
import { recordingDownloadUrl } from "./recordings";

/**
 * The report read model.
 *
 * Both the HTML report page and the PDF endpoints read through here, so a
 * downloaded PDF can never disagree with what the page showed. Visibility is
 * applied once, at the source: a participant reading their own report and a
 * host reading the whole room get the same shape, filtered.
 */

export type ReportDimension = {
  key: string;
  label: string;
  weight: number;
  score: number;
  rationale: string;
};

export type ReportParticipant = {
  participantId: string;
  name: string;
  isHost: boolean;
  removed: boolean;
  /** False when the participant produced no speech, so there is nothing to grade. */
  evaluated: boolean;
  incomplete: boolean;
  incompleteReason: string | null;
  overallScore: number | null;
  band: { label: string; tone: "good" | "ok" | "weak" } | null;
  speakingMs: number;
  contributions: number;
  wordCount: number;
  participationPct: number;
  relevantCount: number;
  partialCount: number;
  irrelevantCount: number;
  averageRelevance: number | null;
  dimensions: ReportDimension[];
  summary: string;
  notes: { strengths: string[]; improvements: string[]; evidence: string[] };
};

export type ReportTranscriptLine = {
  id: string;
  speaker: string;
  speakerIsHost: boolean;
  text: string;
  startedAt: Date;
  relevance: string;
};

/** The stored audio recording of the session, when one was captured. */
export type ReportRecording = {
  id: string;
  /** Route that streams the audio, with range support for seeking. */
  url: string;
  durationMs: number;
  byteSize: number;
  startedAt: Date;
};

export type DiscussionReport = {
  discussion: {
    id: string;
    title: string;
    topic: string;
    context: string;
    mode: string;
    status: string;
    scheduledAt: Date;
    startedAt: Date | null;
    endedAt: Date | null;
    durationMin: number;
    hostName: string;
  };
  viewer: { id: string; name: string; isHost: boolean; seesEveryone: boolean };
  aggregate: OverallAggregate;
  participants: ReportParticipant[];
  transcript: ReportTranscriptLine[];
  recording: ReportRecording | null;
  generatedAt: Date;
};

const MAX_TRANSCRIPT_LINES = 400;

function asStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function asDimensions(value: unknown): ReportDimension[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = item as { key?: unknown; label?: unknown; weight?: unknown; score?: unknown; rationale?: unknown };
    const key = String(record?.key ?? "");
    if (!key) return [];
    return [
      {
        key,
        label: String(record.label ?? key),
        weight: Number(record.weight ?? 0),
        score: Number(record.score ?? 0),
        rationale: String(record.rationale ?? ""),
      },
    ];
  });
}

/**
 * Loads everything needed to render a discussion report, filtered for the
 * viewer. Returns null when the discussion does not exist or the viewer has no
 * access to it.
 */
export async function loadDiscussionReport(
  discussionId: string,
  viewerUserId: string,
): Promise<DiscussionReport | null> {
  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    include: {
      host: { select: { id: true, name: true } },
      participants: {
        orderBy: [{ isHost: "desc" }, { createdAt: "asc" }],
        include: { evaluation: true },
      },
      segments: { orderBy: { startedAt: "asc" }, take: MAX_TRANSCRIPT_LINES },
    },
  });
  if (!discussion) return null;

  const isHost = discussion.hostId === viewerUserId;
  const mine = discussion.participants.find((p) => p.userId === viewerUserId);
  if (!isHost && !mine) return null;

  const seesEveryone = isHost || env.reportVisibility === "all";
  const aggregate = await computeOverallAggregate(discussionId);

  // The most recent stored recording is the session's audio record.
  const recording = await prisma.recording.findFirst({
    where: { discussionId, status: "READY" },
    orderBy: { startedAt: "desc" },
    select: { id: true, durationMs: true, byteSize: true, startedAt: true },
  });

  const toReport = (participant: (typeof discussion.participants)[number]): ReportParticipant => {
    const evaluation = participant.evaluation;
    const incomplete = evaluation?.incomplete ?? true;
    const overallScore = incomplete ? null : (evaluation?.overallScore ?? null);

    return {
      participantId: participant.id,
      name: participant.displayName,
      isHost: participant.isHost,
      removed: participant.removed,
      evaluated: Boolean(evaluation),
      incomplete,
      incompleteReason:
        evaluation?.incompleteReason ??
        (participant.evaluation
          ? null
          : "Not enough spoken content to produce a report."),
      overallScore,
      band: overallScore !== null ? scoreBand(overallScore) : null,
      speakingMs: evaluation?.speakingMs ?? 0,
      contributions: evaluation?.contributions ?? 0,
      wordCount: evaluation?.wordCount ?? 0,
      participationPct: evaluation?.participationPct ?? 0,
      relevantCount: evaluation?.relevantCount ?? 0,
      partialCount: evaluation?.partialCount ?? 0,
      irrelevantCount: evaluation?.irrelevantCount ?? 0,
      averageRelevance: evaluation?.averageRelevance ?? null,
      dimensions: asDimensions(evaluation?.dimensions),
      summary: evaluation?.summary ?? "",
      notes: {
        strengths: asStringList((evaluation?.notes as { strengths?: unknown } | undefined)?.strengths, 8),
        improvements: asStringList(
          (evaluation?.notes as { improvements?: unknown } | undefined)?.improvements,
          8,
        ),
        evidence: asStringList((evaluation?.notes as { evidence?: unknown } | undefined)?.evidence, 8),
      },
    };
  };

  const visible = seesEveryone
    ? discussion.participants
    : discussion.participants.filter((p) => p.id === mine?.id);

  return {
    discussion: {
      id: discussion.id,
      title: discussion.title,
      topic: discussion.topic,
      context: discussion.context,
      mode: discussion.mode,
      status: discussion.status,
      scheduledAt: discussion.scheduledAt,
      startedAt: discussion.startedAt,
      endedAt: discussion.endedAt,
      durationMin: discussion.durationMin,
      hostName: discussion.host.name,
    },
    viewer: {
      id: viewerUserId,
      name: isHost ? discussion.host.name : (mine?.displayName ?? ""),
      isHost,
      seesEveryone,
    },
    aggregate,
    participants: visible.map(toReport),
    transcript: discussion.segments.map((segment) => ({
      id: segment.id,
      speaker:
        discussion.participants.find((p) => p.id === segment.participantId)?.displayName ?? "Unknown",
      speakerIsHost:
        discussion.participants.find((p) => p.id === segment.participantId)?.isHost ?? false,
      text: segment.text,
      startedAt: segment.startedAt,
      relevance: segment.relevance,
    })),
    recording: recording
      ? {
          id: recording.id,
          url: recordingDownloadUrl(discussionId, recording.id),
          durationMs: recording.durationMs,
          byteSize: recording.byteSize,
          startedAt: recording.startedAt,
        }
      : null,
    generatedAt: new Date(),
  };
}

/**
 * True when the report for this participant cannot carry an AI score. Quiet or
 * silent participants are flagged rather than graded, which is the difference
 * between a report and a guess.
 */
export function needsMoreEvidence(participant: ReportParticipant): boolean {
  return participant.incomplete || participant.wordCount < MIN_WORDS_FOR_EVALUATION;
}

/** Dimensions in rubric order, even when a participant is missing some. */
export function orderedDimensions(participant: ReportParticipant): ReportDimension[] {
  return RUBRIC_DIMENSIONS.map(
    (definition) =>
      participant.dimensions.find((dimension) => dimension.key === definition.key) ?? {
        key: definition.key,
        label: definition.label,
        weight: definition.weight,
        score: 0,
        rationale: "",
      },
  );
}
