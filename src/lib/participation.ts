import { prisma } from "./prisma";
import { isAudioActive } from "./conversation";

/**
 * The participation tracker.
 *
 * Everything the moderator decides about people is decided here: who has
 * actually contributed, who has been invited and how they answered, who is
 * eligible to be asked next, and what each participant's live score is.
 *
 * Two rules shape all of it:
 *
 *   - Reward substance, not volume. A participant is measured by the
 *     contributions that were judged relevant, not by how long they held the
 *     floor. Long speeches are not worth more than short, sharp ones.
 *   - Never punish circumstances. A broken microphone, a dropped connection, a
 *     late arrival or a politely declined invitation are not failures to
 *     participate, and nothing here scores them as such.
 *
 * The decisions are pure functions over plain rows, so the whole policy can be
 * tested without a room, a database or a model.
 */

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** How long a recently invited participant is left alone before being asked again. */
export const INVITATION_COOLDOWN_MS = 90_000;

/** A pass is respected for longer than a cooldown: the moderator does not nag. */
export const PASS_COOLDOWN_MS = 180_000;

/** While a microphone is known to be broken, the participant is not asked. */
export const TECHNICAL_COOLDOWN_MS = 120_000;

/**
 * How long a browser's "I am transcribing" report stays valid without being
 * refreshed. The browser heartbeats more often than this, so a recogniser that
 * has silently died stops looking healthy instead of claiming to capture
 * forever.
 */
export const TRANSCRIBING_FRESH_MS = 20_000;

/**
 * Floor on the "time in the room" used when comparing how much each participant
 * has spoken. Without it, somebody who arrived ten seconds ago and said one
 * sentence would look like the loudest person in the room.
 */
export const MIN_PRESENCE_FLOOR_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The participant columns the tracker needs. */
export type ParticipationParticipantSource = {
  id: string;
  displayName: string;
  isHost: boolean;
  seatNumber: number | null;
  joinedAt: Date | null;
  leftAt: Date | null;
  removed: boolean;
  micLocked: boolean;
  lastAudioAt: Date | null;
  speakingSince: Date | null;
  invitedCount: number;
  answeredInviteCount: number;
  unansweredInviteCount: number;
  passCount: number;
  lastInvitedAt: Date | null;
  audioIssueAt: Date | null;
  /** Last time this participant's own browser reported it is transcribing. */
  transcribingAt: Date | null;
};

/** The transcript columns the tracker needs. */
export type ParticipationSegmentSource = {
  participantId: string;
  durationMs: number;
  wordCount: number;
  relevance: string;
  relevanceScore: number | null;
  startedAt: Date;
};

export type ParticipationRow = {
  participantId: string;
  displayName: string;
  isHost: boolean;
  seatNumber: number | null;
  /** In the room: joined, not left, not removed. */
  present: boolean;
  micLocked: boolean;
  /** A recent, unrecovered microphone or connection failure. */
  audioIssue: boolean;
  joinedAt: Date | null;
  /** How long they have been in the discussion. */
  presentMs: number;
  speakingMs: number;
  words: number;
  contributions: number;
  /** Contributions judged relevant or highly relevant to the topic. */
  meaningfulContributions: number;
  averageTurnMs: number;
  averageRelevance: number | null;
  lastSpokeAt: Date | null;
  /** Last moment their audio track carried speech, by any means. */
  lastAudioAt: Date | null;
  /** Has the floor right now, according to LiveKit audio activity. */
  speaking: boolean;
  invitedCount: number;
  answeredInvites: number;
  unansweredInvites: number;
  passCount: number;
  lastInvitedAt: Date | null;
  /**
   * This participant's own browser is turning their speech into transcript
   * right now. Distinguishes "audible but producing nothing" from "captured".
   */
  transcribing: boolean;
  /** Live participation score, 0–100. See `participationScore`. */
  score: number;
};

export type ParticipationContext = {
  /** Total speaking time across the room. */
  totalSpeakingMs: number;
  /** How many present participants have spoken at all. */
  speakerCount: number;
  /** The largest number of relevant contributions by anybody. */
  maxMeaningful: number;
};

export type ParticipationSnapshot = {
  rows: ParticipationRow[];
  context: ParticipationContext;
};

const PRESENT_RELEVANCE = new Set(["HIGHLY_RELEVANT", "RELEVANT"]);

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Building the snapshot
// ---------------------------------------------------------------------------

