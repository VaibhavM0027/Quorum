import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import { countWords, isMeaningful, normalizeTranscript } from "@/lib/transcript";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { transcriptSegmentSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_SEGMENTS = 500;

/**
 * Returns the discussion transcript in chronological order.
 * Both the host and members may read it; it is the shared record of the room.
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

    const segments = await prisma.transcriptSegment.findMany({
      where: {
        discussionId: id,
        ...(sinceDate ? { startedAt: { gt: sinceDate } } : {}),
      },
      orderBy: { startedAt: "asc" },
      take: MAX_SEGMENTS,
      include: { participant: { select: { displayName: true, isHost: true, userId: true } } },
    });

    return ok({
      segments: segments.map((s) => ({
        id: s.id,
        participantId: s.participantId,
        speaker: s.participant.displayName,
        speakerIsHost: s.participant.isHost,
        isMine: s.participant.userId === user.id,
        text: s.text,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt.toISOString(),
        durationMs: s.durationMs,
        wordCount: s.wordCount,
        relevance: s.relevance,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Appends a transcript chunk spoken by the signed-in participant.
 *
 * The chunk arrives from that participant's own browser speech recogniser, so
 * the speaker is always unambiguous.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: { id: true, status: true, transcriptionEnabled: true },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (discussion.status !== "LIVE") {
      return fail("Transcription is only captured while the discussion is live.", 409);
    }
    if (!discussion.transcriptionEnabled) {
      return fail("Transcription is disabled for this discussion.", 409);
    }

    const member = await prisma.discussionParticipant.findUnique({
      where: { discussionId_userId: { discussionId: id, userId: user.id } },
      select: { id: true, removed: true, transcriptionConsent: true },
    });
    if (!member) return fail("Join the discussion before sending transcript data.", 403);
    if (member.removed) return fail("You were removed from this discussion.", 403);
    if (!member.transcriptionConsent) {
      return fail("Transcription consent is required before your speech is recorded.", 403);
    }

    const body = transcriptSegmentSchema.parse(await readJson(request));
    const text = normalizeTranscript(body.text);
    if (!isMeaningful(text)) {
      return fail("Transcript chunk has no spoken content.", 422);
    }

    // Clamp nonsensical timings rather than rejecting a valid utterance.
    const startedAt = body.startedAt;
    const endedAt = body.endedAt >= startedAt ? body.endedAt : new Date(startedAt.getTime() + body.durationMs);

    const segment = await prisma.transcriptSegment.create({
      data: {
        discussionId: id,
        participantId: member.id,
        text,
        startedAt,
        endedAt,
        durationMs: body.durationMs,
        wordCount: countWords(text),
      },
      select: {
        id: true,
        text: true,
        startedAt: true,
        endedAt: true,
        durationMs: true,
        wordCount: true,
      },
    });

    return ok(
      {
        segment: {
          ...segment,
          startedAt: segment.startedAt.toISOString(),
          endedAt: segment.endedAt.toISOString(),
        },
      },
      201,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
