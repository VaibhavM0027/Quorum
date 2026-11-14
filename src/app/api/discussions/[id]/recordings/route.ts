import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import { env } from "@/lib/env";
import { fail, handleRouteError, ok } from "@/lib/http";
import {
  DEFAULT_RECORDING_MIME,
  isSupportedRecordingMime,
  recordingDownloadUrl,
  recordingStorageKey,
  saveRecording,
} from "@/lib/recordings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_RECORDINGS = 50;

/**
 * Session recordings for a discussion.
 *
 * The recording itself is captured in the moderator's browser — the one client
 * every participant's audio reaches — and uploaded here when it ends, so the
 * session ends up as a single file rather than one clip per student. The
 * transcript of the same session is stored as `TranscriptSegment` rows and is
 * exported from the transcript endpoint.
 */

/** Lists the recordings a viewer may see, newest first. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const access = await loadDiscussionForUser(id, user.id);
    if (!access) return fail("Discussion not found, or you do not have access to it.", 404);

    const recordings = await prisma.recording.findMany({
      where: {
        discussionId: id,
        // A capture that is still running, or that failed, has no playable file.
        status: "READY",
      },
      orderBy: { startedAt: "desc" },
      take: MAX_RECORDINGS,
      select: {
        id: true,
        mimeType: true,
        byteSize: true,
        durationMs: true,
        startedAt: true,
        endedAt: true,
      },
    });

    return ok({
      recordings: recordings.map((recording) => ({
        ...recording,
        startedAt: recording.startedAt.toISOString(),
        endedAt: recording.endedAt?.toISOString() ?? null,
        url: recordingDownloadUrl(id, recording.id),
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Stores a finished recording. Only the host may upload: the capture runs in
 * the host's browser, and a participant must not be able to attach arbitrary
 * audio to the session record.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: { id: true, hostId: true, status: true },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (discussion.hostId !== user.id) {
      return fail("Only the host can store a recording of this discussion.", 403);
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > env.recordingMaxBytes) {
      return fail("That recording is larger than this server accepts.", 413);
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return fail("A `file` part is required.", 400);
    if (file.size === 0) return fail("The recording is empty.", 422);
    if (file.size > env.recordingMaxBytes) {
      return fail("That recording is larger than this server accepts.", 413);
    }

    const reportedMime = String(form.get("mimeType") ?? file.type ?? DEFAULT_RECORDING_MIME);
    const mimeType = isSupportedRecordingMime(reportedMime) ? reportedMime : DEFAULT_RECORDING_MIME;

    const startedAtRaw = String(form.get("startedAt") ?? "");
    const startedAt = startedAtRaw ? new Date(startedAtRaw) : new Date();
    const durationMs = Math.max(0, Math.round(Number(form.get("durationMs") ?? 0) || 0));

    const member = await prisma.discussionParticipant.findUnique({
      where: { discussionId_userId: { discussionId: id, userId: user.id } },
      select: { id: true },
    });

    const recording = await prisma.recording.create({
      data: {
        discussionId: id,
        capturedByParticipantId: member?.id ?? null,
        status: "RECORDING",
        mimeType,
        startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
      },
      select: { id: true, startedAt: true },
    });

    const storageKey = recordingStorageKey(id, recording.id, mimeType);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await saveRecording(storageKey, bytes);

      const saved = await prisma.recording.update({
        where: { id: recording.id },
        data: {
          status: "READY",
          storageKey,
          byteSize: bytes.byteLength,
          durationMs,
          endedAt: new Date(),
        },
        select: {
          id: true,
          mimeType: true,
          byteSize: true,
          durationMs: true,
          startedAt: true,
          endedAt: true,
        },
      });

      return ok(
        {
          recording: {
            ...saved,
            startedAt: saved.startedAt.toISOString(),
            endedAt: saved.endedAt?.toISOString() ?? null,
            url: recordingDownloadUrl(id, saved.id),
          },
        },
        201,
      );
    } catch (error) {
      // Record the failure rather than leaving a row that claims a file exists.
      const message = error instanceof Error ? error.message : "Could not store the recording";
      await prisma.recording.update({
        where: { id: recording.id },
        data: { status: "FAILED", endedAt: new Date(), error: message.slice(0, 500) },
      });
      console.error("[recordings]", error);
      return fail("The recording could not be stored on the server.", 500);
    }
  } catch (error) {
    return handleRouteError(error);
  }
}
