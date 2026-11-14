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
}) {
  const { discussionId, enabled, speaking, aiSpeaking } = params;
  /** What the server was last told, so unchanged heartbeats are not resent. */
  const lastSent = useRef<{ speaking: boolean; aiSpeaking: boolean } | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Leaving or ending the discussion clears this browser's claim on the
      // floor; a stale "still speaking" report would hold the moderator back.
      lastSent.current = null;
      return;
    }

    const report = (force: boolean) => {
      const previous = lastSent.current;
      if (!force && previous && previous.speaking === speaking && previous.aiSpeaking === aiSpeaking) {
        return;
      }
      lastSent.current = { speaking, aiSpeaking };
      // Fire and forget: a dropped report is corrected by the next change.
      void fetch(`/api/discussions/${discussionId}/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ speaking, aiSpeaking }),
        keepalive: true,
      }).catch(() => {
        /* transient network errors are ignored; the next report retries */
      });
    };

    report(true);

    // While somebody is audible, refresh the report so the server's "still
    // speaking" window never lapses mid-sentence. A silent room has nothing to
    // refresh, so it stays quiet.
    if (!speaking && !aiSpeaking) return;
    const timer = setInterval(() => report(true), 3000);
    return () => clearInterval(timer);
  }, [discussionId, enabled, speaking, aiSpeaking]);
}

export default usePresenceReporter;
