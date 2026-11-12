"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Loader2,
  Play,
  Square,
  Users2,
  LogOut,
  Copy,
  Check,
  Crown,
  Clock,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Volume2,
  Radio,
  WifiOff,
  ScrollText,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import MediaTrack from "@/components/MediaTrack";
import LiveMonitorPanel, {
  type LiveStat,
  type ParticipantAction,
} from "@/components/LiveMonitorPanel";
import { useLivekitRoom, type TileInfo } from "@/hooks/useLivekitRoom";
import { useSpeechTranscription, type FinalSegment } from "@/hooks/useSpeechTranscription";

export type RoomParticipant = {
  id: string;
  userId: string;
  name: string;
  isHost: boolean;
  joinedAt: string | null;
  leftAt: string | null;
  removed: boolean;
  micLocked: boolean;
  transcriptionConsent: boolean;
};

export type RoomDiscussion = {
  id: string;
  title: string;
  topic: string;
  context: string;
  rules: string;
  status: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  mode: string;
  joinCode: string;
  durationMin: number;
  maxParticipants: number;
  aiEnabled: boolean;
  transcriptionEnabled: boolean;
  silencePromptSec: number;
  scheduledAt: string;
  startedAt: string | null;
  endedAt: string | null;
  hostName: string;
  isHost: boolean;
  participants: RoomParticipant[];
};

type RoomUser = { id: string; name: string; email: string; role: "HOST" | "PARTICIPANT" };

type TranscriptEntry = {
  id: string;
  participantId: string;
  speaker: string;
  speakerIsHost: boolean;
  isMine: boolean;
  text: string;
  startedAt: string;
  durationMs: number;
  wordCount: number;
};

const POLL_MS = 5000;
const TRANSCRIPT_POLL_MS = 4000;
const AI_EVENTS_POLL_MS = 6000;
const AI_TICK_MS = 15_000;

/** How long without speaking before the monitor marks someone as quiet. */
const QUIET_AFTER_MS = 120_000;

type AiEventEntry = {
  id: string;
  kind: string;
  message: string;
  participantName: string | null;
  createdAt: string;
};

const AI_KIND_LABEL: Record<string, string> = {
  QUESTION: "Question",
  NUDGE: "Invitation",
  SILENCE: "Silence",
  RELEVANCE: "Stay on topic",
  SUMMARY: "Summary",
};

