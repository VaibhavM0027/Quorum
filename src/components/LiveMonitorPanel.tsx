"use client";

import { Activity, Crown, MicOff, ShieldAlert, UserMinus, UserPlus, Mic } from "lucide-react";
import type { RoomParticipant } from "@/components/RoomClient";

/**
 * Host-only live participation dashboard.
 *
 * Shows, in real time, how much of the talking each participant is doing, who
 * has gone quiet, who has the floor right now, how each person has answered the
 * moderator's invitations, and their live participation score — and lets the
 * host lock a microphone or remove someone.
 *
 * The numbers come from the same stored transcript and audio activity the
 * moderator itself reads, so the board and the moderator never disagree; no
 * separate, competing stats source exists.
 */

export type LiveStat = {
  participant: RoomParticipant;
  speakingMs: number;
  sharePct: number;
  contributions: number;
  wordCount: number;
  lastSpokeAt: string | null;
  silent: boolean;
  /** Has the floor right now, according to LiveKit audio activity. */
  speaking: boolean;
  /** How long they have been in the discussion. */
  presentMs: number;
  /** Contributions judged relevant or highly relevant to the topic. */
  meaningfulContributions: number;
  averageRelevance: number | null;
  /** Times the moderator offered them the floor. */
  invitedCount: number;
  answeredInvites: number;
  /** Invitations never taken up. The only outcome that is penalised. */
  unansweredInvites: number;
  passCount: number;
  /** A recent microphone or connection failure excuses their silence. */
  audioIssue: boolean;
  /**
   * This participant's own browser is currently turning their speech into
   * transcript. It is the only positive proof that they are being captured:
   * consent and a live microphone say what *should* happen, not what is.
   */
  transcribing: boolean;
  /** Live participation score, 0–100; null until the tracker has loaded. */
  score: number | null;
};

export type ParticipantAction = "lock-mic" | "unlock-mic" | "remove" | "restore";

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export default function LiveMonitorPanel({
  stats,
  fairnessIndex,
  busyId,
  onControl,
}: {
  stats: LiveStat[];
  fairnessIndex: number | null;
  busyId: string | null;
  onControl: (participantId: string, action: ParticipantAction) => void;
}) {
  const speakers = stats.filter((s) => !s.participant.removed);
  const currentSpeaker = speakers.find((s) => s.speaking && !s.participant.removed);

  return (
    <div className="card">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
        <Activity className="h-4 w-4" /> Live participation
        {fairnessIndex !== null && (
          <span className="ml-auto text-xs font-normal normal-case">
            balance {(fairnessIndex / 100).toFixed(2)}
          </span>
        )}
      </h2>

      <p className="mt-2 text-xs text-muted">
        {currentSpeaker
          ? `Speaking now: ${currentSpeaker.participant.name}`
          : "Nobody has the floor."}
      </p>

      {fairnessIndex !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-input">
          <div
            className={`h-full rounded-full ${fairnessIndex >= 70 ? "bg-accent" : fairnessIndex >= 40 ? "bg-warn" : "bg-danger"}`}
            style={{ width: `${Math.max(2, Math.min(100, fairnessIndex))}%` }}
          />
        </div>
      )}

      <ul className="mt-3 space-y-3">
        {speakers.length === 0 && <li className="text-sm text-muted">Nobody is in the room yet.</li>}
        {speakers.map((stat) => {
          const active = !stat.participant.leftAt;
          const locked = stat.participant.micLocked;
          return (
            <li key={stat.participant.id} className="rounded-lg border border-line bg-panel-2 px-3 py-2">
              <div className="flex items-center gap-2">
                {stat.speaking && (
                  <span
                    className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent"
                    title="Speaking now"
                  />
                )}
                <span className="truncate text-sm">{stat.participant.name}</span>
                {stat.participant.isHost && <Crown className="h-3.5 w-3.5 shrink-0 text-accent" />}
                {locked && (
                  <span className="pill shrink-0" title="Microphone locked by the host">
                    <MicOff className="h-3 w-3" /> locked
                  </span>
                )}
                {stat.audioIssue && (
                  <span className="pill shrink-0" title="Microphone or connection problem">
                    audio issue
                  </span>
                )}
                {active && (
                  <span
                    className={`pill shrink-0 ${stat.transcribing ? "text-accent" : "text-warn"}`}
                    title={
                      stat.transcribing
                        ? "This participant's microphone is being transcribed"
                        : !stat.participant.transcriptionConsent
                          ? "This participant has not allowed transcription, so their speech is not captured"
                          : "Not transcribing right now — their microphone is off, or their browser cannot record audio"
                    }
                  >
                    {stat.transcribing
                      ? "transcribing"
                      : stat.participant.transcriptionConsent
                        ? "not transcribing"
                        : "no consent"}
                  </span>
                )}
                {!active && (
                  <span className="pill shrink-0" title="Left the room">
                    left
                  </span>
                )}
                <span className="ml-auto shrink-0 text-xs text-muted">
                  {stat.sharePct.toFixed(1)}% · {formatDuration(stat.speakingMs)}
                </span>
              </div>

              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-input">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${Math.max(1, Math.min(100, stat.sharePct))}%` }}
                />
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>
                  {stat.contributions} contribution{stat.contributions === 1 ? "" : "s"} ·{" "}
                  {stat.wordCount} words
                </span>
                <span title="Contributions judged relevant to the topic">
                  {stat.meaningfulContributions} relevant
                </span>
                {stat.averageRelevance !== null && (
                  <span title="Average relevance of their scored contributions">
                    relevance {Math.round(stat.averageRelevance)}%
                  </span>
                )}
                {stat.score !== null && (
                  <span className="ml-auto font-medium text-ink" title="Live participation score">
                    score {Math.round(stat.score)}
                  </span>
                )}
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span title="Times the moderator offered this participant the floor">
                  invited {stat.invitedCount}
                </span>
                <span>answered {stat.answeredInvites}</span>
                {stat.unansweredInvites > 0 && (
                  <span className="text-warn" title="Invitations this participant never responded to">
                    no reply {stat.unansweredInvites}
                  </span>
                )}
                {stat.passCount > 0 && <span>passed {stat.passCount}</span>}
                <span className="ml-auto">
                  {stat.lastSpokeAt
                    ? `last spoke ${new Date(stat.lastSpokeAt).toLocaleTimeString()}`
                    : "has not spoken"}
                </span>
              </div>

              {stat.silent && !stat.participant.removed && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-warn">
                  <ShieldAlert className="h-3.5 w-3.5" /> Quiet for a while — consider inviting them in.
                </p>
              )}

              {!stat.participant.isHost && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-ghost !py-1 !text-xs"
                    disabled={busyId === stat.participant.id}
                    onClick={() => onControl(stat.participant.id, locked ? "unlock-mic" : "lock-mic")}
                  >
                    {locked ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
                    {locked ? "Unlock mic" : "Lock mic"}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost !py-1 !text-xs"
                    disabled={busyId === stat.participant.id}
                    onClick={() =>
                      onControl(stat.participant.id, stat.participant.removed ? "restore" : "remove")
                    }
                  >
                    {stat.participant.removed ? (
                      <UserPlus className="h-3.5 w-3.5" />
                    ) : (
                      <UserMinus className="h-3.5 w-3.5" />
                    )}
                    {stat.participant.removed ? "Restore" : "Remove"}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
