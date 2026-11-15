"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeTranscriptText, normalizeTranscript } from "@/lib/transcript";
import { transcriptLog, transcriptWarn } from "@/lib/debug-log";

/**
 * Browser speech recognition (Web Speech API).
 *
 * Each participant's browser transcribes that participant's own microphone, so
 * the speaker of every chunk is known exactly. The browser may use its remote
 * speech service; when that fails, supported browsers are switched to on-device
 * recognition.
 *
 * Support: Chromium-based browsers (Chrome, Edge, Brave, Opera). Firefox and
 * Safari do not implement SpeechRecognition, so `supported` stays false and
 * the room uses its Gemini audio-chunk fallback instead.
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
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
type OnDeviceAvailability = "available" | "downloadable" | "downloading" | "unavailable";
type SpeechRecognitionCtorWithOnDevice = SpeechRecognitionCtor & {
  available?: (options: {
    langs: string[];
    quality: "conversation";
    processLocally: true;
  }) => Promise<OnDeviceAvailability>;
  install?: (options: {
    langs: string[];
    quality: "conversation";
  }) => Promise<boolean>;
};

async function prepareOnDeviceRecognition(
  recognition: SpeechRecognitionLike,
  ctor: SpeechRecognitionCtorWithOnDevice,
  lang: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (
    typeof recognition.processLocally !== "boolean" ||
    !ctor.available ||
    !ctor.install
  ) {
    return { ok: false, reason: "this browser does not support on-device recognition" };
  }

  try {
    const availability = await ctor.available({
      langs: [lang],
      quality: "conversation",
      processLocally: true,
    });
    if (availability === "available") return { ok: true };
    if (availability === "unavailable") {
      return { ok: false, reason: `no on-device language pack is available for ${lang}` };
    }

    const installed = await ctor.install({ langs: [lang], quality: "conversation" });
    return installed
      ? { ok: true }
      : { ok: false, reason: `the on-device language pack for ${lang} could not be installed` };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "on-device recognition setup failed",
    };
  }
}

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export type FinalSegment = {
  streamId: string;
  text: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
};

export type PartialSegment = {
  streamId: string;
  revision: number;
  text: string;
  startedAt: Date;
  active: boolean;
};

/**
 * Language the recogniser listens for. Indian English accents are transcribed
 * noticeably better with `en-IN`; a deployment can set NEXT_PUBLIC_SPEECH_LANG
 * to change it without touching the code.
 */
const DEFAULT_LANG = process.env.NEXT_PUBLIC_SPEECH_LANG ?? "en-IN";
const FINALIZE_PAUSE_MS = 1_200;

export type SpeechTranscription = {
  supported: boolean;
  listening: boolean;
  interim: string;
  error: string | null;
};

/**
 * @param enabled  Whether transcription should currently be capturing.
 * @param onSegment Called once per finalised utterance.
 * @param onPartial Called as interim text changes and when its stream ends.
 * @param lang     BCP-47 language tag for the recogniser.
 */
