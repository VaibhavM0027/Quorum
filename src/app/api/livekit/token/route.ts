import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import { browserLivekitUrl, createRoomToken, livekitReady, roomNameFor } from "@/lib/livekit";
import { ensureRoomSttWorker } from "@/lib/livekit-stt-worker";
import {
  expireStaleAiSpeakingLock,
  isAiSpeakingLocked,
  isMeetingPaused,
  isRoomSttActive,
} from "@/lib/room-sync";
import { fail, handleRouteError, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues a LiveKit join token for the signed-in participant of a discussion.
 * The token is scoped to that single room and expires after 4 hours.
 */
export async function GET(request: Request) {
  try {
    const user = await requireSession();

    if (!livekitReady()) {
      return fail(
        "Real-time media is not configured. Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET.",
        503,
      );
    }

    const discussionId = new URL(request.url).searchParams.get("discussionId");
    if (!discussionId) return fail("discussionId is required.", 400);

    await expireStaleAiSpeakingLock(discussionId);

    const access = await loadDiscussionForUser(discussionId, user.id);
    if (!access) return fail("You do not have access to this discussion.", 403);

    const { discussion, isHost } = access;
    if (discussion.status === "CANCELLED") {
      return fail("This discussion was cancelled.", 409);
    }

    const me = discussion.participants.find((p) => p.userId === user.id);
    if (!me) return fail("Join the discussion before connecting to the room.", 403);
    if (me.removed) return fail("You were removed from this discussion.", 403);

    const breakoutRoom = isHost || !discussion.breakoutEnabled ? null : (me.breakoutRoom ?? null);

    const requested = new URL(request.url).searchParams.get("room");
    if (requested) {
      const wanted = Number(requested);
      if (!Number.isInteger(wanted) || wanted !== breakoutRoom) {
        return fail("You are not in that breakout room.", 403);
      }
    }

    const paused = isMeetingPaused(discussion);
    const aiLocked = isAiSpeakingLocked(discussion);
    const canPublish =
      discussion.status === "LIVE" && !paused && !aiLocked && !me.micLocked;

    if (discussion.status === "LIVE" && discussion.transcriptionEnabled) {
      void ensureRoomSttWorker(discussion.id, breakoutRoom);
    }

    const token = await createRoomToken({
      discussionId: discussion.id,
      identity: user.id,
      name: me.displayName,
      isHost,
      canPublish,
      breakoutRoom,
    });

    return ok({
      token,
      url: browserLivekitUrl(),
      roomName: roomNameFor(discussion.id, breakoutRoom),
      identity: user.id,
      canPublish,
      aiSpeaking: aiLocked,
      paused,
      breakoutRoom,
      serverSttActive: isRoomSttActive(discussion.id),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
