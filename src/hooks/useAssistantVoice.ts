"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Text-to-speech for the AI moderator (browser Web Speech API).
 *
 * The assistant already stores every message it posts on the AiEvent table, so
 * the room holds the exact sentence to be spoken. This hook speaks that string
 * verbatim in each participant's own browser: the wording on screen and the
 * wording in the audio are the same string, and everyone hears the question
 * through their own speakers without having to press anything.
 *
 * It also makes the assistant behave like a polite moderator — it waits while
 * somebody else is talking, never says the same sentence twice, and drops a
 * queued sentence that has gone stale instead of blurting it out late.
 */

/**
 * Voices that sound natural and professional, best first. Chromium ships the
 * "Google …" voices, Edge the "… Online (Natural)" ones, Safari "Samantha".
 */
const PREFERRED_VOICES = [
  "Google UK English Female",
  "Microsoft Aria Online (Natural) - English (United States)",
  "Microsoft Jenny Online (Natural) - English (United States)",
  "Google US English",
  "Samantha",
  "Microsoft Zira",
  "Daniel",
  "Google UK English Male",
];

/** Picks the most natural installed voice for the requested language. */
function pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;

  for (const wanted of PREFERRED_VOICES) {
    const exact = voices.find((voice) => voice.name.toLowerCase() === wanted.toLowerCase());
    if (exact) return exact;
  }
  for (const wanted of PREFERRED_VOICES) {
    const partial = voices.find((voice) => voice.name.toLowerCase().includes(wanted.toLowerCase()));
    if (partial) return partial;
  }

  const base = lang.split("-")[0].toLowerCase();
  return voices.find((voice) => voice.lang.toLowerCase().startsWith(base)) ?? null;
}

/**
 * Browsers only allow speech once the page has been interacted with. This is
 * sticky for the lifetime of the document, so it is normally already true by
 * the time a participant reaches the room.
 */
function browserHasUserActivation(): boolean {
  if (typeof navigator === "undefined") return false;
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } })
    .userActivation;
  return Boolean(activation?.hasBeenActive);
}

export type AssistantVoice = {
  /** The browser exposes speech synthesis at all. */
  supported: boolean;
  /** Automatic speaking is switched on (the participant can mute it). */
  enabled: boolean;
  /** The browser will actually play audio; false only before the first gesture. */
  unlocked: boolean;
  /** A sentence is playing right now. */
  speaking: boolean;
  /** The sentence that is playing, for highlighting it in the transcript card. */
  spokenText: string | null;
  /** The installed voice in use, for display. */
  voiceName: string | null;
  setEnabled: (value: boolean) => void;
  /** Speaks a sentence as soon as the room is quiet. Safe to call repeatedly. */
  announce: (text: string) => void;
  /** Cancels anything playing and clears anything queued. */
  stop: () => void;
  /** Callable from a click handler to satisfy the browser's autoplay policy. */
  unlock: () => void;
};

