import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import { checkRateLimit } from "@/lib/rate-limit";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { turnActionSchema } from "@/lib/validation";
import {
  expireTurnIfNeeded,
  finishParticipantTurn,
  hostGrantTurn,
  requestParticipantTurn,
} from "@/lib/turns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const access = await loadDiscussionForUser(id, user.id);
    if (!access) return fail("Discussion not found, or you do not have access to it.", 404);

    const member = access.discussion.participants.find((participant) => participant.userId === user.id);
    if (!member) return fail("Join the discussion before viewing turns.", 403);

    await expireTurnIfNeeded(id);
    if (access.discussion.status === "LIVE" && access.discussion.turnState === "IDLE") {
      await prisma.discussion.updateMany({
        where: { id, status: "LIVE", turnState: "IDLE" },
        data: { turnState: "OPEN" },
      });
    }

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        turnState: true,
        activeTurnParticipantId: true,
        turnStartedAt: true,
        turnEndsAt: true,
        activeAiSpeechEventId: true,
        aiSpeechDeadlineAt: true,
      },
    });
    if (!discussion) return fail("Discussion not found.", 404);

    const [activeParticipant, activeAiEvent, queue, ownRequest] = await Promise.all([
      discussion.activeTurnParticipantId
        ? prisma.discussionParticipant.findUnique({
            where: { id: discussion.activeTurnParticipantId },
            select: { id: true, displayName: true },
          })
        : null,
      discussion.activeAiSpeechEventId
        ? prisma.aiEvent.findUnique({
            where: { id: discussion.activeAiSpeechEventId },
            select: { participantId: true },
          })
        : null,
      prisma.turnRequest.findMany({
        where: { discussionId: id, status: "REQUESTED" },
        orderBy: { requestedAt: "asc" },
        select: {
          id: true,
          requestedAt: true,
          source: true,
          participant: { select: { id: true, userId: true, displayName: true } },
        },
      }),
      prisma.turnRequest.findFirst({
        where: {
          discussionId: id,
          participantId: member.id,
          status: "REQUESTED",
        },
        orderBy: { requestedAt: "asc" },
        select: { id: true, requestedAt: true },
      }),
    ]);

    return ok({
      state: discussion.turnState,
      activeParticipantId: discussion.activeTurnParticipantId,
      activeParticipantName: activeParticipant?.displayName ?? null,
      turnStartedAt: discussion.turnStartedAt?.toISOString() ?? null,
      turnEndsAt: discussion.turnEndsAt?.toISOString() ?? null,
      aiSpeechEventId: discussion.activeAiSpeechEventId,
      invitedParticipantId: activeAiEvent?.participantId ?? null,
      aiSpeechDeadlineAt: discussion.aiSpeechDeadlineAt?.toISOString() ?? null,
      queue: queue.map((request) => ({
        id: request.id,
        participantId: request.participant.id,
        name: request.participant.displayName,
        isSelf: request.participant.userId === user.id,
        source: request.source,
        requestedAt: request.requestedAt.toISOString(),
      })),
      ownRequestId: ownRequest?.id ?? null,
      isActiveSpeaker: discussion.activeTurnParticipantId === member.id,
      isHost: access.isHost,
      sessionLive: discussion.status === "LIVE",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const access = await loadDiscussionForUser(id, user.id);
    if (!access) return fail("Discussion not found, or you do not have access to it.", 404);

    const member = access.discussion.participants.find((participant) => participant.userId === user.id);
    if (!member || member.removed || member.leftAt) {
      return fail("Join the live discussion before managing turns.", 403);
    }

    const body = turnActionSchema.parse(await readJson(request));
    const limit = checkRateLimit(`turn-action:${id}:${user.id}`, 30, 60_000);
    if (!limit.allowed) return fail("Too many turn requests. Please wait a moment.", 429);

    if (body.action === "grant") {
      if (!access.isHost) return fail("Only the host can grant turns.", 403);
      const participantId = await hostGrantTurn({
        discussionId: id,
        participantId: body.participantId,
      });
      return ok({ action: body.action, participantId });
    }

    if (body.action === "request") {
      const result = await requestParticipantTurn({
        discussionId: id,
        participantId: member.id,
        requestId: body.requestId,
      });
      return ok({ action: body.action, ...result });
    }

    if (body.action === "pass" && access.isHost) {
      const discussion = await prisma.discussion.findUnique({
        where: { id },
        select: { activeTurnParticipantId: true, activeAiSpeechEventId: true },
      });
      const activeId = discussion?.activeTurnParticipantId;
      if (activeId && activeId !== member.id) {
        return fail("A host may end another person's turn, but cannot pass it for them.", 403);
      }
      if (!activeId && discussion?.activeAiSpeechEventId) {
        const event = await prisma.aiEvent.findUnique({
          where: { id: discussion.activeAiSpeechEventId },
          select: { participantId: true },
        });
        if (event?.participantId !== member.id) {
          return fail("Only the invited participant can pass this invitation.", 403);
        }
      }
    }

    const result = await finishParticipantTurn({
      discussionId: id,
      participantId: member.id,
      actorIsHost: access.isHost,
      action: body.action,
    });
    return ok({ action: body.action, ...result });
  } catch (error) {
    return handleRouteError(error);
  }
}
