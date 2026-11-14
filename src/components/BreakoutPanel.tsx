"use client";

import { useState } from "react";
import { Loader2, Shuffle, UsersRound } from "lucide-react";
import type { RoomParticipant } from "@/components/RoomClient";
import { MAX_GROUP_SIZE, MIN_GROUP_SIZE, breakoutAllocation } from "@/lib/breakout";

/**
 * Host-only view of the breakout rooms.
 *
 * Shows how the room splits — total participants, the configured group size and
 * how many rooms that needs — lets the host change the group size or reshuffle,
 * and lets them move one student into another room.
 *
 * The grouping is computed with `breakoutAllocation`, the same function the
 * server uses, so what the host reads here is the allocation students are
 * actually being placed in rather than a parallel guess. While the rooms are
 * switched off it shows the split they *would* get, which is why the panel is
 * useful before the discussion has even started.
 */

export type BreakoutCommand =
  | { action: "enable"; groupSize: number }
  | { action: "disable" }
  | { action: "reshuffle" }
  | { action: "move"; participantId: string; room: number };

function clamp(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_GROUP_SIZE, Math.max(MIN_GROUP_SIZE, Math.trunc(value)));
}

export default function BreakoutPanel({
  participants,
  enabled,
  groupSize,
  busy,
  onControl,
}: {
  participants: RoomParticipant[];
  enabled: boolean;
  groupSize: number;
  busy: boolean;
  onControl: (command: BreakoutCommand) => void;
}) {
  /** What the host is typing; null means "show what the server has". */
  const [draft, setDraft] = useState<string | null>(null);

  const allocation = breakoutAllocation(
    participants.map((p) => ({
      id: p.id,
      name: p.name,
      breakoutRoom: p.breakoutRoom,
      isHost: p.isHost,
      removed: p.removed,
      left: Boolean(p.leftAt),
      seatNumber: p.seatNumber,
    })),
    enabled,
    groupSize,
  );

  const shownSize = draft ?? String(allocation.groupSize);
  const nextSize = clamp(Number(shownSize), allocation.groupSize);

  return (
    <div className="card">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
        <UsersRound className="h-4 w-4" /> Breakout rooms
        <span
          className={`ml-auto text-xs font-normal normal-case ${enabled ? "text-accent" : "text-muted"}`}
        >
          {enabled ? "on" : "off"}
        </span>
      </h2>

      <p className="mt-2 text-xs text-muted">
        {allocation.studentCount} student{allocation.studentCount === 1 ? "" : "s"} · group size{" "}
        {allocation.groupSize} · {allocation.roomCount} room
        {allocation.roomCount === 1 ? "" : "s"}
        {allocation.roomCount > 0 && ` · about ${allocation.evenSize} each`}
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="w-24">
          <label className="label" htmlFor="breakout-group-size">
            Group size
          </label>
          <input
            id="breakout-group-size"
            type="number"
            min={MIN_GROUP_SIZE}
            max={MAX_GROUP_SIZE}
            className="field"
            value={shownSize}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => {
            setDraft(null);
            onControl({ action: "enable", groupSize: nextSize });
          }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {enabled ? "Apply" : "Turn on"}
        </button>
        {enabled && (
          <>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => onControl({ action: "reshuffle" })}
            >
              <Shuffle className="h-4 w-4" /> Reshuffle
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => onControl({ action: "disable" })}
            >
              Turn off
            </button>
          </>
        )}
      </div>

      <ul className="mt-3 space-y-3">
        {allocation.rooms.length === 0 && (
          <li className="text-sm text-muted">Nobody is in the room yet.</li>
        )}
        {allocation.rooms.map((room) => (
          <li key={room.number} className="rounded-lg border border-line bg-panel-2 px-3 py-2">
            <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-accent">
              Room {room.number}
              <span className="ml-auto font-normal normal-case text-muted">
                {room.members.length} student{room.members.length === 1 ? "" : "s"}
              </span>
            </p>

            <ul className="mt-2 space-y-1.5">
              {room.members.length === 0 && <li className="text-xs text-muted">empty</li>}
              {room.members.map((member) => (
                <li key={member.id} className="flex items-center gap-2 text-sm">
                  <span className="truncate">{member.name}</span>
                  {member.seatNumber !== null && (
                    <span className="shrink-0 text-xs text-muted">Seat {member.seatNumber}</span>
                  )}
                  {enabled && allocation.roomCount > 1 && (
                    <select
                      className="field ml-auto !w-auto !px-2 !py-1 text-xs"
                      value={member.breakoutRoom ?? room.number}
                      disabled={busy}
                      aria-label={`Move ${member.name} to another room`}
                      onChange={(event) =>
                        onControl({
                          action: "move",
                          participantId: member.id,
                          room: Number(event.target.value),
                        })
                      }
                    >
                      {allocation.rooms.map((option) => (
                        <option key={option.number} value={option.number}>
                          Room {option.number}
                        </option>
                      ))}
                    </select>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs text-muted">
        {enabled
          ? "Each group has its own room, so it hears only itself. You stay in the main room and can move anyone at any time."
          : "Students are shown the split they would get. Nothing changes until you turn the rooms on."}
      </p>
    </div>
  );
}
