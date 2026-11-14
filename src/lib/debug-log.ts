/**
 * Opt-in diagnostics for the capture → speech-to-text → database pipeline.
 *
 * The pipeline spans several browsers and the server, and every stage can fail
 * quietly: a participant may not have consented, their microphone may be off,
 * their browser may not implement speech recognition, or the server may reject
 * a chunk it considers empty or a duplicate. Without a trace there is no way to
 * tell those apart from the outside — which is exactly how "only my own
 * transcript appears" becomes impossible to explain.
 *
 * Off by default and silent when off, so it costs nothing in production. Turn
 * it on with `TRANSCRIPT_DEBUG=1` on the server and
 * `NEXT_PUBLIC_TRANSCRIPT_DEBUG=1` for the browser build.
 *
 * Every line is prefixed with the speaker's identity where one is known, so a
 * log read from the server shows which participant produced which chunk.
 */

const clientEnabled = process.env.NEXT_PUBLIC_TRANSCRIPT_DEBUG === "1";

function enabled(): boolean {
  if (typeof window === "undefined") return process.env.TRANSCRIPT_DEBUG === "1";
  return clientEnabled;
}

function emit(level: "info" | "warn", message: string, detail?: Record<string, unknown>): void {
  if (!enabled()) return;
  if (detail) console[level](`[transcript] ${message}`, detail);
  else console[level](`[transcript] ${message}`);
}

/** A step completed as expected. */
export function transcriptLog(message: string, detail?: Record<string, unknown>): void {
  emit("info", message, detail);
}

/** A step was skipped, rejected or failed. */
export function transcriptWarn(message: string, detail?: Record<string, unknown>): void {
  emit("warn", message, detail);
}
