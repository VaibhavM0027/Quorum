import { encodeWav, peakAmplitude } from "@/lib/wav";

/**
 * Turns one participant's live audio into utterances.
 *
 * The transcription model takes a clip, not a stream, so somebody has to decide
 * where one spoken turn ends and the next begins. That decision is made here,
 * per participant and never across participants: each speaker has their own
 * segmenter, so two people talking over each other produce two independent
 * utterances rather than one mixed, unattributable clip.
 *
 * Pure and free of LiveKit types so the boundaries — start of speech, end of
 * silence, the shortest click worth keeping, the longest monologue — can be
 * asserted in a test rather than only observed on a live call.
 */

/** Peak amplitude above which a block counts as speech rather than room tone. */
export const SPEECH_PEAK = 0.02;

/** Quiet stretch that closes an utterance. */
export const END_SILENCE_MS = 900;

/** Clicks and blips shorter than this are not speech and are discarded. */
export const MIN_UTTERANCE_MS = 350;

/** A long monologue is flushed in pieces so the transcript stays near-live. */
export const MAX_UTTERANCE_MS = 15_000;

/** One finished utterance, already encoded as the clip the model receives. */
export type Utterance = {
  /** Mono PCM16 WAV, the one container every browser-independent decoder accepts. */
  wav: Uint8Array<ArrayBuffer>;
  sampleRate: number;
  /** Wall-clock moment the first voiced block arrived. */
  startedAt: Date;
  /** Wall-clock moment the speaker was last heard. */
  endedAt: Date;
  /** Milliseconds actually spent speaking, excluding the trailing silence. */
  durationMs: number;
};

/**
 * Downmixes an interleaved 16-bit frame to mono floats in −1..1, the shape
 * `encodeWav` and the amplitude check both expect.
 *
 * Stereo is averaged rather than truncated to one channel: a participant on a
 * headset can be almost silent on the right channel, and dropping it would
 * halve their level for no reason.
 */
export function int16ToMonoFloat(data: Int16Array, channels: number): Float32Array {
  if (channels <= 1) {
    const mono = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 1) mono[i] = data[i] / 0x8000;
    return mono;
  }

  const frames = Math.floor(data.length / channels);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += data[frame * channels + channel];
    mono[frame] = sum / channels / 0x8000;
  }
  return mono;
}

/**
 * Splits one participant's microphone audio into utterances.
 *
 * One instance belongs to one audio track. Feeding it samples from a second
 * speaker would defeat the whole point — the clip would contain two voices and
 * could only be attributed to one of them.
 */
export class UtteranceSegmenter {
  private readonly sampleRate: number;
  private chunks: Float32Array[] = [];
  private voicedMs = 0;
  private silenceMs = 0;
  private speaking = false;
  private startedAtMs = 0;
  private lastVoicedAtMs = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate > 0 ? sampleRate : 48_000;
  }

  /**
   * Adds one block of mono samples.
   *
   * Returns a finished utterance when this block closed one — on silence, or
   * because a monologue hit the length cap — and null otherwise.
   *
   * `nowMs` is passed in rather than read from the clock so the boundaries are
   * deterministic in a test.
   */
  push(samples: Float32Array, nowMs: number = Date.now()): Utterance | null {
    const blockMs = (samples.length / this.sampleRate) * 1000;
    const peak = peakAmplitude(samples);

    if (peak >= SPEECH_PEAK) {
      if (!this.speaking) {
        this.speaking = true;
        this.startedAtMs = nowMs;
        this.chunks = [];
        this.voicedMs = 0;
        this.silenceMs = 0;
      }
      this.chunks.push(samples);
      this.voicedMs += blockMs;
      this.lastVoicedAtMs = nowMs;
      this.silenceMs = 0;
      return this.voicedMs >= MAX_UTTERANCE_MS ? this.take() : null;
    }

    if (!this.speaking) return null;

    // Trailing quiet is kept in the clip — it helps the model — but is not
    // counted as time the participant spent speaking.
    this.chunks.push(samples);
    this.silenceMs += blockMs;
    return this.silenceMs >= END_SILENCE_MS ? this.take() : null;
  }

  /**
   * Ends an utterance in progress without waiting for the silence timeout.
   *
   * Called when the audio stops arriving for a reason other than silence — the
   * track was unsubscribed, the microphone was muted, the participant left or
   * the call ended. Without this, the participant's last sentence would be
   * discarded exactly when their connection hiccuped.
   */
  flush(): Utterance | null {
    return this.speaking ? this.take() : null;
  }

  /** True while a turn is being assembled; used only for diagnostics. */
  get inProgress(): boolean {
    return this.speaking;
  }

  /** Closes the current utterance, keeping it only if it held real speech. */
  private take(): Utterance | null {
    const chunks = this.chunks;
    const voicedMs = this.voicedMs;
    const startedAt = this.startedAtMs;
    const finalizedAt = this.lastVoicedAtMs;

    this.speaking = false;
    this.chunks = [];
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.startedAtMs = 0;
    this.lastVoicedAtMs = 0;

    if (voicedMs < MIN_UTTERANCE_MS || chunks.length === 0) return null;

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }

    return {
      wav: encodeWav(samples, this.sampleRate),
      sampleRate: this.sampleRate,
      startedAt: new Date(startedAt),
      endedAt: new Date(finalizedAt),
      durationMs: Math.round(voicedMs),
    };
  }
}
