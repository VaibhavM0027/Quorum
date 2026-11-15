import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import {
  countWords,
  isDuplicateSegment,
  isMeaningful,
  normalizeTranscript,
  TRANSCRIPT_UPDATE_TOPIC,
  transcriptToCsv,
} from "@/lib/transcript";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { transcriptAudioMetadataSchema, transcriptSegmentSchema } from "@/lib/validation";
import { applyInvitationOutcome } from "@/lib/ai-assistant";
import { classifyParticipantResponse } from "@/lib/participation";
import { transcriptLog, transcriptWarn } from "@/lib/debug-log";
import { DataPacket_Kind, RoomServiceClient } from "livekit-server-sdk";
import { env } from "@/lib/env";
import { livekitReady, roomNameFor } from "@/lib/livekit";
import { checkRateLimit } from "@/lib/rate-limit";
import { transcribeAudioWithGemini } from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_SEGMENTS = 500;
const MAX_TRANSCRIPT_AUDIO_BYTES = 1_500_000;
const TRANSCRIPT_AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);

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
        participantIdentity: s.participant.userId,
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
 * Stores a transcript chunk spoken by the signed-in participant. JSON text
 * remains supported; audio chunks are transcribed server-side by Gemini.
 * The speaker is derived from the authenticated LiveKit identity, never from
 * client-supplied speaker metadata.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        transcriptionEnabled: true,
        breakoutEnabled: true,
        participants: { select: { isHost: true, breakoutRoom: true } },
      },
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
      select: {
        id: true,
        displayName: true,
        isHost: true,
        removed: true,
        transcriptionConsent: true,
      },
    });
    if (!member) {
      transcriptWarn("chunk rejected: sender is not a member", { discussionId: id, userId: user.id });
      return fail("Join the discussion before sending transcript data.", 403);
    }
    if (member.removed) {
      transcriptWarn("chunk rejected: sender was removed", { participantId: member.id });
      return fail("You were removed from this discussion.", 403);
    }
    if (!member.transcriptionConsent) {
      transcriptWarn("chunk rejected: no consent recorded", {
        participantId: member.id,
        speaker: member.displayName,
      });
      return fail("Transcription consent is required before your speech is recorded.", 403);
    }

    let text: string;
    let startedAt: Date;
    let endedAt: Date;
    let durationMs: number;

    const requestContentType = request.headers.get("content-type") ?? "";
    if (requestContentType.startsWith("audio/")) {
      const declaredLength = Number(request.headers.get("content-length") ?? "");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_TRANSCRIPT_AUDIO_BYTES) {
        return fail("Audio chunk is too large.", 413);
      }

      const mimeType = requestContentType.split(";")[0]?.toLowerCase();
      if (!mimeType || !TRANSCRIPT_AUDIO_MIME_TYPES.has(mimeType)) {
        return fail("This audio format is not supported for Gemini transcription.", 415);
      }

      const metadata = transcriptAudioMetadataSchema.parse({
        startedAt: request.headers.get("x-transcript-started-at"),
        endedAt: request.headers.get("x-transcript-ended-at"),
        durationMs: request.headers.get("x-transcript-duration-ms"),
        language: request.headers.get("x-transcript-language") || undefined,
      });

      const roomLimit = checkRateLimit(`transcript-audio-room:${id}`, 120, 60_000);
      if (!roomLimit.allowed) {
        return fail("Transcription is busy. Please retry shortly.", 429, {
          retryAfterMs: roomLimit.retryAfterMs,
        });
      }
      const participantLimit = checkRateLimit(`transcript-audio:${id}:${user.id}`, 15, 60_000);
      if (!participantLimit.allowed) {
        return fail("Transcription is busy. Please retry shortly.", 429, {
          retryAfterMs: participantLimit.retryAfterMs,
        });
      }

      const reader = request.body?.getReader();
      if (!reader) return fail("An audio chunk is required.", 400);
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_TRANSCRIPT_AUDIO_BYTES) {
          await reader.cancel();
          return fail("Audio chunk is too large.", 413);
        }
        chunks.push(Buffer.from(value));
      }
      if (totalBytes === 0) return fail("Audio chunk is empty.", 422);

      const audioBytes = Buffer.concat(chunks, totalBytes);
      text = normalizeTranscript(
        await transcribeAudioWithGemini({
          audioBase64: audioBytes.toString("base64"),
          mimeType,
          language: metadata.language,
        }),
      );
      if (!isMeaningful(text)) return ok({ skipped: "no-speech" });

      startedAt = metadata.startedAt;
      endedAt = metadata.endedAt;
      durationMs = metadata.durationMs;
    } else {
      const body = transcriptSegmentSchema.parse(await readJson(request));
      text = normalizeTranscript(body.text);
      startedAt = body.startedAt;
      endedAt = body.endedAt;
      durationMs = body.durationMs;
    }

    if (!isMeaningful(text)) {
      transcriptWarn("chunk rejected: no spoken content", {
        participantId: member.id,
        speaker: member.displayName,
      });
      return fail("Transcript chunk has no spoken content.", 422);
    }

    // Clamp nonsensical timings rather than rejecting a valid utterance.
    endedAt = endedAt >= startedAt ? endedAt : new Date(startedAt.getTime() + durationMs);

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
      transcriptLog("chunk dropped as a duplicate", {
        participantId: member.id,
        speaker: member.displayName,
        startedAt: startedAt.toISOString(),
      });
      return ok({
        segment: {
          ...previous,
          participantId: member.id,
          participantIdentity: user.id,
          speaker: member.displayName,
          speakerIsHost: member.isHost,
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
        durationMs,
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

    transcriptLog("chunk stored", {
      segmentId: segment.id,
      participantId: member.id,
      speaker: member.displayName,
      words: segment.wordCount,
      durationMs: segment.durationMs,
      startedAt: segment.startedAt.toISOString(),
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

    if (livekitReady()) {
      try {
        const roomService = new RoomServiceClient(
          env.livekitHost,
          env.livekitApiKey,
          env.livekitApiSecret,
        );
        const expectedRooms = new Set([roomNameFor(id)]);
        if (discussion.breakoutEnabled) {
          for (const participant of discussion.participants) {
            if (!participant.isHost && participant.breakoutRoom !== null) {
              expectedRooms.add(roomNameFor(id, participant.breakoutRoom));
            }
          }
        }

        const activeRooms = await roomService.listRooms([...expectedRooms]);
        const payload = new TextEncoder().encode("transcript-updated");
        const sends = await Promise.allSettled(
          activeRooms.map((room) =>
            roomService.sendData(room.name, payload, DataPacket_Kind.RELIABLE, {
              topic: TRANSCRIPT_UPDATE_TOPIC,
            }),
          ),
        );
        sends.forEach((result, index) => {
          if (result.status === "rejected") {
            transcriptWarn("live transcript notification failed", {
              discussionId: id,
              room: activeRooms[index]?.name,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
          }
        });
      } catch (error) {
        // The transcript is already durable; clients also poll to recover notifications.
        transcriptWarn("could not publish live transcript notification", {
          discussionId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return ok(
      {
        segment: {
          ...segment,
          participantId: member.id,
          participantIdentity: user.id,
          speaker: member.displayName,
          speakerIsHost: member.isHost,
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
