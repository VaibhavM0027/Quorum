import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { participantControlSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; participantId: string }> };

/**
 * Host controls over a single participant in a room.
 *
 * Mic locking is enforced cooperatively: the flag is stored here and the
 * participant's own client mutes and disables its microphone when it sees it.
 * Removing a participant revokes their room access — every authenticated
 * endpoint checks the `removed` flag — but does not delete their transcript,
 * because that would rewrite the record of the discussion.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id, participantId } = await params;
    const { action } = participantControlSchema.parse(await readJson(request));

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: { id: true, hostId: true },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (discussion.hostId !== user.id) {
      return fail("Only the host can control participants in this discussion.", 403);
    }

    const member = await prisma.discussionParticipant.findUnique({
      where: { id: participantId },
      select: { id: true, discussionId: true, isHost: true },
    });
    if (!member || member.discussionId !== id) {
      return fail("That participant is not in this discussion.", 404);
    }
    if (member.isHost) {
      return fail("The host cannot be removed or muted.", 409);
    }

    const data =
      action === "lock-mic"
        ? { micLocked: true }
        : action === "unlock-mic"
          ? { micLocked: false }
          : action === "remove"
            ? { removed: true, micLocked: true, leftAt: new Date() }
            : { removed: false, micLocked: false, leftAt: null };

    const updated = await prisma.discussionParticipant.update({
      where: { id: participantId },
      data,
      select: { id: true, removed: true, micLocked: true },
    });

    return ok({ participant: updated });
  } catch (error) {
    return handleRouteError(error);
  }
}