export function useSpeechTranscription({
  enabled,
  onSegment,
  onPartial,
  lang = DEFAULT_LANG,
}: {
  enabled: boolean;
  onSegment: (segment: FinalSegment) => void;
  onPartial?: (segment: PartialSegment) => void;
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
  const finalTranscriptRef = useRef("");
  const interimTranscriptRef = useRef("");
  const finalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalizeCurrentRef = useRef<() => void>(() => {});
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const networkFailureRef = useRef(false);
  const onDeviceStateRef = useRef<"not-tried" | "installing" | "ready" | "unavailable">(
    "not-tried",
  );
  const onDeviceFailureRef = useRef<string | null>(null);
  const recognitionEndedRef = useRef(false);
  const onSegmentRef = useRef(onSegment);
  onSegmentRef.current = onSegment;
  const onPartialRef = useRef(onPartial);
  onPartialRef.current = onPartial;
  const streamIdRef = useRef<string | null>(null);
  const streamRevisionRef = useRef(0);

  // Build the recogniser once. Rebuilt only if the language changes.
  useEffect(() => {
    if (!supported) {
      transcriptWarn("this browser does not implement the Web Speech API", { lang });
      return;
    }
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    const recognition = new Ctor();
    const recognitionCtor = Ctor as SpeechRecognitionCtorWithOnDevice;
    onDeviceStateRef.current = recognition.processLocally ? "ready" : "not-tried";
    onDeviceFailureRef.current = null;
    recognitionEndedRef.current = false;
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    const clearFinalizeTimer = () => {
      if (finalizeTimerRef.current) clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    };

    const clearDraft = (streamId: string) => {
      onPartialRef.current?.({
        streamId,
        revision: streamRevisionRef.current + 1,
        text: "",
        startedAt: new Date(phraseStartRef.current ?? Date.now()),
        active: false,
      });
    };

    const finalizeCurrentUtterance = () => {
      clearFinalizeTimer();
      const text = mergeTranscriptText(finalTranscriptRef.current, interimTranscriptRef.current);
      const streamId = streamIdRef.current;
      const startedAt = phraseStartRef.current ?? Date.now();
      const endedAt = Date.now();

      if (streamId) clearDraft(streamId);
      finalTranscriptRef.current = "";
      interimTranscriptRef.current = "";
      phraseStartRef.current = null;
      streamIdRef.current = null;
      streamRevisionRef.current = 0;
      setInterim("");

      if (!text) return;
      transcriptLog("utterance committed", {
        chars: text.length,
        durationMs: Math.max(0, endedAt - startedAt),
      });
      onSegmentRef.current({
        streamId: streamId ?? createStreamId(),
        text,
        startedAt: new Date(startedAt),
        endedAt: new Date(endedAt),
        durationMs: Math.max(0, endedAt - startedAt),
      });
    };
    finalizeCurrentRef.current = finalizeCurrentUtterance;

    const scheduleFinalize = () => {
      clearFinalizeTimer();
      finalizeTimerRef.current = setTimeout(finalizeCurrentUtterance, FINALIZE_PAUSE_MS);
    };

    recognition.onstart = () => {
      recognitionEndedRef.current = false;
      setListening(true);
      transcriptLog("speech recognition listening", {
        lang,
        processLocally: recognition.processLocally ?? false,
      });
    };

    recognition.onresult = (event) => {
      retryAttemptRef.current = 0;
      networkFailureRef.current = false;
      setError(null);
      let changedFinalText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const chunk = result[0]?.transcript ?? "";
        if (result.isFinal) {
          changedFinalText = mergeTranscriptText(changedFinalText, chunk);
        }
      }
      finalTranscriptRef.current = mergeTranscriptText(finalTranscriptRef.current, changedFinalText);

      const interimParts: string[] = [];
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result.isFinal) interimParts.push(result[0]?.transcript ?? "");
      }
      interimTranscriptRef.current = normalizeTranscript(interimParts.join(" "));

      const liveText = mergeTranscriptText(finalTranscriptRef.current, interimTranscriptRef.current);
      if (!liveText) return;
      if (phraseStartRef.current === null) phraseStartRef.current = Date.now();
      if (!streamIdRef.current) streamIdRef.current = createStreamId();
      setInterim(liveText);
      streamRevisionRef.current += 1;
      onPartialRef.current?.({
        streamId: streamIdRef.current,
        revision: streamRevisionRef.current,
        text: liveText,
        startedAt: new Date(phraseStartRef.current),
        active: true,
      });
      scheduleFinalize();
    };

    recognition.onerror = (event) => {
      // These two are normal inside a continuous session and are retried.
      if (event.error === "no-speech" || event.error === "aborted") return;
      transcriptWarn("speech recognition error", { error: event.error });
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantListeningRef.current = false;
        setError("Microphone permission is required for live transcription.");
        return;
      }
      if (event.error === "network") {
        finalizeCurrentUtterance();
        networkFailureRef.current = true;
        if (onDeviceStateRef.current === "installing") {
          setError("Speech service is unreachable; checking for on-device recognition…");
          return;
        }
        if (!recognition.processLocally && onDeviceStateRef.current === "not-tried") {
          onDeviceStateRef.current = "installing";
          setError("Speech service is unreachable; checking for on-device recognition…");
          void prepareOnDeviceRecognition(recognition, recognitionCtor, lang).then((result) => {
            if (result.ok) {
              recognition.processLocally = true;
              onDeviceStateRef.current = "ready";
              networkFailureRef.current = false;
              retryAttemptRef.current = 0;
              if (!wantListeningRef.current) return;
              setError(null);
              transcriptLog("switched to on-device speech recognition", { lang });
              if (wantListeningRef.current && recognitionEndedRef.current) {
                try {
                  recognition.start();
                } catch {
                  /* onend will restart if the recognition is still stopping */
                }
              }
            } else {
              onDeviceStateRef.current = "unavailable";
              onDeviceFailureRef.current = result.reason;
              if (!wantListeningRef.current) return;
              wantListeningRef.current = false;
              networkFailureRef.current = false;
              transcriptWarn("on-device recognition unavailable", { lang, reason: result.reason });
              setError(
                `On-device recognition unavailable: ${result.reason}. The browser speech service is still unreachable; check your internet connection.`,
              );
              if (wantListeningRef.current && recognitionEndedRef.current) {
                scheduleNetworkRetry();
              }
            }
          });
          return;
        }
        setError(
          onDeviceFailureRef.current
            ? `On-device recognition unavailable: ${onDeviceFailureRef.current}. The browser speech service is still unreachable; check your internet connection.`
            : recognition.processLocally
              ? "On-device speech recognition stopped; retrying."
              : "Browser speech recognition service is unreachable; retrying. Check your internet connection.",
        );
        return;
      }
      setError(`Transcription stopped (${event.error}).`);
    };

    recognition.onend = () => {
      recognitionEndedRef.current = true;
      // Chrome ends the session after silence; restart while still wanted.
      if (wantListeningRef.current) {
        if (onDeviceStateRef.current === "installing") {
          setListening(false);
          setInterim("");
          return;
        }
        if (networkFailureRef.current) {
          scheduleNetworkRetry();
          return;
        }

        try {
          recognition.start();
          return;
        } catch {
          /* a restart raced with a stop; fall through */
        }
      }
      finalizeCurrentUtterance();
      setListening(false);
    };

    function scheduleNetworkRetry() {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      const delay = Math.min(1000 * 2 ** retryAttemptRef.current++, 15_000);
      networkFailureRef.current = false;
      setListening(false);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (!wantListeningRef.current) return;
        try {
          recognition.start();
        } catch {
          /* a restart raced with a stop; onend will retry if still wanted */
        }
      }, delay);
    }

    recognitionRef.current = recognition;

    return () => {
      wantListeningRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      clearFinalizeTimer();
      finalizeCurrentRef.current = () => {};
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
      transcriptLog("transcription enabled");
      try {
        recognition.start();
      } catch {
        /* start() throws if already running — that is fine */
      }
    } else {
      wantListeningRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      retryAttemptRef.current = 0;
      networkFailureRef.current = false;
      setError(null);
      transcriptLog("transcription disabled");
      try {
        recognition.stop();
      } catch {
        finalizeCurrentRef.current();
      }
      setListening(false);
    }
  }, [enabled]);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        finalizeCurrentRef.current();
      }
    } else finalizeCurrentRef.current();
  }, []);

  // Never leave the microphone hot after the component unmounts.
  useEffect(() => stop, [stop]);

  return { supported, listening, interim, error };
}

function createStreamId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();

  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
