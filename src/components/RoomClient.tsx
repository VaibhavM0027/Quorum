"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
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
  Pause,
  Lock,
} from "lucide-react";
import MediaTrack from "@/components/MediaTrack";
import GdTable from "@/components/GdTable";
import ThemeToggle from "@/components/ThemeToggle";

const Table3D = dynamic(() => import("@/components/table3d/Table3D"), {
  ssr: false,
  loading: () => (
    <div className="card flex aspect-[16/10] min-h-[360px] items-center justify-center text-sm text-muted">
      Loading 3D table…
    </div>
  ),
});
import PreJoinLobby, { type PreJoinResult } from "@/components/PreJoinLobby";
import BreakoutPanel, { type BreakoutCommand } from "@/components/BreakoutPanel";
import LiveMonitorPanel, {
  type LiveStat,
  type ParticipantAction,
} from "@/components/LiveMonitorPanel";
import { useLivekitRoom, type TranscriptDraftMessage } from "@/hooks/useLivekitRoom";
import {
  useGeminiTranscription,
  type AudioPartialEvent,
} from "@/hooks/useGeminiTranscription";
import { useAssistantVoice } from "@/hooks/useAssistantVoice";
import { useRoomRecorder } from "@/hooks/useRoomRecorder";
import { usePresenceReporter } from "@/hooks/usePresenceReporter";
import { CONVERSATION_STATE_LABEL, coerceConversationState } from "@/lib/conversation-state";
import { transcriptLog } from "@/lib/debug-log";
import type { RoomStateBroadcast } from "@/lib/livekit";
import { shouldApplyTranscriptDraft, shouldClearTranscriptDraft } from "@/lib/transcript";

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
  aiSpeaking?: boolean;
  paused?: boolean;
  activeSpeakerId?: string | null;
  serverSttActive?: boolean;
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
  streamId: string | null;
  participantId: string;
  participantIdentity: string;
  speaker: string;
  speakerIsHost: boolean;
  text: string;
  startedAt: string;
  durationMs: number;
  wordCount: number;
  confidence?: number | null;
  status: "PARTIAL" | "FINAL";
  revision: number;
  updatedAt: string;
};

const POLL_MS = 5000;
const TRANSCRIPT_POLL_MS = 4000;
const AI_EVENTS_POLL_MS = 2500;
const AI_TICK_MS = 4000;

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
  /** This participant's audio is currently being transcribed. */
  transcribing: boolean;
  score: number;
};

const AI_KIND_LABEL: Record<string, string> = {
  WELCOME: "Welcome",
  QUESTION: "Question",
  NUDGE: "Invitation",
  SILENCE: "Silence",
  RELEVANCE: "Stay on topic",
  FOLLOW_UP: "Follow-up",
  SUMMARY: "Summary",
};

