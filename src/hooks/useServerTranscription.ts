"use client";

import { useEffect, useRef, useState } from "react";
import { encodeWav, peakAmplitude } from "@/lib/wav";
import { transcriptLog, transcriptWarn } from "@/lib/debug-log";

/**
 * Server-side transcription for browsers that have no speech recogniser.
 *
 * Chromium transcribes each participant's microphone in the browser and posts
 * the text (`useSpeechTranscription`). Firefox and Safari implement no such
 * API, so those participants would otherwise never appear in the transcript.
 * This hook records their microphone instead — the same microphone LiveKit is
 * already publishing, so no second permission prompt — cuts it into utterances
 * on silence, and posts each utterance as a small WAV clip to `/stt`, where the
 * server turns it into text.
 *
 * Attribution is unchanged: the clip travels on the speaker's own authenticated
 * request, so a chunk can only ever be stored against the person who spoke it.
 * Any browser that needs this path gets it; nothing here is host-specific.
 */

/** Mono 16 kHz is plenty for speech and keeps the uploaded clip small. */
const TARGET_SAMPLE_RATE = 16_000;

/** Samples per processing block. ~85 ms at 48 kHz, ~256 ms at 16 kHz. */
const PROCESSOR_BUFFER = 4096;

/** Peak amplitude above which a block counts as speech rather than room tone. */
const SPEECH_PEAK = 0.02;

/** Quiet stretch that closes an utterance. */
const END_SILENCE_MS = 900;

/** Clicks and blips shorter than this are not speech and are discarded. */
const MIN_UTTERANCE_MS = 350;

/** A long monologue is flushed in pieces so the transcript stays near-live. */
const MAX_UTTERANCE_MS = 15_000;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

export type ServerTranscription = {
  /** Whether this browser can record and post clips at all. */
  supported: boolean;
  /** True while the microphone is actually being recorded for the server. */
  transcribing: boolean;
  error: string | null;
};

/**
 * @param discussionId Where clips are posted and attributed.
 * @param track        The microphone track to record; null when the mic is off.
 * @param enabled      Whether transcription should currently be capturing.
 * @param onStored     Called after a clip was stored, so the room can refresh.
 */
export function useServerTranscription({
  discussionId,
  track,
  enabled,
  onStored,
}: {
  discussionId: string;
  track: MediaStreamTrack | null;
  enabled: boolean;
  onStored?: () => void;
}): ServerTranscription {
  const [supported] = useState(() => Boolean(getAudioContextCtor()));
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onStoredRef = useRef(onStored);
  onStoredRef.current = onStored;

  useEffect(() => {
    if (!enabled || !supported || !track) return;
    const Ctor = getAudioContextCtor();
    if (!Ctor) return;

    let context: AudioContext;
    try {
      // Ask for the small sample rate first; browsers are free to ignore it,
      // and `context.sampleRate` below is what the WAV header is written with.
      context = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      try {
        context = new Ctor();
      } catch {
        setError("Audio capture is unavailable in this browser.");
        return;
      }
    }

    const source = context.createMediaStreamSource(new MediaStream([track]));
    const processor = context.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);
    const sink = context.createGain();
    // The processor must reach the destination to be pumped, but routing the
    // microphone back to the speakers would echo — so the sink is silent.
    sink.gain.value = 0;

    const blockMs = (PROCESSOR_BUFFER / context.sampleRate) * 1000;

    // Utterance state, held in the closure because it is meaningless outside.
    let speaking = false;
    let chunks: Float32Array[] = [];
    let voicedMs = 0;
    let silenceMs = 0;
    let startedAt = 0;

    /** Clips are posted in order so the transcript never lands out of sequence. */
    let chain: Promise<void> = Promise.resolve();

    const send = async (wav: Uint8Array<ArrayBuffer>, clipStartedAt: Date, durationMs: number) => {
      try {
        const res = await fetch(`/api/discussions/${discussionId}/stt`, {
          method: "POST",
          headers: {
            "content-type": "audio/wav",
            "x-clip-started-at": clipStartedAt.toISOString(),
            "x-clip-duration-ms": String(Math.round(durationMs)),
          },
          // A Blob is the most portable way to hand raw bytes to fetch.
          body: new Blob([wav], { type: "audio/wav" }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          segment?: unknown;
          duplicate?: boolean;
          text?: string;
        };
        if (!res.ok) {
          transcriptWarn("server transcription clip rejected", {
            status: res.status,
            error: data.error,
          });
          return;
        }
        if (data.segment && !data.duplicate) {
          transcriptLog("server transcribed an utterance", { chars: data.text?.length ?? 0 });
          onStoredRef.current?.();
        }
      } catch (err) {
        transcriptWarn("server transcription clip could not be sent", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const flush = () => {
      const capturedMs = voicedMs;
      if (capturedMs >= MIN_UTTERANCE_MS && chunks.length > 0) {
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const samples = new Float32Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          samples.set(chunk, offset);
          offset += chunk.length;
        }
        const wav = encodeWav(samples, context.sampleRate);
        const clipStartedAt = new Date(startedAt);
        chain = chain.then(() => send(wav, clipStartedAt, capturedMs));
      }
      speaking = false;
      chunks = [];
      voicedMs = 0;
      silenceMs = 0;
      startedAt = 0;
    };

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const peak = peakAmplitude(input);

      if (peak >= SPEECH_PEAK) {
        if (!speaking) {
          speaking = true;
          startedAt = Date.now();
          chunks = [];
          voicedMs = 0;
          silenceMs = 0;
        }
        chunks.push(new Float32Array(input));
        voicedMs += blockMs;
        silenceMs = 0;
        if (voicedMs >= MAX_UTTERANCE_MS) flush();
        return;
      }

      // Trailing quiet is kept in the clip — it helps the model — but does not
      // count towards how long the participant was actually speaking.
      if (speaking) {
        chunks.push(new Float32Array(input));
        silenceMs += blockMs;
        if (silenceMs >= END_SILENCE_MS) flush();
      }
    };

    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);

    // A context created without a gesture can start suspended.
    void context.resume().catch(() => {});
    setTranscribing(true);
    setError(null);
    transcriptLog("capturing audio for server transcription", {
      sampleRate: context.sampleRate,
      discussionId,
    });

    return () => {
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
        source.disconnect();
        sink.disconnect();
      } catch {
        /* already torn down */
      }
      void context.close().catch(() => {});
      setTranscribing(false);
    };
  }, [discussionId, enabled, supported, track]);

  return { supported, transcribing, error };
}
