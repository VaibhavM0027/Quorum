"use client";

import { Activity, Crown, MicOff, ShieldAlert, UserMinus, UserPlus, Mic } from "lucide-react";
import type { RoomParticipant } from "@/components/RoomClient";

/**
 * Host-only live monitor.
 *
 * Shows, in real time, how much of the talking each participant is doing, who
 * has gone quiet, and lets the host lock a microphone or remove someone. The
 * numbers come from the shared transcript, so they are the same evidence the
 * evaluation will use later — no separate, disagreeing stats source.
 */

export type LiveStat = {
  participant: RoomParticipant;
  speakingMs: number;
  sharePct: number;
  contributions: number;
  wordCount: number;
  lastSpokeAt: string | null;
  silent: boolean;
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

  return (
    <div className="card">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
        <Activity className="h-4 w-4" /> Live monitor
        {fairnessIndex !== null && (
          <span className="ml-auto text-xs font-normal normal-case">
            balance {(fairnessIndex / 100).toFixed(2)}
          </span>
        )}
      </h2>

      {fairnessIndex !== null && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-input">
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
                <span className="truncate text-sm">{stat.participant.name}</span>
                {stat.participant.isHost && <Crown className="h-3.5 w-3.5 shrink-0 text-accent" />}
                {locked && (
                  <span className="pill shrink-0" title="Microphone locked by the host">
                    <MicOff className="h-3 w-3" /> locked
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

              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>
                  {stat.contributions} contribution{stat.contributions === 1 ? "" : "s"} ·{" "}
                  {stat.wordCount} words
                </span>
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
