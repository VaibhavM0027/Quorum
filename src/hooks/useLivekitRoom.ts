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
import {
  TRANSCRIPT_PARTIAL_TOPIC,
  TRANSCRIPT_UPDATE_TOPIC,
} from "@/lib/transcript";
import type { RoomStateBroadcast } from "@/lib/livekit";

const ROOM_STATE_TOPIC = "quorum.room.state";

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

export type TranscriptDraftMessage =
  | {
      type: "partial";
      streamId: string;
      revision: number;
      text: string;
      startedAt: string;
      participantIdentity: string;
      participantName: string;
    }
  | {
      type: "partial-cleared";
      streamId: string;
      revision: number;
      participantIdentity: string;
    };

export type LivekitConnectOptions = {
  initialMicEnabled?: boolean;
  initialCamEnabled?: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
  onRoomState?: (state: RoomStateBroadcast) => void;
};

function parseHost(metadata: string | undefined): boolean {
  if (!metadata) return false;
  try {
    return Boolean((JSON.parse(metadata) as { isHost?: boolean }).isHost);
  } catch {
    return false;
  }
}

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
  onTranscriptDraft?: (message: TranscriptDraftMessage) => void,
  options: LivekitConnectOptions = {},
) {
  const roomRef = useRef<LKRoom | null>(null);
  const onTranscriptUpdateRef = useRef(onTranscriptUpdate);
  onTranscriptUpdateRef.current = onTranscriptUpdate;
  const onTranscriptDraftRef = useRef(onTranscriptDraft);
  onTranscriptDraftRef.current = onTranscriptDraft;
  const onRoomStateRef = useRef(options.onRoomState);
  onRoomStateRef.current = options.onRoomState;

  const audioDeviceIdRef = useRef(options.audioDeviceId);
  audioDeviceIdRef.current = options.audioDeviceId;
  const videoDeviceIdRef = useRef(options.videoDeviceId);
  videoDeviceIdRef.current = options.videoDeviceId;

  const [status, setStatus] = useState<LivekitStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tiles, setTiles] = useState<TileInfo[]>([]);
  const [micEnabled, setMicEnabled] = useState(false);
  const [camEnabled, setCamEnabled] = useState(false);
  const [sfuCanPublish, setSfuCanPublish] = useState(true);
  const [serverSttActive, setServerSttActive] = useState(false);
  const [needsAudioUnblock, setNeedsAudioUnblock] = useState(false);

  const micWantedRef = useRef(Boolean(options.initialMicEnabled));
  const camWantedRef = useRef(Boolean(options.initialCamEnabled));

  // Keep pre-join preferences synced before the initial connect fires.
  useEffect(() => {
    if (status === "idle") {
      micWantedRef.current = Boolean(options.initialMicEnabled);
      camWantedRef.current = Boolean(options.initialCamEnabled);
    }
  }, [options.initialMicEnabled, options.initialCamEnabled, status]);

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
    if (room.localParticipant.permissions) {
      setSfuCanPublish(Boolean(room.localParticipant.permissions.canPublish));
    }
  }, []);

  const releaseLocalMic = useCallback(async (room: LKRoom) => {
    try {
      const publication = await room.localParticipant.setMicrophoneEnabled(false);
      const [anyAudio] = room.localParticipant.audioTrackPublications.values();
      const track = publication?.track ?? anyAudio?.track;
      if (track) {
        try {
          await room.localParticipant.unpublishTrack(track, true);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    sync();
  }, [sync]);

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
          canPublish?: boolean;
          serverSttActive?: boolean;
        };
        if (!tokenRes.ok || !data.token || !data.url) {
          throw new Error(data.error ?? "Could not obtain a room token");
        }
        if (disposed) return;

        setSfuCanPublish(data.canPublish !== false);
        setServerSttActive(Boolean(data.serverSttActive));

        const lk = await import("livekit-client");
        if (disposed) return;

        const room = new lk.Room({
          adaptiveStream: true,
          dynacast: true,
          audioCaptureDefaults: {
            echoCancellation: true,
            noiseSuppression: true,
            ...(audioDeviceIdRef.current ? { deviceId: audioDeviceIdRef.current } : {}),
          },
          videoCaptureDefaults: videoDeviceIdRef.current
            ? { deviceId: videoDeviceIdRef.current }
            : undefined,
        });
        roomRef.current = room;

        const onChange = () => sync();

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
          .on(lk.RoomEvent.ParticipantPermissionsChanged, (_prev, participant) => {
            if (participant === room.localParticipant) {
              const allowed = participant.permissions?.canPublish ?? true;
              setSfuCanPublish(allowed);
              if (!allowed && room.localParticipant.isMicrophoneEnabled) {
                void releaseLocalMic(room);
              } else {
                sync();
              }
            }
          })
          .on(lk.RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
            if (topic === ROOM_STATE_TOPIC) {
              try {
                const state = JSON.parse(new TextDecoder().decode(payload)) as RoomStateBroadcast;
                if (state?.type === "room-state") {
                  setServerSttActive(Boolean(state.serverSttActive));
                  const myIdentity = room.localParticipant.identity;
                  const mustMute =
                    state.aiSpeaking ||
                    state.paused ||
                    state.lockedIdentities.includes(myIdentity);
                  setSfuCanPublish(!mustMute);
                  if (mustMute && room.localParticipant.isMicrophoneEnabled) {
                    void releaseLocalMic(room);
                  }
                  onRoomStateRef.current?.(state);
                }
              } catch {
                /* ignore malformed room-state payload */
              }
              return;
            }
            if (topic === TRANSCRIPT_PARTIAL_TOPIC) {
              try {
                const message = JSON.parse(new TextDecoder().decode(payload)) as {
                  type?: unknown;
                  streamId?: unknown;
                  text?: unknown;
                  startedAt?: unknown;
                  revision?: unknown;
                  participantIdentity?: unknown;
                  participantName?: unknown;
                };
                const identity =
                  participant?.identity ??
                  (typeof message.participantIdentity === "string"
                    ? message.participantIdentity
                    : null);
                if (!identity || typeof message.streamId !== "string") return;
                if (
                  message.type === "partial" &&
                  typeof message.text === "string" &&
                  typeof message.startedAt === "string" &&
                  typeof message.revision === "number"
                ) {
                  onTranscriptDraftRef.current?.({
                    type: "partial",
                    streamId: message.streamId,
                    revision: message.revision,
                    text: message.text,
                    startedAt: message.startedAt,
                    participantIdentity: identity,
                    participantName:
                      participant?.name ||
                      (typeof message.participantName === "string"
                        ? message.participantName
                        : identity),
                  });
                } else if (
                  message.type === "partial-cleared" &&
                  typeof message.revision === "number"
                ) {
                  onTranscriptDraftRef.current?.({
                    type: "partial-cleared",
                    streamId: message.streamId,
                    revision: message.revision,
                    participantIdentity: identity,
                  });
                }
              } catch {
                transcriptWarn("invalid live transcript draft packet", {
                  identity: participant?.identity ?? null,
                });
              }
              return;
            }
            if (topic === TRANSCRIPT_UPDATE_TOPIC) onTranscriptUpdateRef.current?.();
          })
          .on(lk.RoomEvent.Reconnecting, () => setStatus("reconnecting"))
          .on(lk.RoomEvent.Reconnected, () => {
            setStatus("connected");
            sync();
          })
          .on(lk.RoomEvent.Disconnected, () => {
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
        setNeedsAudioUnblock(!room.canPlaybackAudio);

        const canPublishNow =
          data.canPublish !== false && (room.localParticipant.permissions?.canPublish ?? true);
        setSfuCanPublish(canPublishNow);

        if (micWantedRef.current && canPublishNow) {
          try {
            await room.localParticipant.setMicrophoneEnabled(
              true,
              audioDeviceIdRef.current ? { deviceId: audioDeviceIdRef.current } : undefined,
            );
          } catch {
            micWantedRef.current = false;
          }
        }
        if (camWantedRef.current) {
          try {
            await room.localParticipant.setCameraEnabled(
              true,
              videoDeviceIdRef.current ? { deviceId: videoDeviceIdRef.current } : undefined,
            );
          } catch {
            camWantedRef.current = false;
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
  }, [discussionId, breakoutRoom, shouldConnect, sync, releaseLocalMic]);

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
   * Authoritatively verifies microphone permission with the server before
   * publishing audio. Server rejects unmute requests whenever AI is speaking,
   * the host locked the mic, or the meeting is paused.
   */
  const applyMic = useCallback(
    async (enabled: boolean, notifyServer = true): Promise<string | null> => {
      const room = roomRef.current;
      if (!room) return null;

      if (enabled && notifyServer) {
        try {
          const gateRes = await fetch(`/api/discussions/${discussionId}/mic`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: true }),
          });
          if (!gateRes.ok) {
            const gateData = (await gateRes.json().catch(() => ({}))) as { error?: string };
            setSfuCanPublish(false);
            if (room.localParticipant.isMicrophoneEnabled) {
              await releaseLocalMic(room);
            }
            return gateData.error ?? "Your microphone is currently locked.";
          }
          setSfuCanPublish(true);
        } catch {
          return "Could not verify microphone permission with the server.";
        }
      }

      if (room.localParticipant.isMicrophoneEnabled === enabled) {
        if (!enabled) micWantedRef.current = false;
        return null;
      }

      setError(null);
      try {
        const publication = await room.localParticipant.setMicrophoneEnabled(
          enabled,
          enabled && audioDeviceIdRef.current ? { deviceId: audioDeviceIdRef.current } : undefined,
        );
        if (!enabled) {
          const [anyAudio] = room.localParticipant.audioTrackPublications.values();
          const track = publication?.track ?? anyAudio?.track;
          if (track) {
            try {
              await room.localParticipant.unpublishTrack(track, true);
            } catch {
              /* ignore */
            }
          }
          if (notifyServer) {
            void fetch(`/api/discussions/${discussionId}/mic`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ enabled: false }),
              keepalive: true,
            }).catch(() => {});
          }
        }
        micWantedRef.current = enabled;
        transcriptLog(enabled ? "local microphone published" : "local microphone released", {
          sid: publication?.trackSid ?? null,
        });
        sync();
        return null;
      } catch (err) {
        micWantedRef.current = false;
        setMicEnabled(false);
        transcriptWarn("could not change the microphone", {
          error: err instanceof Error ? err.message : String(err),
        });
        return micErrorMessage(err);
      }
    },
    [discussionId, releaseLocalMic, sync],
  );

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const failure = await applyMic(!room.localParticipant.isMicrophoneEnabled, true);
    if (failure) setError(failure);
  }, [applyMic]);

  const setMic = useCallback(
    async (enabled: boolean) => {
      const failure = await applyMic(enabled, enabled);
      if (failure && enabled) setError(failure);
    },
    [applyMic],
  );

  const toggleCam = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      const next = !room.localParticipant.isCameraEnabled;
      await room.localParticipant.setCameraEnabled(
        next,
        next && videoDeviceIdRef.current ? { deviceId: videoDeviceIdRef.current } : undefined,
      );
      camWantedRef.current = next;
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

  const publishTranscriptDraft = useCallback(
    (message: {
      type: "partial" | "partial-cleared";
      streamId: string;
      revision: number;
      text?: string;
      startedAt?: string;
    }) => {
      const room = roomRef.current;
      if (!room) return;
      const topic = TRANSCRIPT_PARTIAL_TOPIC;
      void room.localParticipant
        .publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable: true, topic })
        .catch((cause: unknown) => {
          transcriptWarn("could not publish live transcript draft", {
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
    },
    [],
  );

  return {
    status,
    error,
    tiles,
    micEnabled,
    camEnabled,
    sfuCanPublish,
    serverSttActive,
    needsAudioUnblock,
    startAudio,
    toggleMic,
    setMic,
    toggleCam,
    disconnect,
    publishTranscriptDraft,
  };
}

export type { RemoteTrackPublication };
