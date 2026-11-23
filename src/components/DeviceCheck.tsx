"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Camera,
  Check,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  ShieldCheck,
  VideoOff,
  Volume2,
  Wifi,
} from "lucide-react";

export type RoomDevicePreferences = {
  microphoneId: string;
  cameraId: string;
  speakerId: string;
  cameraOn: boolean;
};

type DeviceOption = { deviceId: string; label: string };
type CheckStatus = "unchecked" | "ready" | "blocked" | "missing" | "unavailable";
type Selection = Pick<RoomDevicePreferences, "microphoneId" | "cameraId" | "speakerId">;

const EMPTY_DEVICES = {
  audioinput: [] as DeviceOption[],
  videoinput: [] as DeviceOption[],
  audiooutput: [] as DeviceOption[],
};

function mediaError(error: unknown, device: "microphone" | "camera"): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return `${device === "microphone" ? "Microphone" : "Camera"} access is blocked. Allow access in your browser's site settings, then retry.`;
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return `No working ${device} was found. Choose another device or continue without it.`;
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return `The ${device} could not start. Close other apps using it and retry.`;
  }
  return `Could not start the ${device}. Check the device connection and try again.`;
}

function deviceOptions(devices: MediaDeviceInfo[], kind: MediaDeviceKind): DeviceOption[] {
  return devices
    .filter((device) => device.kind === kind)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `${kind === "audioinput" ? "Microphone" : kind === "videoinput" ? "Camera" : "Speaker"} ${index + 1}`,
    }));
}

