import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { presenceSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Records live audio activity for a discussion.
 *
 * This is the moderator's ears. A browser knows the moment somebody's
 * microphone carries speech — LiveKit fires `ActiveSpeakersChanged` — whereas a
 * transcript sentence only exists once the recogniser has committed it, which
 * can be several seconds later. Reporting that raw activity is what lets the
 * conversation engine promise never to talk over a participant mid-sentence.
 *
 * Each browser reports its own microphone, so attribution is exact; a browser
 * also reports when the moderator's voice is playing, so the engine knows not
 * to talk over itself.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (discussion.status !== "LIVE") {
      return fail("Audio activity is only tracked while the discussion is live.", 409);
    }

    const member = await prisma.discussionParticipant.findUnique({
      where: { discussionId_userId: { discussionId: id, userId: user.id } },
      select: { id: true, removed: true },
    });
    if (!member) return fail("Join the discussion before reporting audio activity.", 403);
    if (member.removed) return fail("You were removed from this discussion.", 403);

    // A generous ceiling: a speaking browser heartbeats every few seconds.
    const limit = checkRateLimit(`presence:${id}:${user.id}`, 120, 60_000);
    if (!limit.allowed) return ok({ skipped: "rate-limited" });

    const body = presenceSchema.parse(await readJson(request));
    const now = new Date();

    if (body.speaking !== undefined) {
      await prisma.discussionParticipant.update({
        where: { id: member.id },
        data: {
          lastAudioAt: now,
          // Non-null while they hold the floor, cleared the moment they stop.
          speakingSince: body.speaking ? now : null,
        },
      });
    }

    if (body.aiSpeaking) {
      await prisma.discussion.update({
        where: { id },
        data: { lastAiSpokeAt: now },
      });
    }

    return ok({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
