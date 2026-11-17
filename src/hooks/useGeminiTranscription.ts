"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MAX_SEGMENT_DURATION_MS = 45_000;
const SILENCE_FINALIZE_MS = 1_200;
const PARTIAL_INTERVAL_MS = 3_000;
const PRE_ROLL_MS = 250;
const TARGET_SAMPLE_RATE = 16_000;
const MAX_PENDING_CHUNKS = 20;
const DEFAULT_LANG = process.env.NEXT_PUBLIC_SPEECH_LANG ?? "en-IN";

type AudioChunk = {
  audio: Blob;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  streamId: string;
  revision: number;
  mode: "partial" | "final";
};

type TranscriptionResponse = {
  error?: string;
  issues?: Array<{ path?: string; message?: string }>;
  retryAfterMs?: number;
  skipped?: string;
  text?: string;
  streamId?: string;
  revision?: number;
};

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

function createUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function encodePcmWav(sourceSamples: Float32Array, sourceSampleRate: number): Blob {
  const outputLength = Math.ceil((sourceSamples.length * TARGET_SAMPLE_RATE) / sourceSampleRate);
  const samples = new Int16Array(outputLength);
  const downsamplingRatio = sourceSampleRate / TARGET_SAMPLE_RATE;
  for (let i = 0; i < outputLength; i += 1) {
    let sample: number;
    if (downsamplingRatio > 1) {
      const start = i * downsamplingRatio;
      const end = Math.min((i + 1) * downsamplingRatio, sourceSamples.length);
      let weightedSum = 0;
      let weightTotal = 0;
      for (let index = Math.floor(start); index < end; index += 1) {
        const weight = Math.min(end, index + 1) - Math.max(start, index);
        weightedSum += (sourceSamples[index] ?? 0) * weight;
        weightTotal += weight;
      }
      sample = weightTotal > 0 ? weightedSum / weightTotal : 0;
    } else {
      const sourcePosition = i * downsamplingRatio;
      const sourceIndex = Math.floor(sourcePosition);
      const fraction = sourcePosition - sourceIndex;
      const left = sourceSamples[sourceIndex] ?? 0;
      const right = sourceSamples[sourceIndex + 1] ?? left;
      sample = left + (right - left) * fraction;
    }
    sample = Math.max(-1, Math.min(1, sample));
    samples[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  const bytesPerSample = 2;
  const wav = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(wav);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, wav.byteLength - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  write(36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * bytesPerSample, samples[i], true);
  }

  return new Blob([wav], { type: "audio/wav" });
}

export function normalizeChunkDurationMs(durationMs: number): number {
  return Math.max(1, Math.min(MAX_SEGMENT_DURATION_MS, Math.round(durationMs)));
}

export function isSpeechFrame(rms: number, noiseFloor: number, speaking: boolean): boolean {
  const threshold = Math.max(
    speaking ? 0.0025 : 0.008,
    noiseFloor * (speaking ? 1.1 : 1.5),
  );
  return rms >= threshold && (speaking || rms >= 0.015);
}

export function shouldFinalizeAudioBuffer(durationMs: number, silenceMs: number): boolean {
  return durationMs >= MAX_SEGMENT_DURATION_MS || silenceMs >= SILENCE_FINALIZE_MS;
}

export type AudioPartialEvent = {
  streamId: string;
  revision: number;
  text: string;
  startedAt: Date;
};

/**
 * Browser-independent continuous audio transcription hook.
 *
 * Uses standard Web Audio (`AudioContext` + WAV) instead of Chrome-only Web
 * Speech API so Chrome, Edge, Firefox, and Safari all produce identical,
 * speaker-attributed transcripts with rolling PARTIAL captions during long
 * speeches (30-60s) and seamless FINAL promotion on speech end.
 */
export function useGeminiTranscription({
  discussionId,
  enabled,
  audioTrack,
  speaking,
  language = DEFAULT_LANG,
  onStored,
  onPartial,
}: {
  discussionId: string;
  enabled: boolean;
  audioTrack: MediaStreamTrack | null;
  speaking: boolean;
  language?: string;
  onStored?: () => void;
  onPartial?: (partial: AudioPartialEvent) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const speakingRef = useRef(speaking);
  const onStoredRef = useRef(onStored);
  const onPartialRef = useRef(onPartial);
  const pendingRef = useRef<AudioChunk[]>([]);
  const postingRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const retryAfterRef = useRef(0);
  const flushRef = useRef<() => void>(() => {});

  speakingRef.current = speaking;
  onStoredRef.current = onStored;
  onPartialRef.current = onPartial;

  useEffect(() => {
    setSupported(typeof window !== "undefined" && getAudioContextConstructor() !== null);
  }, []);

  const flushPending = useCallback(async () => {
    if (postingRef.current || pendingRef.current.length === 0) return;
    postingRef.current = true;

    try {
      while (pendingRef.current.length > 0) {
        const chunk = pendingRef.current[0];
        const headers = new Headers({
          "content-type": chunk.audio.type,
          "x-transcript-started-at": chunk.startedAt.toISOString(),
          "x-transcript-ended-at": chunk.endedAt.toISOString(),
          "x-transcript-duration-ms": String(chunk.durationMs),
          "x-transcript-language": language,
          "x-transcript-stream-id": chunk.streamId,
          "x-transcript-revision": String(chunk.revision),
          "x-transcript-mode": chunk.mode,
        });
        const response = await fetch(`/api/discussions/${discussionId}/transcript`, {
          method: "POST",
          headers,
          body: chunk.audio,
        });
        const data = (await response.json().catch(() => ({}))) as TranscriptionResponse;
        if (!response.ok) {
          const details = data.issues
            ?.map((issue) => [issue.path, issue.message].filter(Boolean).join(": "))
            .filter(Boolean)
            .join("; ");
          setError(
            details
              ? `${data.error ?? "Validation failed"}: ${details}`
              : data.error ?? "Transcription could not be completed.",
          );
          if (chunk.mode === "partial") {
            // Drop stale failed partials cleanly; the final chunk will persist the full utterance.
            pendingRef.current.shift();
            continue;
          }
          if (response.status === 429) {
            retryAfterRef.current = Math.min(data.retryAfterMs ?? 0, 15_000);
            break;
          }
          if (response.status === 408 || response.status >= 500) break;
          pendingRef.current.shift();
          continue;
        }

        pendingRef.current.shift();
        retryAttemptRef.current = 0;
        setError(null);
        if (!data.skipped) {
          if (chunk.mode === "partial" && data.text) {
            setInterim(data.text);
            onPartialRef.current?.({
              streamId: chunk.streamId,
              revision: chunk.revision,
              text: data.text,
              startedAt: chunk.startedAt,
            });
          } else if (chunk.mode === "final") {
            setInterim("");
            onStoredRef.current?.();
          }
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Transcription could not be sent.");
    } finally {
      postingRef.current = false;
      if (pendingRef.current.length > 0 && !retryTimerRef.current) {
        const backoffMs = Math.min(1000 * 2 ** retryAttemptRef.current++, 15_000);
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          flushRef.current();
        }, Math.max(backoffMs, retryAfterRef.current));
        retryAfterRef.current = 0;
      }
    }
  }, [discussionId, language]);
  flushRef.current = () => {
    void flushPending();
  };

  const enqueue = useCallback((chunk: AudioChunk) => {
    // Avoid piling up stale partials behind queued final segments.
    if (chunk.mode === "partial" && pendingRef.current.some((c) => c.mode === "partial")) {
      return;
    }
    if (pendingRef.current.length >= MAX_PENDING_CHUNKS) {
      setError("Transcription queue is full; this audio chunk could not be queued. Check your connection.");
      return;
    }
    pendingRef.current.push(chunk);
    flushRef.current();
  }, []);

  useEffect(() => {
    const retryWhenOnline = () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      flushRef.current();
    };
    window.addEventListener("online", retryWhenOnline);
    return () => {
      window.removeEventListener("online", retryWhenOnline);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !audioTrack || !supported || audioTrack.readyState !== "live") {
      setListening(false);
      setInterim("");
      return;
    }

    let disposed = false;
    let firstSpeechAt: number | null = null;
    let silenceStartedAt: number | null = null;
    let lastPartialAt = 0;
    let streamId = createUuid();
    let revision = 0;
    let noiseFloor = 0.001;
    let sampleChunks: Float32Array[] = [];
    let sampleCount = 0;
    let preRollChunks: Float32Array[] = [];
    let preRollSampleCount = 0;
    const stream = new MediaStream([audioTrack]);
    const AudioContextCtor = getAudioContextConstructor();
    if (!AudioContextCtor) {
      setError("This browser does not support audio processing.");
      return;
    }

    let context: AudioContext;
    let source: MediaStreamAudioSourceNode;
    let processor: ScriptProcessorNode;
    let mutedOutput: GainNode;
    try {
      context = new AudioContextCtor();
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      mutedOutput = context.createGain();
      mutedOutput.gain.value = 0;
      source.connect(processor);
      processor.connect(mutedOutput);
      mutedOutput.connect(context.destination);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Microphone audio processing is unavailable.");
      return;
    }

    const buildSamples = () => {
      const samples = new Float32Array(sampleCount);
      let offset = 0;
      for (const chunk of sampleChunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      return samples;
    };

    const emitChunk = (mode: "partial" | "final") => {
      if (sampleCount === 0 || firstSpeechAt === null) return;
      const durationMs = normalizeChunkDurationMs((sampleCount / context.sampleRate) * 1000);
      if (mode === "final" && durationMs < 250) {
        sampleChunks = [];
        sampleCount = 0;
        firstSpeechAt = null;
        silenceStartedAt = null;
        preRollChunks = [];
        preRollSampleCount = 0;
        streamId = createUuid();
        revision = 0;
        return;
      }

      const samples = buildSamples();
      enqueue({
        audio: encodePcmWav(samples, context.sampleRate),
        startedAt: new Date(firstSpeechAt),
        endedAt: new Date(firstSpeechAt + durationMs),
        durationMs,
        streamId,
        revision: ++revision,
        mode,
      });

      if (mode === "final") {
        sampleChunks = [];
        sampleCount = 0;
        firstSpeechAt = null;
        silenceStartedAt = null;
        lastPartialAt = 0;
        preRollChunks = [];
        preRollSampleCount = 0;
        streamId = createUuid();
        revision = 0;
      } else {
        lastPartialAt = Date.now();
      }
    };

    const appendSamples = (samples: Float32Array) => {
      const copy = new Float32Array(samples);
      sampleChunks.push(copy);
      sampleCount += copy.length;
    };

    processor.onaudioprocess = (event) => {
      if (disposed) return;
      const input = event.inputBuffer.getChannelData(0);
      const now = Date.now();
      let energy = 0;
      for (let index = 0; index < input.length; index += 1) {
        energy += input[index] * input[index];
      }
      const rms = Math.sqrt(energy / input.length);
      const speechDetected = isSpeechFrame(rms, noiseFloor, speakingRef.current);
      if (!speechDetected) noiseFloor = noiseFloor * 0.98 + rms * 0.02;

      if (firstSpeechAt === null) {
        if (speechDetected) {
          firstSpeechAt = now - (preRollSampleCount / context.sampleRate) * 1000;
          lastPartialAt = now;
          for (const chunk of preRollChunks) appendSamples(chunk);
          appendSamples(input);
          silenceStartedAt = null;
        } else {
          preRollChunks.push(new Float32Array(input));
          preRollSampleCount += input.length;
          const maxPreRollSamples = (PRE_ROLL_MS / 1000) * context.sampleRate;
          while (preRollSampleCount > maxPreRollSamples && preRollChunks.length > 0) {
            const removed = preRollChunks.shift();
            if (removed) preRollSampleCount -= removed.length;
          }
          return;
        }
      } else {
        appendSamples(input);
        if (speechDetected) {
          silenceStartedAt = null;
        } else if (silenceStartedAt === null) {
          silenceStartedAt = now;
        }
      }

      const durationMs = (sampleCount / context.sampleRate) * 1000;
      const silenceMs = silenceStartedAt === null ? 0 : now - silenceStartedAt;
      if (shouldFinalizeAudioBuffer(durationMs, silenceMs)) {
        emitChunk("final");
      } else if (durationMs >= 1400 && now - lastPartialAt >= PARTIAL_INTERVAL_MS) {
        emitChunk("partial");
      }
    };

    void context.resume().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Microphone audio processing could not start.");
    });
    setListening(true);

    return () => {
      disposed = true;
      emitChunk("final");
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      mutedOutput.disconnect();
      void context.close();
      setListening(false);
    };
  }, [audioTrack, enabled, enqueue, supported]);

  return { supported, listening, interim, error };
}
