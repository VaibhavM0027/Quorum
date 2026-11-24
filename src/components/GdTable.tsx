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
  joinedAt: string | null;
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
  if (total <= 4) return 17;
  if (total <= 8) return 14.5;
  if (total <= 14) return 12;
  if (total <= 22) return 10;
  return 8.5;
}

export default function GdTable({
  participants,
  tiles,
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

  const seatedParticipants = participants
    .filter(
      (person) =>
        !person.removed &&
        !person.leftAt &&
        (person.joinedAt || mediaByUser.has(person.userId)) &&
        !person.isHost,
    )
    .sort((a, b) => (a.seatNumber ?? Number.MAX_SAFE_INTEGER) - (b.seatNumber ?? Number.MAX_SAFE_INTEGER));
  const host =
    participants.find(
      (person) =>
        person.isHost &&
        !person.removed &&
        !person.leftAt &&
        (person.joinedAt || mediaByUser.has(person.userId)),
    ) ?? null;
  const seatCount = seatedParticipants.length;
  const tableOccupancy = seatCount + Number(Boolean(host));
  const tileWidth = tileWidthPercent(tableOccupancy);
  const chairWidth = Math.max(tileWidth * 1.12, 8);

  return (
    <div className="card overflow-hidden">
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
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/50 bg-accent/10 px-2.5 py-1 font-medium text-accent">
              <span className="h-2 w-2 rounded-full bg-accent" />
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
        {/* Upholstered chairs sit behind the table and move with each live seat. */}
        {seatedParticipants.map((person, index) => {
          const position = seatPosition(index, seatCount, 1.14);
          const angle = Math.atan2((position.top - 50) / 36, (position.left - 50) / 40);
          return (
            <ConferenceChair
              key={`chair-${person.id}`}
              position={position}
              width={chairWidth}
              height={chairWidth * 1.2}
              rotation={angle * (180 / Math.PI) + 90}
            />
          );
        })}
        {host && (
          <ConferenceChair
            position={headPosition(1.13)}
            width={chairWidth}
            height={chairWidth * 1.2}
            rotation={0}
          />
        )}

        {/* Tapered walnut legs are hidden by the top where they meet the apron. */}
        <div
          aria-hidden
          className="absolute left-[31%] top-[61%] z-[3] h-[38%] w-[6%] border-x border-[#4c3223] shadow-[inset_5px_0_6px_rgba(255,255,255,0.12),4px_8px_10px_rgba(36,24,16,0.22)]"
          style={{
            clipPath: "polygon(20% 0, 80% 0, 100% 100%, 0 100%)",
            background: "linear-gradient(90deg, #5f3d29 0%, #9a6b45 48%, #68432d 100%)",
          }}
        />
        <div
          aria-hidden
          className="absolute left-[63%] top-[61%] z-[3] h-[38%] w-[6%] border-x border-[#4c3223] shadow-[inset 5px 0_6px_rgba(255,255,255,0.12),-4px_8px_10px_rgba(36,24,16,0.22)]"
          style={{
            clipPath: "polygon(20% 0, 80% 0, 100% 100%, 0 100%)",
            background: "linear-gradient(90deg, #68432d 0%, #9a6b45 52%, #5f3d29 100%)",
          }}
        />
        <div
          aria-hidden
          className="absolute left-[21%] top-[49%] z-[2] h-[25%] w-[4.5%] border-x border-[#4c3223]"
          style={{
            clipPath: "polygon(25% 0, 75% 0, 100% 100%, 0 100%)",
            background: "linear-gradient(90deg, #583925 0%, #8a5e3d 50%, #68432d 100%)",
          }}
        />
        <div
          aria-hidden
          className="absolute left-[74.5%] top-[49%] z-[2] h-[25%] w-[4.5%] border-x border-[#4c3223]"
          style={{
            clipPath: "polygon(25% 0, 75% 0, 100% 100%, 0 100%)",
            background: "linear-gradient(90deg, #68432d 0%, #8a5e3d 50%, #583925 100%)",
          }}
        />

        {/* Raised table edge gives the wood surface a restrained 3D profile. */}
        <div
          className="absolute left-1/2 top-[52%] z-[4] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-[#62402d] shadow-[0_18px_22px_rgba(35,25,18,0.24)]"
          style={{
            width: "64%",
            height: "62%",
            background: "linear-gradient(180deg, #6f4933 0%, #593a2a 100%)",
          }}
        />
        {/* Oval walnut tabletop */}
        <div
          className={`absolute left-1/2 top-1/2 z-[6] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-[5px] transition-colors duration-300 ${
            aiSpeaking
              ? "border-[#9a6b48]"
              : paused
                ? "border-[#a88455]"
                : "border-[#855b3d]"
          }`}
          style={{
            width: "63%",
            height: "62%",
            background: "linear-gradient(165deg, #b6855e 0%, #9a6c49 46%, #815638 100%)",
            boxShadow: "inset 0 2px 3px rgba(255,255,255,0.16), inset 0 -7px 12px rgba(56,34,20,0.24)",
          }}
        >
          {/* Subtle inset rim on the tabletop */}
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-[#d1a37c]/35"
            style={{ width: "80%", height: "78%" }}
          />

          {/* Centerpiece: AI Moderator Presence Hub */}
          {aiEnabled && (
            <div className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center">
              <div className="relative flex items-center justify-center">
                <div
                  className={`relative grid h-14 w-14 place-items-center rounded-full border-2 transition-colors duration-300 ${
                    paused
                      ? "border-warn/70 bg-panel text-warn"
                      : aiSpeaking
                        ? "border-accent bg-panel text-accent"
                        : aiThinking
                          ? "border-accent/70 bg-panel text-accent"
                          : "border-[#785238] bg-panel text-accent"
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

        {/* Name plates sit on the outward-facing chair backs, clear of the video tiles. */}
        {seatedParticipants.map((occupant, index) => {
          const position = seatPosition(index, seatCount, 1.27);
          const name =
            occupant.userId === selfUserId ? `${occupant.name} (you)` : occupant.name;
          return (
            <div
              key={`plate-${occupant.id}`}
              className="absolute z-10 -translate-x-1/2 -translate-y-1/2 transition-all duration-500"
              style={{ left: `${position.left}%`, top: `${position.top}%`, width: `${chairWidth}%` }}
            >
              <div
                title={name}
                className={`truncate rounded-md border border-[#68472f] px-2 py-1 text-center text-[10px] font-semibold leading-tight text-[#34251c] shadow-md sm:text-[11px] ${
                  activeSpeakerId === occupant.id
                    ? "bg-[#f7dca8]"
                    : invitedParticipantId === occupant.id
                      ? "bg-[#f4e3bf]"
                      : "bg-[#f4eee5]"
                }`}
              >
                {name}
              </div>
            </div>
          );
        })}

        {/* Host name plate on the back of the moderator's chair */}
        <div
          className="absolute z-10 -translate-x-1/2 -translate-y-1/2 transition-all duration-500"
          style={{
            left: `${headPosition(1.27).left}%`,
            top: `${headPosition(1.27).top}%`,
            width: `${chairWidth}%`,
          }}
        >
          <div
            title={host?.name ?? "Host"}
            className="truncate rounded-md border border-[#68472f] bg-[#f4eee5] px-2 py-1 text-center text-[10px] font-semibold leading-tight text-[#34251c] shadow-md sm:text-[11px]"
          >
            {host?.userId === selfUserId ? `${host.name} (you)` : host?.name ?? "Host"}
          </div>
        </div>

        {/* Participant video seats around the table */}
        {seatedParticipants.map((occupant, index) => {
          const seatNumber = occupant.seatNumber ?? index + 1;
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
              position={seatPosition(index, seatCount, 0.84)}
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
            position={headPosition(0.82)}
            width={tileWidth}
            media={mediaByUser.get(host.userId) ?? null}
          />
        )}
      </div>

      {/* Responsive mobile round-table arrangement (< 640px) */}
      <div className="mt-4 space-y-3 sm:hidden">
        {aiEnabled && (
          <div
            className={`flex items-center justify-between rounded-lg border p-3 ${
              aiSpeaking
                ? "border-accent bg-accent/10"
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
            .filter((p) => !p.removed && !p.leftAt && p.joinedAt)
            .map((person) => {
              const media = mediaByUser.get(person.userId) ?? null;
              const speakingNow = Boolean(media?.speaking) || activeSpeakerId === person.id;
              const locked = Boolean(person.micLocked) || aiSpeaking || paused;
              return (
                <div
                  key={`mobile-seat-${person.id}`}
                  className={`relative aspect-[4/3] overflow-hidden rounded-lg border bg-panel-2 ${
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
        Seats are arranged for participants currently in the room. When someone leaves, the remaining seats close the gap.
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

function ConferenceChair({
  position,
  width,
  height,
  rotation,
}: {
  position: { left: number; top: number };
  width: number;
  height: number;
  rotation: number;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-[1] transition-all duration-500 ease-out"
      style={{
        left: `${position.left}%`,
        top: `${position.top}%`,
        width: `${width}%`,
        height: `${height}%`,
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
      }}
    >
      <svg viewBox="0 0 100 100" className="h-full w-full" preserveAspectRatio="none">
        <ellipse cx="50" cy="93" rx="33" ry="5" fill="#24180f" opacity=".22" />
        <path
          d="M25 14Q50 4 75 14L78 45Q50 53 22 45Z"
          fill="#765239"
          stroke="#493021"
          strokeWidth="5"
          strokeLinejoin="round"
        />
        <path
          d="M30 16Q50 9 70 16L72 40Q50 46 28 40Z"
          fill="#987252"
          stroke="#b18b67"
          strokeWidth="1.5"
        />
        <path
          d="M20 45Q50 37 80 45L88 58Q50 70 12 58Z"
          fill="#60422f"
          stroke="#493021"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path d="M22 46Q50 40 78 46L82 54Q50 62 18 54Z" fill="#96704e" />
        <path d="M20 38L11 46L14 60L23 61" fill="none" stroke="#4a3021" strokeWidth="7" strokeLinecap="round" />
        <path d="M80 38L89 46L86 60L77 61" fill="none" stroke="#4a3021" strokeWidth="7" strokeLinecap="round" />
        <path d="M20 58L17 78L12 94M80 58L83 78L88 94" fill="none" stroke="#4a3021" strokeWidth="6" strokeLinecap="round" />
        <path d="M29 63L31 79L27 92M71 63L69 79L73 92" fill="none" stroke="#64452e" strokeWidth="4" strokeLinecap="round" />
      </svg>
    </div>
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
        className={`relative aspect-[4/3] overflow-hidden rounded-lg border-2 bg-panel-2 shadow-md transition-all duration-300 ${
          speakingNow
            ? "scale-[1.02] border-accent ring-2 ring-accent/20"
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
          <div className="flex h-full w-full flex-col items-center justify-center bg-panel-2">
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
      </div>

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

  );
}
