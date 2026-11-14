import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import { transcriptToCsv } from "@/lib/transcript";
import { fail, handleRouteError, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_SEGMENTS = 500;

/**
 * Returns the discussion transcript in chronological order.
 * Both the host and members may read it; it is the shared record of the room.
 *
 * Read-only: segments are written by the transcription agent, never by a
 * browser, so no participant can inject text attributed to somebody else.
 *
 * `?format=csv` downloads the stored transcript instead of the JSON the room
 * polls: every stored entry with its speaker, timestamps, text, speaking
 * duration and word count. The JSON view is capped so the live room stays
 * responsive; the export is not, because it is the permanent record.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const access = await loadDiscussionForUser(id, user.id);
    if (!access) return fail("Discussion not found, or you do not have access to it.", 404);

    const search = new URL(request.url).searchParams;
    const since = search.get("since");
    const sinceDate = since ? new Date(since) : null;
    if (sinceDate && Number.isNaN(sinceDate.getTime())) {
      return fail("`since` must be an ISO date.", 400);
    }
    const asCsv = search.get("format") === "csv";

    const segments = await prisma.transcriptSegment.findMany({
      where: {
        discussionId: id,
        ...(sinceDate ? { startedAt: { gt: sinceDate } } : {}),
      },
      orderBy: { startedAt: "asc" },
      ...(asCsv ? {} : { take: MAX_SEGMENTS }),
      include: { participant: { select: { displayName: true, isHost: true, userId: true } } },
    });

    if (asCsv) {
      const csv = transcriptToCsv(
        segments.map((segment) => ({
          discussionId: id,
          userId: segment.participant.userId,
          studentName: segment.participant.displayName,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          text: segment.text,
          durationMs: segment.durationMs,
          wordCount: segment.wordCount,
        })),
      );

      // Note the export so the dashboard can show what has been downloaded,
      // exactly as the PDF endpoints do.
      const existing = await prisma.report.findFirst({
        where: { discussionId: id, kind: "TRANSCRIPT", participantId: null },
        select: { id: true },
      });
      if (existing) {
        await prisma.report.update({
          where: { id: existing.id },
          data: { lastDownloadedAt: new Date() },
        });
      } else {
        await prisma.report.create({
          data: { discussionId: id, kind: "TRANSCRIPT", lastDownloadedAt: new Date() },
        });
      }

      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="quorum-${id}-transcript.csv"`,
          "cache-control": "no-store",
        },
      });
    }

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
