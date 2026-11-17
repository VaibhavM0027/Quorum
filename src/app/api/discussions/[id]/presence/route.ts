import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { enforceParticipantMicPermission } from "@/lib/livekit";
import {
  expireStaleAiSpeakingLock,
  isAiSpeakingLocked,
  isMeetingPaused,
  syncRoomStateSnapshot,
} from "@/lib/room-sync";
import { presenceSchema } from "@/lib/validation";
import { transcriptLog } from "@/lib/debug-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Records live audio activity and turn state for a discussion.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    await expireStaleAiSpeakingLock(id);

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        pausedAt: true,
        conversationState: true,
        aiSpeakingUntil: true,
        lastAiSpokeAt: true,
        breakoutEnabled: true,
      },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (discussion.status !== "LIVE") {
      return fail("Audio activity is only tracked while the discussion is live.", 409);
    }

    const member = await prisma.discussionParticipant.findUnique({
      where: { discussionId_userId: { discussionId: id, userId: user.id } },
      select: {
        id: true,
        displayName: true,
        isHost: true,
        removed: true,
        micLocked: true,
        breakoutRoom: true,
      },
    });
    if (!member) return fail("Join the discussion before reporting audio activity.", 403);
    if (member.removed) return fail("You were removed from this discussion.", 403);

    const limit = checkRateLimit(`presence:${id}:${user.id}`, 120, 60_000);
    if (!limit.allowed) return ok({ skipped: "rate-limited" });

    const body = presenceSchema.parse(await readJson(request));
    const now = new Date();
    const paused = isMeetingPaused(discussion);
    const aiLocked = isAiSpeakingLocked(discussion, now.getTime());

    let blocked = false;
    if (body.speaking === true && (paused || aiLocked || member.micLocked)) {
      blocked = true;
      await prisma.discussionParticipant.update({
        where: { id: member.id },
        data: { speakingSince: null },
      });
      await enforceParticipantMicPermission({
        discussionId: id,
        breakoutRoom: discussion.breakoutEnabled && !member.isHost ? member.breakoutRoom : null,
        identity: user.id,
        canPublish: false,
      });
    } else if (body.speaking !== undefined || body.transcribing !== undefined) {
      await prisma.discussionParticipant.update({
        where: { id: member.id },
        data: {
          ...(body.speaking !== undefined
            ? {
                lastAudioAt: now,
                speakingSince: body.speaking ? now : null,
              }
            : {}),
          ...(body.transcribing !== undefined
            ? { transcribing: body.transcribing, transcribingAt: now }
            : {}),
        },
      });
    }

    if (body.transcribing !== undefined) {
      transcriptLog(
        body.transcribing ? "participant started transcribing" : "participant stopped transcribing",
        { participantId: member.id, speaker: member.displayName },
      );
    }

    if (body.aiSpeaking === true && !paused) {
      await prisma.discussion.update({
        where: { id },
        data: { lastAiSpokeAt: now },
      });
    }

    if (body.speaking !== undefined) {
      await syncRoomStateSnapshot(id, { broadcast: true, syncMics: false });
    }

    return ok({ ok: true, blocked });
  } catch (error) {
    return handleRouteError(error);
  }
}
