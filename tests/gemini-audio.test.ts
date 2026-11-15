import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    geminiKey: "test-key-not-real",
    geminiBaseUrl: "https://generativelanguage.googleapis.com",
    geminiFastModel: "gemini-audio-test",
    geminiSmartModel: "gemini-audio-test",
    aiEnabled: false,
  },
}));

import {
  encodePcmWav,
  isSpeechFrame,
  normalizeChunkDurationMs,
  shouldFinalizeAudioBuffer,
} from "@/hooks/useGeminiTranscription";
import { transcribeAudioWithGemini } from "@/lib/gemini";

describe("transcript audio metadata", () => {
  it("rounds fractional capture durations and keeps them within the utterance safety cap", () => {
    expect(normalizeChunkDurationMs(2400.5)).toBe(2401);
    expect(normalizeChunkDurationMs(0.2)).toBe(1);
    expect(normalizeChunkDurationMs(45_500)).toBe(45_000);
  });

  it("uses adaptive energy and speaker activity to reject low-level background noise", () => {
    expect(isSpeechFrame(0.006, 0.004, false)).toBe(false);
    expect(isSpeechFrame(0.02, 0.004, false)).toBe(true);
    expect(isSpeechFrame(0.006, 0.004, true)).toBe(true);
  });

  it("buffers through natural pauses and only splits continuous speech at the safety cap", () => {
    expect(shouldFinalizeAudioBuffer(30_000, 0)).toBe(false);
    expect(shouldFinalizeAudioBuffer(5_000, 1_199)).toBe(false);
    expect(shouldFinalizeAudioBuffer(5_000, 1_200)).toBe(true);
    expect(shouldFinalizeAudioBuffer(45_000, 0)).toBe(true);
  });
});

describe("PCM WAV encoding", () => {
  it("creates a valid 16 kHz mono WAV without decoding a browser recording", async () => {
    const wav = encodePcmWav(new Float32Array([-1, 0, 1]), 16_000);
    const bytes = new DataView(await wav.arrayBuffer());

    expect(wav.type).toBe("audio/wav");
    expect(String.fromCharCode(...new Uint8Array(bytes.buffer, 0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...new Uint8Array(bytes.buffer, 8, 4))).toBe("WAVE");
    expect(bytes.getUint32(24, true)).toBe(16_000);
    expect(bytes.getUint32(40, true)).toBe(6);
    expect([0, 1, 2].map((index) => bytes.getInt16(44 + index * 2, true))).toEqual([
      -32_768,
      0,
      32_767,
    ]);
  });

  it("averages samples when downsampling microphone audio to reduce aliasing", async () => {
    const wav = encodePcmWav(new Float32Array([0.3, 0.6, 0.9]), 48_000);
    const bytes = new DataView(await wav.arrayBuffer());

    expect(bytes.getUint32(40, true)).toBe(2);
    expect(bytes.getInt16(44, true)).toBe(Math.round(0.6 * 0x7fff));
  });
});

describe("Gemini audio transcription", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "  hello from audio  " }] } }],
          }),
          { status: 200 },
        ),
      ),
    );
  });

  it("sends the audio to Gemini with the server-side API key and returns normalized content", async () => {
    await expect(
      transcribeAudioWithGemini({
        audioBase64: "d2F2",
        mimeType: "audio/wav",
        language: "en-IN",
      }),
    ).resolves.toBe("hello from audio");

    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-audio-test:generateContent",
    );
    expect(new Headers(options.headers).get("x-goog-api-key")).toBe("test-key-not-real");
    const body = JSON.parse(String(options.body)) as {
      contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>;
    };
    expect(body.contents[0]?.parts[1]?.inlineData).toEqual({
      mimeType: "audio/wav",
      data: "d2F2",
    });
    expect(body.contents[0]?.parts[0]?.text).toContain("en-IN");
  });

  it("returns an empty transcript for audio without speech", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "[NO_SPEECH]" }] } }] }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      transcribeAudioWithGemini({ audioBase64: "d2F2", mimeType: "audio/wav" }),
    ).resolves.toBe("");
  });
});
