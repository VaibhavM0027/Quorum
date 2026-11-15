"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const CHUNK_DURATION_MS = 6000;
const TARGET_SAMPLE_RATE = 16_000;
const MAX_PENDING_CHUNKS = 20;
const DEFAULT_LANG = process.env.NEXT_PUBLIC_SPEECH_LANG ?? "en-US";

type AudioChunk = {
  audio: Blob;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
};

type TranscriptionResponse = {
  error?: string;
  issues?: Array<{ path?: string; message?: string }>;
  retryAfterMs?: number;
  skipped?: string;
};

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

export function encodePcmWav(sourceSamples: Float32Array, sourceSampleRate: number): Blob {
  const outputLength = Math.ceil((sourceSamples.length * TARGET_SAMPLE_RATE) / sourceSampleRate);
  const samples = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const sourcePosition = (i * sourceSampleRate) / TARGET_SAMPLE_RATE;
    const sourceIndex = Math.floor(sourcePosition);
    const fraction = sourcePosition - sourceIndex;
    const left = sourceSamples[sourceIndex] ?? 0;
    const right = sourceSamples[sourceIndex + 1] ?? left;
    const sample = Math.max(-1, Math.min(1, left + (right - left) * fraction));
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
  return Math.max(1, Math.min(CHUNK_DURATION_MS, Math.round(durationMs)));
}

export function useGeminiTranscription({
  discussionId,
  enabled,
  audioTrack,
  speaking,
  language = DEFAULT_LANG,
  onStored,
}: {
  discussionId: string;
  enabled: boolean;
  audioTrack: MediaStreamTrack | null;
  speaking: boolean;
  language?: string;
  onStored?: () => void;
}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabledRef = useRef(enabled);
  const speakingRef = useRef(speaking);
  const onStoredRef = useRef(onStored);
  const pendingRef = useRef<AudioChunk[]>([]);
  const postingRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const retryAfterRef = useRef(0);
  const flushRef = useRef<() => void>(() => {});

  enabledRef.current = enabled;
  speakingRef.current = speaking;
  onStoredRef.current = onStored;

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
        getAudioContextConstructor() !== null,
    );
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
              : data.error ?? "Gemini transcription could not be completed.",
          );
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
        if (!data.skipped) onStoredRef.current?.();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Gemini transcription could not be sent.");
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
      return;
    }

    let disposed = false;
    let chunkTimer: ReturnType<typeof setInterval> | null = null;
    let firstSpeechAt: number | null = null;
    let lastSpeechAt: number | null = null;
    let speechDurationMs = 0;
    let sampleChunks: Float32Array[] = [];
    let sampleCount = 0;
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

    const flushSamples = () => {
      if (sampleCount === 0 || firstSpeechAt === null) return;
      const samples = new Float32Array(sampleCount);
      let offset = 0;
      for (const chunk of sampleChunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      enqueue({
        audio: encodePcmWav(samples, context.sampleRate),
        startedAt: new Date(firstSpeechAt),
        endedAt: new Date(lastSpeechAt ?? Date.now()),
        durationMs: normalizeChunkDurationMs(speechDurationMs),
      });
      sampleChunks = [];
      sampleCount = 0;
      firstSpeechAt = null;
      lastSpeechAt = null;
      speechDurationMs = 0;
    };

    processor.onaudioprocess = (event) => {
      if (!speakingRef.current || disposed) return;
      const input = event.inputBuffer.getChannelData(0);
      sampleChunks.push(new Float32Array(input));
      sampleCount += input.length;
      const now = Date.now();
      if (firstSpeechAt === null) firstSpeechAt = now;
      lastSpeechAt = now;
      speechDurationMs += (input.length / context.sampleRate) * 1000;
    };
    void context.resume().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Microphone audio processing could not start.");
    });
    chunkTimer = setInterval(flushSamples, CHUNK_DURATION_MS);
    setListening(true);

    return () => {
      disposed = true;
      if (chunkTimer) clearInterval(chunkTimer);
      flushSamples();
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      mutedOutput.disconnect();
      void context.close();
      setListening(false);
    };
  }, [audioTrack, enabled, enqueue, supported]);

  return { supported, listening, interim: "", error };
}