export default function DeviceCheck({
  title,
  topic,
  joining = false,
  onContinue,
}: {
  title: string;
  topic: string;
  joining?: boolean;
  onContinue: (preferences: RoomDevicePreferences) => void;
}) {
  const [devices, setDevices] = useState(EMPTY_DEVICES);
  const [selection, setSelection] = useState<Selection>({
    microphoneId: "",
    cameraId: "",
    speakerId: "",
  });
  const [cameraOn, setCameraOn] = useState(false);
  const [micStatus, setMicStatus] = useState<CheckStatus>("unchecked");
  const [cameraStatus, setCameraStatus] = useState<CheckStatus>("unchecked");
  const [micError, setMicError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [deviceListError, setDeviceListError] = useState<string | null>(null);
  const [monitorError, setMonitorError] = useState<string | null>(null);
  const [monitoring, setMonitoring] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [checking, setChecking] = useState(false);
  const [hasChecked, setHasChecked] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const lastMeterUpdateRef = useRef(0);
  const monitorAudioRef = useRef<HTMLAudioElement | null>(null);
  const monitorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  const stopMonitor = useCallback(() => {
    if (monitorTimerRef.current) clearTimeout(monitorTimerRef.current);
    monitorTimerRef.current = null;
    const audio = monitorAudioRef.current;
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      monitorAudioRef.current = null;
    }
    setMonitoring(false);
  }, []);

  const releaseCapture = useCallback(() => {
    requestIdRef.current += 1;
    stopMonitor();
    if (meterFrameRef.current !== null) cancelAnimationFrame(meterFrameRef.current);
    meterFrameRef.current = null;
    if (contextRef.current) void contextRef.current.close();
    contextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setMicLevel(0);
  }, [stopMonitor]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDeviceListError("Device selection is not supported in this browser; default devices will be used.");
      return;
    }
    try {
      const found = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        audioinput: deviceOptions(found, "audioinput"),
        videoinput: deviceOptions(found, "videoinput"),
        audiooutput: deviceOptions(found, "audiooutput"),
      });
      setDeviceListError(null);
    } catch {
      setDeviceListError("Could not list devices. The browser's default devices can still be used.");
    }
  }, []);

  const startMeter = useCallback((stream: MediaStream) => {
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;
    try {
      const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
      const AudioContextCtor = window.AudioContext ?? audioWindow.webkitAudioContext;
      if (!AudioContextCtor) return;
      const context = new AudioContextCtor();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(new MediaStream([audioTrack])).connect(analyser);
      contextRef.current = context;
      const samples = new Uint8Array(analyser.fftSize);
      const update = (timestamp: number) => {
        if (timestamp - lastMeterUpdateRef.current >= 100) {
          lastMeterUpdateRef.current = timestamp;
          analyser.getByteTimeDomainData(samples);
          let energy = 0;
          for (const sample of samples) {
            const value = (sample - 128) / 128;
            energy += value * value;
          }
          setMicLevel(Math.min(100, Math.round(Math.sqrt(energy / samples.length) * 260)));
        }
        meterFrameRef.current = requestAnimationFrame(update);
      };
      meterFrameRef.current = requestAnimationFrame(update);
    } catch {
      setMicError("Microphone access works, but this browser cannot display the live input meter.");
    }
  }, []);

  const checkDevices = useCallback(
    async (nextSelection: Selection = selection) => {
      releaseCapture();
      setChecking(true);
      setMicError(null);
      setCameraError(null);
      setMonitorError(null);
      setMicStatus("unchecked");
      setCameraStatus("unchecked");

      if (!navigator.mediaDevices?.getUserMedia) {
        setMicStatus("unavailable");
        setCameraStatus("unavailable");
        setMicError("This browser does not support microphone capture.");
        setCameraError("This browser does not support camera capture.");
        setHasChecked(true);
        setChecking(false);
        return;
      }

      const requestId = requestIdRef.current;
      const audioConstraint: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        ...(nextSelection.microphoneId ? { deviceId: { exact: nextSelection.microphoneId } } : {}),
      };
      const videoConstraint: MediaTrackConstraints = nextSelection.cameraId
        ? { deviceId: { exact: nextSelection.cameraId } }
        : {};
      const [audioResult, videoResult] = await Promise.allSettled([
        navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false }),
        navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraint }),
      ]);

      if (requestId !== requestIdRef.current) {
        for (const result of [audioResult, videoResult]) {
          if (result.status === "fulfilled") result.value.getTracks().forEach((track) => track.stop());
        }
        return;
      }

      const streams = [audioResult, videoResult]
        .filter((result): result is PromiseFulfilledResult<MediaStream> => result.status === "fulfilled")
        .map((result) => result.value);
      const tracks = streams.flatMap((stream) => stream.getTracks());
      const combined = tracks.length ? new MediaStream(tracks) : null;
      streamRef.current = combined;
      if (combined && videoRef.current) {
        const cameraTrack = combined.getVideoTracks()[0];
        if (cameraTrack) {
          videoRef.current.srcObject = new MediaStream([cameraTrack]);
          void videoRef.current.play().catch(() => {
            setCameraStatus("blocked");
            setCameraError("Camera was detected, but its preview could not play. Check browser permissions and retry.");
          });
        }
      }

      if (audioResult.status === "fulfilled" && audioResult.value.getAudioTracks().length) {
        setMicStatus("ready");
        startMeter(combined ?? audioResult.value);
      } else {
        const reason = audioResult.status === "rejected" ? audioResult.reason : new Error("No microphone was found.");
        const unavailable = reason instanceof Error && reason.name === "NotFoundError";
        setMicStatus(unavailable ? "missing" : "blocked");
        setMicError(mediaError(reason, "microphone"));
      }
      if (videoResult.status === "fulfilled" && videoResult.value.getVideoTracks().length) {
        setCameraStatus("ready");
      } else {
        const reason = videoResult.status === "rejected" ? videoResult.reason : new Error("No camera was found.");
        const unavailable = reason instanceof Error && reason.name === "NotFoundError";
        setCameraStatus(unavailable ? "missing" : "blocked");
        setCameraError(mediaError(reason, "camera"));
      }

      setHasChecked(true);
      setChecking(false);
      await refreshDevices();
    },
    [refreshDevices, releaseCapture, selection, startMeter],
  );

  useEffect(() => {
    void refreshDevices();
    const onDeviceChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      releaseCapture();
    };
  }, [refreshDevices, releaseCapture]);

  async function monitorMicrophone() {
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) return;
    stopMonitor();
    setMonitorError(null);
    const audio = new Audio();
    audio.volume = 0.18;
    audio.srcObject = new MediaStream([track]);
    const output = audio as HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
    try {
      if (selection.speakerId && !output.setSinkId) {
        throw new Error("This browser cannot select a speaker output.");
      }
      if (selection.speakerId) await output.setSinkId(selection.speakerId);
      await audio.play();
      monitorAudioRef.current = audio;
      setMonitoring(true);
      monitorTimerRef.current = setTimeout(stopMonitor, 2000);
    } catch (cause) {
      audio.srcObject = null;
      setMonitorError(
        cause instanceof Error
          ? cause.message
          : "Could not play the microphone monitor. Check speaker permission and volume.",
      );
    }
  }

  function continueToRoom(withCamera: boolean) {
    releaseCapture();
    onContinue({
      ...selection,
      cameraOn: withCamera && cameraStatus === "ready",
    });
  }

  const statusText = (status: CheckStatus) =>
    status === "ready"
      ? "Ready"
      : status === "blocked"
        ? "Access blocked"
        : status === "missing"
          ? "Not found"
          : status === "unavailable"
            ? "Unavailable"
            : "Needs check";

  return (
    <main className="min-h-dvh bg-[radial-gradient(ellipse_at_top,#1b3026_0%,#0e1512_52%)] px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-7 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent font-bold text-[#06170f]">Q</span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Quorum · Device check</p>
            <p className="truncate text-xs text-muted">{title} · {topic}</p>
          </div>
          <span className="pill ml-auto hidden sm:inline-flex"><ShieldCheck className="h-3.5 w-3.5" /> Private device test</span>
        </header>

        <div className="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
          <section className="card overflow-hidden !p-0">
            <div className="relative aspect-video min-h-[220px] bg-[#080d0a]">
              <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
              {cameraStatus !== "ready" && (
                <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle,#25392e,#101713)] p-6 text-center">
                  <div>
                    <span className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full border border-line bg-panel text-muted">
                      <VideoOff className="h-7 w-7" />
                    </span>
                    <p className="font-medium">Camera preview will appear here</p>
                    <p className="mt-1 text-sm text-muted">You can join with your camera off.</p>
                  </div>
                </div>
              )}
              <span className="absolute bottom-3 left-3 rounded-full border border-white/10 bg-black/70 px-3 py-1 text-xs text-white">
                {cameraStatus === "ready" ? "Camera preview · local only" : "Camera off"}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4">
              <label className="flex cursor-pointer items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={cameraOn}
                  onChange={(event) => setCameraOn(event.target.checked)}
                  disabled={cameraStatus !== "ready"}
                  className="h-4 w-4 accent-emerald-400"
                />
                Enter with camera on
              </label>
              <span className="text-xs text-muted">Your microphone always enters muted.</span>
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <div className="card">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"><Mic className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h1 className="font-semibold">Microphone</h1>
                    <span className={`pill ${micStatus === "ready" ? "border-accent/40 text-accent" : ""}`}>
                      {micStatus === "ready" && <Check className="h-3 w-3" />}{statusText(micStatus)}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center gap-1" role="meter" aria-label="Live microphone input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={micLevel}>
                    {Array.from({ length: 20 }, (_, index) => (
                      <span key={index} className={`h-2 flex-1 rounded-full ${index < micLevel / 5 ? "bg-accent" : "bg-input"}`} />
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted">{micStatus === "ready" ? "Speak to see the input indicator move." : "Check your microphone to see the live input level."}</p>
                </div>
              </div>
              <label className="label mt-4" htmlFor="device-microphone">Microphone</label>
              <select id="device-microphone" className="field" disabled={joining} value={selection.microphoneId} onChange={(event) => {
                const next = { ...selection, microphoneId: event.target.value };
                setSelection(next);
                if (hasChecked) void checkDevices(next);
              }}>
                <option value="">Default microphone</option>
                {devices.audioinput.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
              </select>
              {micError && <p className="mt-2 flex gap-2 text-xs text-warn" role="status"><AlertCircle className="h-4 w-4 shrink-0" />{micError}</p>}
              <button type="button" className="btn-ghost mt-3 w-full" onClick={() => void monitorMicrophone()} disabled={joining || micStatus !== "ready" || monitoring}>
                <Headphones className="h-4 w-4" />{monitoring ? "Monitoring for 2 seconds…" : "Briefly monitor my microphone"}
              </button>
              <p className="mt-2 text-xs text-muted">Live monitor only; no audio is recorded or saved. Headphones help prevent echo.</p>
              {monitorError && <p className="mt-2 text-xs text-danger" role="alert">{monitorError}</p>}
            </div>

            <div className="card">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><Camera className="h-5 w-5" /></span>
                  <h2 className="font-semibold">Camera</h2>
                </div>
                <span className={`pill ${cameraStatus === "ready" ? "border-accent/40 text-accent" : ""}`}>
                  {cameraStatus === "ready" && <Check className="h-3 w-3" />}{statusText(cameraStatus)}
                </span>
              </div>
              <label className="label mt-4" htmlFor="device-camera">Camera</label>
              <select id="device-camera" className="field" disabled={joining} value={selection.cameraId} onChange={(event) => {
                const next = { ...selection, cameraId: event.target.value };
                setSelection(next);
                if (hasChecked) void checkDevices(next);
              }}>
                <option value="">Default camera</option>
                {devices.videoinput.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
              </select>
              {cameraError && <p className="mt-2 flex gap-2 text-xs text-warn" role="status"><AlertCircle className="h-4 w-4 shrink-0" />{cameraError}</p>}
            </div>
          </section>
        </div>

        <section className="card mt-5">
          <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <div className="flex items-center gap-2">
                <Volume2 className="h-4 w-4 text-accent" />
                <h2 className="font-semibold">Speaker</h2>
              </div>
              <label className="label mt-3" htmlFor="device-speaker">Audio output</label>
              <select id="device-speaker" className="field" disabled={joining} value={selection.speakerId} onChange={(event) => setSelection((current) => ({ ...current, speakerId: event.target.value }))}>
                <option value="">Default speaker</option>
                {devices.audiooutput.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
              </select>
              {!devices.audiooutput.length && hasChecked && <p className="mt-2 text-xs text-muted">This browser does not expose selectable output devices; the system default will be used.</p>}
              {deviceListError && <p className="mt-2 text-xs text-warn" role="status">{deviceListError}</p>}
            </div>
            <button type="button" className="btn-ghost" onClick={() => void checkDevices()} disabled={checking || joining}>
              {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
              {checking ? "Checking devices…" : hasChecked ? "Check again" : "Check camera & microphone"}
            </button>
          </div>
        </section>

        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost" onClick={() => continueToRoom(false)} disabled={!hasChecked || checking || joining}>
            {joining ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {joining ? "Joining…" : "Continue without camera"}
          </button>
          <button type="button" className="btn-primary" onClick={() => continueToRoom(cameraOn)} disabled={!hasChecked || checking || joining}>
            {joining ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {joining ? "Joining…" : "Join discussion"}
          </button>
        </div>
        <p className="mt-4 flex items-center justify-center gap-2 text-center text-xs text-muted">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          Device check media stays in this browser and is stopped before you join. It is not recorded or retained.
        </p>
      </div>
    </main>
  );
}
