"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Participant, Room as LKRoom, RemoteTrackPublication } from "livekit-client";

/**
 * LiveKit connection for a single discussion room.
 *
 * `livekit-client` is imported dynamically because it touches browser globals
 * and must never run during server rendering.
 */

export type LivekitStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export type TileInfo = {
  identity: string;
  name: string;
  isLocal: boolean;
  isHost: boolean;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
  micEnabled: boolean;
  camEnabled: boolean;
  speaking: boolean;
};

function parseHost(metadata: string | undefined): boolean {
  if (!metadata) return false;
  try {
    return Boolean((JSON.parse(metadata) as { isHost?: boolean }).isHost);
  } catch {
    return false;
  }
}

/** Reads the first published video/audio track for a participant. */
function describeParticipant(participant: Participant, isLocal: boolean): TileInfo {
  let videoTrack: MediaStreamTrack | null = null;
  let audioTrack: MediaStreamTrack | null = null;
  let camEnabled = false;
  let micEnabled = false;

  for (const publication of participant.videoTrackPublications.values()) {
    if (publication.track) {
      videoTrack = publication.track.mediaStreamTrack;
      camEnabled = !publication.isMuted;
      break;
    }
  }
  for (const publication of participant.audioTrackPublications.values()) {
    if (publication.track) {
      audioTrack = publication.track.mediaStreamTrack;
      micEnabled = !publication.isMuted;
      break;
    }
  }

  return {
    identity: participant.identity,
    name: participant.name || participant.identity,
    isLocal,
    isHost: parseHost(participant.metadata),
    videoTrack,
    audioTrack,
    micEnabled,
    camEnabled,
    speaking: participant.isSpeaking,
  };
}

export function useLivekitRoom(discussionId: string, shouldConnect: boolean) {
  const roomRef = useRef<LKRoom | null>(null);
  const [status, setStatus] = useState<LivekitStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tiles, setTiles] = useState<TileInfo[]>([]);
  const [micEnabled, setMicEnabled] = useState(false);
  const [camEnabled, setCamEnabled] = useState(false);
  const [needsAudioUnblock, setNeedsAudioUnblock] = useState(false);

  /** Rebuilds the tile list from the current room state. */
  const sync = useCallback(() => {
    const room = roomRef.current;
    if (!room) {
      setTiles([]);
      return;
    }
    const list: TileInfo[] = [describeParticipant(room.localParticipant, true)];
    for (const participant of room.remoteParticipants.values()) {
      list.push(describeParticipant(participant, false));
    }
    setTiles(list);
    setMicEnabled(room.localParticipant.isMicrophoneEnabled);
    setCamEnabled(room.localParticipant.isCameraEnabled);
  }, []);

  useEffect(() => {
    if (!shouldConnect) return;
    let disposed = false;

    async function connect() {
      setStatus("connecting");
      setError(null);
      try {
        const tokenRes = await fetch(`/api/livekit/token?discussionId=${encodeURIComponent(discussionId)}`, {
          cache: "no-store",
        });
        const data = (await tokenRes.json().catch(() => ({}))) as {
          error?: string;
          token?: string;
          url?: string;
        };
        if (!tokenRes.ok || !data.token || !data.url) {
          throw new Error(data.error ?? "Could not obtain a room token");
        }
        if (disposed) return;

        const lk = await import("livekit-client");
        if (disposed) return;

        const room = new lk.Room({
          adaptiveStream: true,
          dynacast: true,
          audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
        });
        roomRef.current = room;

        const onChange = () => sync();
        room
          .on(lk.RoomEvent.ParticipantConnected, onChange)
          .on(lk.RoomEvent.ParticipantDisconnected, onChange)
          .on(lk.RoomEvent.TrackPublished, onChange)
          .on(lk.RoomEvent.TrackUnpublished, onChange)
          .on(lk.RoomEvent.TrackSubscribed, onChange)
          .on(lk.RoomEvent.TrackUnsubscribed, onChange)
          .on(lk.RoomEvent.TrackMuted, onChange)
          .on(lk.RoomEvent.TrackUnmuted, onChange)
          .on(lk.RoomEvent.LocalTrackPublished, onChange)
          .on(lk.RoomEvent.LocalTrackUnpublished, onChange)
          .on(lk.RoomEvent.ActiveSpeakersChanged, onChange)
          .on(lk.RoomEvent.Reconnecting, () => setStatus("reconnecting"))
          .on(lk.RoomEvent.Reconnected, () => {
            setStatus("connected");
            sync();
          })
          .on(lk.RoomEvent.Disconnected, () => {
            setStatus("idle");
            roomRef.current = null;
            setTiles([]);
          });

        await room.connect(data.url, data.token);
        if (disposed) {
          await room.disconnect();
          return;
        }

        room.remoteParticipants.forEach((p: Participant) => {
          p.on("trackMuted", onChange);
        });

        setStatus("connected");
        // Browsers block remote audio until the user interacts with the page.
        setNeedsAudioUnblock(!room.canPlaybackAudio);
        sync();
      } catch (err) {
        if (disposed) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "Could not connect to the room");
      }
    }

    void connect();

    return () => {
      disposed = true;
      const room = roomRef.current;
      roomRef.current = null;
      if (room) void room.disconnect();
    };
  }, [discussionId, shouldConnect, sync]);

  /** Some browsers need a user gesture before remote audio is audible. */
  const startAudio = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.startAudio();
      setNeedsAudioUnblock(false);
    } catch {
      setNeedsAudioUnblock(true);
    }
  }, []);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled);
      sync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not access the microphone");
    }
  }, [sync]);

  /** Explicitly enables or disables the microphone (used when the host locks it). */
  const setMic = useCallback(
    async (enabled: boolean) => {
      const room = roomRef.current;
      if (!room) return;
      if (room.localParticipant.isMicrophoneEnabled === enabled) return;
      try {
        await room.localParticipant.setMicrophoneEnabled(enabled);
        sync();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not access the microphone");
      }
    },
    [sync],
  );

  const toggleCam = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled);
      sync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not access the camera");
    }
  }, [sync]);

  const disconnect = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) await room.disconnect();
    setTiles([]);
    setStatus("idle");
  }, []);

  return {
    status,
    error,
    tiles,
    micEnabled,
    camEnabled,
    needsAudioUnblock,
    startAudio,
    toggleMic,
    setMic,
    toggleCam,
    disconnect,
  };
}

export type { RemoteTrackPublication };
