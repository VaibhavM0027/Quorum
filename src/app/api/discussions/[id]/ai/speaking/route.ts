import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { beginAiSpeaking, endAiSpeaking, isMeetingPaused } from "@/lib/room-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const aiSpeakingSchema = z.object({
  speaking: z.boolean(),
  estimatedDurationMs: z.number().int().min(1000).max(25_000).optional(),
});

/**
 * Synchronizes when the AI moderator starts or finishes speaking aloud.
 *
 * Starting (`speaking: true`) immediately moves the room into `AI_SPEAKING`,
 * mutes and revokes `canPublish` for every participant at LiveKit, and
 * broadcasts the lock across all connected browsers. Stopping (`speaking: false`)
 * restores participant microphone permissions.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const body = aiSpeakingSchema.parse(await readJson(request));

    const access = await loadDiscussionForUser(id, user.id);
    if (!access) return fail("Discussion not found, or you do not have access to it.", 404);

    const { discussion } = access;
    if (discussion.status !== "LIVE") {
      return fail("Discussion is not live.", 409);
    }
    if (!discussion.aiEnabled) {
      return fail("AI moderation is disabled for this discussion.", 409);
    }
    if (isMeetingPaused(discussion)) {
      return fail("Meeting is paused.", 409);
    }

    const state = body.speaking
      ? await beginAiSpeaking(id, body.estimatedDurationMs ?? 9000)
      : await endAiSpeaking(id);

    return ok({ ok: true, state });
  } catch (error) {
    return handleRouteError(error);
  }
}