/** Assistant messages that are read aloud as well as shown in the card. */
const SPOKEN_AI_KINDS = new Set([
  "WELCOME",
  "QUESTION",
  "NUDGE",
  "SILENCE",
  "RELEVANCE",
  "FOLLOW_UP",
]);

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
  const [lobbyResult, setLobbyResult] = useState<PreJoinResult | null>(null);
  const [roomState, setRoomState] = useState<RoomStateBroadcast | null>(null);
  const [tableLayout, setTableLayout] = useState<"round" | "table3d">("round");
  const [webglFallback, setWebglFallback] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("quorum-layout");
      if (saved === "table3d" || saved === "round") setTableLayout(saved);
    } catch {
      /* ignore */
    }
  }, []);

  const selectTableLayout = useCallback((next: "round" | "table3d") => {
    setTableLayout(next);
    if (next === "round") setWebglFallback(false);
    try {
      window.localStorage.setItem("quorum-layout", next);
    } catch {
      /* ignore */
    }
  }, []);

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
  const transcriptRefreshRef = useRef<() => void>(() => {});
  const transcriptDraftHandlerRef = useRef<(message: TranscriptDraftMessage) => void>(() => {});
  const media = useLivekitRoom(
    discussion.id,
    myBreakoutRoom,
    isLive && Boolean(participantId) && Boolean(lobbyResult),
    () => transcriptRefreshRef.current(),
    (message) => transcriptDraftHandlerRef.current(message),
    {
      initialMicEnabled: lobbyResult?.micEnabled ?? false,
      initialCamEnabled: lobbyResult?.camEnabled ?? false,
      audioDeviceId: lobbyResult?.audioDeviceId,
      videoDeviceId: lobbyResult?.videoDeviceId,
      onRoomState: setRoomState,
    },
  );
  const localAudioTile = media.tiles.find((tile) => tile.isLocal);
  const localSpeaking = localAudioTile?.speaking ?? false;

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
      setRoomState((prev) => {
        if (!prev) return prev;
        // If server poll says AI is no longer speaking and the broadcast is older
        // than 2s, clear stale aiSpeaking so mics can never stay locked.
        if (
          prev.aiSpeaking &&
          !data.discussion.aiSpeaking &&
          Date.now() - new Date(prev.updatedAt).getTime() > 2000
        ) {
          return {
            ...prev,
            aiSpeaking: false,
            aiSpeakingUntil: null,
            paused: Boolean(data.discussion.paused),
            conversationState: data.discussion.conversationState,
          };
        }
        return prev;
      });
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
  const transcriptLoadVersionRef = useRef(0);
  const transcriptUpdatedSinceRef = useRef<string | null>(null);
  const [segments, setSegments] = useState<TranscriptEntry[]>([]);
  const [consentBusy, setConsentBusy] = useState(false);

  const consented = Boolean(myMembership && !myMembership.removed && myMembership.transcriptionConsent);

  const loadTranscript = useCallback(async () => {
    const requestVersion = ++transcriptLoadVersionRef.current;
    const updatedSince = transcriptUpdatedSinceRef.current;
    try {
      const query = updatedSince ? `?updatedSince=${encodeURIComponent(updatedSince)}` : "";
      const res = await fetch(`/api/discussions/${initial.id}/transcript${query}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { segments: TranscriptEntry[]; asOf: string };
      if (requestVersion === transcriptLoadVersionRef.current) {
        transcriptUpdatedSinceRef.current = data.asOf;
        const changes = data.segments.map((entry) => ({
          ...entry,
          id: entry.streamId ?? entry.id,
        }));
        if (!updatedSince) {
          setSegments(changes);
        } else if (changes.length > 0) {
          setSegments((current) => {
            const merged = new Map(current.map((entry) => [entry.id, entry]));
            for (const change of changes) merged.set(change.id, change);
            return [...merged.values()].sort(
              (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
            );
          });
        }
      }
    } catch {
      /* transient network errors are ignored; the next poll retries */
    }
  }, [initial.id]);
  transcriptRefreshRef.current = () => {
    void loadTranscript();
  };

  useEffect(() => {
    if (!discussion.transcriptionEnabled || discussion.status === "SCHEDULED") return;
    void loadTranscript();
    if (discussion.status === "COMPLETED" || discussion.status === "CANCELLED") return;
    const timer = setInterval(() => void loadTranscript(), TRANSCRIPT_POLL_MS);
    return () => clearInterval(timer);
  }, [discussion.transcriptionEnabled, discussion.status, loadTranscript]);

  const acceptRealtimeDraft = useCallback(
    (message: TranscriptDraftMessage) => {
      transcriptLoadVersionRef.current += 1;
      if (message.type === "partial-cleared") {
        setSegments((current) =>
          current.filter(
            (entry) =>
              entry.id !== message.streamId ||
              !shouldClearTranscriptDraft(entry, message.revision),
          ),
        );
        return;
      }

      const member = discussion.participants.find(
        (candidate) => candidate.userId === message.participantIdentity,
      );
      const entry: TranscriptEntry = {
        id: message.streamId,
        streamId: message.streamId,
        revision: message.revision,
        participantId: member?.id ?? message.participantIdentity,
        participantIdentity: message.participantIdentity,
        speaker: member?.name || message.participantName,
        speakerIsHost: member?.isHost ?? false,
        text: message.text,
        startedAt: message.startedAt,
        durationMs: 0,
        wordCount: message.text.trim().split(/\s+/).filter(Boolean).length,
        status: "PARTIAL",
        updatedAt: new Date().toISOString(),
      };
      setSegments((current) => {
        const existing = current.find((item) => item.id === entry.id);
        if (!shouldApplyTranscriptDraft(existing, entry.revision)) return current;
        return [...current.filter((item) => item.id !== entry.id), entry].sort(
          (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
        );
      });
    },
    [discussion.participants],
  );
  transcriptDraftHandlerRef.current = acceptRealtimeDraft;

  // Synchronized lock state: host lock, AI moderator speaking, or meeting paused.
  // Never OR a stale roomState.aiSpeaking with a fresh server poll, and never
  // deadlock the mic button on a stale sfuCanPublish (clicking unmute verifies
  // authoritatively with POST /api/discussions/[id]/mic and restores SFU grants).
  const myLocked = Boolean(myMembership && !myMembership.removed && myMembership.micLocked);
  const roomPaused = roomState?.paused ?? discussion.paused ?? false;
  const roomStateFresh =
    roomState !== null && now - new Date(roomState.updatedAt).getTime() < 8000;
  const roomAiLocked = roomStateFresh
    ? Boolean(roomState.aiSpeaking)
    : Boolean(discussion.aiSpeaking);
  const micHardLocked = myLocked || roomAiLocked || roomPaused;

  // Transcription follows the active microphone and consent: never captures
  // while muted, paused, or while the AI moderator is speaking.
  const shouldTranscribe =
    isLive &&
    discussion.transcriptionEnabled &&
    consented &&
    Boolean(participantId) &&
    !micHardLocked &&
    media.micEnabled;
  const transcriptionActive =
    shouldTranscribe &&
    media.status === "connected" &&
    localAudioTile?.audioTrack?.readyState === "live";

  const publishTranscriptDraft = media.publishTranscriptDraft;
  const handleGeminiPartial = useCallback(
    (partial: AudioPartialEvent) => {
      acceptRealtimeDraft({
        type: "partial",
        streamId: partial.streamId,
        revision: partial.revision,
        text: partial.text,
        startedAt: partial.startedAt.toISOString(),
        participantIdentity: user.id,
        participantName: myMembership?.name ?? user.name,
      });
      publishTranscriptDraft({
        type: "partial",
        streamId: partial.streamId,
        revision: partial.revision,
        text: partial.text,
        startedAt: partial.startedAt.toISOString(),
      });
    },
    [acceptRealtimeDraft, publishTranscriptDraft, myMembership?.name, user.id, user.name],
  );

  const geminiSpeech = useGeminiTranscription({
    discussionId: discussion.id,
    enabled: transcriptionActive && !media.serverSttActive,
    audioTrack: localAudioTile?.audioTrack ?? null,
    speaking: localSpeaking,
    onPartial: handleGeminiPartial,
    onStored: () => transcriptRefreshRef.current(),
  });
  const canTranscribe =
    shouldTranscribe &&
    media.status === "connected" &&
    (media.serverSttActive || (geminiSpeech.listening && Boolean(localAudioTile?.audioTrack)));

  // Keep the transcript pinned to the newest line.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments]);

  useEffect(() => {
    const timer = setInterval(() => {
      const staleBefore = Date.now() - 60_000;
      setSegments((current) =>
        current.filter(
          (entry) =>
            entry.status === "FINAL" || new Date(entry.updatedAt).getTime() >= staleBefore,
        ),
      );
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * State, in the browser's own log, whether this participant is capturing.
   */
  useEffect(() => {
    if (!isLive || !discussion.transcriptionEnabled) return;
    transcriptLog(canTranscribe ? "capturing this microphone" : "not capturing this microphone", {
      participantId,
      consented,
      micEnabled: media.micEnabled,
      micHardLocked,
      serverSttActive: media.serverSttActive,
      supportsAudioCapture: geminiSpeech.supported,
      reason: canTranscribe
        ? undefined
        : !participantId
          ? "not a member of this discussion"
          : !consented
            ? "transcription consent not given"
            : micHardLocked
              ? "microphone is locked"
              : !media.serverSttActive && !geminiSpeech.supported
                ? "browser cannot record microphone audio"
                : !media.serverSttActive && !localAudioTile?.audioTrack
                  ? "local microphone track is unavailable"
                  : !media.micEnabled
                    ? "microphone is off"
                    : "discussion is not live",
    });
  }, [
    canTranscribe,
    consented,
    discussion.transcriptionEnabled,
    isLive,
    localAudioTile?.audioTrack,
    media.micEnabled,
    media.serverSttActive,
    micHardLocked,
    participantId,
    geminiSpeech.supported,
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

  const notifyAiSpeaking = useCallback(
    (speaking: boolean, estimatedDurationMs?: number) => {
      if (!discussion.aiEnabled || discussion.status !== "LIVE") return;
      void fetch(`/api/discussions/${discussion.id}/ai/speaking`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          speaking,
          ...(typeof estimatedDurationMs === "number" ? { estimatedDurationMs } : {}),
        }),
      })
        .then(() => refresh())
        .catch(() => {});
    },
    [discussion.aiEnabled, discussion.id, discussion.status, refresh],
  );

  // The moderator speaks its messages aloud. It holds its tongue while a
  // participant is talking or the meeting is paused, so it never interrupts.
  const someoneSpeaking = useMemo(() => media.tiles.some((tile) => tile.speaking), [media.tiles]);
  const voice = useAssistantVoice({
    hold: someoneSpeaking || roomPaused,
    onSpeakingChange: notifyAiSpeaking,
  });
  /** Kept in a ref so the polling loop below never restarts when voice state changes. */
  const announceRef = useRef(voice.announce);
  useEffect(() => {
    announceRef.current = voice.announce;
  }, [voice.announce]);

  /** Ids already seen, so a message is spoken once and only once. */
  const seenAiEventIds = useRef(new Set<string>());
  /** The first payload is the backlog: shown, only reading brand-new welcomes (<12s). */
  const aiEventsPrimed = useRef(false);

  /**
   * The countdown the room is currently watching.
   */
  const countdownRef = useRef<{ id: string; endsAt: number; label: string | null } | null>(null);

  const loadAiEvents = useCallback(async () => {
    try {
      const res = await fetch(`/api/discussions/${initial.id}/ai/events`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { events: AiEventEntry[] };
      setAiEvents(data.events);

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
        // Speak a brand-new opening welcome if the host just started the meeting.
        for (const event of fresh) {
          if (
            SPOKEN_AI_KINDS.has(event.kind) &&
            Date.now() - new Date(event.createdAt).getTime() <= 12_000
          ) {
            announceRef.current(event.message);
          }
        }
        return;
      }
      for (const event of fresh) {
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
    if (!discussion.aiEnabled || discussion.status !== "LIVE" || roomPaused) return;
    void loadAiEvents();
    const eventsTimer = setInterval(() => void loadAiEvents(), AI_EVENTS_POLL_MS);
    const tickTimer = setInterval(() => void runAiTick(), AI_TICK_MS);
    const kickoff = setTimeout(() => void runAiTick(), 1200);
    return () => {
      clearInterval(eventsTimer);
      clearInterval(tickTimer);
      clearTimeout(kickoff);
    };
  }, [discussion.aiEnabled, discussion.status, roomPaused, loadAiEvents, runAiTick]);

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

  // Authoritative microphone lock: whenever the host locks this mic, the AI
  // moderator starts speaking, or the meeting pauses, release local capture immediately.
  //
  // FIX: `media.micEnabled` is intentionally excluded from the dependency array.
  // The old code had it in deps, which caused the effect to fire every time the
  // user toggled the mic ON (micEnabled: false → true), and if `micHardLocked`
  // was still stale-true (AI-speaking window < 8 s), the mic was immediately
  // force-muted again — making it impossible to unmute.
  // Now the effect only runs when the lock state itself transitions, so the user
  // can unmute normally once the server confirms the action via POST /mic.
  const setMic = media.setMic;
  const prevMicHardLockedRef = useRef(micHardLocked);
  useEffect(() => {
    const prevLocked = prevMicHardLockedRef.current;
    prevMicHardLockedRef.current = micHardLocked;

    // Force-mute only on lock transitions (unlocked → locked), so we don't
    // repeatedly stomp on the user's own unmute attempts while locked state
    // is stale (< 8 s old roomState broadcast).
    if (micHardLocked && !prevLocked && media.micEnabled) {
      void setMic(false);
    }
  }, [micHardLocked, setMic]); // intentionally omit `media.micEnabled` – we act on lock transitions only

  const removed = Boolean(myMembership?.removed);
  const disconnect = media.disconnect;
  useEffect(() => {
    if (removed) void disconnect();
  }, [removed, disconnect]);

  // ---- Live audio activity, reported to the moderator ----------------------
  usePresenceReporter({
    discussionId: discussion.id,
    enabled: isLive && Boolean(participantId) && !removed && media.status === "connected",
    speaking: localSpeaking && !micHardLocked,
    aiSpeaking: voice.speaking,
    transcribing: Boolean(
      transcriptionActive && (media.serverSttActive || geminiSpeech.listening),
    ),
  });

  /** Synchronized conversation state across all participants. */
  const conversationState = coerceConversationState(
    roomState?.conversationState ?? discussion.conversationState,
  );
  const effectiveAiSpeaking = roomAiLocked || voice.speaking;
  const activeSpeakerId = roomState?.activeSpeakerId ?? discussion.activeSpeakerId ?? null;
  const turnQueue = roomState?.turnQueue ?? [];
  const invitedParticipantId = useMemo(() => {
    const announced = [...aiEvents]
      .reverse()
      .find((event) => (event.kind === "NUDGE" || event.kind === "SILENCE") && event.dueAt);
    return announced?.participantId ?? null;
  }, [aiEvents]);

  const control = useCallback(
    async (action: "start" | "pause" | "resume" | "end") => {
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
        if (action === "start" || action === "resume") {
          void loadAiEvents();
        }

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
    [discussion.id, loadAiEvents, refresh],
  );

  // ---- Auto-end: enforce the host-configured meeting duration ----------------
  // Only the host's browser fires the end action so it runs exactly once.
  // The timer is reset whenever the discussion is paused (paused time does not
  // count toward the duration) and cancelled if the host ends the meeting first.
  const autoEndFiredRef = useRef(false);
  useEffect(() => {
    if (!discussion.isHost) return;
    if (!isLive) return;
    if (!discussion.startedAt) return;
    if (discussion.durationMin <= 0) return;
    if (roomPaused) return;

    const startMs = new Date(discussion.startedAt).getTime();
    const limitMs = discussion.durationMin * 60 * 1000;
    const remaining = limitMs - (Date.now() - startMs);

    if (remaining <= 0) {
      // Already over-time — end immediately (guard against double-fire).
      if (!autoEndFiredRef.current) {
        autoEndFiredRef.current = true;
        void control("end");
      }
      return;
    }

    const timer = setTimeout(() => {
      if (!autoEndFiredRef.current) {
        autoEndFiredRef.current = true;
        void control("end");
      }
    }, remaining);

    return () => clearTimeout(timer);
  }, [
    discussion.isHost,
    isLive,
    discussion.startedAt,
    discussion.durationMin,
    roomPaused,
    control,
  ]);

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

  /** Seconds remaining before the meeting auto-ends; null when not applicable. */
  const timeRemainingSec = useMemo(() => {
    if (!isLive || !discussion.startedAt || discussion.durationMin <= 0) return null;
    const elapsedSec = Math.floor((now - new Date(discussion.startedAt).getTime()) / 1000);
    return Math.max(0, discussion.durationMin * 60 - elapsedSec);
  }, [isLive, discussion.startedAt, discussion.durationMin, now]);

  const remoteWithAudio = media.tiles.filter((tile) => !tile.isLocal && tile.audioTrack);

  if ((discussion.status === "SCHEDULED" || discussion.status === "LIVE") && !lobbyResult && !removed) {
    return (
      <PreJoinLobby
        discussionId={discussion.id}
        title={discussion.title}
        topic={discussion.topic}
        mode={discussion.mode}
        userName={user.name}
        transcriptionEnabled={discussion.transcriptionEnabled}
        initialConsent={consented}
        onEnter={(res) => {
          setLobbyResult(res);
          void refresh();
        }}
      />
    );
  }

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
        <ThemeToggle />
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
          <span
            className={`pill${timeRemainingSec !== null && timeRemainingSec <= 120 ? " border-warn/50 text-warn" : ""}`}
            title={timeRemainingSec !== null ? `${discussion.durationMin} min limit — ${Math.floor(timeRemainingSec / 60)}m ${timeRemainingSec % 60}s remaining` : undefined}
          >
            <Clock className="h-3.5 w-3.5" /> {elapsed}
            {timeRemainingSec !== null && (
              <span className="ml-1 opacity-70">
                / {String(Math.floor(discussion.durationMin * 60 / 60)).padStart(2, "0")}:00
              </span>
            )}
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
          <>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => control(roomPaused ? "resume" : "pause")}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : roomPaused ? (
                <Play className="h-4 w-4 text-accent" />
              ) : (
                <Pause className="h-4 w-4 text-warn" />
              )}
              {roomPaused ? "Resume" : "Pause"}
            </button>
            <button type="button" className="btn-danger" onClick={() => control("end")} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />} End
            </button>
          </>
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

      {isLive && effectiveAiSpeaking && !removed && (
        <p className="flex items-center gap-2 border-b border-accent/50 bg-accent/15 px-5 py-2 text-sm font-medium text-accent">
          <Lock className="h-4 w-4 shrink-0" />
          AI Moderator is speaking – Microphones locked until the moderator finishes.
        </p>
      )}

      {isLive && roomPaused && !effectiveAiSpeaking && !removed && (
        <p className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-5 py-2 text-sm text-warn">
          <Pause className="h-4 w-4 shrink-0" />
          Meeting paused by the host — microphones are locked until resumed.
        </p>
      )}

      {myLocked && !removed && !effectiveAiSpeaking && !roomPaused && (
        <p className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-5 py-2 text-sm text-warn">
          <MicOff className="h-4 w-4" /> Your microphone was locked by the host.
        </p>
      )}

      {/* ---- Meeting-time warning banners ----------------------------------- */}
      {isLive && timeRemainingSec !== null && timeRemainingSec <= 60 && timeRemainingSec > 0 && (
        <p className="flex items-center gap-2 border-b border-danger/50 bg-danger/10 px-5 py-2 text-sm font-semibold text-danger">
          <Clock className="h-4 w-4 shrink-0 animate-pulse" />
          Less than 1 minute remaining — the discussion will end automatically.
          <span className="ml-auto font-mono tabular-nums">
            {String(Math.floor(timeRemainingSec / 60)).padStart(2, "0")}:{String(timeRemainingSec % 60).padStart(2, "0")}
          </span>
        </p>
      )}
      {isLive && timeRemainingSec !== null && timeRemainingSec > 60 && timeRemainingSec <= 120 && (
        <p className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-5 py-2 text-sm text-warn">
          <Clock className="h-4 w-4 shrink-0" />
          2 minutes remaining — the discussion will end automatically when the time is up.
          <span className="ml-auto font-mono tabular-nums">
            {String(Math.floor(timeRemainingSec / 60)).padStart(2, "0")}:{String(timeRemainingSec % 60).padStart(2, "0")}
          </span>
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
            {media.serverSttActive || geminiSpeech.supported
              ? "Live transcription is on. Whenever your microphone is unmuted, your speech is transcribed independently and shared with the room. Your microphone stays off when locked or muted."
              : "Live transcription is on, but audio capture is unavailable in this browser environment."}
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
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  aria-pressed={tableLayout === "round"}
                  onClick={() => selectTableLayout("round")}
                  className={tableLayout === "round" ? "btn-primary py-1 text-xs" : "btn-ghost py-1 text-xs"}
                >
                  Round table
                </button>
                <button
                  type="button"
                  aria-pressed={tableLayout === "table3d"}
                  onClick={() => selectTableLayout("table3d")}
                  className={tableLayout === "table3d" ? "btn-primary py-1 text-xs" : "btn-ghost py-1 text-xs"}
                >
                  3D table
                </button>
              </div>
              {tableLayout === "table3d" && !webglFallback ? (
                <Table3D
                  participants={discussion.participants}
                  tiles={media.tiles}
                  selfUserId={user.id}
                  aiEnabled={discussion.aiEnabled}
                  aiSpeaking={effectiveAiSpeaking}
                  activeSpeakerId={activeSpeakerId}
                  invitedParticipantId={invitedParticipantId}
                  paused={roomPaused}
                  onWebGLFallback={() => setWebglFallback(true)}
                />
              ) : (
                <GdTable
                  participants={discussion.participants}
                  tiles={media.tiles}
                  selfUserId={user.id}
                  aiEnabled={discussion.aiEnabled}
                  aiSpeaking={effectiveAiSpeaking}
                  conversationState={conversationState}
                  activeSpeakerId={activeSpeakerId}
                  turnQueue={turnQueue}
                  paused={roomPaused}
                  invitedParticipantId={invitedParticipantId}
                />
              )}
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
                  disabled={media.status !== "connected" || micHardLocked || removed}
                  className={
                    micHardLocked
                      ? "btn-ghost cursor-not-allowed opacity-70"
                      : media.micEnabled
                        ? "btn-primary"
                        : "btn-ghost"
                  }
                >
                  {micHardLocked ? (
                    <Lock className="h-4 w-4 text-warn" />
                  ) : media.micEnabled ? (
                    <Mic className="h-4 w-4" />
                  ) : (
                    <MicOff className="h-4 w-4" />
                  )}
                  {effectiveAiSpeaking
                    ? "Locked (AI speaking)"
                    : roomPaused
                      ? "Locked (Paused)"
                      : micHardLocked
                        ? "Microphone locked"
                        : media.micEnabled
                          ? "Microphone on"
                          : "Microphone off"}
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
                {turnQueue.length > 0 && (
                  <span className="pill ml-auto text-xs text-warn">
                    Turn queue: {turnQueue.length} waiting
                  </span>
                )}
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
                  {!media.serverSttActive && !geminiSpeech.supported
                    ? "transcription unavailable"
                    : canTranscribe
                      ? media.serverSttActive
                        ? "server STT active"
                        : geminiSpeech.listening
                          ? "listening"
                          : "starting…"
                      : consented
                        ? micHardLocked
                          ? "mic locked"
                          : media.micEnabled
                            ? "paused"
                            : "mic off"
                        : isLive
                          ? "consent needed"
                          : "offline"}
                </span>
              </h2>

              {geminiSpeech.error && (
                <p className="mt-2 text-xs text-danger">{geminiSpeech.error}</p>
              )}
              <p className="mt-1.5 text-xs text-muted">
                {media.serverSttActive
                  ? "Independent server-side transcription is capturing each participant's audio stream directly."
                  : "Cross-browser continuous audio transcription is active for your microphone whenever unmuted."}
              </p>

              <ol
                ref={transcriptRef}
                aria-live="polite"
                className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1"
              >
                {segments.length === 0 ? (
                  <li className="text-sm text-muted">
                    {discussion.status === "LIVE" ? "No speech captured yet." : "The transcript appears once the discussion is live."}
                  </li>
                ) : (
                  segments.map((entry) => (
                    <li
                      key={entry.id}
                      className={`text-sm ${entry.status === "PARTIAL" ? "text-muted" : ""}`}
                    >
                      <span className="mr-2 font-medium text-accent">
                        {entry.speaker}:
                      </span>
                      <span className={entry.status === "PARTIAL" ? "italic text-ink/80" : "text-ink"}>
                        {entry.text}
                      </span>
                      {entry.status === "PARTIAL" && (
                        <span className="ml-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-accent">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                          Live
                        </span>
                      )}
                      {typeof entry.confidence === "number" && (
                        <span
                          className="ml-2 rounded bg-panel-2 px-1 py-0.5 font-mono text-[10px] text-muted"
                          title="Speech-to-text confidence"
                        >
                          {Math.round(entry.confidence * 100)}%
                        </span>
                      )}
                      <span className="ml-2 text-xs text-muted">
                        {new Date(entry.startedAt).toLocaleTimeString()}
                      </span>
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
