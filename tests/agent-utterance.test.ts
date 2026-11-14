import { describe, expect, it } from "vitest";
import {
  END_SILENCE_MS,
  int16ToMonoFloat,
  MAX_UTTERANCE_MS,
  MIN_UTTERANCE_MS,
  UtteranceSegmenter,
} from "@/agent/utterance";

/** 16 kHz mono, so a 1600-sample block is exactly 100 ms. */
const RATE = 16_000;
const BLOCK = 1600;

function block(amplitude: number, length: number = BLOCK): Float32Array {
  return new Float32Array(length).fill(amplitude);
}

/** Feeds blocks at a fixed 100 ms cadence and collects every utterance. */
function feed(segmenter: UtteranceSegmenter, blocks: Array<[number, number]>) {
  const out = [];
  let now = 1_000_000;
  for (const [amplitude, count] of blocks) {
    for (let i = 0; i < count; i += 1) {
      const utterance = segmenter.push(block(amplitude), now);
      if (utterance) out.push(utterance);
      now += 100;
    }
  }
  return out;
}

describe("int16ToMonoFloat", () => {
  it("scales mono 16-bit samples into -1..1", () => {
    const mono = int16ToMonoFloat(new Int16Array([0, 32767, -32768]), 1);
    expect(mono[0]).toBe(0);
    expect(mono[1]).toBeCloseTo(1, 4);
    expect(mono[2]).toBeCloseTo(-1, 4);
  });

  it("averages stereo channels into a single mono stream", () => {
    // Left loud, right silent: averaging keeps half the level rather than
    // discarding the participant who is only on one channel.
    const mono = int16ToMonoFloat(new Int16Array([32767, 0, 0, 0]), 2);
    expect(mono.length).toBe(2);
    expect(mono[0]).toBeCloseTo(0.5, 4);
    expect(mono[1]).toBe(0);
  });
});

describe("UtteranceSegmenter", () => {
  it("emits nothing for a silent track", () => {
    const segmenter = new UtteranceSegmenter(RATE);
    expect(feed(segmenter, [[0, 50]])).toEqual([]);
  });

  it("discards a click shorter than the minimum utterance", () => {
    const segmenter = new UtteranceSegmenter(RATE);
    // 200 ms of sound — below MIN_UTTERANCE_MS — then silence to close it.
    expect(feed(segmenter, [[0.5, 2], [0, 20]])).toEqual([]);
  });

  it("emits one utterance per spoken turn, in order", () => {
    const segmenter = new UtteranceSegmenter(RATE);
    const utterances = feed(segmenter, [
      [0, 10],
      [0.5, 4], // 400 ms of speech
      [0, 20],
      [0.5, 6], // 600 ms of speech
      [0, 20],
    ]);

    expect(utterances).toHaveLength(2);
    expect(utterances[0].durationMs).toBe(400);
    expect(utterances[1].durationMs).toBe(600);
    expect(utterances[0].endedAt.getTime()).toBeLessThan(utterances[1].startedAt.getTime());
  });

  it("keeps the trailing silence in the clip but not in the speaking time", () => {
    const segmenter = new UtteranceSegmenter(RATE);
    const [utterance] = feed(segmenter, [[0.5, 4], [0, 20]]);

    // 400 ms voiced plus END_SILENCE_MS of quiet, and the clip carries both.
    expect(utterance.durationMs).toBe(400);
    const clipMs = ((utterance.wav.byteLength - 44) / 2 / RATE) * 1000;
    expect(clipMs).toBeCloseTo(400 + END_SILENCE_MS, 0);
  });

  it("writes a WAV the decoder can read", () => {
    const segmenter = new UtteranceSegmenter(RATE);
    const [utterance] = feed(segmenter, [[0.5, 4], [0, 20]]);

    const view = new DataView(utterance.wav.buffer);
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(utterance.sampleRate).toBe(RATE);
  });

  it("flushes a monologue at the length cap instead of waiting for silence", () => {
    const segmenter = new UtteranceSegmenter(RATE);
    const blocks = MAX_UTTERANCE_MS / 100;
    const utterances = feed(segmenter, [[0.5, blocks + 5]]);

    expect(utterances).toHaveLength(1);
    expect(utterances[0].durationMs).toBe(MAX_UTTERANCE_MS);
  });

  it("emits the in-progress turn when the audio stops mid-sentence", () => {
    const segmenter = new UtteranceSegmenter(RATE);
    let now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      expect(segmenter.push(block(0.5), now)).toBeNull();
      now += 100;
    }
    expect(segmenter.inProgress).toBe(true);

    // The track went away before the silence timeout could fire.
    const utterance = segmenter.flush();
    expect(utterance).not.toBeNull();
    expect(utterance!.durationMs).toBe(500);
    expect(segmenter.inProgress).toBe(false);
    expect(segmenter.flush()).toBeNull();
  });

  it("treats a level below the speech floor as silence", () => {
    const segmenter = new UtteranceSegmenter(RATE);
    // Room tone, never loud enough to open an utterance.
    expect(feed(segmenter, [[0.01, 40]])).toEqual([]);
  });

  it("keeps utterances shorter than the cap when they close on silence", () => {
    const segmenter = new UtteranceSegmenter(RATE);
    const utterances = feed(segmenter, [[0.5, 10], [0, 20]]);
    expect(utterances).toHaveLength(1);
    expect(utterances[0].durationMs).toBe(1000);
    expect(utterances[0].durationMs).toBeGreaterThan(MIN_UTTERANCE_MS);
  });
});
