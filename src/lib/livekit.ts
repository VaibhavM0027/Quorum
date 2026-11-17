import { AccessToken, DataPacket_Kind, RoomServiceClient, TrackType } from "livekit-server-sdk";
import { env } from "./env";

/**
 * Server-side LiveKit helpers and authoritative participant permission control.
 *
 * LiveKit is an SFU (Selective Forwarding Unit): browsers publish their audio and
 * video to it and subscribe to everyone else's. Because permissions are enforced
 * at the SFU (`canPublish`, `mutePublishedTrack`), a participant whose mic is
 * locked — either by the host or while the AI moderator is speaking — cannot
 * publish audio even by bypassing frontend controls via browser console or
 * another tab.
 */

export const ROOM_STATE_TOPIC = "quorum.room.state";

export type RoomStateBroadcast = {
  type: "room-state";
  discussionId: string;
  status: string;
  conversationState: string;
  aiSpeaking: boolean;
  aiSpeakingUntil: string | null;
  paused: boolean;
  activeSpeakerId: string | null;
  turnQueue: string[];
  lockedIdentities: string[];
  serverSttActive: boolean;
  updatedAt: string;
};

/**
 * The LiveKit room a participant belongs in.
 *
 * One room per discussion; once the host splits the room, each breakout group
 * gets a room of its own so a group hears only itself.
 */
export function roomNameFor(discussionId: string, breakoutRoom?: number | null): string {
  return breakoutRoom && breakoutRoom > 0
    ? `discussion-${discussionId}-room-${breakoutRoom}`
    : `discussion-${discussionId}`;
}

/**
 * URL the *browser* must use. Derived from LIVEKIT_HOST (http -> ws, https -> wss)
 * unless LIVEKIT_URL is set explicitly (required for LiveKit Cloud).
 */
export function browserLivekitUrl(): string {
  if (env.livekitUrl) return env.livekitUrl;
  return env.livekitHost.replace(/^http/, "ws");
}

/** URL the Node.js server uses to connect to LiveKit over WebSocket (for STT worker). */
export function serverLivekitWsUrl(): string {
  if (env.livekitUrl) return env.livekitUrl;
  return env.livekitHost.replace(/^http/, "ws");
}

export type TokenOptions = {
  discussionId: string;
  identity: string;
  name: string;
  isHost: boolean;
  ttlSeconds?: number;
  /** Hosts and the AI state machine can revoke publishing at the SFU. */
  canPublish?: boolean;
  /** Breakout room to join. Omitted or null means the main room. */
  breakoutRoom?: number | null;
  /** Hidden server-side worker (e.g., independent STT subscriber). */
  hidden?: boolean;
};

/** Issues a short-lived join token scoped to a single discussion room. */
export async function createRoomToken(options: TokenOptions): Promise<string> {
  const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
    identity: options.identity,
    name: options.name,
    ttl: options.ttlSeconds ?? 60 * 60 * 4,
    metadata: JSON.stringify({
      isHost: options.isHost,
      breakoutRoom: options.breakoutRoom ?? null,
      hidden: Boolean(options.hidden),
    }),
  });

  token.addGrant({
    room: roomNameFor(options.discussionId, options.breakoutRoom),
    roomJoin: true,
    canPublish: options.hidden ? false : (options.canPublish ?? true),
    canSubscribe: true,
    canPublishData: !options.hidden,
    hidden: Boolean(options.hidden),
    // Hosts may also mute/remove others and close the room.
    roomAdmin: options.isHost,
  });

  return token.toJwt();
}

/** True when the LiveKit credentials required to issue tokens are present. */
export function livekitReady(): boolean {
  return env.livekitConfigured;
}

export function getRoomService(): RoomServiceClient | null {
  if (!livekitReady()) return null;
  return new RoomServiceClient(env.livekitHost, env.livekitApiKey, env.livekitApiSecret);
}

