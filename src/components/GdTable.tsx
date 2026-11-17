"use client";

import {
  Bot,
  Crown,
  Lock,
  Mic,
  MicOff,
  PauseCircle,
  Sparkles,
  VideoOff,
  WifiOff,
} from "lucide-react";
import MediaTrack from "@/components/MediaTrack";
import { CONVERSATION_STATE_LABEL, coerceConversationState } from "@/lib/conversation-state";
import { headPosition, seatPosition } from "@/lib/seats";

export type SeatPerson = {
  id: string;
  userId: string;
  name: string;
  isHost: boolean;
  seatNumber: number | null;
  removed: boolean;
  leftAt: string | null;
  micLocked?: boolean;
};

export type SeatMedia = {
  identity: string;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
  micEnabled: boolean;
  camEnabled: boolean;
  speaking: boolean;
};

function tileWidthPercent(total: number): number {
  if (total <= 6) return 21;
  if (total <= 10) return 16.5;
  if (total <= 16) return 13;
  if (total <= 22) return 10;
  return 8.5;
}

function plateWidthPercent(total: number): number {
  if (total <= 10) return 9.5;
  if (total <= 16) return 7.5;
  if (total <= 22) return 5.8;
  return 4.8;
}

export default function GdTable({
  participants,
  tiles,
  maxSeats,
  selfUserId,
  aiEnabled = true,
  aiSpeaking = false,
  conversationState = "IDLE",
  activeSpeakerId = null,
  turnQueue = [],
  paused = false,
  invitedParticipantId = null,
}: {
  participants: SeatPerson[];
  tiles: SeatMedia[];
  maxSeats: number;
  selfUserId: string;
  aiEnabled?: boolean;
  aiSpeaking?: boolean;
  conversationState?: string;
  activeSpeakerId?: string | null;
  turnQueue?: string[];
  paused?: boolean;
  invitedParticipantId?: string | null;
}) {
  const mediaByUser = new Map(tiles.map((tile) => [tile.identity, tile]));
  const normalizedState = coerceConversationState(conversationState);
  const aiThinking = normalizedState === "AI_THINKING";

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
  const showNames = maxSeats <= 12;
  const headPlate = headPosition(0.62);

  return (
    <div className="card overflow-hidden border-line/90 bg-gradient-to-b from-panel to-bg/95">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Round-Table Conference Room
          </h2>
          <p className="text-xs text-muted/80">
            Seated circular discussion table with synchronized human-AI turn control
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {paused ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn/15 px-2.5 py-1 font-medium text-warn">
              <PauseCircle className="h-3.5 w-3.5" /> Meeting paused
            </span>
          ) : aiSpeaking ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/60 bg-accent/20 px-2.5 py-1 font-medium text-accent shadow-[0_0_16px_rgba(52,211,153,0.25)]">
              <span className="h-2 w-2 animate-ping rounded-full bg-accent" />
              AI Moderator Speaking · Mics Locked
            </span>
          ) : (
            <span className="pill text-xs">
              <Sparkles className="h-3 w-3 text-accent" />
              {CONVERSATION_STATE_LABEL[normalizedState]}
            </span>
          )}
        </div>
      </div>

      {/* Physical round-table stage (desktop & tablet) */}
      <div className="relative mx-auto mt-4 hidden min-h-[340px] w-full max-w-4xl sm:block sm:aspect-[16/10]">
        {/* Soft conference-room floor aura */}
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[50%] blur-2xl transition-all duration-500"
          style={{
            width: "70%",
            height: "68%",
            background: aiSpeaking
              ? "radial-gradient(circle, rgba(52,211,153,0.18) 0%, rgba(14,21,18,0) 70%)"
              : "radial-gradient(circle, rgba(52,211,153,0.08) 0%, rgba(14,21,18,0) 72%)",
          }}
        />

        {/* Sculpted oval conference table top with recessed inner acoustic surface */}
        <div
          className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-2 shadow-[0_24px_60px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.08)] transition-all duration-500 ${
            aiSpeaking
              ? "border-accent/60 ring-4 ring-accent/15"
              : paused
                ? "border-warn/40"
                : "border-[#2f493e]"
          }`}
          style={{
            width: "63%",
            height: "62%",
            background:
              "radial-gradient(ellipse at 50% 42%, #23382f 0%, #16241e 58%, #0f1915 100%)",
          }}
        >
          {/* Decorative inner table inlay ring */}
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-white/5"
            style={{ width: "80%", height: "78%" }}
          />

          {/* Centerpiece: AI Moderator Presence Hub */}
          {aiEnabled && (
            <div className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center">
              <div className="relative flex items-center justify-center">
                {aiSpeaking && (
                  <>
                    <span className="absolute h-20 w-20 animate-ping rounded-full bg-accent/20" />
                    <span className="absolute h-16 w-16 animate-pulse rounded-full border border-accent/60" />
                  </>
                )}
                {aiThinking && !aiSpeaking && (
                  <span className="absolute h-16 w-16 animate-spin rounded-full border-2 border-dashed border-accent/50" />
                )}
                <div
                  className={`relative grid h-14 w-14 place-items-center rounded-full border-2 shadow-lg transition-all duration-300 ${
                    paused
                      ? "border-warn/50 bg-panel-2 text-warn"
                      : aiSpeaking
                        ? "scale-110 border-accent bg-accent/25 text-accent shadow-[0_0_24px_rgba(52,211,153,0.45)]"
                        : aiThinking
                          ? "border-accent/60 bg-panel-2 text-accent"
                          : "border-accent/35 bg-panel/95 text-accent/90"
                  }`}
                >
                  <Bot className="h-6 w-6" />
                </div>
              </div>

              <div className="mt-2 rounded-lg border border-line/80 bg-bg/85 px-2.5 py-1 backdrop-blur-sm">
                <p className="text-[11px] font-semibold tracking-wide text-ink">AI Moderator</p>
                <div className="flex items-center justify-center gap-1.5">
                  {aiSpeaking && <WaveformBars active />}
                  <p className={`text-[10px] ${aiSpeaking ? "font-medium text-accent" : "text-muted"}`}>
                    {paused
                      ? "Paused"
                      : aiSpeaking
                        ? "Speaking aloud…"
                        : aiThinking
                          ? "Formulating response…"
                          : "Listening"}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Name plates placed cleanly on the inner perimeter of the table */}
        {seats.map((seatNumber) => {
          const position = seatPosition(seatNumber - 1, maxSeats, 0.62);
          const occupant = seatHolders.get(seatNumber);
          const isActiveSpeaker = occupant && activeSpeakerId === occupant.id;
          const isInvited = occupant && invitedParticipantId === occupant.id;
          return (
            <div
              key={`plate-${seatNumber}`}
              className="absolute z-10 -translate-x-1/2 -translate-y-1/2 transition-all duration-300"
              style={{ left: `${position.left}%`, top: `${position.top}%`, width: `${plateWidth}%` }}
            >
              <div
                className={`rounded-md border px-1 py-0.5 text-center leading-tight shadow-sm backdrop-blur-sm transition-colors ${
                  isActiveSpeaker
                    ? "border-accent bg-accent/20"
                    : isInvited
                      ? "border-warn/70 bg-warn/15"
                      : occupant
                        ? "border-accent/35 bg-bg/80"
                        : "border-line/50 bg-panel/50 opacity-70"
                }`}
              >
                <p className={`text-[9px] font-semibold ${occupant ? "text-ink" : "text-muted"}`}>
                  Seat {seatNumber}
                </p>
                {showNames && (
                  <p className="truncate text-[8px] text-muted">
                    {occupant ? (occupant.userId === selfUserId ? "You" : occupant.name) : "open"}
                  </p>
                )}
              </div>
            </div>
          );
        })}

        {/* Host nameplate at head of the table */}
        <div
          className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${headPlate.left}%`, top: `${headPlate.top}%`, width: `${plateWidth}%` }}
        >
          <div className="rounded-md border border-accent/45 bg-bg/85 px-1 py-0.5 text-center leading-tight shadow-sm">
            <p className="text-[9px] font-semibold text-accent">Host Chair</p>
            {showNames && <p className="truncate text-[8px] text-muted">{host ? host.name : "—"}</p>}
          </div>
        </div>

        {/* Participant video seats around the table */}
        {seats.map((seatNumber) => {
          const occupant = seatHolders.get(seatNumber);
          if (!occupant) return null;
          const queueIdx = turnQueue.indexOf(occupant.id);
          return (
            <Seat
              key={`seat-${occupant.id}`}
              seatNumber={seatNumber}
              name={occupant.userId === selfUserId ? `${occupant.name} (you)` : occupant.name}
              isSelf={occupant.userId === selfUserId}
              isHost={false}
              micLocked={Boolean(occupant.micLocked) || aiSpeaking || paused}
              isActiveSpeaker={activeSpeakerId === occupant.id}
              isInvited={invitedParticipantId === occupant.id}
              queuePosition={queueIdx >= 0 ? queueIdx + 1 : null}
              position={seatPosition(seatNumber - 1, maxSeats)}
              width={tileWidth}
              media={mediaByUser.get(occupant.userId) ?? null}
            />
          );
        })}

        {/* Host seated at head of table */}
        {host && (
          <Seat
            key={`seat-host-${host.id}`}
            seatNumber={null}
            name={host.userId === selfUserId ? `${host.name} (you)` : host.name}
            isSelf={host.userId === selfUserId}
            isHost
            micLocked={Boolean(host.micLocked) || aiSpeaking || paused}
            isActiveSpeaker={activeSpeakerId === host.id}
            isInvited={false}
            queuePosition={turnQueue.indexOf(host.id) >= 0 ? turnQueue.indexOf(host.id) + 1 : null}
            position={headPosition()}
            width={tileWidth}
            media={mediaByUser.get(host.userId) ?? null}
          />
        )}
      </div>

      {/* Responsive mobile round-table arrangement (< 640px) */}
      <div className="mt-4 space-y-3 sm:hidden">
        {aiEnabled && (
          <div
            className={`flex items-center justify-between rounded-xl border p-3 ${
              aiSpeaking
                ? "border-accent bg-accent/15 shadow-[0_0_20px_rgba(52,211,153,0.2)]"
                : "border-line bg-panel-2"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <div className="grid h-10 w-10 place-items-center rounded-full border border-accent/40 bg-bg text-accent">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold text-ink">AI Moderator</p>
                <p className="text-[11px] text-muted">
                  {paused
                    ? "Paused"
                    : aiSpeaking
                      ? "Speaking – mics locked"
                      : aiThinking
                        ? "Formulating response…"
                        : "Listening"}
                </p>
              </div>
            </div>
            {aiSpeaking && <WaveformBars active />}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2.5">
          {participants
            .filter((p) => !p.removed)
            .map((person) => {
              const media = mediaByUser.get(person.userId) ?? null;
              const speakingNow = Boolean(media?.speaking) || activeSpeakerId === person.id;
              const locked = Boolean(person.micLocked) || aiSpeaking || paused;
              return (
                <div
                  key={`mobile-seat-${person.id}`}
                  className={`relative aspect-[4/3] overflow-hidden rounded-xl border bg-panel-2 ${
                    speakingNow ? "border-accent ring-2 ring-accent/25" : "border-line"
                  }`}
                >
                  {media?.camEnabled && media.videoTrack ? (
                    <MediaTrack
                      track={media.videoTrack}
                      kind="video"
                      muted={person.userId === selfUserId}
                      className={`h-full w-full object-cover ${person.userId === selfUserId ? "-scale-x-100" : ""}`}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-bg">
                      <span className="grid h-10 w-10 place-items-center rounded-full border border-line bg-panel text-xs font-semibold uppercase">
                        {person.name.slice(0, 2)}
                      </span>
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/75 px-2 py-1 text-[10px] text-white">
                    <span className="truncate">
                      {person.userId === selfUserId ? `${person.name} (you)` : person.name}
                    </span>
                    {speakingNow ? (
                      <WaveformBars active />
                    ) : locked ? (
                      <Lock className="h-3 w-3 text-warn" />
                    ) : media?.micEnabled ? (
                      <Mic className="h-3 w-3 text-accent" />
                    ) : (
                      <MicOff className="h-3 w-3 text-muted" />
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      <p className="mt-3 text-xs text-muted">
        Seats stay assigned per participant throughout the meeting. The glowing ring marks whoever holds the speaking floor.
      </p>
    </div>
  );
}

function WaveformBars({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <span className="inline-flex items-end gap-0.5" aria-hidden>
      <span className="h-2 w-0.5 animate-pulse rounded-full bg-accent" />
      <span className="h-3.5 w-0.5 animate-bounce rounded-full bg-accent" />
      <span className="h-2.5 w-0.5 animate-pulse rounded-full bg-accent" />
    </span>
  );
}

function Seat({
  seatNumber,
  name,
  isSelf,
  isHost,
  micLocked,
  isActiveSpeaker,
  isInvited,
  queuePosition,
  position,
  width,
  media,
}: {
  seatNumber: number | null;
  name: string;
  isSelf: boolean;
  isHost: boolean;
  micLocked: boolean;
  isActiveSpeaker: boolean;
  isInvited: boolean;
  queuePosition: number | null;
  position: { left: number; top: number };
  width: number;
  media: SeatMedia | null;
}) {
  const connected = Boolean(media);
  const video = media?.camEnabled ? media.videoTrack : null;
  const speakingNow = Boolean(media?.speaking) || isActiveSpeaker;

  return (
    <div
      className="absolute z-20 -translate-x-1/2 -translate-y-1/2 transition-all duration-500 ease-out"
      style={{ left: `${position.left}%`, top: `${position.top}%`, width: `${width}%` }}
    >
      <div
        className={`relative aspect-[4/3] overflow-hidden rounded-2xl border-2 bg-panel-2 shadow-[0_12px_28px_rgba(0,0,0,0.55)] transition-all duration-300 ${
          speakingNow
            ? "scale-105 border-accent ring-4 ring-accent/25 shadow-[0_0_24px_rgba(52,211,153,0.35)]"
            : isInvited
              ? "border-warn ring-2 ring-warn/25"
              : isSelf
                ? "border-accent/65"
                : "border-line"
        } ${connected ? "opacity-100" : "opacity-65"}`}
      >
        {video ? (
          <MediaTrack
            track={video}
            kind="video"
            muted={isSelf}
            className={`h-full w-full object-cover ${isSelf ? "-scale-x-100" : ""}`}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-b from-panel-2 to-bg">
            <span
              className={`grid h-10 w-10 place-items-center rounded-full border text-xs font-semibold uppercase sm:h-12 sm:w-12 sm:text-sm ${
                speakingNow
                  ? "border-accent bg-accent/20 text-accent"
                  : "border-line bg-input text-ink"
              }`}
            >
              {name.slice(0, 2)}
            </span>
          </div>
        )}

        {/* Top-left seat/host indicator */}
        {seatNumber !== null ? (
          <span className="absolute left-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[9px] font-semibold text-white backdrop-blur-sm">
            #{seatNumber}
          </span>
        ) : (
          <span
            className="absolute left-1.5 top-1.5 rounded-md bg-black/70 p-1 backdrop-blur-sm"
            title="Host"
          >
            <Crown className="h-3 w-3 text-accent" />
          </span>
        )}

        {/* Top-right mic / camera / lock / queue status */}
        <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
          {queuePosition !== null && (
            <span
              className="rounded-md bg-warn/90 px-1 py-0.5 text-[8px] font-bold text-black"
              title="Waiting for speaking turn"
            >
              Q{queuePosition}
            </span>
          )}
          {!connected ? (
            <span className="rounded-full bg-black/70 p-1" title="Offline">
              <WifiOff className="h-2.5 w-2.5 text-muted" />
            </span>
          ) : (
            <>
              {!media?.camEnabled && (
                <span className="rounded-full bg-black/70 p-1" title="Camera off">
                  <VideoOff className="h-2.5 w-2.5 text-muted" />
                </span>
              )}
              {micLocked ? (
                <span className="rounded-full bg-black/80 p-1" title="Microphone locked">
                  <Lock className="h-2.5 w-2.5 text-warn" />
                </span>
              ) : media?.micEnabled ? (
                <span
                  className={`rounded-full p-1 ${
                    speakingNow ? "bg-accent text-black" : "bg-black/70 text-accent"
                  }`}
                  title={speakingNow ? "Speaking" : "Microphone on"}
                >
                  <Mic className="h-2.5 w-2.5" />
                </span>
              ) : (
                <span className="rounded-full bg-black/70 p-1" title="Microphone muted">
                  <MicOff className="h-2.5 w-2.5 text-muted" />
                </span>
              )}
            </>
          )}
        </div>

        {/* Nameplate gradient bar */}
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-2 py-1">
          {isHost && <Crown className="h-3 w-3 shrink-0 text-accent" />}
          <span className="truncate text-[10px] font-medium text-white">{name}</span>
          {speakingNow && (
            <span className="ml-auto shrink-0">
              <WaveformBars active />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
