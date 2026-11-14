import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import { fail, handleRouteError, ok } from "@/lib/http";
import { loadRecording, parseByteRange, removeRecording } from "@/lib/recordings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; recordingId: string }> };

/**
 * Streams, and lets the host delete, one stored session recording.
 *
 * Access is the same as the transcript: the recording is the shared record of
 * the session, so everyone in the discussion may play it back.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id, recordingId } = await params;

    const access = await loadDiscussionForUser(id, user.id);
    if (!access) return fail("Discussion not found, or you do not have access to it.", 404);

    const recording = await prisma.recording.findFirst({
      where: { id: recordingId, discussionId: id, status: "READY" },
      select: { id: true, storageKey: true, mimeType: true, byteSize: true },
    });
    if (!recording || !recording.storageKey) return fail("Recording not found.", 404);

    const bytes = await loadRecording(recording.storageKey);
    if (!bytes) return fail("The recording file is no longer on the server.", 410);

    const total = bytes.byteLength;
    const range = parseByteRange(request.headers.get("range"), total);
    const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;

    return new Response(new Uint8Array(body), {
      status: range ? 206 : 200,
      headers: {
        "content-type": recording.mimeType || "audio/webm",
        "content-length": String(body.byteLength),
        "accept-ranges": "bytes",
        ...(range
          ? { "content-range": `bytes ${range.start}-${range.end}/${total}` }
          : {}),
        // A recording is private to the discussion, so nothing may cache it.
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Deletes a recording: the file first, then the row that points at it. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id, recordingId } = await params;

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: { hostId: true },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (discussion.hostId !== user.id) {
      return fail("Only the host can delete a recording.", 403);
    }

    const recording = await prisma.recording.findFirst({
      where: { id: recordingId, discussionId: id },
      select: { id: true, storageKey: true },
    });
    if (!recording) return fail("Recording not found.", 404);

    if (recording.storageKey) await removeRecording(recording.storageKey);
    await prisma.recording.delete({ where: { id: recording.id } });

    return ok({ deleted: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