/** Lists active LiveKit room names belonging to this discussion (main + any active breakouts). */
export async function listActiveDiscussionRooms(
  discussionId: string,
  breakoutRooms: Array<number | null | undefined> = [],
): Promise<string[]> {
  const client = getRoomService();
  if (!client) return [];
  const expected = new Set<string>([roomNameFor(discussionId)]);
  for (const br of breakoutRooms) {
    if (typeof br === "number" && br > 0) {
      expected.add(roomNameFor(discussionId, br));
    }
  }
  try {
    const active = await client.listRooms([...expected]);
    return active.map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * Authoritatively enforces a single participant's microphone permission at the
 * LiveKit SFU level: sets `canPublish` and immediately mutes active audio
 * tracks when locking, or removes them from the room when `remove` is true.
 */
export async function enforceParticipantMicPermission(params: {
  discussionId: string;
  breakoutRoom?: number | null;
  identity: string;
  canPublish: boolean;
  remove?: boolean;
}): Promise<void> {
  const client = getRoomService();
  if (!client) return;

  const targetRooms = [roomNameFor(params.discussionId)];
  if (params.breakoutRoom && params.breakoutRoom > 0) {
    targetRooms.push(roomNameFor(params.discussionId, params.breakoutRoom));
  }

  await Promise.allSettled(
    targetRooms.map(async (room) => {
      if (params.remove) {
        try {
          await client.removeParticipant(room, params.identity);
        } catch {
          /* participant may already be disconnected */
        }
        return;
      }

      try {
        await client.updateParticipant(room, params.identity, undefined, {
          canPublish: params.canPublish,
          canSubscribe: true,
          canPublishData: true,
        });
      } catch {
        /* participant may not be connected to this LiveKit room */
        return;
      }

      if (!params.canPublish) {
        try {
          const info = await client.getParticipant(room, params.identity);
          for (const track of info.tracks ?? []) {
            if (track.type === TrackType.AUDIO && !track.muted && track.sid) {
              await client.mutePublishedTrack(room, params.identity, track.sid, true);
            }
          }
        } catch {
          /* ignore if participant disconnected mid-call */
        }
      }
    }),
  );
}

export type SyncParticipantPermissionInput = {
  userId: string;
  isHost: boolean;
  micLocked: boolean;
  removed: boolean;
  breakoutRoom: number | null;
};

/**
 * Synchronizes SFU microphone publish permissions for every participant in the
 * discussion. When `aiSpeaking` or `meetingPaused` is true, ALL participants'
 * microphones are authoritatively muted and `canPublish` is revoked on LiveKit.
 */
export async function syncAllRoomMicPermissions(params: {
  discussionId: string;
  aiSpeaking: boolean;
  meetingPaused?: boolean;
  breakoutEnabled: boolean;
  participants: SyncParticipantPermissionInput[];
}): Promise<string[]> {
  const lockedIdentities: string[] = [];
  for (const p of params.participants) {
    const allowed = !p.removed && !params.aiSpeaking && !params.meetingPaused && !p.micLocked;
    if (!allowed) lockedIdentities.push(p.userId);
  }

  const client = getRoomService();
  if (!client) return lockedIdentities;

  const activeRooms = await listActiveDiscussionRooms(
    params.discussionId,
    params.breakoutEnabled ? params.participants.map((p) => p.breakoutRoom) : [],
  );
  if (activeRooms.length === 0) return lockedIdentities;

  await Promise.allSettled(
    activeRooms.flatMap((room) =>
      params.participants.map(async (p) => {
        if (p.removed) return;
        const canPublish = !params.aiSpeaking && !params.meetingPaused && !p.micLocked;
        try {
          await client.updateParticipant(room, p.userId, undefined, {
            canPublish,
            canSubscribe: true,
            canPublishData: true,
          });
          if (!canPublish) {
            const info = await client.getParticipant(room, p.userId);
            for (const track of info.tracks ?? []) {
              if (track.type === TrackType.AUDIO && !track.muted && track.sid) {
                await client.mutePublishedTrack(room, p.userId, track.sid, true);
              }
            }
          }
        } catch {
          /* participant might be in a different breakout room or offline */
        }
      }),
    ),
  );

  return lockedIdentities;
}

/** Broadcasts the authoritative room state packet to every connected LiveKit client. */
export async function broadcastRoomState(
  discussionId: string,
  breakoutRooms: Array<number | null | undefined>,
  payload: RoomStateBroadcast,
): Promise<void> {
  const client = getRoomService();
  if (!client) return;

  const activeRooms = await listActiveDiscussionRooms(discussionId, breakoutRooms);
  if (activeRooms.length === 0) return;

  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  await Promise.allSettled(
    activeRooms.map((room) =>
      client.sendData(room, bytes, DataPacket_Kind.RELIABLE, { topic: ROOM_STATE_TOPIC }),
    ),
  );
}
