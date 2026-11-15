"use client";

import { useEffect, useRef } from "react";

/**
 * Reports this browser's live audio activity to the server.
 *
 * The moderator decides whether it may speak from real audio activity, not from
 * the transcript: a browser knows somebody has the floor the moment LiveKit
 * reports speech, whereas a transcript sentence only exists once the recogniser
 * has committed it — which can be seconds later. Reporting that raw activity is
 * what lets the conversation engine promise never to talk over a participant
 * mid-sentence.
 *
 * Only changes are sent, so a silent room costs nothing, plus a slow heartbeat
 * while something is audible so a participant keeps their claim on the floor
 * fresh for as long as they are still talking.
 */
export function usePresenceReporter(params: {
  discussionId: string;
  /** Only report while the discussion is live and this browser is a member. */
  enabled: boolean;
  /** This browser's own microphone is carrying speech right now. */
  speaking: boolean;
  /** The moderator's voice is being played back in this browser right now. */
  aiSpeaking: boolean;
  /**
   * This browser is capturing microphone audio for Gemini transcription.
   *
   * It is reported separately from `speaking` because the two answer different
   * questions: audio activity says somebody is audible, whereas this says their
   * audio is being captured for transcription. A participant with a live
   * microphone whose browser cannot record audio is audible and still produces
   * nothing, and only this flag tells the room which of the two is happening.
   */
  transcribing: boolean;
}) {
  const { discussionId, enabled, speaking, aiSpeaking, transcribing } = params;
  /** What the server was last told, so unchanged heartbeats are not resent. */
  const lastSent = useRef<{ speaking: boolean; aiSpeaking: boolean; transcribing: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (!enabled) {
      // Leaving or ending the discussion clears this browser's claim on the
      // floor; a stale "still speaking" report would hold the moderator back.
      lastSent.current = null;
      return;
    }

    const report = (force: boolean) => {
      const previous = lastSent.current;
      if (
        !force &&
        previous &&
        previous.speaking === speaking &&
        previous.aiSpeaking === aiSpeaking &&
        previous.transcribing === transcribing
      ) {
        return;
      }
      lastSent.current = { speaking, aiSpeaking, transcribing };
      // Fire and forget: a dropped report is corrected by the next change.
      void fetch(`/api/discussions/${discussionId}/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ speaking, aiSpeaking, transcribing }),
        keepalive: true,
      }).catch(() => {
        /* transient network errors are ignored; the next report retries */
      });
    };

    report(true);

    // While somebody is audible, refresh the report so the server's "still
    // speaking" window never lapses mid-sentence. A silent room has nothing to
    // refresh — but a silent participant who is transcribing still has to prove
    // it stays alive, so that claim is refreshed more slowly instead.
    if (!speaking && !aiSpeaking && !transcribing) return;
    const interval = speaking || aiSpeaking ? 3000 : 8000;
    const timer = setInterval(() => report(true), interval);
    return () => clearInterval(timer);
  }, [discussionId, enabled, speaking, aiSpeaking, transcribing]);
}

export default usePresenceReporter;
