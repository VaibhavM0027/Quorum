import { describe, expect, it } from "vitest";
import { encodeWav, peakAmplitude } from "@/lib/wav";
import { cleanTranscript, MAX_CLIP_BYTES, NO_SPEECH } from "@/lib/stt";

/** Reads a little-endian ASCII tag out of the WAV header. */
function tag(view: DataView, offset: number): string {
  let text = "";
  for (let i = 0; i < 4; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
}

describe("encodeWav", () => {
  it("writes a canonical 44-byte PCM header", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const wav = encodeWav(samples, 16_000);
    const view = new DataView(wav.buffer);

    expect(wav.byteLength).toBe(44 + samples.length * 2);

    expect(tag(view, 0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(tag(view, 8)).toBe("WAVE");

    expect(tag(view, 12)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // PCM header length
    expect(view.getUint16(20, true)).toBe(1); // uncompressed PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000); // sample rate
    expect(view.getUint32(28, true)).toBe(16_000 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample

    expect(tag(view, 36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it("reports the sample rate it was given", () => {
    const wav = encodeWav(new Float32Array([0]), 48_000);
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(48_000);
  });

  it("clamps full-scale samples instead of wrapping them", () => {
    const wav = encodeWav(new Float32Array([-2, 2, 0]), 8_000);
    const view = new DataView(wav.buffer);

    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(0);
  });

  it("produces just a header for an empty clip", () => {
    const wav = encodeWav(new Float32Array(0), 16_000);
    expect(wav.byteLength).toBe(44);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0);
  });
});

describe("peakAmplitude", () => {
  it("returns the largest absolute sample", () => {
    expect(peakAmplitude(new Float32Array([0.1, -0.7, 0.3]))).toBeCloseTo(0.7);
  });

  it("returns 0 for silence", () => {
    expect(peakAmplitude(new Float32Array([0, 0, 0]))).toBe(0);
  });

  it("returns 0 for an empty buffer", () => {
    expect(peakAmplitude(new Float32Array(0))).toBe(0);
  });
});

describe("cleanTranscript", () => {
  it("keeps plain speech as-is", () => {
    expect(cleanTranscript("The policy should fund rural schools.")).toBe(
      "The policy should fund rural schools.",
    );
  });

  it("drops a label the model added", () => {
    expect(cleanTranscript("Transcript: we agree with that")).toBe("we agree with that");
    expect(cleanTranscript("Transcription - we agree with that")).toBe("we agree with that");
  });

  it("unwraps a wholly quoted reply", () => {
    expect(cleanTranscript('"we agree with that"')).toBe("we agree with that");
  });

  it("strips bracketed no-speech markers", () => {
    expect(cleanTranscript(`[${NO_SPEECH}]`)).toBe("");
    expect(cleanTranscript("(no speech)")).toBe("");
  });

  it("treats the bare marker as nothing said", () => {
    expect(cleanTranscript(NO_SPEECH)).toBe("");
    expect(cleanTranscript("no_speech.")).toBe("");
    expect(cleanTranscript("NO_SPEECH - the clip is silent")).toBe("");
  });

  it("collapses whitespace and trims", () => {
    expect(cleanTranscript("  hello    there \n friend ")).toBe("hello there friend");
  });

  it("returns an empty string for empty input", () => {
    expect(cleanTranscript("   ")).toBe("");
  });
});

describe("MAX_CLIP_BYTES", () => {
  it("is large enough for the longest clip the browser sends", () => {
    // 15 s of mono 16-bit audio at 48 kHz is well under the cap.
    expect(MAX_CLIP_BYTES).toBeGreaterThan(48_000 * 2 * 15);
  });
});
