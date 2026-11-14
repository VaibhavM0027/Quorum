import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { inviteUrl, loadDiscussionForUser } from "@/lib/discussions";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { updateDiscussionSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Full detail for a discussion the user hosts or has joined. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const access = await loadDiscussionForUser(id, user.id);
    if (!access) return fail("Discussion not found, or you do not have access to it.", 404);

    const { discussion, isHost } = access;

    return ok({
      discussion: {
        id: discussion.id,
        title: discussion.title,
        topic: discussion.topic,
        context: discussion.context,
        rules: discussion.rules,
        status: discussion.status,
        mode: discussion.mode,
        joinCode: discussion.joinCode,
        inviteUrl: inviteUrl(discussion.joinCode),
        scheduledAt: discussion.scheduledAt,
        durationMin: discussion.durationMin,
        maxParticipants: discussion.maxParticipants,
        aiEnabled: discussion.aiEnabled,
        transcriptionEnabled: discussion.transcriptionEnabled,
        silencePromptSec: discussion.silencePromptSec,
        inviteResponseSec: discussion.inviteResponseSec,
        // What the conversation-management engine currently believes the room
        // is doing. Every browser reads the same value, so they agree.
        conversationState: discussion.conversationState,
        conversationStateAt: discussion.conversationStateAt,
        breakoutEnabled: discussion.breakoutEnabled,
        breakoutGroupSize: discussion.breakoutGroupSize,
        startedAt: discussion.startedAt,
        endedAt: discussion.endedAt,
        host: discussion.host,
        isHost,
        participants: discussion.participants.map((p) => ({
          id: p.id,
          userId: p.userId,
          name: p.displayName,
          isHost: p.isHost,
          joinedAt: p.joinedAt,
          leftAt: p.leftAt,
          removed: p.removed,
          micLocked: p.micLocked,
          transcriptionConsent: p.transcriptionConsent,
          seatNumber: p.seatNumber,
          breakoutRoom: p.breakoutRoom,
        })),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Host controls: start, end, cancel or reopen a discussion. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const { action } = updateDiscussionSchema.parse(await readJson(request));

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: { id: true, hostId: true, status: true, startedAt: true },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (discussion.hostId !== user.id) {
      return fail("Only the host can control this discussion.", 403);
    }

    const now = new Date();
    const data =
      action === "start"
        ? { status: "LIVE" as const, startedAt: discussion.startedAt ?? now }
        : action === "end"
          ? { status: "COMPLETED" as const, endedAt: now }
          : action === "cancel"
            ? { status: "CANCELLED" as const, endedAt: now }
            : { status: "LIVE" as const, endedAt: null };

    const updated = await prisma.discussion.update({ where: { id }, data });

    // When the room goes live, mark every member that is still present.
    if (action === "start") {
      await prisma.discussionParticipant.updateMany({
        where: { discussionId: id, removed: false, joinedAt: null },
        data: { joinedAt: now },
      });
    }
    if (action === "end" || action === "cancel") {
      await prisma.discussionParticipant.updateMany({
        where: { discussionId: id, leftAt: null },
        data: { leftAt: now },
      });
    }

    return ok({ status: updated.status, startedAt: updated.startedAt, endedAt: updated.endedAt });
  } catch (error) {
    return handleRouteError(error);
  }
}
