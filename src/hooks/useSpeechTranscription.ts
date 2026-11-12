"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeTranscript } from "@/lib/transcript";

/**
 * Browser speech recognition (Web Speech API).
 *
 * Each participant's browser transcribes that participant's own microphone, so
 * the speaker of every chunk is known exactly — no audio is uploaded and no
 * diarisation is needed.
 *
 * Support: Chromium-based browsers (Chrome, Edge, Brave, Opera). Firefox and
 * Safari do not implement SpeechRecognition, so `supported` stays false and the
 * UI falls back to the shared chat instead.
 */

type SpeechAlternative = { transcript: string; confidence: number };
type SpeechResult = { isFinal: boolean; length: number; 0: SpeechAlternative };
type SpeechResultList = { length: number; [index: number]: SpeechResult };
type SpeechResultEvent = { resultIndex: number; results: SpeechResultList };
type SpeechErrorEvent = { error: string };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export type FinalSegment = {
  text: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
};

export type SpeechTranscription = {
  supported: boolean;
  listening: boolean;
  interim: string;
  error: string | null;
};

/**
 * @param enabled  Whether transcription should currently be capturing.
 * @param onSegment Called once per finalised utterance.
 * @param lang     BCP-47 language tag for the recogniser.
 */
export function useSpeechTranscription({
  enabled,
  onSegment,
  lang = "en-US",
}: {
  enabled: boolean;
  onSegment: (segment: FinalSegment) => void;
  lang?: string;
}): SpeechTranscription {
  const [supported] = useState(() => Boolean(getRecognitionCtor()));
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** Intent flag: true while we want the recogniser running (it auto-restarts). */
  const wantListeningRef = useRef(false);
  const phraseStartRef = useRef<number | null>(null);
  const onSegmentRef = useRef(onSegment);
  onSegmentRef.current = onSegment;

  // Build the recogniser once. Rebuilt only if the language changes.
  useEffect(() => {
    if (!supported) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setListening(true);
      setError(null);
    };

    recognition.onresult = (event) => {
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const chunk = result[0]?.transcript ?? "";
        if (result.isFinal) {
          const text = normalizeTranscript(chunk);
          if (text) {
            const endedAt = Date.now();
            const startedAt = phraseStartRef.current ?? endedAt;
            phraseStartRef.current = null;
            onSegmentRef.current({
              text,
              startedAt: new Date(startedAt),
              endedAt: new Date(endedAt),
              durationMs: Math.max(0, endedAt - startedAt),
            });
          }
        } else {
          if (phraseStartRef.current === null) phraseStartRef.current = Date.now();
          pending += chunk;
        }
      }
      setInterim(normalizeTranscript(pending));
    };

    recognition.onerror = (event) => {
      // These two are normal inside a continuous session and are retried.
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantListeningRef.current = false;
        setError("Microphone permission is required for live transcription.");
        return;
      }
      if (event.error === "network") {
        setError("Speech recognition lost its network connection; retrying…");
        return;
      }
      setError(`Transcription stopped (${event.error}).`);
    };

    recognition.onend = () => {
      // Chrome ends the session after silence; restart while still wanted.
      if (wantListeningRef.current) {
        try {
          recognition.start();
          return;
        } catch {
          /* a restart raced with a stop; fall through */
        }
      }
      setListening(false);
      setInterim("");
    };

    recognitionRef.current = recognition;

    return () => {
      wantListeningRef.current = false;
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
      recognitionRef.current = null;
    };
  }, [supported, lang]);

  // Start / stop in response to `enabled`.
  useEffect(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    if (enabled) {
      wantListeningRef.current = true;
      phraseStartRef.current = null;
      try {
        recognition.start();
      } catch {
        /* start() throws if already running — that is fine */
      }
    } else {
      wantListeningRef.current = false;
      phraseStartRef.current = null;
      try {
        recognition.stop();
      } catch {
        /* not running */
      }
      setInterim("");
      setListening(false);
    }
  }, [enabled]);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        /* not running */
      }
    }
  }, []);

  // Never leave the microphone hot after the component unmounts.
  useEffect(() => stop, [stop]);

  return { supported, listening, interim, error };
}
