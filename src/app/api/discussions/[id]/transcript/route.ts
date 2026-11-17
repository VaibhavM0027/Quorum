import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import {
  countWords,
  isDuplicateSegment,
  isMeaningful,
  normalizeTranscript,
  TRANSCRIPT_PARTIAL_TOPIC,
  TRANSCRIPT_UPDATE_TOPIC,
  transcriptToCsv,
} from "@/lib/transcript";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import {
  transcriptAudioMetadataSchema,
  transcriptPartialSchema,
  transcriptSegmentSchema,
} from "@/lib/validation";
import { applyInvitationOutcome } from "@/lib/ai-assistant";
import { classifyParticipantResponse } from "@/lib/participation";
import { transcriptLog, transcriptWarn } from "@/lib/debug-log";
import { DataPacket_Kind, RoomServiceClient } from "livekit-server-sdk";
import { env } from "@/lib/env";
import { livekitReady, roomNameFor } from "@/lib/livekit";
import { checkRateLimit } from "@/lib/rate-limit";
import { getSttProvider } from "@/lib/stt/provider";
import { isAiSpeakingLocked } from "@/lib/room-sync";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_SEGMENTS = 2500;
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
    const updatedSince = search.get("updatedSince");
    const updatedSinceDate = updatedSince ? new Date(updatedSince) : null;
    if (updatedSinceDate && Number.isNaN(updatedSinceDate.getTime())) {
      return fail("`updatedSince` must be an ISO date.", 400);
    }
    const asOf = new Date();
    const asCsv = search.get("format") === "csv";

    const segments = await prisma.transcriptSegment.findMany({
      where: {
        discussionId: id,
        status: "FINAL",
        ...(updatedSinceDate
          ? { updatedAt: { gte: updatedSinceDate } }
          : sinceDate
            ? { startedAt: { gt: sinceDate } }
            : {}),
      },
      orderBy: updatedSinceDate ? { updatedAt: "desc" } : { startedAt: "desc" },
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

    const partials = await prisma.transcriptSegment.findMany({
      where: {
        discussionId: id,
        status: "PARTIAL",
        ...(updatedSinceDate
          ? { updatedAt: { gte: updatedSinceDate } }
          : { endedAt: { gt: new Date(Date.now() - 60_000) } }),
      },
      orderBy: updatedSinceDate ? { updatedAt: "desc" } : { startedAt: "desc" },
      take: MAX_SEGMENTS,
      include: { participant: { select: { displayName: true, isHost: true, userId: true } } },
    });

    return ok({
      segments: [...segments, ...partials]
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
        .map((s) => ({
          id: s.id,
          streamId: s.streamId,
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
          confidence: s.confidence ?? null,
          status: s.status,
          revision: s.revision,
          updatedAt: s.updatedAt.toISOString(),
          relevance: s.relevance,
        })),
      asOf: asOf.toISOString(),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Stores an interim browser-recognition result. The authenticated membership
 * supplies the speaker identity; the LiveKit data channel carries the faster
 * room-wide updates while this row provides recovery after reconnects.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const body = transcriptPartialSchema.parse(await readJson(request));
    const text = normalizeTranscript(body.text);
    if (!isMeaningful(text)) return fail("Transcript chunk has no spoken content.", 422);

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
    if (discussion.status !== "LIVE" || !discussion.transcriptionEnabled) {
      return fail("Transcription is not active for this discussion.", 409);
    }

    const member = await prisma.discussionParticipant.findUnique({
      where: { discussionId_userId: { discussionId: id, userId: user.id } },
      select: {
        id: true,
        displayName: true,
        removed: true,
        leftAt: true,
        transcriptionConsent: true,
      },
    });
    if (!member || member.removed || member.leftAt) {
      return fail("Join the discussion before sending transcript data.", 403);
    }
    if (!member.transcriptionConsent) {
      return fail("Transcription consent is required before your speech is recorded.", 403);
    }

    const limit = checkRateLimit(`transcript-partial:${id}:${user.id}`, 120, 60_000);
    if (!limit.allowed) {
      return fail("Live transcription is busy. Please retry shortly.", 429, {
        retryAfterMs: limit.retryAfterMs,
      });
    }

    const where = {
      participantId_streamId: {
        participantId: member.id,
        streamId: body.streamId,
      },
    };
    const data = {
      discussionId: id,
      participantId: member.id,
      streamId: body.streamId,
      text,
      startedAt: body.startedAt,
      endedAt: new Date(),
      durationMs: 0,
      wordCount: countWords(text),
      status: "PARTIAL" as const,
      revision: body.revision,
    };

    const updated = await prisma.transcriptSegment.updateMany({
      where: {
        participantId: member.id,
        streamId: body.streamId,
        status: "PARTIAL",
        revision: { lte: body.revision },
      },
      data,
    });
    if (updated.count === 0) {
      const existing = await prisma.transcriptSegment.findUnique({ where });
      if (existing) return ok({ stored: false, status: existing.status });
      try {
        await prisma.transcriptSegment.create({ data });
      } catch (error) {
        // A final result may have won the unique-key race; never downgrade it.
        const raced = await prisma.transcriptSegment.findUnique({ where });
        if (!raced) throw error;
        return ok({ stored: false, status: raced.status });
      }
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
        const payload = new TextEncoder().encode(
          JSON.stringify({
            type: "partial",
            streamId: body.streamId,
            text,
            startedAt: body.startedAt.toISOString(),
            revision: body.revision,
            participantIdentity: user.id,
            participantName: member.displayName,
          }),
        );
        const sends = await Promise.allSettled(
          activeRooms.map((room) =>
            roomService.sendData(room.name, payload, DataPacket_Kind.RELIABLE, {
              topic: TRANSCRIPT_PARTIAL_TOPIC,
            }),
          ),
        );
        sends.forEach((result, index) => {
          if (result.status === "rejected") {
            transcriptWarn("live transcript draft notification failed", {
              discussionId: id,
              room: activeRooms[index]?.name,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
          }
        });
      } catch (error) {
        transcriptWarn("could not publish live transcript draft", {
          discussionId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return ok({ stored: true, status: "PARTIAL" });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Removes a stale interim row when recognition stops without a final result. */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const search = new URL(request.url).searchParams;
    const streamId = search.get("streamId");
    const revision = Number(search.get("revision"));
    if (!streamId || !z.string().uuid().safeParse(streamId).success) {
      return fail("A valid streamId is required.", 400);
    }
    if (!Number.isInteger(revision) || revision < 0) {
      return fail("A valid revision is required.", 400);
    }
    const member = await prisma.discussionParticipant.findUnique({
      where: { discussionId_userId: { discussionId: id, userId: user.id } },
      select: { id: true },
    });
    if (!member) return fail("You do not have access to this discussion.", 403);

    const deleted = await prisma.transcriptSegment.deleteMany({
      where: { discussionId: id, participantId: member.id, streamId, status: "PARTIAL" },
    });
    if (deleted.count > 0 && livekitReady()) {
      try {
        const discussion = await prisma.discussion.findUnique({
          where: { id },
          select: {
            breakoutEnabled: true,
            participants: { select: { isHost: true, breakoutRoom: true } },
          },
        });
        if (discussion) {
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
          const payload = new TextEncoder().encode(
            JSON.stringify({
              type: "partial-cleared",
              streamId,
              revision,
              participantIdentity: user.id,
            }),
          );
          const sends = await Promise.allSettled(
            activeRooms.map((room) =>
              roomService.sendData(room.name, payload, DataPacket_Kind.RELIABLE, {
                topic: TRANSCRIPT_PARTIAL_TOPIC,
              }),
            ),
          );
          sends.forEach((result, index) => {
            if (result.status === "rejected") {
              transcriptWarn("live transcript draft clear failed", {
                discussionId: id,
                room: activeRooms[index]?.name,
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
              });
            }
          });
        }
      } catch (error) {
        transcriptWarn("could not publish live transcript draft clear", {
          discussionId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return ok({ deleted: true });
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
        endedAt: true,
        transcriptionEnabled: true,
        breakoutEnabled: true,
        conversationState: true,
        aiSpeakingUntil: true,
        lastAiSpokeAt: true,
        pausedAt: true,
        participants: { select: { isHost: true, breakoutRoom: true } },
      },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (discussion.status !== "LIVE" && discussion.status !== "COMPLETED") {
      return fail("Transcription is only captured while the discussion is live.", 409);
    }
    if (
      discussion.status === "COMPLETED" &&
      (!discussion.endedAt || Date.now() - discussion.endedAt.getTime() > 15 * 60_000)
    ) {
      return fail("The transcript submission window for this discussion has closed.", 409);
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
        micLocked: true,
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
    let confidence: number | null = null;
    let startedAt: Date;
    let endedAt: Date;
    let durationMs: number;
    let streamId: string | undefined;

    const requestContentType = request.headers.get("content-type") ?? "";
    if (requestContentType.startsWith("audio/")) {
      const declaredLength = Number(request.headers.get("content-length") ?? "");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_TRANSCRIPT_AUDIO_BYTES) {
        return fail("Audio chunk is too large.", 413);
      }

      const mimeType = requestContentType.split(";")[0]?.toLowerCase();
      if (!mimeType || !TRANSCRIPT_AUDIO_MIME_TYPES.has(mimeType)) {
        return fail("This audio format is not supported for transcription.", 415);
      }

      const metadata = transcriptAudioMetadataSchema.parse({
        startedAt: request.headers.get("x-transcript-started-at"),
        endedAt: request.headers.get("x-transcript-ended-at"),
        durationMs: request.headers.get("x-transcript-duration-ms"),
        language: request.headers.get("x-transcript-language") || undefined,
        streamId: request.headers.get("x-transcript-stream-id") || undefined,
        revision: request.headers.get("x-transcript-revision") || undefined,
        mode: request.headers.get("x-transcript-mode") || undefined,
      });

      // Prevent AI moderator speech or locked mics from being attributed as human speech.
      if (
        member.micLocked ||
        discussion.pausedAt ||
        (isAiSpeakingLocked(discussion, metadata.endedAt.getTime()) &&
          discussion.lastAiSpokeAt &&
          metadata.startedAt >= discussion.lastAiSpokeAt)
      ) {
        return ok({ skipped: "ai-speaking" });
      }

      const roomLimit = checkRateLimit(`transcript-audio-room:${id}`, 240, 60_000);
      if (!roomLimit.allowed) {
        return fail("Transcription is busy. Please retry shortly.", 429, {
          retryAfterMs: roomLimit.retryAfterMs,
        });
      }
      const participantLimit = checkRateLimit(`transcript-audio:${id}:${user.id}`, 45, 60_000);
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
      const sttProvider = getSttProvider();
      const sttInput = {
        audioBase64: audioBytes.toString("base64"),
        mimeType,
        language: metadata.language,
      };
      const sttResult = sttProvider.transcribeDetailed
        ? await sttProvider.transcribeDetailed(sttInput)
        : { text: await sttProvider.transcribe(sttInput), confidence: null };
      text = normalizeTranscript(sttResult.text);
      confidence = sttResult.confidence;
      if (!isMeaningful(text)) return ok({ skipped: "no-speech" });

      startedAt = metadata.startedAt;
      endedAt = metadata.endedAt;
      durationMs = metadata.durationMs;
      streamId = metadata.streamId;

      if (metadata.mode === "partial" && streamId) {
        const revision = metadata.revision ?? 0;
        const partialWhere = {
          participantId_streamId: { participantId: member.id, streamId },
        };
        const partialData = {
          discussionId: id,
          participantId: member.id,
          streamId,
          text,
          startedAt,
          endedAt: endedAt >= startedAt ? endedAt : new Date(),
          durationMs,
          wordCount: countWords(text),
          confidence,
          status: "PARTIAL" as const,
          revision,
        };
        const updated = await prisma.transcriptSegment.updateMany({
          where: {
            participantId: member.id,
            streamId,
            status: "PARTIAL",
            revision: { lte: revision },
          },
          data: partialData,
        });
        if (updated.count === 0) {
          const existing = await prisma.transcriptSegment.findUnique({ where: partialWhere });
          if (existing) {
            return ok({ stored: false, status: existing.status, text: existing.text });
          }
          await prisma.transcriptSegment.create({ data: partialData }).catch(() => null);
        }
        await prisma.discussionParticipant.update({
          where: { id: member.id },
          data: { transcribing: true, transcribingAt: new Date() },
        });
        if (livekitReady()) {
          try {
            const roomService = new RoomServiceClient(
              env.livekitHost,
              env.livekitApiKey,
              env.livekitApiSecret,
            );
            const expectedRooms = new Set([roomNameFor(id)]);
            if (discussion.breakoutEnabled) {
              for (const p of discussion.participants) {
                if (!p.isHost && p.breakoutRoom !== null) {
                  expectedRooms.add(roomNameFor(id, p.breakoutRoom));
                }
              }
            }
            const activeRooms = await roomService.listRooms([...expectedRooms]);
            const payload = new TextEncoder().encode(
              JSON.stringify({
                type: "partial",
                streamId,
                text,
                startedAt: startedAt.toISOString(),
                revision,
                participantIdentity: user.id,
                participantName: member.displayName,
              }),
            );
            await Promise.allSettled(
              activeRooms.map((room) =>
                roomService.sendData(room.name, payload, DataPacket_Kind.RELIABLE, {
                  topic: TRANSCRIPT_PARTIAL_TOPIC,
                }),
              ),
            );
          } catch {
            /* clients also poll */
          }
        }
        return ok({ stored: true, status: "PARTIAL", streamId, revision, text });
      }
    } else {
      const finalLimit = checkRateLimit(`transcript-final:${id}:${user.id}`, 120, 60_000);
      if (!finalLimit.allowed) {
        return fail("Transcription is busy. Please retry shortly.", 429, {
          retryAfterMs: finalLimit.retryAfterMs,
        });
      }
      const body = transcriptSegmentSchema.parse(await readJson(request));
      text = normalizeTranscript(body.text);
      confidence = typeof body.confidence === "number" ? body.confidence : null;
      startedAt = body.startedAt;
      endedAt = body.endedAt;
      durationMs = body.durationMs;
      streamId = body.streamId;
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

    const segmentSelect = {
      id: true,
      streamId: true,
      text: true,
      startedAt: true,
      endedAt: true,
      durationMs: true,
      wordCount: true,
      confidence: true,
      status: true,
      revision: true,
    };
    // Drop a re-delivered copy of the participant's previous utterance.
    const streamWhere = streamId
      ? {
          participantId_streamId: {
            participantId: member.id,
            streamId,
          },
        }
      : null;
    const streamedSegment = streamWhere
      ? await prisma.transcriptSegment.findUnique({ where: streamWhere, select: segmentSelect })
      : null;

    const previous = await prisma.transcriptSegment.findFirst({
      where: { discussionId: id, participantId: member.id, status: "FINAL" },
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

    if (!streamedSegment && previous && isDuplicateSegment(previous, text, startedAt)) {
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

    const segmentData = {
      discussionId: id,
      participantId: member.id,
      text,
      startedAt,
      endedAt,
      durationMs,
      wordCount: countWords(text),
      confidence,
      status: "FINAL" as const,
      streamId: streamId ?? null,
    };
    const segment =
      streamedSegment?.status === "FINAL"
        ? streamedSegment
        : streamId
      ? await prisma.transcriptSegment.upsert({
          where: {
            participantId_streamId: {
              participantId: member.id,
              streamId,
            },
          },
          create: segmentData,
          update: segmentData,
          select: segmentSelect,
        })
      : await prisma.transcriptSegment.create({
          data: segmentData,
          select: segmentSelect,
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
      const kind = classifyParticipantResponse(segment.text);
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
          status: "FINAL",
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
