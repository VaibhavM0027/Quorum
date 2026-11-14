import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { JOINABLE_STATUSES, assignBreakoutRooms, assignSeat, previewByJoinCode } from "@/lib/discussions";
import { checkRateLimit, clientKey } from "@/lib/rate-limit";
import { fail, handleRouteError, ok } from "@/lib/http";
import { joinRequestBodySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Join-code lookups are cheap but guessable, so both previewing and joining are
 * throttled per client. The limit is deliberately generous: several people
 * joining the same room often share one IP address.
 */
const JOIN_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

/** Preview a discussion from its join code, before the user commits to joining. */
export async function GET(request: Request) {
  try {
    await requireSession();

    const limit = checkRateLimit(`join:${clientKey(request)}`, JOIN_RATE_LIMIT.limit, JOIN_RATE_LIMIT.windowMs);
    if (!limit.allowed) {
      return fail("Too many attempts. Please wait a moment and try again.", 429);
    }

    const code = new URL(request.url).searchParams.get("code")?.trim().toUpperCase();
    if (!code) return fail("A join code is required.", 400);

    const preview = await previewByJoinCode(code);
    if (!preview) return fail("No discussion matches that code.", 404);

    return ok({ discussion: preview });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Join a discussion using its code. Idempotent for existing members. */
export async function POST(request: Request) {
  try {
    const user = await requireSession();

    const limit = checkRateLimit(`join:${clientKey(request)}`, JOIN_RATE_LIMIT.limit, JOIN_RATE_LIMIT.windowMs);
    if (!limit.allowed) {
      return fail("Too many attempts. Please wait a moment and try again.", 429);
    }

    const code = new URL(request.url).searchParams.get("code")?.trim().toUpperCase();

    // The body is optional — the code may arrive as a query parameter instead.
    // It is still validated rather than trusted: reading `body.code.trim()` off
    // an unchecked cast used to throw out of the handler and surface as a 500.
    const body = joinRequestBodySchema.parse(await request.json().catch(() => ({})));
    const joinCode = code ?? body.code;
    const displayName = body.displayName;

    if (!joinCode) return fail("A join code is required.", 400);

    const discussion = await prisma.discussion.findUnique({
      where: { joinCode },
      include: { _count: { select: { participants: true } } },
    });
    if (!discussion) return fail("No discussion matches that code.", 404);

    if (!(JOINABLE_STATUSES as readonly string[]).includes(discussion.status)) {
      return fail(
        discussion.status === "COMPLETED"
          ? "This discussion has already ended."
          : "This discussion was cancelled.",
        409,
      );
    }

    const existing = await prisma.discussionParticipant.findUnique({
      where: { discussionId_userId: { discussionId: discussion.id, userId: user.id } },
    });

    // Joining a discussion that transcribes is what records consent, so a
    // participant is never silently left out of their own transcript. It is
    // still an explicit act with a timestamp, and "Stop transcribing my voice"
    // can withdraw it afterwards.
    const consent = discussion.transcriptionEnabled;

    if (existing) {
      if (existing.removed) return fail("You were removed from this discussion.", 403);
      const updated = await prisma.discussionParticipant.update({
        where: { id: existing.id },
        data: {
          leftAt: null,
          joinedAt: existing.joinedAt ?? new Date(),
          transcriptionConsent: existing.transcriptionConsent || consent,
          consentAt: existing.consentAt ?? (consent ? new Date() : null),
        },
      });
      // A student who only lost their connection keeps the seat they already
      // have; someone who left deliberately (and so gave it up) is seated again.
      const seatNumber =
        updated.seatNumber ?? (await assignSeat(discussion.id, updated.id, discussion.maxParticipants));
      // Someone arriving after the groups were set goes into the emptiest one
      // rather than disturbing a group that is already talking.
      if (discussion.breakoutEnabled) await assignBreakoutRooms(discussion.id);
      return ok({
        discussionId: discussion.id,
        participantId: updated.id,
        seatNumber,
        alreadyMember: true,
      });
    }

    if (discussion._count.participants >= discussion.maxParticipants) {
      return fail("This discussion is full.", 409);
    }

    const participant = await prisma.discussionParticipant.create({
      data: {
        discussionId: discussion.id,
        userId: user.id,
        displayName: displayName || user.name,
        isHost: discussion.hostId === user.id,
        joinedAt: discussion.status === "LIVE" ? new Date() : null,
        transcriptionConsent: consent,
        consentAt: consent ? new Date() : null,
      },
    });

    // Every student gets exactly one numbered seat when they join. The seat is
    // stored, so reconnecting later returns them to the same chair.
    const seatNumber = await assignSeat(discussion.id, participant.id, discussion.maxParticipants);
    if (discussion.breakoutEnabled) await assignBreakoutRooms(discussion.id);

    return ok(
      { discussionId: discussion.id, participantId: participant.id, seatNumber, alreadyMember: false },
      201,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
