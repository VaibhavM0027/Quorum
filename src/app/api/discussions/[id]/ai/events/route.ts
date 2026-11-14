import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import { fail, handleRouteError, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_EVENTS = 100;

/**
 * Returns the assistant's messages for a discussion, oldest first.
 * `?since=<ISO>` fetches only what is new, which is what the room UI polls for.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const access = await loadDiscussionForUser(id, user.id);
    if (!access) return fail("Discussion not found, or you do not have access to it.", 404);

    const since = new URL(request.url).searchParams.get("since");
    const sinceDate = since ? new Date(since) : null;
    if (sinceDate && Number.isNaN(sinceDate.getTime())) {
      return fail("`since` must be an ISO date.", 400);
    }

    const events = await prisma.aiEvent.findMany({
      where: { discussionId: id, ...(sinceDate ? { createdAt: { gt: sinceDate } } : {}) },
      orderBy: { createdAt: "asc" },
      take: MAX_EVENTS,
    });

    // Resolve the addressee's display name for nudges, when there is one.
    const participantIds = events
      .map((event) => event.participantId)
      .filter((value): value is string => Boolean(value));

    const names = participantIds.length
      ? new Map(
          (
            await prisma.discussionParticipant.findMany({
              where: { id: { in: participantIds } },
              select: { id: true, displayName: true },
            })
          ).map((p) => [p.id, p.displayName] as const),
        )
      : new Map<string, string>();

    return ok({
      events: events.map((event) => ({
        id: event.id,
        kind: event.kind,
        message: event.message,
        source: event.source,
        participantId: event.participantId,
        participantName: event.participantId ? names.get(event.participantId) ?? null : null,
        // Set when the assistant has announced an action it is about to take.
        // The room counts down to this moment, so every browser shows the same
        // timer without having to agree on the current time.
        dueAt: event.dueAt ? event.dueAt.toISOString() : null,
        createdAt: event.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
