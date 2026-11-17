import {
  geminiAvailable,
  transcribeAudioDetailedWithGemini,
  transcribeAudioWithGemini,
} from "@/lib/gemini";

/**
 * Provider abstraction for Speech-to-Text (STT).
 *
 * All live transcription (whether fed from the server-side LiveKit room
 * subscriber or from participant browser audio streams) goes through this
 * interface so the underlying STT provider (Gemini, Deepgram, Whisper, Google
 * Cloud Speech, etc.) can be swapped in one place without rewriting the room
 * or pipeline logic.
 */

export interface SttTranscribeInput {
  audioBase64: string;
  mimeType: string;
  language?: string;
  promptHint?: string;
}

export interface SttTranscribeResult {
  text: string;
  confidence: number | null;
}

export interface SttProvider {
  readonly name: string;
  isAvailable(): boolean;
  transcribe(input: SttTranscribeInput): Promise<string>;
  transcribeDetailed?(input: SttTranscribeInput): Promise<SttTranscribeResult>;
}

class GeminiSttProvider implements SttProvider {
  readonly name = "gemini";

  isAvailable(): boolean {
    return geminiAvailable();
  }

  async transcribe(input: SttTranscribeInput): Promise<string> {
    return transcribeAudioWithGemini({
      audioBase64: input.audioBase64,
      mimeType: input.mimeType,
      language: input.language,
    });
  }

  async transcribeDetailed(input: SttTranscribeInput): Promise<SttTranscribeResult> {
    return transcribeAudioDetailedWithGemini({
      audioBase64: input.audioBase64,
      mimeType: input.mimeType,
      language: input.language,
    });
  }
}

let activeProvider: SttProvider = new GeminiSttProvider();

/** Returns the configured Speech-to-Text provider. */
export function getSttProvider(): SttProvider {
  return activeProvider;
}

/** Allows swapping or mocking the STT provider in tests or deployments. */
export function setSttProvider(provider: SttProvider): void {
  activeProvider = provider;
}
