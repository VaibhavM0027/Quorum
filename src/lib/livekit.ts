import { AccessToken } from "livekit-server-sdk";
import { env } from "./env";

/**
 * Server-side LiveKit helpers.
 *
 * LiveKit is an SFU (Selective Forwarding Unit): browsers publish their audio and
 * video to it and subscribe to everyone else's. It is the only component that
 * handles media, which keeps this app's Node process light.
 */

/**
 * The LiveKit room a participant belongs in.
 *
 * One room per discussion; once the host splits the room, each breakout group
 * gets a room of its own so a group hears only itself. The main room is still
 * where the moderator stays, which is also what keeps the session recording
 * working — the moderator's browser goes on subscribing to the main room.
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

export type TokenOptions = {
  discussionId: string;
  identity: string;
  name: string;
  isHost: boolean;
  ttlSeconds?: number;
  /** Hosts can revoke publishing; a mic-locked participant must not be able to speak. */
  canPublish?: boolean;
  /** Breakout room to join. Omitted or null means the main room. */
  breakoutRoom?: number | null;
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
    }),
  });

  token.addGrant({
    room: roomNameFor(options.discussionId, options.breakoutRoom),
    roomJoin: true,
    canPublish: options.canPublish ?? true,
    canSubscribe: true,
    canPublishData: true,
    // Hosts may also mute/remove others and close the room.
    roomAdmin: options.isHost,
  });

  return token.toJwt();
}

/** True when the LiveKit credentials required to issue tokens are present. */
export function livekitReady(): boolean {
  return env.livekitConfigured;
}
