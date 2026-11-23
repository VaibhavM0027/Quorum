import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { generateUniqueJoinCode, inviteUrl } from "@/lib/discussions";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { createDiscussionSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lists the discussions the signed-in user hosts or has joined. */
export async function GET() {
  try {
    const user = await requireSession();

    const discussions = await prisma.discussion.findMany({
      where: user.role === "HOST" ? { hostId: user.id } : { participants: { some: { userId: user.id } } },
      orderBy: [{ status: "asc" }, { scheduledAt: "desc" }],
      include: {
        host: { select: { name: true } },
        _count: {
          select: {
            participants: true,
            segments: { where: { status: "FINAL" } },
            evaluations: true,
          },
        },
      },
    });

    return ok({
      discussions: discussions.map((d) => ({
        id: d.id,
        title: d.title,
        topic: d.topic,
        status: d.status,
        mode: d.mode,
        joinCode: d.joinCode,
        inviteUrl: inviteUrl(d.joinCode),
        scheduledAt: d.scheduledAt,
        durationMin: d.durationMin,
        maxParticipants: d.maxParticipants,
        startedAt: d.startedAt,
        endedAt: d.endedAt,
        hostName: d.host.name,
        isHost: d.hostId === user.id,
        participantCount: d._count.participants,
        segmentCount: d._count.segments,
        evaluationCount: d._count.evaluations,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Creates a discussion. Host accounts only. */
export async function POST(request: Request) {
  try {
    const user = await requireSession();
    if (user.role !== "HOST") {
      return fail("Only host accounts can create discussions.", 403);
    }

    const body = createDiscussionSchema.parse(await readJson(request));
    const joinCode = await generateUniqueJoinCode();

    const discussion = await prisma.discussion.create({
      data: {
        title: body.title,
        topic: body.topic,
        context: body.context,
        rules: body.rules,
        hostId: user.id,
        joinCode,
        scheduledAt: body.scheduledAt ?? new Date(),
        durationMin: body.durationMin,
        maxParticipants: body.maxParticipants,
        mode: body.mode,
        aiEnabled: body.aiEnabled,
        transcriptionEnabled: body.transcriptionEnabled,
        silencePromptSec: body.silencePromptSec,
        inviteResponseSec: body.inviteResponseSec,
        turnDurationSec: body.turnDurationSec,
        // The host is a participant of their own room.
        participants: {
          create: { userId: user.id, displayName: user.name, isHost: true },
        },
      },
    });

    return ok(
      {
        discussion: {
          id: discussion.id,
          title: discussion.title,
          joinCode: discussion.joinCode,
          inviteUrl: inviteUrl(discussion.joinCode),
          status: discussion.status,
        },
      },
      201,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
