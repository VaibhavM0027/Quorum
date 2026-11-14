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
  VolumeX,
  Radio,
  WifiOff,
  ScrollText,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  Circle,
  UsersRound,
} from "lucide-react";
import MediaTrack from "@/components/MediaTrack";
import GdTable from "@/components/GdTable";
import BreakoutPanel, { type BreakoutCommand } from "@/components/BreakoutPanel";
import LiveMonitorPanel, {
  type LiveStat,
  type ParticipantAction,
} from "@/components/LiveMonitorPanel";
import { useLivekitRoom } from "@/hooks/useLivekitRoom";
import { useAssistantVoice } from "@/hooks/useAssistantVoice";
import { useRoomRecorder } from "@/hooks/useRoomRecorder";
import { usePresenceReporter } from "@/hooks/usePresenceReporter";
import { CONVERSATION_STATE_LABEL, coerceConversationState } from "@/lib/conversation-state";
import { transcriptLog } from "@/lib/debug-log";

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
  /** Numbered seat at the discussion table; null for the host and freed seats. */
  seatNumber: number | null;
  /** Breakout group this student is in; null while breakout rooms are off. */
  breakoutRoom: number | null;
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
  /** How long an invited participant has to reply before the moderator checks in. */
  inviteResponseSec: number;
  /** What the conversation-management engine believes the room is doing. */
  conversationState: string;
  breakoutEnabled: boolean;
  breakoutGroupSize: number;
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
  participantId: string | null;
  participantName: string | null;
  /** Set while the assistant is counting down to an action it has announced. */
  dueAt: string | null;
  createdAt: string;
};

/** One participant's live row from the participation tracker. */
type ParticipationEntry = {
  participantId: string;
  /** Has the floor right now, according to LiveKit audio activity. */
  speaking: boolean;
  presentMs: number;
  meaningfulContributions: number;
  averageRelevance: number | null;
  invitedCount: number;
  answeredInvites: number;
  unansweredInvites: number;
  passCount: number;
  audioIssue: boolean;
  /** This participant's microphone is being captured for transcription. */
  transcribing: boolean;
  score: number;
};

const AI_KIND_LABEL: Record<string, string> = {
  QUESTION: "Question",
  NUDGE: "Invitation",
  SILENCE: "Silence",
  RELEVANCE: "Stay on topic",
  SUMMARY: "Summary",
};

/** Assistant messages that are read aloud as well as shown in the card. */
const SPOKEN_AI_KINDS = new Set(["QUESTION", "NUDGE", "SILENCE", "RELEVANCE"]);

/**
 * How long the room counts down for when the server did not stamp a usable
 * window. Mirrors the default invitation response window; the real window is
 * the gap the server stamped between the event's `createdAt` and its `dueAt`.
 */
