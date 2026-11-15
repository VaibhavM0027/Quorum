"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LocalTrackPublication,
  Participant,
  RemoteTrack,
  RemoteTrackPublication,
  Room as LKRoom,
} from "livekit-client";
import { transcriptLog, transcriptWarn } from "@/lib/debug-log";
import { TRANSCRIPT_UPDATE_TOPIC } from "@/lib/transcript";

/**
 * LiveKit connection for a single discussion room.
 *
 * `breakoutRoom` names the group this browser belongs in: null is the main
 * room, a number is that breakout group's own room. Changing it reconnects the
 * client, which is how a student follows the host's allocation.
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

/** Turns a getUserMedia failure into something a participant can act on. */
function micErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";

  if (name === "NotAllowedError" || name === "PermissionDeniedError" || /permission|denied/i.test(message)) {
    return "Microphone access is blocked. Allow microphone permission for this site, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || /device.*not.*found/i.test(message)) {
    return "No microphone was found on this device.";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || /in use|could not start/i.test(message)) {
    return "Another application is using your microphone. Close it and try again.";
  }
  return message || "Could not access the microphone";
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

export function useLivekitRoom(
  discussionId: string,
  breakoutRoom: number | null,
  shouldConnect: boolean,
  onTranscriptUpdate?: () => void,
) {
  const roomRef = useRef<LKRoom | null>(null);
  const onTranscriptUpdateRef = useRef(onTranscriptUpdate);
  onTranscriptUpdateRef.current = onTranscriptUpdate;
  const [status, setStatus] = useState<LivekitStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tiles, setTiles] = useState<TileInfo[]>([]);
  const [micEnabled, setMicEnabled] = useState(false);
  const [camEnabled, setCamEnabled] = useState(false);
  const [needsAudioUnblock, setNeedsAudioUnblock] = useState(false);
  /**
   * The microphone state the participant last chose.
   *
   * Moving to a breakout room tears the connection down and builds a new one,
   * and a fresh connection starts with the microphone off. Remembering the
   * choice lets it be restored, so being moved to a group does not silently
   * mute someone who was taking part.
   */
  const micWantedRef = useRef(false);

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
        const params = new URLSearchParams({ discussionId });
        if (breakoutRoom !== null) params.set("room", String(breakoutRoom));
        const tokenRes = await fetch(`/api/livekit/token?${params.toString()}`, {
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

        // The media path is logged at every step, because "this participant is
        // audible" and "this participant is being transcribed" are different
        // facts: audio arriving over LiveKit never becomes a transcript by
        // itself, and only the microphone owner's own browser can transcribe it.
        const onParticipantConnected = (participant: Participant) => {
          transcriptLog("participant connected", {
            identity: participant.identity,
            name: participant.name || participant.identity,
          });
          sync();
        };
        const onParticipantDisconnected = (participant: Participant) => {
          transcriptLog("participant disconnected", { identity: participant.identity });
          sync();
        };
        const onTrackPublished = (publication: RemoteTrackPublication, participant: Participant) => {
          transcriptLog("remote track published", {
            identity: participant.identity,
            kind: publication.kind,
            sid: publication.trackSid,
            muted: publication.isMuted,
          });
          sync();
        };
        const onTrackSubscribed = (
          track: RemoteTrack,
          publication: RemoteTrackPublication,
          participant: Participant,
        ) => {
          transcriptLog("remote track subscribed", {
            identity: participant.identity,
            kind: publication.kind,
            sid: publication.trackSid,
            device: track.mediaStreamTrack.label,
          });
          sync();
        };
        const onTrackUnsubscribed = (
          track: RemoteTrack,
          publication: RemoteTrackPublication,
          participant: Participant,
        ) => {
          transcriptLog("remote track unsubscribed", {
            identity: participant.identity,
            kind: publication.kind,
            sid: publication.trackSid,
            device: track.mediaStreamTrack.label,
          });
          sync();
        };
        const onLocalTrackPublished = (publication: LocalTrackPublication) => {
          transcriptLog("local track published", {
            kind: publication.kind,
            sid: publication.trackSid,
            muted: publication.isMuted,
          });
          sync();
        };

        room
          .on(lk.RoomEvent.ParticipantConnected, onParticipantConnected)
          .on(lk.RoomEvent.ParticipantDisconnected, onParticipantDisconnected)
          .on(lk.RoomEvent.TrackPublished, onTrackPublished)
          .on(lk.RoomEvent.TrackUnpublished, onChange)
          .on(lk.RoomEvent.TrackSubscribed, onTrackSubscribed)
          .on(lk.RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
          .on(lk.RoomEvent.TrackMuted, onChange)
          .on(lk.RoomEvent.TrackUnmuted, onChange)
          .on(lk.RoomEvent.LocalTrackPublished, onLocalTrackPublished)
          .on(lk.RoomEvent.LocalTrackUnpublished, onChange)
          .on(lk.RoomEvent.ActiveSpeakersChanged, onChange)
          .on(lk.RoomEvent.DataReceived, (_payload, _participant, _kind, topic) => {
            if (topic === TRANSCRIPT_UPDATE_TOPIC) {
              onTranscriptUpdateRef.current?.();
            }
          })
          .on(lk.RoomEvent.Reconnecting, () => setStatus("reconnecting"))
          .on(lk.RoomEvent.Reconnected, () => {
            setStatus("connected");
            sync();
          })
          .on(lk.RoomEvent.Disconnected, () => {
            // A room we have already moved on from can report its disconnect
            // after the new one is up; ignoring it stops that late event from
            // clearing the room we are actually in.
            if (roomRef.current !== room) return;
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

        // A new connection starts muted; put back the microphone state the
        // participant had chosen before they were moved.
        if (micWantedRef.current) {
          try {
            await room.localParticipant.setMicrophoneEnabled(true);
          } catch {
            // The device may have gone; never claim a microphone that is not there.
            micWantedRef.current = false;
          }
        }

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
  }, [discussionId, breakoutRoom, shouldConnect, sync]);

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

  /**
   * Turns the microphone on or off. Returns an error message, or null on success.
   *
   * Switching it off does two things: the published track is muted (so not a
   * single audio packet leaves the browser) *and* the capture device is released.
   * Muting alone would leave `MediaStreamTrack.enabled = false` capturing, which
   * is why the browser keeps showing its recording indicator and why anything
   * reading the microphone — such as the audio chunk recorder — keeps hearing the
   * room. Releasing the device is what makes "microphone off" true rather than a
   * label. Switching it back on republishes through LiveKit's normal path.
   *
   * Because nothing stays published while the microphone is off, a reconnection
   * has nothing to bring back: the microphone cannot come on by itself.
   */
  const applyMic = useCallback(
    async (enabled: boolean): Promise<string | null> => {
      const room = roomRef.current;
      if (!room) return null;
      if (room.localParticipant.isMicrophoneEnabled === enabled) {
        micWantedRef.current = enabled;
        return null;
      }

      setError(null);
      try {
        const publication = await room.localParticipant.setMicrophoneEnabled(enabled);
        if (!enabled) {
          const [anyAudio] = room.localParticipant.audioTrackPublications.values();
          const track = publication?.track ?? anyAudio?.track;
          // `stopOnUnpublish` stops the underlying MediaStreamTrack, releasing
          // the device. Failing here is not fatal: the track is already muted.
          if (track) {
            try {
              await room.localParticipant.unpublishTrack(track, true);
            } catch {
              /* the mute above already stops any transmission */
            }
          }
        }
        micWantedRef.current = enabled;
        transcriptLog(enabled ? "local microphone published" : "local microphone released", {
          sid: publication?.trackSid ?? null,
        });
        sync();
        return null;
      } catch (err) {
        // Never leave the UI claiming a microphone that is not there.
        micWantedRef.current = false;
        setMicEnabled(false);
        transcriptWarn("could not change the microphone", {
          error: err instanceof Error ? err.message : String(err),
        });
        return micErrorMessage(err);
      }
    },
    [sync],
  );

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const failure = await applyMic(!room.localParticipant.isMicrophoneEnabled);
    if (failure) setError(failure);
  }, [applyMic]);

  /** Explicitly enables or disables the microphone (used when the host locks it). */
  const setMic = useCallback(
    async (enabled: boolean) => {
      const failure = await applyMic(enabled);
      if (failure) setError(failure);
    },
    [applyMic],
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
