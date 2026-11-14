import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import { loadParticipation } from "@/lib/participation";
import { fail, handleRouteError, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/**
 * The live participation snapshot for a discussion.
 *
 * This is what the dashboard polls: who has spoken for how long, how much of
 * it was on topic, who has the floor right now, how many times each
 * participant has been invited and how they answered, and the live score. It
 * is computed from the same stored transcript and audio activity the moderator
 * itself reads, so the board and the moderator never disagree.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const access = await loadDiscussionForUser(id, user.id);
    if (!access) return fail("Discussion not found, or you do not have access to it.", 404);

    const snapshot = await loadParticipation(id);

    return ok({
      conversationState: access.discussion.conversationState,
      context: snapshot.context,
      rows: snapshot.rows.map((row) => ({
        participantId: row.participantId,
        displayName: row.displayName,
        isHost: row.isHost,
        seatNumber: row.seatNumber,
        present: row.present,
        micLocked: row.micLocked,
        audioIssue: row.audioIssue,
        speaking: row.speaking,
        presentMs: row.presentMs,
        speakingMs: row.speakingMs,
        words: row.words,
        contributions: row.contributions,
        meaningfulContributions: row.meaningfulContributions,
        averageTurnMs: row.averageTurnMs,
        averageRelevance: row.averageRelevance,
        lastSpokeAt: iso(row.lastSpokeAt),
        invitedCount: row.invitedCount,
        answeredInvites: row.answeredInvites,
        unansweredInvites: row.unansweredInvites,
        passCount: row.passCount,
        score: row.score,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
