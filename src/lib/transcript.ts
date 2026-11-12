/**
 * Transcript helpers.
 *
 * Live transcription is produced by the browser's Web Speech API: every
 * participant's own browser transcribes that participant's microphone. That
 * makes speaker attribution exact (a browser only ever hears its own speaker),
 * so no audio ever leaves the participant's machine for transcription.
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
