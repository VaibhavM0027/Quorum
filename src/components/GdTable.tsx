"use client";

import { Crown, MicOff, WifiOff } from "lucide-react";
import MediaTrack from "@/components/MediaTrack";
import { headPosition, seatPosition } from "@/lib/seats";

/**
 * The group discussion table.
 *
 * This is the room seen from above: one oval table, a numbered seat for every
 * student and a distinguishable place at the head for the moderator. Seat
 * numbers come from the database rather than from the order people happened to
 * connect, so a student who drops out and returns sits back down in the same
 * chair — the same number plate is waiting in front of them.
 */

/** The minimum a participant needs to be given a place at the table. */
export type SeatPerson = {
  id: string;
  userId: string;
  name: string;
  isHost: boolean;
  seatNumber: number | null;
  removed: boolean;
  leftAt: string | null;
};

/** The media a person brings to their seat, once their browser is connected. */
export type SeatMedia = {
  identity: string;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
  micEnabled: boolean;
  camEnabled: boolean;
  speaking: boolean;
};

/** Tiles and name plates shrink as the room fills, so a large table still fits. */
function tileWidthPercent(total: number): number {
  if (total <= 6) return 22;
  if (total <= 10) return 17;
  if (total <= 16) return 13;
  if (total <= 22) return 10;
  return 8;
}

function plateWidthPercent(total: number): number {
  if (total <= 10) return 9;
  if (total <= 16) return 7;
  if (total <= 22) return 5.5;
  return 4.5;
}

export default function GdTable({
  participants,
  tiles,
  maxSeats,
  selfUserId,
}: {
  participants: SeatPerson[];
  tiles: SeatMedia[];
  maxSeats: number;
  selfUserId: string;
}) {
  const mediaByUser = new Map(tiles.map((tile) => [tile.identity, tile]));

  const seatHolders = new Map<number, SeatPerson>();
  let host: SeatPerson | null = null;
  for (const person of participants) {
    if (person.removed) continue;
    if (person.isHost) {
      host = host ?? person;
      continue;
    }
    if (person.seatNumber !== null) seatHolders.set(person.seatNumber, person);
  }

  const seats = Array.from({ length: maxSeats }, (_, index) => index + 1);
  const tileWidth = tileWidthPercent(maxSeats);
  const plateWidth = plateWidthPercent(maxSeats);
  // On a crowded table there is no room for names on the plates as well.
  const showNames = maxSeats <= 12;
  const headPlate = headPosition(0.62);

  return (
    <div className="card">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Discussion table</h2>

      <div className="relative mx-auto mt-2 aspect-[16/10] w-full max-w-3xl">
        {/* The table itself. */}
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-line bg-panel-2"
          style={{ width: "62%", height: "62%" }}
        />

        {/* Name plates on the table, one in front of every seat. */}
        {seats.map((seatNumber) => {
          const position = seatPosition(seatNumber - 1, maxSeats, 0.62);
          const occupant = seatHolders.get(seatNumber);
          return (
            <div
              key={`plate-${seatNumber}`}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${position.left}%`, top: `${position.top}%`, width: `${plateWidth}%` }}
            >
              <div
                className={`rounded border px-0.5 py-0.5 text-center leading-tight ${
                  occupant ? "border-accent/40 bg-accent/10" : "border-line/70 bg-panel/70"
                }`}
              >
                <p className={`text-[10px] font-semibold ${occupant ? "text-ink" : "text-muted"}`}>
                  Seat {seatNumber}
                </p>
                {showNames && (
                  <p className="truncate text-[9px] text-muted">
                    {occupant ? (occupant.userId === selfUserId ? "You" : occupant.name) : "open"}
                  </p>
                )}
              </div>
            </div>
          );
        })}

        {/* The moderator's place at the head of the table. */}
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${headPlate.left}%`, top: `${headPlate.top}%`, width: `${plateWidth}%` }}
        >
          <div className="rounded border border-accent/40 bg-accent/10 px-0.5 py-0.5 text-center leading-tight">
            <p className="text-[10px] font-semibold text-ink">Moderator</p>
            {showNames && <p className="truncate text-[9px] text-muted">{host ? host.name : "—"}</p>}
          </div>
        </div>

        {/* Students, seated in their numbered chairs. */}
        {seats.map((seatNumber) => {
          const occupant = seatHolders.get(seatNumber);
          if (!occupant) return null;
          return (
            <Seat
              key={`seat-${seatNumber}`}
              seatNumber={seatNumber}
              name={occupant.userId === selfUserId ? `${occupant.name} (you)` : occupant.name}
              isSelf={occupant.userId === selfUserId}
              isHost={false}
              position={seatPosition(seatNumber - 1, maxSeats)}
              width={tileWidth}
              media={mediaByUser.get(occupant.userId) ?? null}
            />
          );
        })}

        {host && (
          <Seat
            seatNumber={null}
            name={host.userId === selfUserId ? `${host.name} (you)` : host.name}
            isSelf={host.userId === selfUserId}
            isHost
            position={headPosition()}
            width={tileWidth}
            media={mediaByUser.get(host.userId) ?? null}
          />
        )}
      </div>

      <p className="mt-3 text-xs text-muted">
        Seats are numbered around the table. Your seat is kept while you are away, so you come back
        to the same place.
      </p>
    </div>
  );
}

/** One student's chair: their camera, or their initials when the camera is off. */
function Seat({
  seatNumber,
  name,
  isSelf,
  isHost,
  position,
  width,
  media,
}: {
  seatNumber: number | null;
  name: string;
  isSelf: boolean;
  isHost: boolean;
  position: { left: number; top: number };
  width: number;
  media: SeatMedia | null;
}) {
  const connected = Boolean(media);
  const video = media?.camEnabled ? media.videoTrack : null;

  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${position.left}%`, top: `${position.top}%`, width: `${width}%` }}
    >
      <div
        className={`relative aspect-video overflow-hidden rounded-lg border bg-panel-2 ${
          media?.speaking ? "border-accent" : isSelf ? "border-accent/60" : "border-line"
        } ${connected ? "" : "opacity-60"}`}
      >
        {video ? (
          <MediaTrack track={video} kind="video" muted={isSelf} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-input text-xs font-semibold uppercase text-ink sm:h-11 sm:w-11">
              {name.slice(0, 2)}
            </span>
          </div>
        )}

        {seatNumber !== null ? (
          <span className="absolute left-1 top-1 rounded bg-black/65 px-1 py-0.5 text-[9px] font-semibold text-white">
            {seatNumber}
          </span>
        ) : (
          <span className="absolute left-1 top-1 rounded bg-black/65 p-0.5">
            <Crown className="h-3 w-3 text-accent" />
          </span>
        )}

        {connected && !media?.micEnabled && (
          <span className="absolute right-1 top-1 rounded-full bg-black/65 p-0.5" title="Microphone off">
            <MicOff className="h-2.5 w-2.5 text-muted" />
          </span>
        )}
        {!connected && (
          <span className="absolute right-1 top-1 rounded-full bg-black/65 p-0.5" title="Not connected">
            <WifiOff className="h-2.5 w-2.5 text-muted" />
          </span>
        )}

        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/75 to-transparent px-1 py-0.5">
          {isHost && <Crown className="h-3 w-3 shrink-0 text-accent" />}
          <span className="truncate text-[10px] text-white">{name}</span>
        </div>
      </div>
    </div>
  );
}
