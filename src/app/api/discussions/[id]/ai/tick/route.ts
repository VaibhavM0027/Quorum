import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import { ensureRoomOrchestrator, runAssistantTick } from "@/lib/ai-assistant";
import { checkRateLimit } from "@/lib/rate-limit";
import { fail, handleRouteError, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Advances the live AI assistant by one step: scores new contributions, then
 * decides whether to post a silence, balance or drift message.
 *
 * Any member may call this; the assistant itself suppresses duplicate work, so
 * having several clients poll is harmless.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const access = await loadDiscussionForUser(id, user.id);
    if (!access) return fail("Discussion not found, or you do not have access to it.", 404);

    if (access.discussion.status === "LIVE" && access.discussion.aiEnabled) {
      ensureRoomOrchestrator(id);
    }

    // Shared ceiling across every client watching this room.
    const limit = checkRateLimit(`ai-tick:${id}`, 30, 60_000);
    if (!limit.allowed) {
      return ok({ skipped: "rate-limited", classified: 0, eventsCreated: [] });
    }

    const result = await runAssistantTick(id);
    return ok(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
