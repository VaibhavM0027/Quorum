import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { enforceParticipantMicPermission } from "@/lib/livekit";
import {
  expireStaleAiSpeakingLock,
  isAiSpeakingLocked,
  isMeetingPaused,
  syncRoomStateSnapshot,
} from "@/lib/room-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const micToggleSchema = z.object({
  enabled: z.boolean(),
});

/**
 * Authoritative server-side microphone gate.
 *
 * Every client unmute request must pass this check. If the AI moderator is
 * speaking, the meeting is paused, or the host has locked this participant's
 * mic, the request is rejected (403) and `canPublish: false` + `mutePublishedTrack`
 * are immediately re-enforced at the LiveKit SFU so client-side console or
 * multi-tab bypasses cannot publish audio.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const { enabled } = micToggleSchema.parse(await readJson(request));

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

    const member = await prisma.discussionParticipant.findUnique({
      where: { discussionId_userId: { discussionId: id, userId: user.id } },
      select: {
        id: true,
        isHost: true,
        removed: true,
        leftAt: true,
        micLocked: true,
        breakoutRoom: true,
      },
    });
    if (!member) return fail("Join the discussion before using the microphone.", 403);

    const effectiveBreakout = discussion.breakoutEnabled && !member.isHost ? member.breakoutRoom : null;

    if (enabled) {
      const paused = isMeetingPaused(discussion);
      const aiLocked = isAiSpeakingLocked(discussion);
      let blockReason: string | null = null;

      if (member.removed || member.leftAt) {
        blockReason = "You are no longer active in this discussion.";
      } else if (discussion.status !== "LIVE") {
        blockReason = "Microphone can only be enabled while the discussion is live.";
      } else if (paused) {
        blockReason = "The meeting is currently paused by the host.";
      } else if (aiLocked) {
        blockReason = "Microphones are locked while the AI moderator is speaking.";
      } else if (member.micLocked) {
        blockReason = "Your microphone was locked by the host.";
      }

      if (blockReason) {
        await enforceParticipantMicPermission({
          discussionId: id,
          breakoutRoom: effectiveBreakout,
          identity: user.id,
          canPublish: false,
        });
        return fail(blockReason, 403);
      }

      await enforceParticipantMicPermission({
        discussionId: id,
        breakoutRoom: effectiveBreakout,
        identity: user.id,
        canPublish: true,
      });

      return ok({ allowed: true, enabled: true, canPublish: true });
    }

    // Participant muted themselves: clear any active speaking floor claim.
    await prisma.discussionParticipant.update({
      where: { id: member.id },
      data: { speakingSince: null },
    });
    await syncRoomStateSnapshot(id, { broadcast: true, syncMics: false });

    return ok({ allowed: true, enabled: false, canPublish: !member.micLocked });
  } catch (error) {
    return handleRouteError(error);
  }
}
