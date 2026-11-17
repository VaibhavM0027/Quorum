"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  CheckCircle2,
  Loader2,
  Mic,
  MicOff,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Volume2,
} from "lucide-react";

export type PreJoinResult = {
  micEnabled: boolean;
  camEnabled: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
};

type DeviceOption = {
  deviceId: string;
  label: string;
};

export default function PreJoinLobby({
  discussionId,
  title,
  topic,
  mode,
  userName,
  transcriptionEnabled,
  initialConsent,
  onEnter,
}: {
  discussionId: string;
  title: string;
  topic: string;
  mode: string;
  userName: string;
  transcriptionEnabled: boolean;
  initialConsent: boolean;
  onEnter: (result: PreJoinResult) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [camWanted, setCamWanted] = useState(true);
  const [micWanted, setMicWanted] = useState(true);
  const [audioDevices, setAudioDevices] = useState<DeviceOption[]>([]);
  const [videoDevices, setVideoDevices] = useState<DeviceOption[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<string>("");
  const [selectedVideoId, setSelectedVideoId] = useState<string>("");
  const [micLevel, setMicLevel] = useState(0);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [checkingDevices, setCheckingDevices] = useState(true);
  const [consent, setConsent] = useState(initialConsent);
  const [savingConsent, setSavingConsent] = useState(false);

  const [testingMicPlayback, setTestingMicPlayback] = useState(false);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);

  const stopPreview = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setMicLevel(0);
  }, []);

  const refreshDeviceList = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audios = devices
        .filter((d) => d.kind === "audioinput")
        .map((d, idx) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${idx + 1}` }));
      const videos = devices
        .filter((d) => d.kind === "videoinput")
        .map((d, idx) => ({ deviceId: d.deviceId, label: d.label || `Camera ${idx + 1}` }));
      setAudioDevices(audios);
      setVideoDevices(videos);
      if (audios.length > 0 && !selectedAudioId) setSelectedAudioId(audios[0].deviceId);
      if (videos.length > 0 && !selectedVideoId) setSelectedVideoId(videos[0].deviceId);
    } catch {
      /* device enumeration unavailable */
    }
  }, [selectedAudioId, selectedVideoId]);

  const startPreview = useCallback(async () => {
    stopPreview();
    setMediaError(null);
    setCheckingDevices(true);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setMediaError("Media capture is not supported in this browser. You can still join in listen-only mode.");
      setCamWanted(false);
      setMicWanted(false);
      setCheckingDevices(false);
      return;
    }

    if (!camWanted && !micWanted) {
      await refreshDeviceList();
      setCheckingDevices(false);
      return;
    }

    try {
      const constraints: MediaStreamConstraints = {
        audio: micWanted
          ? {
              echoCancellation: true,
              noiseSuppression: true,
              ...(selectedAudioId ? { deviceId: { exact: selectedAudioId } } : {}),
            }
          : false,
        video: camWanted
          ? selectedVideoId
            ? { deviceId: { exact: selectedVideoId }, width: { ideal: 640 }, height: { ideal: 360 } }
            : { width: { ideal: 640 }, height: { ideal: 360 } }
          : false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current && camWanted) {
        videoRef.current.srcObject = stream;
      }

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0 && typeof window !== "undefined") {
        const Ctor =
          window.AudioContext ??
          (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctor) {
          const ctx = new Ctor();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          const data = new Uint8Array(analyser.frequencyBinCount);
          const tick = () => {
            if (!audioCtxRef.current) return;
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (let i = 0; i < data.length; i += 1) {
              const dist = Math.abs(data[i] - 128) / 128;
              if (dist > peak) peak = dist;
            }
            setMicLevel(Math.min(100, Math.round(peak * 220)));
            rafRef.current = requestAnimationFrame(tick);
          };
          tick();
        }
      }

      await refreshDeviceList();
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const msg =
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "Camera or microphone permission was denied. Allow access in browser settings or join with devices off."
          : name === "NotFoundError" || name === "DevicesNotFoundError"
            ? "No working camera or microphone was detected. You can still enter the room in listen-only mode."
            : err instanceof Error
              ? err.message
              : "Could not access your camera or microphone.";
      setMediaError(msg);
      if (camWanted && micWanted) {
        // Retry audio-only gracefully if camera failed.
        try {
          const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          streamRef.current = audioOnly;
          setCamWanted(false);
          setMediaError("Camera unavailable — microphone is ready. You can still join audio-only.");
        } catch {
          setCamWanted(false);
          setMicWanted(false);
        }
      } else {
        setCamWanted(false);
        setMicWanted(false);
      }
    } finally {
      setCheckingDevices(false);
    }
  }, [camWanted, micWanted, refreshDeviceList, selectedAudioId, selectedVideoId, stopPreview]);

  useEffect(() => {
    void startPreview();
    return () => {
      stopPreview();
    };
  }, [startPreview, stopPreview]);

  useEffect(() => {
    return () => {
      if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
      if (playbackUrl) URL.revokeObjectURL(playbackUrl);
    };
  }, [playbackUrl]);

  const togglePlaybackTest = () => {
    if (testingMicPlayback && recorderRef.current) {
      recorderRef.current.stop();
      return;
    }
    const stream = streamRef.current;
    if (!stream || stream.getAudioTracks().length === 0 || typeof MediaRecorder === "undefined") return;
    if (playbackUrl) {
      URL.revokeObjectURL(playbackUrl);
      setPlaybackUrl(null);
    }
    try {
      const audioStream = new MediaStream(stream.getAudioTracks());
      const recorder = new MediaRecorder(audioStream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.onstop = () => {
        setTestingMicPlayback(false);
        if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
        if (chunks.length > 0) {
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          setPlaybackUrl(URL.createObjectURL(blob));
        }
      };
      recorderRef.current = recorder;
      setTestingMicPlayback(true);
      recorder.start();
      playbackTimerRef.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 3200);
    } catch {
      setTestingMicPlayback(false);
    }
  };

  const handleEnter = async () => {
    if (transcriptionEnabled && consent !== initialConsent) {
      setSavingConsent(true);
      try {
        await fetch(`/api/discussions/${discussionId}/consent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ consent }),
        });
      } catch {
        /* user can still toggle inside the room */
      } finally {
        setSavingConsent(false);
      }
    }
    stopPreview();
    onEnter({
      micEnabled: micWanted,
      camEnabled: camWanted,
      audioDeviceId: selectedAudioId || undefined,
      videoDeviceId: selectedVideoId || undefined,
    });
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-4xl flex-col justify-center px-5 py-8">
      <div className="card border-accent/30 bg-panel shadow-2xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-accent">
              <Sparkles className="h-3.5 w-3.5" /> Pre-meeting device check
            </p>
            <h1 className="mt-1 text-xl font-semibold text-ink">{title}</h1>
            <p className="mt-1 text-sm text-muted">{topic}</p>
          </div>
          <span className="pill">
            {mode === "AI_MODERATED" ? "AI moderated round-table" : "Free-flow discussion"}
          </span>
        </div>

        <div className="mt-5 grid gap-6 md:grid-cols-[1.2fr_1fr]">
          {/* Camera preview */}
          <div className="flex flex-col gap-3">
            <div className="relative aspect-video overflow-hidden rounded-xl border border-line bg-bg">
              {camWanted ? (
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className="h-full w-full -scale-x-100 object-cover"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted">
                  <span className="grid h-16 w-16 place-items-center rounded-full border border-accent/40 bg-panel-2 text-lg font-semibold uppercase text-ink">
                    {userName.slice(0, 2)}
                  </span>
                  <span className="text-xs">Camera is off</span>
                </div>
              )}

              <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 py-2.5">
                <span className="text-xs font-medium text-white">{userName}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMicWanted((v) => !v)}
                    className={micWanted ? "btn-primary px-2.5 py-1 text-xs" : "btn-ghost px-2.5 py-1 text-xs"}
                  >
                    {micWanted ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
                    {micWanted ? "Mic ON" : "Mic OFF"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCamWanted((v) => !v)}
                    className={camWanted ? "btn-primary px-2.5 py-1 text-xs" : "btn-ghost px-2.5 py-1 text-xs"}
                  >
                    {camWanted ? <Camera className="h-3.5 w-3.5" /> : <CameraOff className="h-3.5 w-3.5" />}
                    {camWanted ? "Cam ON" : "Cam OFF"}
                  </button>
                </div>
              </div>
            </div>

            {mediaError && (
              <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="flex-1">
                  <p>{mediaError}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setMicWanted(true);
                    setCamWanted(true);
                    void startPreview();
                  }}
                  className="inline-flex shrink-0 items-center gap-1 underline"
                >
                  <RefreshCw className="h-3 w-3" /> Retry
                </button>
              </div>
            )}
          </div>

          {/* Controls, selectors & audio level meter */}
          <div className="flex flex-col justify-between gap-4">
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-muted">
                  Microphone
                </label>
                <select
                  value={selectedAudioId}
                  onChange={(e) => setSelectedAudioId(e.target.value)}
                  disabled={audioDevices.length === 0 || !micWanted}
                  className="input mt-1 w-full text-sm"
                >
                  {audioDevices.length === 0 ? (
                    <option value="">Default microphone</option>
                  ) : (
                    audioDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))
                  )}
                </select>

                {/* Live AnalyserNode audio level meter */}
                <div className="mt-2.5 rounded-lg border border-line bg-panel-2 p-2.5">
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span className="flex items-center gap-1.5">
                      <Volume2 className="h-3.5 w-3.5 text-accent" /> Input level
                    </span>
                    <span className="font-mono text-[11px] tabular-nums">
                      {micWanted ? (micLevel > 6 ? "Receiving audio" : "Quiet") : "Muted"}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-bg">
                    <div
                      className="h-full rounded-full bg-accent transition-all duration-75"
                      style={{ width: `${micWanted ? Math.max(4, micLevel) : 0}%` }}
                    />
                  </div>

                  {micWanted && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={togglePlaybackTest}
                        className="btn-ghost px-2.5 py-1 text-xs"
                      >
                        {testingMicPlayback ? (
                          <>
                            <Square className="h-3 w-3 text-danger" /> Recording test (3s)…
                          </>
                        ) : (
                          <>
                            <Play className="h-3 w-3 text-accent" /> Test mic playback
                          </>
                        )}
                      </button>
                      {playbackUrl && (
                        <audio controls src={playbackUrl} className="h-7 max-w-[180px]" />
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-muted">
                  Camera
                </label>
                <select
                  value={selectedVideoId}
                  onChange={(e) => setSelectedVideoId(e.target.value)}
                  disabled={videoDevices.length === 0 || !camWanted}
                  className="input mt-1 w-full text-sm"
                >
                  {videoDevices.length === 0 ? (
                    <option value="">Default camera</option>
                  ) : (
                    videoDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))
                  )}
                </select>
              </div>

              {transcriptionEnabled && (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-panel-2 p-3 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    className="mt-0.5 accent-accent"
                  />
                  <span>
                    <span className="flex items-center gap-1 font-medium text-ink">
                      <ShieldCheck className="h-3.5 w-3.5 text-accent" /> Allow live speech transcription
                    </span>
                    Your speech is captured independently for the room transcript and evaluation report whenever your microphone is unmuted.
                  </span>
                </label>
              )}
            </div>

            <div className="flex flex-col gap-2 pt-2">
              {!micWanted && !camWanted && !mediaError && (
                <p className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-muted">
                  Joining with camera and microphone off (listen-only mode). You can turn devices on inside the room if needed.
                </p>
              )}
              <button
                type="button"
                onClick={() => void handleEnter()}
                disabled={checkingDevices || savingConsent}
                className="btn-primary w-full justify-center py-2.5 text-sm font-semibold"
              >
                {savingConsent || checkingDevices ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Join Meeting
              </button>
              <p className="text-center text-[11px] text-muted">
                You can adjust your microphone and camera anytime inside the meeting. All participant microphones pause automatically when the AI Moderator speaks.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
