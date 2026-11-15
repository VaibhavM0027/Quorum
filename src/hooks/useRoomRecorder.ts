"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Records the discussion as a single audio file, in the browser of the client
 * that is meeting everybody else's audio.
 *
 * LiveKit already gives this client a `MediaStreamTrack` for every speaker in
 * the room, including its own microphone. Those tracks are summed through a Web
 * Audio graph into one stream, which `MediaRecorder` encodes. The result is one
 * file per session rather than one clip per student, with no extra media server:
 * the finished mix is uploaded once, after the discussion. Browser speech
 * recognition may separately use its own remote service.
 *
 * Capture follows the live discussion. It starts when the discussion goes live,
 * stops when the discussion ends, and the finished file is uploaded once, to the
 * recordings endpoint. Nothing is recorded while the room is idle.
 */

export type RecorderState = "idle" | "recording" | "saving" | "saved" | "error";

export type RoomRecorder = {
  state: RecorderState;
  /** Seconds captured so far, or the length of the stored recording once saved. */
  seconds: number;
  /** Route the stored recording can be played from, once saved. */
  url: string | null;
  error: string | null;
};

/** Containers in the order we would like the encoder to pick. */
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

type MixingGraph = {
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
  recorder: MediaRecorder;
  sources: Map<MediaStreamTrack, MediaStreamAudioSourceNode>;
};

type Options = {
  discussionId: string;
  /** Every audio track this client can hear: its own microphone plus each remote speaker. */
  tracks: MediaStreamTrack[];
  /** True while the discussion is live and this client should be capturing it. */
  enabled: boolean;
};

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

/** Resolves once the recorder has emitted its final `dataavailable` and stopped. */
function whenStopped(recorder: MediaRecorder): Promise<void> {
  return new Promise((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
}

export function useRoomRecorder({ discussionId, tracks, enabled }: Options): RoomRecorder {
  const [state, setState] = useState<RecorderState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** The mixing graph, shared between the capture effect and the track effect. */
  const graphRef = useRef<MixingGraph | null>(null);

  // ---- Capture, from the moment the discussion goes live -------------------
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return;

    const AudioContextCtor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    const startedAt = Date.now();
    const context = new AudioContextCtor();
    const destination = context.createMediaStreamDestination();
    const mimeType = pickMimeType();

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(destination.stream, mimeType ? { mimeType } : undefined);
      recorder.start(2000);
    } catch (err) {
      void context.close();
      setState("error");
      setError(err instanceof Error ? err.message : "This browser cannot record audio.");
      return;
    }

    const chunks: BlobPart[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    const graph: MixingGraph = { context, destination, recorder, sources: new Map() };
    graphRef.current = graph;

    // A suspended context would hold a "recording" state while capturing silence.
    if (context.state === "suspended") void context.resume();

    setState("recording");
    setSeconds(0);
    setError(null);

    const ticker = setInterval(() => {
      setSeconds(Math.round((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => {
      clearInterval(ticker);
      graphRef.current = null;

      const stopped = whenStopped(recorder);
      // `requestData` flushes the tail so the last couple of seconds are kept.
      try {
        recorder.requestData();
      } catch {
        /* the recorder was already stopping */
      }
      if (recorder.state !== "inactive") recorder.stop();

      void stopped.then(async () => {
        const durationMs = Date.now() - startedAt;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });

        for (const source of graph.sources.values()) source.disconnect();
        graph.sources.clear();
        void context.close();

        if (blob.size === 0) {
          // Nothing was captured (nobody published audio), so there is nothing to store.
          setState("idle");
          return;
        }

        setSeconds(Math.round(durationMs / 1000));
        setState("saving");

        const form = new FormData();
        form.append("file", blob);
        form.append("durationMs", String(durationMs));
        form.append("startedAt", new Date(startedAt).toISOString());

        try {
          const res = await fetch(`/api/discussions/${discussionId}/recordings`, {
            method: "POST",
            body: form,
          });
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            recording?: { url?: string };
          };
          if (!res.ok) throw new Error(data.error ?? "The recording could not be stored.");
          setUrl(data.recording?.url ?? null);
          setState("saved");
        } catch (err) {
          setState("error");
          setError(err instanceof Error ? err.message : "The recording could not be stored.");
        }
      });
    };
  }, [discussionId, enabled]);

  // ---- Keep the mix in step with who is currently able to speak -----------
  // Microphones are released when muted (see `useLivekitRoom`), so tracks come
  // and go throughout a session. Every track that arrives joins the mix and
  // every track that ends leaves it, so the recording holds exactly the audio
  // this client could hear.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !enabled) return;

    const live = new Set(tracks.filter((track) => track.readyState === "live"));
    for (const [track, source] of graph.sources) {
      if (!live.has(track)) {
        source.disconnect();
        graph.sources.delete(track);
      }
    }
    for (const track of live) {
      if (graph.sources.has(track)) continue;
      try {
        const source = graph.context.createMediaStreamSource(new MediaStream([track]));
        source.connect(graph.destination);
        graph.sources.set(track, source);
      } catch {
        /* a track that ended between the check and here is simply skipped */
      }
    }
  }, [tracks, enabled]);

  return { state, seconds, url, error };
}
