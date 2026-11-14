import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import {
  assignBreakoutRooms,
  moveParticipantToRoom,
  reshuffleBreakoutRooms,
} from "@/lib/discussions";
import { breakoutAllocation, breakoutRoomCount } from "@/lib/breakout";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { breakoutControlSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Reads the allocation straight from the database.
 *
 * `breakoutAllocation` is the same function the room UI calls, so the numbers
 * the host sees in the panel and the rooms people are actually in cannot
 * disagree.
 */
async function loadAllocation(discussionId: string) {
  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      breakoutEnabled: true,
      breakoutGroupSize: true,
      participants: {
        orderBy: [{ seatNumber: "asc" }],
        select: {
          id: true,
          displayName: true,
          seatNumber: true,
          breakoutRoom: true,
          isHost: true,
          removed: true,
          leftAt: true,
        },
      },
    },
  });
  if (!discussion) return null;

  return breakoutAllocation(
    discussion.participants.map((p) => ({
      id: p.id,
      name: p.displayName,
      seatNumber: p.seatNumber,
      breakoutRoom: p.breakoutRoom,
      isHost: p.isHost,
      removed: p.removed,
      left: p.leftAt !== null,
    })),
    discussion.breakoutEnabled,
    discussion.breakoutGroupSize,
  );
}

/**
 * Host control over the breakout rooms: switch them on or off, change the group
 * size, shuffle the groups, or move one student to another room.
 *
 * Only the host may call this. Students are told which room they are in through
 * the ordinary discussion payload, and the LiveKit token route refuses to
 * connect them anywhere else, so a student cannot place themselves in a room.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const body = breakoutControlSchema.parse(await readJson(request));

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: { id: true, hostId: true, breakoutEnabled: true, breakoutGroupSize: true },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (discussion.hostId !== user.id) {
      return fail("Only the host can manage breakout rooms.", 403);
    }

    if (body.action === "enable") {
      // Group size and on/off are the same decision, so they are written
      // together and the students are placed in one pass.
      await prisma.discussion.update({
        where: { id },
        data: {
          breakoutEnabled: true,
          ...(body.groupSize !== undefined ? { breakoutGroupSize: body.groupSize } : {}),
        },
      });
      await assignBreakoutRooms(id);
    } else if (body.action === "disable") {
      await prisma.discussion.update({ where: { id }, data: { breakoutEnabled: false } });
      await assignBreakoutRooms(id);
    } else if (body.action === "reshuffle") {
      if (!discussion.breakoutEnabled) return fail("Turn breakout rooms on first.", 409);
      await reshuffleBreakoutRooms(id);
    } else {
      if (!discussion.breakoutEnabled) return fail("Turn breakout rooms on first.", 409);

      const member = await prisma.discussionParticipant.findUnique({
        where: { id: body.participantId },
        select: { id: true, discussionId: true, isHost: true },
      });
      if (!member || member.discussionId !== id) {
        return fail("That participant is not in this discussion.", 404);
      }
      if (member.isHost) return fail("The host is not in a breakout room.", 409);

      const students = await prisma.discussionParticipant.count({
        where: { discussionId: id, removed: false, leftAt: null, isHost: false },
      });
      const roomCount = Math.max(1, breakoutRoomCount(students, discussion.breakoutGroupSize));
      if (body.room > roomCount) {
        return fail(`This discussion has ${roomCount} breakout room${roomCount === 1 ? "" : "s"}.`, 409);
      }

      await moveParticipantToRoom(id, body.participantId, body.room);
    }

    const breakout = await loadAllocation(id);
    return ok({ breakout });
  } catch (error) {
    return handleRouteError(error);
  }
}