/**
 * Turns stored rows into the per-participant picture the moderator works from.
 * Pure: the same input always produces the same output.
 */
export function buildParticipation(
  source: {
    participants: ParticipationParticipantSource[];
    segments: ParticipationSegmentSource[];
  },
  now: number = Date.now(),
): ParticipationSnapshot {
  const byParticipant = new Map<string, ParticipationSegmentSource[]>();
  for (const segment of source.segments) {
    const list = byParticipant.get(segment.participantId);
    if (list) list.push(segment);
    else byParticipant.set(segment.participantId, [segment]);
  }

  const totalSpeakingMs = source.segments.reduce((sum, s) => sum + s.durationMs, 0);
  const speakerCount = source.participants.filter(
    (p) => !p.removed && (byParticipant.get(p.id)?.length ?? 0) > 0,
  ).length;

  const base = source.participants.map((participant) => {
    const mine = byParticipant.get(participant.id) ?? [];
    const speakingMs = mine.reduce((sum, s) => sum + s.durationMs, 0);
    const scored = mine.filter((s) => typeof s.relevanceScore === "number");
    const meaningfulContributions = mine.filter((s) => PRESENT_RELEVANCE.has(s.relevance)).length;
    const lastSpokeAt = mine.length > 0 ? mine[mine.length - 1].startedAt : null;

    return {
      participantId: participant.id,
      displayName: participant.displayName,
      isHost: participant.isHost,
      seatNumber: participant.seatNumber,
      present: !participant.removed && participant.leftAt === null && participant.joinedAt !== null,
      micLocked: participant.micLocked,
      audioIssue: isTechnicalIssue(participant.audioIssueAt, now),
      joinedAt: participant.joinedAt,
      presentMs: participant.joinedAt ? Math.max(0, now - participant.joinedAt.getTime()) : 0,
      speakingMs,
      words: mine.reduce((sum, s) => sum + s.wordCount, 0),
      contributions: mine.length,
      meaningfulContributions,
      averageTurnMs: mine.length > 0 ? Math.round(speakingMs / mine.length) : 0,
      averageRelevance:
        scored.length > 0
          ? round1(scored.reduce((sum, s) => sum + (s.relevanceScore ?? 0), 0) / scored.length)
          : null,
      lastSpokeAt,
      lastAudioAt: participant.lastAudioAt,
      speaking: isAudioActive(participant.speakingSince, participant.lastAudioAt, now),
      invitedCount: participant.invitedCount,
      answeredInvites: participant.answeredInviteCount,
      unansweredInvites: participant.unansweredInviteCount,
      passCount: participant.passCount,
      lastInvitedAt: participant.lastInvitedAt,
      transcribing: isTranscribing(participant.transcribingAt, now),
      score: 0,
    } satisfies ParticipationRow;
  });

  const context: ParticipationContext = {
    totalSpeakingMs,
    speakerCount,
    maxMeaningful: base.reduce((max, row) => Math.max(max, row.meaningfulContributions), 0),
  };

  // The score depends on the context, so it is filled in once the context is known.
  const rows = base.map((row) => ({ ...row, score: participationScore(row, context) }));

  return { rows, context };
}

/** Loads the tracker's inputs from the database and builds the snapshot. */
export async function loadParticipation(
  discussionId: string,
  now: number = Date.now(),
): Promise<ParticipationSnapshot> {
  const [participants, segments] = await Promise.all([
    prisma.discussionParticipant.findMany({
      where: { discussionId },
      orderBy: [{ isHost: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        displayName: true,
        isHost: true,
        seatNumber: true,
        joinedAt: true,
        leftAt: true,
        removed: true,
        micLocked: true,
        lastAudioAt: true,
        speakingSince: true,
        invitedCount: true,
        answeredInviteCount: true,
        unansweredInviteCount: true,
        passCount: true,
        lastInvitedAt: true,
        audioIssueAt: true,
        transcribingAt: true,
      },
    }),
    prisma.transcriptSegment.findMany({
      where: { discussionId },
      orderBy: { startedAt: "asc" },
      select: {
        participantId: true,
        durationMs: true,
        wordCount: true,
        relevance: true,
        relevanceScore: true,
        startedAt: true,
      },
    }),
  ]);

  return buildParticipation({ participants, segments }, now);
}

// ---------------------------------------------------------------------------
// Technical difficulties
// ---------------------------------------------------------------------------

/** True while an audio failure is recent enough to still excuse a silence. */
export function isTechnicalIssue(audioIssueAt: Date | null, now: number): boolean {
  if (!audioIssueAt) return false;
  return now - audioIssueAt.getTime() <= TECHNICAL_COOLDOWN_MS;
}

/** True while a browser's "I am transcribing" report is still fresh. */
export function isTranscribing(transcribingAt: Date | null, now: number): boolean {
  if (!transcribingAt) return false;
  return now - transcribingAt.getTime() <= TRANSCRIBING_FRESH_MS;
}

/**
 * Reads a participant's sentence for the two things a moderator must react to:
 * a polite request to be excused, and a report of an audio problem.
 *
 * This runs over speech-to-text output, which arrives without reliable
 * punctuation, so the patterns are deliberately tolerant. A technical report is
 * checked first: "sorry, my mic isn't working" must never be read as a pass.
 */
export function classifyParticipantResponse(text: string): "pass" | "technical" | null {
  const value = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!value) return null;

  if (TECHNICAL_PATTERNS.some((pattern) => pattern.test(value))) return "technical";
  if (PASS_PATTERNS.some((pattern) => pattern.test(value))) return "pass";
  return null;
}

