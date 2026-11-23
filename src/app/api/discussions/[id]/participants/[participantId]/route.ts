import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { assignBreakoutRooms, assignSeat, releaseSeat } from "@/lib/discussions";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { enforceParticipantMicPermission } from "@/lib/livekit";
import { isAiSpeakingLocked, isMeetingPaused, syncRoomStateSnapshot } from "@/lib/room-sync";
import { participantControlSchema } from "@/lib/validation";
import { finishParticipantTurn, syncRoomPermissions } from "@/lib/turns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; participantId: string }> };

/**
 * Host controls over a single participant in a room.
 * Enforces `canPublish` and mutes active tracks authoritatively on LiveKit SFU.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id, participantId } = await params;
    const { action } = participantControlSchema.parse(await readJson(request));

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: {
        id: true,
        hostId: true,
        maxParticipants: true,
        status: true,
        pausedAt: true,
        conversationState: true,
        aiSpeakingUntil: true,
        lastAiSpokeAt: true,
        breakoutEnabled: true,
      },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (discussion.hostId !== user.id) {
      return fail("Only the host can control participants in this discussion.", 403);
    }

    const member = await prisma.discussionParticipant.findUnique({
      where: { id: participantId },
      select: { id: true, discussionId: true, userId: true, isHost: true, breakoutRoom: true },
    });
    if (!member || member.discussionId !== id) {
      return fail("That participant is not in this discussion.", 404);
    }
    if (member.isHost) {
      return fail("The host cannot be removed or muted.", 409);
    }

    const data =
      action === "lock-mic"
        ? { micLocked: true, speakingSince: null }
        : action === "unlock-mic"
          ? { micLocked: false }
          : action === "remove"
            ? { removed: true, micLocked: true, speakingSince: null, leftAt: new Date() }
            : { removed: false, micLocked: false, leftAt: null };

    const updated = await prisma.discussionParticipant.update({
      where: { id: participantId },
      data,
      select: { id: true, removed: true, micLocked: true },
    });

    if (action === "remove") {
      await releaseSeat(id, participantId);
    } else if (action === "restore") {
      await assignSeat(id, participantId, discussion.maxParticipants);
    }
    if (action === "remove" || action === "restore") {
      await assignBreakoutRooms(id);
    }

<<<<<<< HEAD
    const roomBlocked =
      discussion.status !== "LIVE" || isAiSpeakingLocked(discussion) || isMeetingPaused(discussion);
    await enforceParticipantMicPermission({
      discussionId: id,
      breakoutRoom: discussion.breakoutEnabled ? member.breakoutRoom : null,
      identity: member.userId,
      canPublish: !updated.removed && !updated.micLocked && !roomBlocked,
      remove: action === "remove",
    });

    await syncRoomStateSnapshot(id, { broadcast: true, syncMics: false });
=======
    if (action === "lock-mic" || action === "remove") {
      const now = new Date();
      await prisma.$transaction([
        prisma.turnRequest.updateMany({
          where: {
            discussionId: id,
            participantId,
            status: { in: ["REQUESTED", "GRANTED"] },
          },
          data: { status: "CANCELLED", finishedAt: now },
        }),
        prisma.invitation.updateMany({
          where: { discussionId: id, participantId, status: "PENDING" },
          data: { status: "TECHNICAL", respondedAt: now },
        }),
      ]);
    }

    const currentDiscussion = await prisma.discussion.findUnique({
      where: { id },
      select: { turnState: true, activeTurnParticipantId: true },
    });
    if (
      (action === "lock-mic" || action === "remove") &&
      currentDiscussion?.turnState === "PARTICIPANT_SPEAKING" &&
      currentDiscussion.activeTurnParticipantId === participantId
    ) {
      await finishParticipantTurn({
        discussionId: id,
        participantId,
        actorIsHost: true,
        action: "finish",
      });
    } else {
      await syncRoomPermissions(id);
    }
>>>>>>> a42fb56 (Mic fixes with ui changes)

    return ok({ participant: updated });
  } catch (error) {
    return handleRouteError(error);
  }
}