export default function RoomClient({
  user,
  discussion: initial,
  participantId,
}: {
  user: RoomUser;
  discussion: RoomDiscussion;
  participantId: string | null;
}) {
  const router = useRouter();
  const [discussion, setDiscussion] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const isLive = discussion.status === "LIVE";
  const media = useLivekitRoom(discussion.id, isLive && Boolean(participantId));

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/discussions/${initial.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { discussion: RoomDiscussion };
      setDiscussion(data.discussion);
    } catch {
      /* transient network errors are ignored; the next poll retries */
    }
  }, [initial.id]);

  useEffect(() => {
    if (discussion.status === "COMPLETED" || discussion.status === "CANCELLED") return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [discussion.status, refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // ---- Live transcription --------------------------------------------------
  const transcriptRef = useRef<HTMLOListElement | null>(null);
  const [segments, setSegments] = useState<TranscriptEntry[]>([]);
  const [consentBusy, setConsentBusy] = useState(false);

  const myMembership = discussion.participants.find((p) => p.userId === user.id) ?? null;
  const consented = Boolean(myMembership && !myMembership.removed && myMembership.transcriptionConsent);

  const loadTranscript = useCallback(async () => {
    try {
      const res = await fetch(`/api/discussions/${initial.id}/transcript`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { segments: TranscriptEntry[] };
      setSegments(data.segments);
    } catch {
      /* transient network errors are ignored; the next poll retries */
    }
  }, [initial.id]);

  useEffect(() => {
    if (!discussion.transcriptionEnabled || discussion.status === "SCHEDULED") return;
    void loadTranscript();
    if (discussion.status === "COMPLETED" || discussion.status === "CANCELLED") return;
    const timer = setInterval(() => void loadTranscript(), TRANSCRIPT_POLL_MS);
    return () => clearInterval(timer);
  }, [discussion.transcriptionEnabled, discussion.status, loadTranscript]);

  const postSegment = useCallback(
    async (segment: FinalSegment) => {
      try {
        await fetch(`/api/discussions/${discussion.id}/transcript`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: segment.text,
            startedAt: segment.startedAt.toISOString(),
            endedAt: segment.endedAt.toISOString(),
            durationMs: segment.durationMs,
          }),
        });
        void loadTranscript();
      } catch {
        /* the next utterance retries */
      }
    },
    [discussion.id, loadTranscript],
  );

  const canTranscribe = isLive && discussion.transcriptionEnabled && consented && Boolean(participantId);
  const speech = useSpeechTranscription({ enabled: canTranscribe, onSegment: postSegment });

  // Keep the transcript pinned to the newest line.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments.length, speech.interim]);

  const setConsent = useCallback(
    async (next: boolean) => {
      setConsentBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/discussions/${discussion.id}/consent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ consent: next }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Could not save your choice");
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save your choice");
      } finally {
        setConsentBusy(false);
      }
    },
    [discussion.id, refresh],
  );

  // ---- AI discussion assistant --------------------------------------------
  const [aiEvents, setAiEvents] = useState<AiEventEntry[]>([]);

  const loadAiEvents = useCallback(async () => {
    try {
      const res = await fetch(`/api/discussions/${initial.id}/ai/events`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { events: AiEventEntry[] };
      setAiEvents(data.events);
    } catch {
      /* transient network errors are ignored; the next poll retries */
    }
  }, [initial.id]);

  const runAiTick = useCallback(async () => {
    try {
      await fetch(`/api/discussions/${initial.id}/ai/tick`, { method: "POST" });
      await loadAiEvents();
    } catch {
      /* the assistant simply tries again on the next tick */
    }
  }, [initial.id, loadAiEvents]);

  useEffect(() => {
    if (!discussion.aiEnabled || discussion.status !== "LIVE") return;
    void loadAiEvents();
    const eventsTimer = setInterval(() => void loadAiEvents(), AI_EVENTS_POLL_MS);
    const tickTimer = setInterval(() => void runAiTick(), AI_TICK_MS);
    const kickoff = setTimeout(() => void runAiTick(), 3000);
    return () => {
      clearInterval(eventsTimer);
      clearInterval(tickTimer);
      clearTimeout(kickoff);
    };
  }, [discussion.aiEnabled, discussion.status, loadAiEvents, runAiTick]);

  // ---- Host live monitor ---------------------------------------------------
  const [monitorBusyId, setMonitorBusyId] = useState<string | null>(null);

  const liveStats = useMemo<LiveStat[]>(() => {
    const byParticipant = new Map<
      string,
      { ms: number; contributions: number; words: number; lastAt: string | null }
    >();
    for (const segment of segments) {
      const entry = byParticipant.get(segment.participantId) ?? {
        ms: 0,
        contributions: 0,
        words: 0,
        lastAt: null,
      };
      entry.ms += segment.durationMs;
      entry.contributions += 1;
      entry.words += segment.wordCount;
      if (!entry.lastAt || segment.startedAt > entry.lastAt) entry.lastAt = segment.startedAt;
      byParticipant.set(segment.participantId, entry);
    }

    const totalMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0);

    return discussion.participants.map((participant) => {
      const entry = byParticipant.get(participant.id);
      const speakingMs = entry?.ms ?? 0;
      const lastSpokeAt = entry?.lastAt ?? null;
      return {
        participant,
        speakingMs,
        sharePct: totalMs > 0 ? Math.round((speakingMs / totalMs) * 1000) / 10 : 0,
        contributions: entry?.contributions ?? 0,
        wordCount: entry?.words ?? 0,
        lastSpokeAt,
        silent:
          isLive &&
          !participant.removed &&
          !participant.isHost &&
          (!lastSpokeAt || now - new Date(lastSpokeAt).getTime() > QUIET_AFTER_MS),
      };
    });
  }, [segments, discussion.participants, isLive, now]);

  const fairnessIndex = useMemo(() => {
    const speakers = liveStats.filter((stat) => stat.speakingMs > 0 && !stat.participant.removed);
    if (speakers.length < 2) return null;
    const total = speakers.reduce((sum, stat) => sum + stat.speakingMs, 0);
    if (total === 0) return null;
    const ideal = 1 / speakers.length;
    const deviation = speakers.reduce((sum, stat) => sum + Math.abs(stat.speakingMs / total - ideal), 0);
    const maxDeviation = 2 * (1 - ideal);
    return maxDeviation > 0 ? Math.round((1 - deviation / maxDeviation) * 1000) / 10 : null;
  }, [liveStats]);

  const participantControl = useCallback(
    async (participantId: string, action: ParticipantAction) => {
      setMonitorBusyId(participantId);
      setError(null);
      try {
        const res = await fetch(`/api/discussions/${discussion.id}/participants/${participantId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Could not update that participant");
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update that participant");
      } finally {
        setMonitorBusyId(null);
      }
    },
    [discussion.id, refresh],
  );

  // A host's mic lock is enforced on the client it applies to.
  const myLocked = Boolean(myMembership && !myMembership.removed && myMembership.micLocked);
  const setMic = media.setMic;
  useEffect(() => {
    if (myLocked && media.micEnabled) void setMic(false);
  }, [myLocked, media.micEnabled, setMic]);

  const removed = Boolean(myMembership?.removed);
  const disconnect = media.disconnect;
  useEffect(() => {
    if (removed) void disconnect();
  }, [removed, disconnect]);

  const control = useCallback(
    async (action: "start" | "end") => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/discussions/${discussion.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Could not update the discussion");
        await refresh();

        // Ending the discussion kicks off the evaluation so reports are ready.
        if (action === "end") {
          setEvaluating(true);
          try {
            const evalRes = await fetch(`/api/discussions/${discussion.id}/evaluate`, {
              method: "POST",
            });
            const evalData = (await evalRes.json().catch(() => ({}))) as { error?: string };
            if (!evalRes.ok) {
              setError(evalData.error ?? "The discussion ended, but the evaluation could not run.");
            }
          } catch {
            setError("The discussion ended, but the evaluation could not run.");
          } finally {
            setEvaluating(false);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update the discussion");
      } finally {
        setBusy(false);
      }
    },
    [discussion.id, refresh],
  );

  const leave = useCallback(async () => {
    await media.disconnect();
    router.push("/dashboard");
  }, [media, router]);

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/join?code=${discussion.joinCode}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Could not copy to the clipboard.");
    }
  }

  const activeMembers = useMemo(
    () => discussion.participants.filter((p) => !p.removed && !p.leftAt),
    [discussion.participants],
  );

  const elapsed = useMemo(() => {
    if (!discussion.startedAt) return null;
    const end = discussion.endedAt ? new Date(discussion.endedAt).getTime() : now;
    const seconds = Math.max(0, Math.floor((end - new Date(discussion.startedAt).getTime()) / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }, [discussion.startedAt, discussion.endedAt, now]);

  const remoteWithAudio = media.tiles.filter((tile) => !tile.isLocal && tile.audioTrack);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <button type="button" onClick={() => void leave()} className="btn-ghost">
          <LogOut className="h-4 w-4 rotate-180" /> Leave
        </button>
        <div className="min-w-0">
          <h1 className="truncate font-medium leading-tight">{discussion.title}</h1>
          <p className="truncate text-xs text-muted">
            Host {discussion.hostName} · {discussion.mode === "AI_MODERATED" ? "AI moderated" : "Free flow"}
          </p>
        </div>

        <span className="pill ml-auto">{discussion.status}</span>
        {isLive && (
          <span className="pill" title={media.status}>
            <Radio className="h-3.5 w-3.5" />
            {media.status === "connected"
              ? `${media.tiles.length} connected`
              : media.status === "connecting"
                ? "connecting…"
                : media.status === "reconnecting"
                  ? "reconnecting…"
                  : media.status === "error"
                    ? "media error"
                    : "offline"}
          </span>
        )}
        {elapsed && (
          <span className="pill">
            <Clock className="h-3.5 w-3.5" /> {elapsed}
          </span>
        )}
        <button type="button" onClick={copyInvite} className="btn-ghost" title="Copy invite link">
          {copied ? <Check className="h-4 w-4 text-accent" /> : <Copy className="h-4 w-4" />}
          <span className="font-mono tracking-widest">{discussion.joinCode}</span>
        </button>
        {discussion.isHost && discussion.status === "SCHEDULED" && (
          <button type="button" className="btn-primary" onClick={() => control("start")} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Start
          </button>
        )}
        {discussion.isHost && isLive && (
          <button type="button" className="btn-danger" onClick={() => control("end")} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />} End
          </button>
        )}
      </header>

      {evaluating && (
        <p className="flex items-center gap-2 border-b border-accent/40 bg-accent/10 px-5 py-2 text-sm text-accent">
          <Loader2 className="h-4 w-4 animate-spin" /> Assessing contributions and writing reports…
        </p>
      )}

      {(error || media.error) && (
        <p className="border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          {error ?? media.error}
        </p>
      )}

      {removed && (
        <p className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          <ShieldAlert className="h-4 w-4" /> The host removed you from this discussion. You can still
          leave, but you can no longer speak or be transcribed.
        </p>
      )}

      {myLocked && !removed && (
        <p className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-5 py-2 text-sm text-warn">
          <MicOff className="h-4 w-4" /> Your microphone was muted by the host.
        </p>
      )}

      {isLive && media.needsAudioUnblock && (
        <button
          type="button"
          onClick={() => void media.startAudio()}
          className="flex items-center justify-center gap-2 border-b border-accent/40 bg-accent/10 px-5 py-2 text-sm text-accent"
        >
          <Volume2 className="h-4 w-4" /> Tap to enable sound
        </button>
      )}

      {isLive && discussion.transcriptionEnabled && speech.supported && !consented && (
        <div className="flex flex-wrap items-center gap-3 border-b border-warn/40 bg-warn/10 px-5 py-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-warn" />
          <span className="text-warn">
            Live transcription is on. Your speech will be transcribed and shared with the room.
          </span>
          <button
            type="button"
            className="btn-ghost ml-auto"
            onClick={() => void setConsent(true)}
            disabled={consentBusy}
          >
            {consentBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Allow
          </button>
        </div>
      )}

      <div className="grid flex-1 gap-5 p-5 lg:grid-cols-[2fr_1fr]">
        <section className="flex flex-col gap-4">
          {isLive ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {media.tiles.map((tile) => (
                  <VideoTile key={tile.identity} tile={tile} />
                ))}
                {media.status !== "connected" && (
                  <div className="card flex min-h-[150px] flex-col items-center justify-center gap-2 text-sm text-muted">
                    {media.status === "error" ? (
                      <>
                        <WifiOff className="h-5 w-5 text-danger" /> Could not join the media room
                      </>
                    ) : (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin" /> Connecting to the room…
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Remote audio is rendered separately so it plays even without video. */}
              <div className="sr-only" aria-hidden>
                {remoteWithAudio.map((tile) => (
                  <MediaTrack key={tile.identity} track={tile.audioTrack} kind="audio" />
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void media.toggleMic()}
                  disabled={media.status !== "connected" || myLocked || removed}
                  className={media.micEnabled ? "btn-primary" : "btn-ghost"}
                >
                  {media.micEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
                  {myLocked ? "Microphone locked" : media.micEnabled ? "Microphone on" : "Microphone off"}
                </button>
                <button
                  type="button"
                  onClick={() => void media.toggleCam()}
                  disabled={media.status !== "connected" || removed}
                  className={media.camEnabled ? "btn-primary" : "btn-ghost"}
                >
                  {media.camEnabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
                  {media.camEnabled ? "Camera on" : "Camera off"}
                </button>
              </div>
            </>
          ) : (
            <div className="card">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
                <Users2 className="h-4 w-4" /> In the room ({activeMembers.length}/{discussion.maxParticipants})
              </h2>
              <p className="mb-4 text-sm text-muted">
                {discussion.status === "SCHEDULED"
                  ? "Waiting for the host to start. Media starts automatically when the discussion goes live."
                  : "This discussion has finished."}
              </p>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {activeMembers.map((participant) => (
                  <li
                    key={participant.id}
                    className="flex items-center gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-input text-xs font-semibold uppercase">
                      {participant.name.slice(0, 2)}
                    </span>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1 truncate text-sm">
                        {participant.name}
                        {participant.isHost && <Crown className="h-3.5 w-3.5 text-accent" />}
                        {participant.userId === user.id && <span className="text-xs text-muted">(you)</span>}
                      </p>
                      <p className="text-xs text-muted">
                        {participant.joinedAt ? "present" : "waiting"}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {discussion.transcriptionEnabled && (
            <div className="card">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
                <ScrollText className="h-4 w-4" /> Live transcript
                <span className="ml-auto text-xs font-normal normal-case">
                  {!speech.supported
                    ? "browser not supported"
                    : canTranscribe
                      ? speech.listening
                        ? "listening"
                        : "starting…"
                      : consented
                        ? "paused"
                        : isLive
                          ? "consent needed"
                          : "offline"}
                </span>
              </h2>

              {speech.error && <p className="mt-2 text-xs text-danger">{speech.error}</p>}
              {!speech.supported && (
                <p className="mt-2 text-xs text-muted">
                  Live transcription uses the browser Speech API, available in Chromium-based browsers
                  (Chrome, Edge, Brave). Other browsers can still follow the shared transcript.
                </p>
              )}

              <ol ref={transcriptRef} className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                {segments.length === 0 ? (
                  <li className="text-sm text-muted">
                    {discussion.status === "LIVE" ? "No speech captured yet." : "The transcript appears once the discussion is live."}
                  </li>
                ) : (
                  segments.map((entry) => (
                    <li key={entry.id} className="text-sm">
                      <span className="mr-2 font-medium text-accent">
                        {entry.isMine ? "You" : entry.speaker}
                      </span>
                      <span className="text-xs text-muted">
                        {new Date(entry.startedAt).toLocaleTimeString()}
                      </span>
                      <p className="text-ink">{entry.text}</p>
                    </li>
                  ))
                )}
                {speech.interim && <li className="text-sm italic text-muted">… {speech.interim}</li>}
              </ol>

              {isLive && speech.supported && consented && (
                <button
                  type="button"
                  className="btn-ghost mt-3"
                  onClick={() => void setConsent(false)}
                  disabled={consentBusy}
                >
                  {consentBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Stop transcribing my voice
                </button>
              )}
            </div>
          )}

          <div className="card">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Topic</h2>
            <p className="mt-2 leading-relaxed text-ink">{discussion.topic}</p>
            {discussion.context && (
              <p className="mt-3 leading-relaxed text-muted">{discussion.context}</p>
            )}
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          {discussion.isHost && isLive && (
            <LiveMonitorPanel
              stats={liveStats}
              fairnessIndex={fairnessIndex}
              busyId={monitorBusyId}
              onControl={(participantId, action) => void participantControl(participantId, action)}
            />
          )}

          {discussion.aiEnabled && (
            <div className="card">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
                <Sparkles className="h-4 w-4" /> AI assistant
              </h2>
              {aiEvents.length === 0 ? (
                <p className="mt-2 text-sm text-muted">
                  {discussion.status === "LIVE"
                    ? "Watching the discussion. Nothing to add yet."
                    : "The assistant joins once the discussion is live."}
                </p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {aiEvents.slice(-8).map((event) => (
                    <li key={event.id} className="rounded-lg border border-line bg-panel-2 px-3 py-2">
                      <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-accent">
                        {AI_KIND_LABEL[event.kind] ?? event.kind}
                        <span className="ml-auto font-normal normal-case text-muted">
                          {new Date(event.createdAt).toLocaleTimeString()}
                        </span>
                      </p>
                      <p className="mt-1 text-sm text-ink">{event.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="card">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Session</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Scheduled</dt>
                <dd>{new Date(discussion.scheduledAt).toLocaleString()}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Duration</dt>
                <dd>{discussion.durationMin} minutes</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Transcription</dt>
                <dd>{discussion.transcriptionEnabled ? "Enabled" : "Off"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">AI assistant</dt>
                <dd>{discussion.aiEnabled ? "Enabled" : "Off"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Silence prompt</dt>
                <dd>{discussion.silencePromptSec}s</dd>
              </div>
            </dl>
          </div>

          {discussion.rules && (
            <div className="card">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Rules</h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted">
                {discussion.rules}
              </p>
            </div>
          )}

          {(discussion.status === "COMPLETED" || discussion.status === "CANCELLED") && (
            <Link href={`/reports/${discussion.id}`} className="btn-primary">
              View reports
            </Link>
          )}
        </aside>
      </div>
    </div>
  );
}

function VideoTile({ tile }: { tile: TileInfo }) {
  return (
    <div
      className={`relative aspect-video overflow-hidden rounded-xl border bg-panel-2 ${
        tile.speaking ? "border-accent" : "border-line"
      }`}
    >
      {tile.videoTrack && tile.camEnabled ? (
        <MediaTrack track={tile.videoTrack} kind="video" muted={tile.isLocal} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-input text-lg font-semibold uppercase">
            {tile.name.slice(0, 2)}
          </span>
        </div>
      )}

      {!tile.audioTrack && !tile.isLocal && (
        <span className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5" title="Microphone off">
          <MicOff className="h-3.5 w-3.5 text-muted" />
        </span>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
        {tile.isHost && <Crown className="h-3.5 w-3.5 shrink-0 text-accent" />}
        <span className="truncate text-xs text-white">
          {tile.name}
          {tile.isLocal && " (you)"}
        </span>
      </div>
    </div>
  );
}
