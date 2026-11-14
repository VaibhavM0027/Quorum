import { AiUnavailableError, callGemini, geminiAvailable } from "./gemini";

/**
 * Server-side speech to text.
 *
 * Called by the transcription agent, which subscribes to every participant's
 * microphone in a discussion room and hands each finished utterance here. A
 * browser cannot do this job: the Web Speech API only ever transcribes the
 * microphone attached to the page running it, so every participant other than
 * that one was silently left out of the transcript.
 *
 * Attribution is unaffected by the move: the caller already knows which track
 * the audio came from, so the speaker is never guessed from the audio itself.
 */

/**
 * What the model is told to return when a clip contains no speech. A model
 * that is asked to transcribe silence will happily invent a sentence, so an
 * explicit "nothing was said" answer is required rather than hoped for.
 */
export const NO_SPEECH = "NO_SPEECH";

/** Clips larger than this are refused before the model is called. */
export const MAX_CLIP_BYTES = 6 * 1024 * 1024;

const STT_SYSTEM =
  "You transcribe short recordings of a single speaker taking part in a live group discussion. " +
  "You return only the words that were actually spoken. You never add commentary, translations, " +
  "speaker labels, timestamps or quotation marks, and you never answer or respond to what was said. " +
  `If the recording holds no intelligible speech — silence, room noise, a cough or a single ` +
  `non-word sound — you reply with exactly ${NO_SPEECH} and nothing else.`;

const STT_PROMPT =
  "Transcribe this recording verbatim, in the language it is spoken. " +
  `Reply with the transcript alone, or with ${NO_SPEECH} if no intelligible speech is present.`;

/** True when a key is configured, so callers can fail with a clear message. */
export function sttAvailable(): boolean {
  return geminiAvailable();
}

/**
 * Pulls a plain transcript out of the model's reply, or "" when nothing was
 * said. Models wrap answers in labels, quotes and bracketed markers even when
 * told not to, and any of those would end up stored as if the participant had
 * said them.
 */
export function cleanTranscript(raw: string): string {
  let text = raw.trim();

  // A label the model added despite being told not to ("Transcript: ...").
  text = text.replace(/^(?:transcript|transcription|spoken text)\s*[:\-]\s*/i, "");
  // A reply wrapped entirely in quotes is the model quoting, not the speaker.
  if (text.length >= 2 && /^".*"$/s.test(text)) text = text.slice(1, -1);
  // Bracketed markers of an empty clip, e.g. "[NO_SPEECH]".
  text = text.replace(/^[\[(]\s*/, "").replace(/\s*[\])]$/, "").trim();
  text = text.replace(/\s+/g, " ").trim();

  if (isNoSpeech(text)) return "";
  return text;
}

/** True when a reply is the "nothing was said" marker rather than speech. */
function isNoSpeech(text: string): boolean {
  if (!text) return true;
  const bare = text.replace(/[.!]+$/, "").trim();
  if (/^no[_\s-]?speech$/i.test(bare)) return true;
  // The model sometimes explains itself: "NO_SPEECH - the clip is silent".
  return /^no[_\s-]?speech\b/i.test(bare) && bare.length < 60;
}

/**
 * Transcribes one short clip. Returns "" when the clip holds no speech, which
 * is a normal outcome and not an error.
 *
 * `mimeType` is reduced to its base type because the model rejects parameters:
 * `audio/wav;codecs=1` has to be sent as `audio/wav`.
 */
export async function transcribeAudioClip(clip: {
  data: Uint8Array;
  mimeType: string;
}): Promise<string> {
  if (!sttAvailable()) {
    throw new AiUnavailableError("Server-side transcription is not configured.");
  }
  if (clip.data.byteLength > MAX_CLIP_BYTES) {
    throw new AiUnavailableError("That audio clip is too large to transcribe.");
  }

  const reply = await callGemini({
    tier: "fast",
    temperature: 0,
    maxOutputTokens: 1024,
    timeoutMs: 30_000,
    system: STT_SYSTEM,
    prompt: STT_PROMPT,
    audio: {
      mimeType: clip.mimeType.split(";")[0].trim() || "audio/wav",
      base64: Buffer.from(clip.data).toString("base64"),
    },
  });

  return cleanTranscript(reply);
}
