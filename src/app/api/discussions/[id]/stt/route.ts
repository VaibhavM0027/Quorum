import { requireSession } from "@/lib/auth";
import { fail, handleRouteError, ok } from "@/lib/http";
import { ingestTranscriptChunk, loadSpeaker } from "@/lib/transcript-ingest";
import { MAX_CLIP_BYTES, sttAvailable, transcribeAudioClip } from "@/lib/stt";
import { checkRateLimit } from "@/lib/rate-limit";
import { transcriptLog, transcriptWarn } from "@/lib/debug-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/** Longest clip we will attribute to a single utterance, in milliseconds. */
const MAX_CLIP_MS = 60_000;

/** Clips per participant per minute. Well above a natural speaking cadence. */
const CLIPS_PER_MINUTE = 20;

/**
 * Transcribes a short recording of the signed-in participant's microphone.
 *
 * This is the fallback for browsers without the Web Speech API (Firefox,
 * Safari): they cannot transcribe their own microphone, so they record clips
 * and post them here, and the server does the speech to text. It is not a
 * host-only path — every participant who needs it uses it, and the speaker is
 * resolved from the session, never from the request, so a clip can only ever be
 * attributed to the person who recorded it.
 *
 * The body is the raw audio (WAV): sending it as base64 JSON would inflate it
 * by a third and run into the JSON body limit. The timing the browser measured
 * travels in headers, so the stored segment keeps the speaker's real start time
 * rather than the moment the server happened to receive it.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    const speaker = await loadSpeaker(id, user.id);
    if (!speaker.ok) return fail(speaker.error, speaker.status);

    if (!sttAvailable()) {
      transcriptWarn("server transcription requested but not configured", {
        discussionId: id,
        participantId: speaker.member.id,
      });
      return fail("Server-side transcription is not configured.", 503);
    }

    // Each clip costs a model call, so a runaway client must not be able to
    // drain the quota for the whole room.
    const limit = checkRateLimit(`stt:${speaker.member.id}`, CLIPS_PER_MINUTE, 60_000);
    if (!limit.allowed) {
      transcriptWarn("server transcription rate limited", {
        participantId: speaker.member.id,
        speaker: speaker.member.displayName,
      });
      return fail("Too many audio clips were sent. Please slow down.", 429);
    }

    const buffer = new Uint8Array(await request.arrayBuffer());
    if (buffer.byteLength === 0) return fail("The audio clip is empty.", 422);
    if (buffer.byteLength > MAX_CLIP_BYTES) {
      transcriptWarn("server transcription clip too large", {
        participantId: speaker.member.id,
        bytes: buffer.byteLength,
      });
      return fail("That audio clip is too large to transcribe.", 413);
    }

    const timing = readTiming(request.headers);
    const mimeType = request.headers.get("content-type") ?? "audio/wav";

    transcriptLog("server transcription clip received", {
      participantId: speaker.member.id,
      speaker: speaker.member.displayName,
      bytes: buffer.byteLength,
      durationMs: timing.durationMs,
    });

    const text = await transcribeAudioClip({ data: buffer, mimeType });

    // Silence is a normal outcome: there is simply nothing to store, and it is
    // not an error the participant needs to see.
    if (!text) {
      transcriptLog("server transcription found no speech", {
        participantId: speaker.member.id,
        speaker: speaker.member.displayName,
      });
      return ok({ segment: null, duplicate: false, text: "" });
    }

    const result = await ingestTranscriptChunk({
      discussionId: id,
      participant: speaker.member,
      text,
      startedAt: timing.startedAt,
      endedAt: new Date(timing.startedAt.getTime() + timing.durationMs),
      durationMs: timing.durationMs,
      source: "server",
    });
    if (!result.ok) return fail(result.error, result.status);

    return ok(
      { segment: result.segment, duplicate: result.duplicate, text: result.segment.text },
      result.duplicate ? 200 : 201,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Reads the timings the browser measured for the clip.
 *
 * A malformed or missing header falls back to a sane value instead of rejecting
 * the clip: an utterance that was genuinely spoken is worth keeping even if its
 * timing is approximate, and the clip's own duration is a good proxy.
 */
function readTiming(headers: Headers): { startedAt: Date; durationMs: number } {
  const rawDuration = Number(headers.get("x-clip-duration-ms") ?? "");
  const durationMs =
    Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.min(Math.round(rawDuration), MAX_CLIP_MS)
      : 0;

  const rawStarted = headers.get("x-clip-started-at");
  const parsed = rawStarted ? new Date(rawStarted) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return { startedAt: parsed, durationMs };
  }
  return { startedAt: new Date(Date.now() - durationMs), durationMs };
}