const DEFAULT_COUNTDOWN_MS = 12_000;

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

  const myMembership = discussion.participants.find((p) => p.userId === user.id) ?? null;
  /**
   * The breakout group this browser belongs in.
   *
   * The moderator stays in the main room, so the session recording keeps
   * following them rather than one group, and the server refuses to hand anyone
   * a token for a room they were not placed in.
   */
  const myBreakoutRoom =
    discussion.breakoutEnabled && !discussion.isHost ? (myMembership?.breakoutRoom ?? null) : null;
  const media = useLivekitRoom(
    discussion.id,
    myBreakoutRoom,
    isLive && Boolean(participantId),
  );

  // ---- Session recording ---------------------------------------------------
  /** Every audio track this browser can hear: its own microphone plus each remote speaker. */
  const audioTracks = useMemo(
    () => media.tiles.flatMap((tile) => (tile.audioTrack ? [tile.audioTrack] : [])),
    [media.tiles],
  );
  // The moderator's browser is the one client that subscribes to the whole room,
  // so it is the one that captures the session. Capture follows the discussion:
  // it runs only while the discussion is live.
  const recorder = useRoomRecorder({
    discussionId: discussion.id,
    tracks: audioTracks,
    enabled: isLive && discussion.isHost && Boolean(participantId),
  });

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

  /**
   * Whether this participant's voice is being transcribed right now.
   *
   * Transcription itself runs in the LiveKit agent, which subscribes to every
   * participant's microphone; this browser only reports whether its own tracks
   * are eligible. A muted microphone publishes nothing, so it is not captured —
   * and a participant who has withdrawn consent is not captured either.
   */
  const transcribing =
    isLive &&
    discussion.transcriptionEnabled &&
    consented &&
    Boolean(participantId) &&
    media.micEnabled;

  // Keep the transcript pinned to the newest line.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments.length]);

  /**
   * State, in the browser's own log, whether this participant is being
   * captured.
   *
   * "No transcript from me" has several unrelated causes — missing consent, a
   * muted microphone, a discussion that is not live — and they are
   * indistinguishable from the outside. Naming the one that applies turns a
   * vague report into a diagnosable one.
   */
  useEffect(() => {
    if (!isLive || !discussion.transcriptionEnabled) return;
    transcriptLog(transcribing ? "this microphone is being transcribed" : "this microphone is not being transcribed", {
      participantId,
      consented,
      micEnabled: media.micEnabled,
      reason: transcribing
        ? undefined
        : !participantId
          ? "not a member of this discussion"
          : !consented
            ? "transcription consent not given"
            : !media.micEnabled
              ? "microphone is off"
              : "discussion is not live",
    });
  }, [
    consented,
    discussion.transcriptionEnabled,
    isLive,
    media.micEnabled,
    participantId,
    transcribing,
  ]);

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

  // The moderator speaks its messages aloud. It holds its tongue while a
  // participant is talking, so it never interrupts the discussion.
  const someoneSpeaking = useMemo(() => media.tiles.some((tile) => tile.speaking), [media.tiles]);
  const voice = useAssistantVoice({ hold: someoneSpeaking });
  /** Kept in a ref so the polling loop below never restarts when voice state changes. */
  const announceRef = useRef(voice.announce);
  useEffect(() => {
    announceRef.current = voice.announce;
  }, [voice.announce]);

  /** Ids already seen, so a message is spoken once and only once. */
  const seenAiEventIds = useRef(new Set<string>());
  /** The first payload is the backlog: it is shown, but never read aloud. */
  const aiEventsPrimed = useRef(false);

  /**
   * The countdown the room is currently watching.
   *
   * The server stamps `dueAt` on the announcement; this browser turns that into
   * a local deadline the first time it sees the event. Counting from the moment
   * the event arrived, using the server's own window, means two machines whose
   * clocks disagree still show the same number of seconds.
   */
  const countdownRef = useRef<{ id: string; endsAt: number; label: string | null } | null>(null);

  const loadAiEvents = useCallback(async () => {
    try {
      const res = await fetch(`/api/discussions/${initial.id}/ai/events`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { events: AiEventEntry[] };
      setAiEvents(data.events);

      // The newest announcement the room is still waiting on: the moderator's
      // invitation to a participant, or its earlier warning that one is coming.
      // The deadline is cleared server-side the moment the participant answers,
      // so an answered invitation stops the countdown on the next poll.
      const announced = [...data.events]
        .reverse()
        .find((event) => (event.kind === "NUDGE" || event.kind === "SILENCE") && event.dueAt);

      if (!announced?.dueAt) {
        countdownRef.current = null;
      } else if (countdownRef.current?.id !== announced.id) {
        const windowMs =
          new Date(announced.dueAt).getTime() - new Date(announced.createdAt).getTime();
        countdownRef.current = {
          id: announced.id,
          endsAt: Date.now() + (Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_COUNTDOWN_MS),
          label: announced.participantName,
        };
      }

      const fresh = data.events.filter((event) => !seenAiEventIds.current.has(event.id));
      for (const event of data.events) seenAiEventIds.current.add(event.id);
      if (!aiEventsPrimed.current) {
        aiEventsPrimed.current = true;
        return;
      }
      for (const event of fresh) {
        // Verbatim: the sentence on screen is the sentence that is spoken.
        if (SPOKEN_AI_KINDS.has(event.kind)) announceRef.current(event.message);
      }
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

  /**
   * Seconds left on the assistant's current invitation, counted down from the
   * moment each browser first saw the announcement.
   *
   * Null when nothing is counting down — and also while somebody is talking.
   * A participant who is mid-sentence keeps the floor; if the room falls quiet
   * again the countdown reappears with the time it had left.
   */
  const countdown = useMemo(() => {
    const anchor = countdownRef.current;
    if (!anchor || !isLive || someoneSpeaking) return null;
    return Math.max(0, Math.ceil((anchor.endsAt - now) / 1000));
  }, [now, isLive, someoneSpeaking, aiEvents]);

  /** Who the assistant is waiting on, if it named anybody. */
  const countdownLabel = countdownRef.current?.label ?? null;

  /** When the clock reaches zero, ask the assistant to follow up at once. */
  const countdownKicked = useRef<string | null>(null);
  useEffect(() => {
    const anchor = countdownRef.current;
    if (!anchor) {
      countdownKicked.current = null;
      return;
    }
    if (countdown === 0 && countdownKicked.current !== anchor.id) {
      countdownKicked.current = anchor.id;
      void runAiTick();
    }
  }, [countdown, runAiTick]);

  // The moderator is silent before the discussion starts and after it ends.
  const silenceVoice = voice.stop;
  useEffect(() => {
    if (discussion.aiEnabled && discussion.status === "LIVE") return;
    silenceVoice();
  }, [discussion.aiEnabled, discussion.status, silenceVoice]);

  // ---- Host live monitor ---------------------------------------------------
  const [monitorBusyId, setMonitorBusyId] = useState<string | null>(null);

  /**
   * The participation tracker's view of the room: invitations, scores, who has
   * the floor. Polled rather than derived, because it is computed server-side
   * from the same evidence the moderator reads — the board and the moderator
   * must never disagree.
   */
  const [participation, setParticipation] = useState<ParticipationEntry[] | null>(null);

  const loadParticipation = useCallback(async () => {
    try {
      const res = await fetch(`/api/discussions/${initial.id}/participation`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { rows: ParticipationEntry[] };
      setParticipation(data.rows);
    } catch {
      /* transient network errors are ignored; the next poll retries */
    }
  }, [initial.id]);

  useEffect(() => {
    if (discussion.status !== "LIVE") return;
    void loadParticipation();
    const timer = setInterval(() => void loadParticipation(), POLL_MS);
    return () => clearInterval(timer);
  }, [discussion.status, loadParticipation]);

  const participationById = useMemo(() => {
    const map = new Map<string, ParticipationEntry>();
    for (const row of participation ?? []) map.set(row.participantId, row);
    return map;
  }, [participation]);

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
      const tracked = participationById.get(participant.id);
      const speakingMs = entry?.ms ?? 0;
      const lastSpokeAt = entry?.lastAt ?? null;
      const audioIssue = tracked?.audioIssue ?? false;
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
          // A participant whose microphone is broken is not "going quiet" in a
          // way the host should act on.
          !audioIssue &&
          (!lastSpokeAt || now - new Date(lastSpokeAt).getTime() > QUIET_AFTER_MS),
        speaking: tracked?.speaking ?? false,
        presentMs: tracked?.presentMs ?? 0,
        meaningfulContributions: tracked?.meaningfulContributions ?? 0,
        averageRelevance: tracked?.averageRelevance ?? null,
        invitedCount: tracked?.invitedCount ?? 0,
        answeredInvites: tracked?.answeredInvites ?? 0,
        unansweredInvites: tracked?.unansweredInvites ?? 0,
        passCount: tracked?.passCount ?? 0,
        audioIssue,
        transcribing: tracked?.transcribing ?? false,
        score: tracked?.score ?? null,
      };
    });
  }, [segments, discussion.participants, participationById, isLive, now]);

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

  // ---- Breakout rooms -------------------------------------------------------
  const [breakoutBusy, setBreakoutBusy] = useState(false);

  const breakoutControl = useCallback(
    async (command: BreakoutCommand) => {
      setBreakoutBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/discussions/${discussion.id}/breakout`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Could not update the breakout rooms");
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update the breakout rooms");
      } finally {
        setBreakoutBusy(false);
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

  // ---- Live audio activity, reported to the moderator ----------------------
  /**
   * Whether this browser's own microphone is carrying speech. Read from the
   * live tile rather than the transcript: the moderator must know somebody has
   * the floor the instant they start talking, not seconds later when their
   * sentence is finally transcribed.
   */
  const localSpeaking = useMemo(
    () => media.tiles.find((tile) => tile.isLocal)?.speaking ?? false,
    [media.tiles],
  );
  usePresenceReporter({
    discussionId: discussion.id,
    enabled: isLive && Boolean(participantId) && !removed && media.status === "connected",
    speaking: localSpeaking,
    aiSpeaking: voice.speaking,
    // The transcription agent transcribes exactly the microphones that are
    // live, consented and unmuted, which is the condition reported here.
    transcribing,
  });

  /** What the conversation engine believes the room is doing right now. */
  const conversationState = coerceConversationState(discussion.conversationState);

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
    // Leaving on purpose gives the seat up. A dropped connection never reaches
    // this line, which is what keeps a returning student in the same chair.
    try {
      await fetch(`/api/discussions/${discussion.id}/leave`, { method: "POST" });
    } catch {
      /* leaving must not be blocked by a failed bookkeeping call */
    }
    await media.disconnect();
    router.push("/dashboard");
  }, [discussion.id, media, router]);

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
        {isLive && discussion.aiEnabled && (
          <span
            className="pill"
            title="What the conversation engine believes the room is doing"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {CONVERSATION_STATE_LABEL[conversationState]}
          </span>
        )}
        {recorder.state === "recording" && (
          <span className="pill" title="This session is being recorded from this browser">
            <Circle className="h-3.5 w-3.5 fill-current text-danger" /> Recording
          </span>
        )}
        {recorder.state === "saving" && (
          <span className="pill">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving recording…
          </span>
        )}
        {recorder.state === "saved" && recorder.url && (
          <a className="pill" href={recorder.url} title="Play the stored session recording">
            <Circle className="h-3.5 w-3.5 fill-current text-accent" /> Recording stored
          </a>
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

      {(error || media.error || recorder.error) && (
        <p className="border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          {error ?? media.error ?? recorder.error}
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

      {isLive && discussion.transcriptionEnabled && !consented && (
        <div className="flex flex-wrap items-center gap-3 border-b border-warn/40 bg-warn/10 px-5 py-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-warn" />
          <span className="text-warn">
            Live transcription is on. While your microphone is on, your speech is transcribed and
            shared with the room, and the session audio is recorded so it can be reviewed after the
            discussion. Your microphone stays off until you turn it on.
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

      {isLive && countdown !== null && (
        <div className="flex flex-wrap items-center gap-3 border-b border-accent/40 bg-accent/10 px-5 py-2 text-sm text-accent">
          <Sparkles className="h-4 w-4 shrink-0" />
          <span>
            {countdownLabel
              ? `${countdownLabel} was invited to take the floor. The AI will check in in`
              : "The group has gone quiet. The AI will invite whoever has spoken least in"}
          </span>
          <span className="font-mono text-lg font-semibold leading-none tabular-nums">
            {countdown}
          </span>
          <span>{countdown === 1 ? "second" : "seconds"}…</span>
        </div>
      )}

      <div className="grid flex-1 gap-5 p-5 lg:grid-cols-[2fr_1fr]">
        <section className="flex flex-col gap-4">
          {isLive ? (
            <>
              {/* Everyone is seated around the table at their own numbered seat,
                  so the room reads as a real discussion rather than a grid. */}
              <GdTable
                participants={discussion.participants}
                tiles={media.tiles}
                maxSeats={discussion.maxParticipants}
                selfUserId={user.id}
              />
              {media.status !== "connected" && (
                <div className="card flex min-h-[90px] flex-col items-center justify-center gap-2 text-sm text-muted">
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
                        {participant.isHost
                          ? "moderator"
                          : participant.seatNumber !== null
                            ? `Seat ${participant.seatNumber}`
                            : "no seat yet"}
                        {" · "}
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
                  {transcribing
                    ? "listening"
                    : !isLive
                      ? "offline"
                      : !discussion.transcriptionEnabled
                        ? "off"
                        : consented
                          ? "mic off"
                          : "consent needed"}
                </span>
              </h2>

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
              </ol>

              {isLive && consented && (
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

          {discussion.isHost && isLive && (
            <BreakoutPanel
              participants={discussion.participants}
              enabled={discussion.breakoutEnabled}
              groupSize={discussion.breakoutGroupSize}
              busy={breakoutBusy}
              onControl={(command) => void breakoutControl(command)}
            />
          )}

          {/* Everyone else is told which group they are in; the host stays behind. */}
          {isLive && !discussion.isHost && discussion.breakoutEnabled && myBreakoutRoom !== null && (
            <div className="card">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
                <UsersRound className="h-4 w-4" /> Breakout room
              </h2>
              <p className="mt-2 text-sm text-ink">
                You are in room {myBreakoutRoom}. You can hear and speak with your group only.
              </p>
            </div>
          )}

          {discussion.aiEnabled && (
            <div className="card">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
                <Sparkles className="h-4 w-4" /> AI assistant
                {voice.supported ? (
                  <button
                    type="button"
                    onClick={() => voice.setEnabled(!voice.enabled)}
                    title={
                      voice.enabled
                        ? `Mute the assistant's voice${voice.voiceName ? ` (${voice.voiceName})` : ""}`
                        : "Unmute the assistant's voice"
                    }
                    className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs font-normal normal-case"
                  >
                    {voice.enabled ? (
                      <Volume2 className={`h-3.5 w-3.5 ${voice.speaking ? "text-accent" : ""}`} />
                    ) : (
                      <VolumeX className="h-3.5 w-3.5 text-muted" />
                    )}
                    <span className={voice.speaking ? "text-accent" : "text-muted"}>
                      {voice.speaking ? "speaking…" : voice.enabled ? "voice on" : "voice off"}
                    </span>
                  </button>
                ) : (
                  <span className="ml-auto text-xs font-normal normal-case text-muted">
                    voice unavailable
                  </span>
                )}
              </h2>

              {voice.supported && voice.enabled && !voice.unlocked && (
                <button
                  type="button"
                  onClick={voice.unlock}
                  className="mt-2 flex items-center gap-2 text-xs text-accent underline"
                >
                  <Volume2 className="h-3.5 w-3.5" /> Let the assistant speak through your speakers
                </button>
              )}

              {aiEvents.length === 0 ? (
                <p className="mt-2 text-sm text-muted">
                  {discussion.status === "LIVE"
                    ? "Watching the discussion. Nothing to add yet."
                    : "The assistant joins once the discussion is live."}
                </p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {aiEvents.slice(-8).map((event) => (
                    <li
                      key={event.id}
                      className={`rounded-lg border px-3 py-2 ${
                        event.message === voice.spokenText
                          ? "border-accent/60 bg-accent/10"
                          : "border-line bg-panel-2"
                      }`}
                    >
                      <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-accent">
                        {AI_KIND_LABEL[event.kind] ?? event.kind}
                        {event.participantName && (
                          <span className="font-normal normal-case text-ink">
                            → {event.participantName}
                          </span>
                        )}
                        <span className="ml-auto font-normal normal-case text-muted">
                          {new Date(event.createdAt).toLocaleTimeString()}
                        </span>
                      </p>
                      <p className="mt-1 text-sm text-ink">{event.message}</p>
                      {countdown !== null && countdownRef.current?.id === event.id && (
                        <p className="mt-1 flex items-center gap-2 text-sm text-accent">
                          <Clock className="h-3.5 w-3.5" /> Following up in
                          <span className="font-mono font-semibold tabular-nums">{countdown}</span>
                        </p>
                      )}
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
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Invitation window</dt>
                <dd>{discussion.inviteResponseSec}s</dd>
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