const TECHNICAL_PATTERNS: RegExp[] = [
  /\bi (?:can(?:'|no)?t|cannot) hear\b/,
  /\bmy (?:mic|mike|microphone|audio|sound)\b[^.]{0,24}\b(?:not|isn'?t|stopped|broken|dead|fail|working)\b/,
  /\b(?:mic|mike|microphone|audio|connection|internet|network)\s+(?:issue|problem|trouble|drop|died)\b/,
  /\b(?:breaking up|cutting out|can you hear me|you'?re frozen)\b/,
];

const PASS_PATTERNS: RegExp[] = [
  /\bi(?:\s*(?:'d|would))?\s*(?:like|want|prefer)\s+to\s+pass\b/,
  /\bi(?:\s*(?:'ll|will))?\s*(?:pass|skip)\b/,
  /\bpass for now\b/,
  /\bpass(?:ing)? on (?:this|that|it)\b/,
  /\bskip me\b/,
  /\bi(?:\s*(?:'ll|will))?\s*sit\s+(?:this|it)\s+out\b/,
  /\bnothing (?:more|else) (?:to add|from me)\b/,
  /\bno (?:thanks|comment|input|thoughts)\b/,
];

// ---------------------------------------------------------------------------
// Invitation eligibility and selection
// ---------------------------------------------------------------------------

export type EligibilityReason =
  | "eligible"
  | "host"
  | "not-present"
  | "microphone-locked"
  | "technical-issue"
  | "currently-speaking"
  | "already-invited-this-round"
  | "recently-invited"
  | "passed-recently";

export type Eligibility = { eligible: boolean; reason: EligibilityReason };

/**
 * Whether the moderator may offer this participant the floor.
 *
 * Every exclusion is a circumstance, not a judgement: the moderator does not
 * press somebody who has just declined, does not talk over somebody who has the
 * floor, and does not ask somebody whose microphone is broken.
 */
export function invitationEligibility(
  row: ParticipationRow,
  opts: { now: number; excludeIds?: ReadonlySet<string> } ,
): Eligibility {
  if (opts.excludeIds?.has(row.participantId)) {
    return { eligible: false, reason: "already-invited-this-round" };
  }
  if (row.isHost) return { eligible: false, reason: "host" };
  if (!row.present) return { eligible: false, reason: "not-present" };
  if (row.micLocked) return { eligible: false, reason: "microphone-locked" };
  if (row.speaking) return { eligible: false, reason: "currently-speaking" };
  if (row.audioIssue) return { eligible: false, reason: "technical-issue" };

  if (row.lastInvitedAt && opts.now - row.lastInvitedAt.getTime() < passCooldown(row)) {
    return {
      eligible: false,
      reason: row.passCount > 0 && row.invitedCount === row.passCount ? "passed-recently" : "recently-invited",
    };
  }
  if (row.lastInvitedAt && opts.now - row.lastInvitedAt.getTime() < INVITATION_COOLDOWN_MS) {
    return { eligible: false, reason: "recently-invited" };
  }

  return { eligible: true, reason: "eligible" };
}

/** A participant who passed recently is left alone for longer than an ordinary cooldown. */
function passCooldown(row: ParticipationRow): number {
  return row.passCount > row.answeredInvites ? PASS_COOLDOWN_MS : 0;
}

/**
 * How much a participant has spoken, per minute of their time in the room.
 *
 * This is the primary fairness key: it compares like with like, so somebody who
 * arrived late and has been contributing is not mistaken for a quiet member and
 * somebody who has been present throughout but silent is picked up.
 */
export function speakingRate(row: ParticipationRow): number {
  return row.speakingMs / Math.max(row.presentMs, MIN_PRESENCE_FLOOR_MS);
}

/**
 * Ranked candidates for the next invitation, most deserving first.
 *
 * The ordering, in priority order:
 *   1. lowest speaking rate per minute present — the fairest measure of who has
 *      contributed least, and the one that does not punish a late arrival;
 *   2. fewest relevant contributions;
 *   3. fewest invitations so far, so the same person is not asked repeatedly;
 *   4. longest since they were last invited;
 *   5. seat order, purely so the result is stable when everything else ties.
 */
export function rankInviteCandidates(
  rows: ParticipationRow[],
  opts: { now: number; excludeIds?: ReadonlySet<string> },
): ParticipationRow[] {
  return rows
    .filter((row) => invitationEligibility(row, opts).eligible)
    .sort((a, b) => {
      const rate = speakingRate(a) - speakingRate(b);
      if (Math.abs(rate) > 0.0005) return rate;

      if (a.meaningfulContributions !== b.meaningfulContributions) {
        return a.meaningfulContributions - b.meaningfulContributions;
      }
      if (a.invitedCount !== b.invitedCount) return a.invitedCount - b.invitedCount;

      const aInvited = a.lastInvitedAt?.getTime() ?? 0;
      const bInvited = b.lastInvitedAt?.getTime() ?? 0;
      if (aInvited !== bInvited) return aInvited - bInvited;

      return seatOrder(a) - seatOrder(b);
    });
}

/** The single best candidate, or null when nobody should be asked. */
export function pickInviteCandidate(
  rows: ParticipationRow[],
  opts: { now: number; excludeIds?: ReadonlySet<string> },
): ParticipationRow | null {
  return rankInviteCandidates(rows, opts)[0] ?? null;
}

function seatOrder(row: ParticipationRow): number {
  return typeof row.seatNumber === "number" ? row.seatNumber : Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// Live participation score
// ---------------------------------------------------------------------------

/**
 * The live participation score, 0–100, shown on the dashboard while the
 * discussion runs. The final grade is produced separately from the transcript;
 * this number exists so participants and the host can see how the discussion is
 * balancing out in real time.
 *
 * Composition, and why:
 *   - 40% content — relevant contributions relative to the room's most
 *     prolific contributor. Word count and speaking time are deliberately not
 *     used here, so rambling scores no better than a concise point.
 *   - 25% relevance — the average live relevance verdict for the participant.
 *     A participant with nothing scored yet sits at the neutral midpoint rather
 *     than being marked down before they have been assessed.
 *   - 20% balance — speaking share against an equal share of the room. This is
 *     the only place talking time counts at all, and it is capped: past a fair
 *     share, speaking more adds nothing.
 *   - 15% responsiveness — how they answered invitations. Passing counts as
 *     answering: it is a response, and it is respected. Only repeated silence
 *     lowers this.
 *
 * Repeatedly ignoring invitations costs 3% per invitation beyond the first,
 * capped at 10%. Nothing else is deducted: no penalty exists for listening, for
 * thinking, for joining late, for a locked or broken microphone, or for taking
 * a pass.
 */
export function participationScore(row: ParticipationRow, context: ParticipationContext): number {
  const content = context.maxMeaningful > 0 ? Math.min(1, row.meaningfulContributions / context.maxMeaningful) : 0;
  const relevance = row.averageRelevance === null ? 0.5 : Math.min(1, Math.max(0, row.averageRelevance / 100));

  const equalShareMs = context.speakerCount > 0 ? context.totalSpeakingMs / context.speakerCount : 0;
  const balance = equalShareMs > 0 ? Math.min(1, row.speakingMs / equalShareMs) : 0;

  const answered = row.answeredInvites + row.passCount;
  const responsiveness = row.invitedCount === 0 ? 1 : Math.min(1, answered / row.invitedCount);

  const raw = content * 40 + relevance * 25 + balance * 20 + responsiveness * 15;
  const ignoredPenalty = Math.min(10, Math.max(0, row.unansweredInvites - 1) * 3);

  return Math.max(0, Math.round((raw - ignoredPenalty) * 10) / 10);
}
