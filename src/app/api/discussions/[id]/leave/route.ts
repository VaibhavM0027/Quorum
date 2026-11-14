import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { releaseSeat, assignBreakoutRooms } from "@/lib/discussions";
import { fail, handleRouteError, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Marks the signed-in member as having left the room for good.
 *
 * Only a deliberate departure calls this. A dropped connection, a refreshed tab
 * or a closed laptop never does — which is exactly what allows that student to
 * come back to the same numbered seat. Leaving frees the seat for the next
 * arrival; speech already transcribed stays part of the discussion record.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const member = await prisma.discussionParticipant.findUnique({
      where: { discussionId_userId: { discussionId: id, userId: user.id } },
      select: { id: true, isHost: true },
    });
    if (!member) return fail("You are not a member of this discussion.", 403);

    await prisma.discussionParticipant.update({
      where: { id: member.id },
      data: { leftAt: new Date() },
    });
    // The moderator's place is not a numbered seat, so there is nothing to free.
    if (!member.isHost) await releaseSeat(id, member.id);
    // Someone who has gone frees their place in a breakout room too, which can
    // mean one fewer group is needed.
    await assignBreakoutRooms(id);

    return ok({ left: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