export function useAssistantVoice({
  lang = "en-US",
  hold = false,
  maxDeferMs = 25_000,
  onSpeakingChange,
}: {
  /** BCP-47 language tag for the spoken sentence. */
  lang?: string;
  /** True while a participant is talking, so the assistant waits its turn. */
  hold?: boolean;
  /** A sentence that has waited longer than this is dropped rather than spoken late. */
  maxDeferMs?: number;
  /** Notifies the room when browser TTS actually begins or ends speaking. */
  onSpeakingChange?: (speaking: boolean, estimatedDurationMs?: number) => void;
} = {}): AssistantVoice {
  // Detected in an effect so the first client render matches the server HTML.
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabledState] = useState(true);
  const [unlocked, setUnlockedState] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [spokenText, setSpokenText] = useState<string | null>(null);
  const [voiceName, setVoiceName] = useState<string | null>(null);

  const enabledRef = useRef(enabled);
  const unlockedRef = useRef(false);
  const holdRef = useRef(hold);
  const speakingRef = useRef(false);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const onSpeakingChangeRef = useRef(onSpeakingChange);
  onSpeakingChangeRef.current = onSpeakingChange;
  /** Sentences waiting for the room to fall quiet again. */
  const queueRef = useRef<{ text: string; queuedAt: number }[]>([]);
  /** The last sentence actually spoken, so nothing is ever said twice. */
  const lastSpokenRef = useRef<string | null>(null);
  /** Lets the mount effect drain the queue without depending on `drain`. */
  const drainRef = useRef<() => void>(() => {});

  holdRef.current = hold;

  /**
   * Speaks the next queued sentence. Called after every change that could
   * unblock the assistant, and again by each utterance when it finishes.
   */
  const drain = useCallback(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;

    const step = () => {
      const wasSpeaking = speakingRef.current;
      speakingRef.current = false;
      setSpeaking(false);
      setSpokenText(null);
      if (wasSpeaking && queueRef.current.length === 0) {
        onSpeakingChangeRef.current?.(false);
      }

      // Wait for a gap: never talk over a participant, and stay muted on request.
      if (!enabledRef.current || !unlockedRef.current || holdRef.current) {
        if (wasSpeaking) onSpeakingChangeRef.current?.(false);
        return;
      }

      let item = queueRef.current.shift();
      while (item && Date.now() - item.queuedAt > maxDeferMs) {
        item = queueRef.current.shift();
      }
      if (!item) {
        if (wasSpeaking) onSpeakingChangeRef.current?.(false);
        return;
      }
      const pending = item;

      const utterance = new SpeechSynthesisUtterance(pending.text);
      utterance.lang = lang;
      if (voiceRef.current) utterance.voice = voiceRef.current;
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.volume = 1;

      const words = pending.text.trim().split(/\s+/).filter(Boolean).length;
      const estimatedMs = Math.max(3000, Math.min(25_000, words * 400 + 1800));

      const release = () => {
        queueRef.current.unshift(pending);
        unlockedRef.current = false;
        setUnlockedState(false);
        speakingRef.current = false;
        setSpeaking(false);
        setSpokenText(null);
        onSpeakingChangeRef.current?.(false);
      };

      let started = false;
      const watchdog = setTimeout(() => {
        if (started || synth.speaking || synth.pending) return;
        release();
      }, 4000);

      utterance.onstart = () => {
        started = true;
        clearTimeout(watchdog);
      };
      utterance.onend = () => {
        clearTimeout(watchdog);
        step();
      };
      utterance.onerror = (event) => {
        clearTimeout(watchdog);
        if (event.error === "not-allowed") {
          release();
          return;
        }
        step();
      };

      speakingRef.current = true;
      setSpeaking(true);
      setSpokenText(pending.text);
      lastSpokenRef.current = pending.text;
      onSpeakingChangeRef.current?.(true, estimatedMs);
      synth.speak(utterance);
    };

    if (speakingRef.current) return;
    step();
  }, [supported, lang, maxDeferMs]);

  drainRef.current = drain;

  const announce = useCallback(
    (text: string) => {
      const message = text.trim();
      if (!supported || !message) return;
      if (message === lastSpokenRef.current) return;
      if (queueRef.current.some((item) => item.text === message)) return;
      queueRef.current.push({ text: message, queuedAt: Date.now() });
      drain();
    },
    [supported, drain],
  );

  const stop = useCallback(() => {
    const wasSpeaking = speakingRef.current;
    queueRef.current = [];
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    speakingRef.current = false;
    setSpeaking(false);
    setSpokenText(null);
    if (wasSpeaking) onSpeakingChangeRef.current?.(false);
  }, []);

  const setEnabled = useCallback(
    (value: boolean) => {
      enabledRef.current = value;
      setEnabledState(value);
      if (value) drain();
      else stop();
    },
    [drain, stop],
  );

  const unlock = useCallback(() => {
    unlockedRef.current = true;
    setUnlockedState(true);
    drain();
  }, [drain]);

  // Feature detection plus the browser's existing user activation.
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    setSupported(true);
    if (browserHasUserActivation()) {
      unlockedRef.current = true;
      setUnlockedState(true);
      drainRef.current();
    }
  }, []);

  // Voices arrive asynchronously in most browsers.
  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    const select = () => {
      const voice = pickVoice(synth.getVoices(), lang);
      voiceRef.current = voice;
      setVoiceName(voice?.name ?? null);
    };
    select();
    synth.addEventListener("voiceschanged", select);
    return () => synth.removeEventListener("voiceschanged", select);
  }, [supported, lang]);

  // The assistant waits its turn while somebody else is talking.
  useEffect(() => {
    if (!hold) drain();
  }, [hold, drain]);

  // Most browsers only speak after the page has been interacted with, so any
  // click or key press is enough to release a sentence that was held back.
  useEffect(() => {
    if (!supported || unlocked) return;
    const onGesture = () => unlock();
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    window.addEventListener("touchstart", onGesture);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      window.removeEventListener("touchstart", onGesture);
    };
  }, [supported, unlocked, unlock]);

  // Never leave a voice running after the room is left.
  useEffect(() => stop, [stop]);

  return {
    supported,
    enabled,
    unlocked,
    speaking,
    spokenText,
    voiceName,
    setEnabled,
    announce,
    stop,
    unlock,
  };
}
