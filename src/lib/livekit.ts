import { AccessToken } from "livekit-server-sdk";
import { env } from "./env";

/**
 * Server-side LiveKit helpers.
 *
 * LiveKit is an SFU (Selective Forwarding Unit): browsers publish their audio and
 * video to it and subscribe to everyone else's. It is the only component that
 * handles media, which keeps this app's Node process light.
 */

/** One LiveKit room per discussion. */
export function roomNameFor(discussionId: string): string {
  return `discussion-${discussionId}`;
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
};

/** Issues a short-lived join token scoped to a single discussion room. */
export async function createRoomToken(options: TokenOptions): Promise<string> {
  const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
    identity: options.identity,
    name: options.name,
    ttl: options.ttlSeconds ?? 60 * 60 * 4,
    metadata: JSON.stringify({ isHost: options.isHost }),
  });

  token.addGrant({
    room: roomNameFor(options.discussionId),
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
