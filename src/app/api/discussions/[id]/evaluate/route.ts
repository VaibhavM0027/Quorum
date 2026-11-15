import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { evaluateDiscussion } from "@/lib/evaluation";
import { geminiAvailable } from "@/lib/gemini";
import { checkRateLimit } from "@/lib/rate-limit";
import { fail, handleRouteError, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/**
 * Runs the evaluation for a discussion.
 *
 * Evaluations are produced once the transcript is complete, so this is allowed
 * while the room is LIVE (a partial run) and after it ends. Only the host may
 * trigger it — it consumes AI quota and should not be fired by every client.
 * Re-running is safe: results are replaced, never appended.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: {
        id: true,
        hostId: true,
        status: true,
        _count: { select: { segments: { where: { status: "FINAL" } } } },
      },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (discussion.hostId !== user.id) {
      return fail("Only the host can run the evaluation for this discussion.", 403);
    }
    if (discussion.status !== "LIVE" && discussion.status !== "COMPLETED") {
      return fail("The evaluation can only run once the discussion is live or finished.", 409);
    }
    if (discussion._count.segments === 0) {
      return fail("There is no transcript to evaluate yet.", 409);
    }
    if (!geminiAvailable()) {
      return fail("The AI evaluator is not configured, so scoring is unavailable.", 503);
    }

    // One run per discussion per window: evaluation is the most expensive call.
    const limit = checkRateLimit(`evaluate:${id}`, 3, 5 * 60_000);
    if (!limit.allowed) {
      return fail("The evaluation was run recently. Please wait a few minutes.", 429);
    }

    const result = await evaluateDiscussion(id);
    return ok({ ok: true, ...result });
  } catch (error) {
    return handleRouteError(error);
  }
}
