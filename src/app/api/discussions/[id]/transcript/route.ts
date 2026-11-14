import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import {
  countWords,
  isDuplicateSegment,
  isMeaningful,
  normalizeTranscript,
  transcriptToCsv,
} from "@/lib/transcript";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { transcriptSegmentSchema } from "@/lib/validation";
import { applyInvitationOutcome } from "@/lib/ai-assistant";
import { classifyParticipantResponse } from "@/lib/participation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_SEGMENTS = 500;

/**
 * Returns the discussion transcript in chronological order.
 * Both the host and members may read it; it is the shared record of the room.
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

    // Drop a re-delivered copy of the participant's previous utterance.
    const previous = await prisma.transcriptSegment.findFirst({
      where: { discussionId: id, participantId: member.id },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        text: true,
        startedAt: true,
        endedAt: true,
        durationMs: true,
        wordCount: true,
      },
    });

    if (previous && isDuplicateSegment(previous, text, startedAt)) {
      return ok({
        segment: {
          ...previous,
          startedAt: previous.startedAt.toISOString(),
          endedAt: previous.endedAt.toISOString(),
        },
        duplicate: true,
      });
    }

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

    // A committed transcript is proof that this participant had the floor even
    // if their browser never reported audio activity to us. Stamping their
    // latest audio makes the moderator wait on somebody who is already talking
    // instead of inviting them.
    const spokeAt = new Date();
    await prisma.discussionParticipant.update({
      where: { id: member.id },
      data: { lastAudioAt: spokeAt },
    });

    // If the moderator is waiting on this participant, their answer is settled
    // here rather than on the next tick, so the room's countdown stops the
    // moment the floor is taken — or, if they asked to be excused, the moment
    // they say so.
    const pendingInvite = await prisma.invitation.findFirst({
      where: { discussionId: id, participantId: member.id, status: "PENDING" },
      select: { id: true },
    });
    if (pendingInvite) {
      const kind = classifyParticipantResponse(text);
      await applyInvitationOutcome({
        invitationId: pendingInvite.id,
        participantId: member.id,
        kind: kind === "pass" ? "pass" : kind === "technical" ? "technical" : "answered",
        segmentId: segment.id,
        now: spokeAt.getTime(),
      });
    }

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
