/**
 * Transcript helpers.
 *
 * Live transcription is produced by the transcription agent, which subscribes to
 * every participant's microphone and reads each track on its own. A speaker is
 * therefore always known from the track the words arrived on, never guessed from
 * the audio.
 */

/** Collapses whitespace and trims a spoken chunk. */
export function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Counts words in a transcript chunk. */
export function countWords(text: string): number {
  const matches = normalizeTranscript(text).match(/\S+/g);
  return matches ? matches.length : 0;
}

/** True when a text chunk carries no actual spoken content. */
export function isMeaningful(text: string): boolean {
  return countWords(text) > 0;
}

/** Minimum words a chunk needs before it is worth storing. */
export const MIN_SEGMENT_WORDS = 1;

/**
 * The same words can reach the store twice: a recognition pass that has to
 * restart, or a track the agent re-attaches to around a mute or a reconnect, can
 * redeliver the tail of an utterance it had already finished. Storing it twice
 * would double-count the participant's speaking time and skew the AI's reading
 * of the discussion, so an identical chunk arriving this soon after the previous
 * one is treated as the same utterance.
 */
export const DUPLICATE_WINDOW_MS = 5000;

/** The stored shape the duplicate check needs from the previous chunk. */
export type StoredSegment = { text: string; startedAt: Date };

/** True when a chunk is a re-delivered copy of the participant's previous one. */
export function isDuplicateSegment(
  previous: StoredSegment | null | undefined,
  text: string,
  startedAt: Date,
  windowMs: number = DUPLICATE_WINDOW_MS,
): boolean {
  if (!previous) return false;
  if (previous.text !== text) return false;
  return Math.abs(startedAt.getTime() - previous.startedAt.getTime()) < windowMs;
}

// ---------------------------------------------------------------------------
// Participation totals
// ---------------------------------------------------------------------------

/** How much one participant has said, summed over every stored chunk. */
export type SpeakingTotal = {
  /** Milliseconds actually spent talking; the fairest measure of a share. */
  durationMs: number;
  words: number;
  contributions: number;
};

/** The part of a stored segment the totals need. */
export type SpeakingSegment = {
  participantId: string;
  durationMs: number;
  wordCount: number;
};

/** Sums the transcript into one entry per participant who has spoken. */
export function speakingTotals(
  segments: SpeakingSegment[],
): Map<string, SpeakingTotal> {
  const totals = new Map<string, SpeakingTotal>();
  for (const segment of segments) {
    const entry = totals.get(segment.participantId) ?? {
      durationMs: 0,
      words: 0,
      contributions: 0,
    };
    entry.durationMs += segment.durationMs;
    entry.words += segment.wordCount;
    entry.contributions += 1;
    totals.set(segment.participantId, entry);
  }
  return totals;
}

/** The candidate a moderator can hand the floor to. */
export type SpokenCandidate = {
  id: string;
  seatNumber?: number | null;
};

/**
 * Whoever has spoken least so far — the natural person to bring in when the
 * room falls silent. Someone who has never spoken has zero speaking time, so
 * they are chosen first; among the rest the shortest talking time wins, and
 * ties fall back to a lower total word count, then to seat order. Returns null
 * only when there is nobody to ask.
 */
export function leastSpokenParticipant<C extends SpokenCandidate>(
  candidates: C[],
  totals: Map<string, SpeakingTotal>,
): C | null {
  let best: C | null = null;
  let bestTotal: SpeakingTotal = { durationMs: 0, words: 0, contributions: 0 };

  for (const candidate of candidates) {
    const total = totals.get(candidate.id) ?? { durationMs: 0, words: 0, contributions: 0 };
    if (!best) {
      best = candidate;
      bestTotal = total;
      continue;
    }

    const better =
      total.durationMs < bestTotal.durationMs ||
      (total.durationMs === bestTotal.durationMs && total.words < bestTotal.words) ||
      (total.durationMs === bestTotal.durationMs &&
        total.words === bestTotal.words &&
        seatOrder(candidate) < seatOrder(best));

    if (better) {
      best = candidate;
      bestTotal = total;
    }
  }

  return best;
}

/** Seat number for tie-breaking; a missing seat sorts last. */
function seatOrder(candidate: SpokenCandidate): number {
  return typeof candidate.seatNumber === "number" ? candidate.seatNumber : Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// Transcript export
// ---------------------------------------------------------------------------

/**
 * One stored transcript entry, flattened for export. Every field the stored
 * segment carries is present, so a downloaded transcript is the record itself
 * rather than a summary of it.
 */
export type TranscriptExportRow = {
  discussionId: string;
  userId: string;
  studentName: string;
  startedAt: Date;
  endedAt: Date;
  text: string;
  durationMs: number;
  wordCount: number;
};

/** Header row of the transcript export, in the order the fields are stored. */
export const TRANSCRIPT_CSV_COLUMNS = [
  "Session ID",
  "Student ID",
  "Student name",
  "Start timestamp",
  "End timestamp",
  "Transcript text",
  "Speaking duration (ms)",
  "Word count",
] as const;

/** Quotes a field only when it contains a delimiter, a quote or a newline. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialises stored transcript entries as CSV (RFC 4180). Spoken text routinely
 * contains commas and quotes, so every field goes through the same escaping
 * rule rather than a special case for the text column.
 */
export function transcriptToCsv(rows: TranscriptExportRow[]): string {
  const lines = [TRANSCRIPT_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.discussionId,
        row.userId,
        row.studentName,
        row.startedAt.toISOString(),
        row.endedAt.toISOString(),
        row.text,
        String(row.durationMs),
        String(row.wordCount),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // A trailing newline keeps concatenated exports valid and diff-friendly.
  return `${lines.join("\r\n")}\r\n`;
}
