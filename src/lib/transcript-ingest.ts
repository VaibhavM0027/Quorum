import { prisma } from "./prisma";
import { countWords, isDuplicateSegment, isMeaningful, normalizeTranscript } from "./transcript";
import { applyInvitationOutcome } from "./ai-assistant";
import { classifyParticipantResponse } from "./participation";
import { transcriptLog, transcriptWarn } from "./debug-log";

/**
 * Shared ingestion for spoken chunks.
 *
 * There is one producer: the LiveKit agent worker, which subscribes to every
 * participant's microphone and transcribes each track on its own. It reaches
 * the database through here so that attribution, deduplication, logging,
 * participant activity and — crucially — settling a pending invitation all
 * stay in one place rather than being re-implemented beside the audio code.
 */

/** Stored segment shape returned to a caller. */
export type StoredSegmentDto = {
  id: string;
  text: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  wordCount: number;
};

export type IngestOutcome =
  | { ok: true; duplicate: boolean; segment: StoredSegmentDto }
  | { ok: false; status: number; error: string };

/**
 * Validates, deduplicates and stores one spoken chunk, then settles any
 * invitation it answers.
 *
 * The speaker is passed in rather than derived from a request, so this stays a
 * storage function: only the caller that owns the audio can say whose it is.
 */
export async function ingestTranscriptChunk(params: {
  discussionId: string;
  participant: { id: string; displayName: string };
  text: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  /** Where the text came from. Only used to name the log line. */
  source: "browser" | "server";
  /**
   * Where the audio was captured, so a stored segment can be traced back to
   * the exact LiveKit room, identity and track it came from. Omitted by
   * callers that have no audio capture behind them.
   */
  origin?: { roomId: string; participantIdentity: string; trackId: string };
}): Promise<IngestOutcome> {
  const { discussionId, participant, startedAt, endedAt, durationMs, source, origin } = params;

  const text = normalizeTranscript(params.text);
  if (!isMeaningful(text)) {
    transcriptWarn("chunk rejected: no spoken content", {
      participantId: participant.id,
      speaker: participant.displayName,
      source,
    });
    return { ok: false, status: 422, error: "Transcript chunk has no spoken content." };
  }

  // Drop a re-delivered copy of the participant's previous utterance. The
  // server-transcribed path can genuinely produce one: a retried clip covers
  // the same seconds of speech as the attempt it repeats.
  const previous = await prisma.transcriptSegment.findFirst({
    where: { discussionId, participantId: participant.id },
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
      participantId: participant.id,
      speaker: participant.displayName,
      source,
      startedAt: startedAt.toISOString(),
    });
    return {
      ok: true,
      duplicate: true,
      segment: {
        ...previous,
        startedAt: previous.startedAt.toISOString(),
        endedAt: previous.endedAt.toISOString(),
      },
    };
  }

  const segment = await prisma.transcriptSegment.create({
    data: {
      discussionId,
      participantId: participant.id,
      roomId: origin?.roomId ?? "",
      participantIdentity: origin?.participantIdentity ?? "",
      trackId: origin?.trackId ?? "",
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
    where: { id: participant.id },
    data: { lastAudioAt: spokeAt },
  });

  transcriptLog("transcript stored in PostgreSQL", {
    segmentId: segment.id,
    roomId: origin?.roomId ?? "",
    participantId: participant.id,
    participantIdentity: origin?.participantIdentity ?? "",
    participantName: participant.displayName,
    trackId: origin?.trackId ?? "",
    transcriptText: segment.text,
    startedAt: segment.startedAt.toISOString(),
    endedAt: segment.endedAt.toISOString(),
    durationMs: segment.durationMs,
    words: segment.wordCount,
    source,
  });

  // If the moderator is waiting on this participant, their answer is settled
  // here rather than on the next tick, so the room's countdown stops the
  // moment the floor is taken — or, if they asked to be excused, the moment
  // they say so.
  const pendingInvite = await prisma.invitation.findFirst({
    where: { discussionId, participantId: participant.id, status: "PENDING" },
    select: { id: true },
  });
  if (pendingInvite) {
    const kind = classifyParticipantResponse(text);
    await applyInvitationOutcome({
      invitationId: pendingInvite.id,
      participantId: participant.id,
      kind: kind === "pass" ? "pass" : kind === "technical" ? "technical" : "answered",
      segmentId: segment.id,
      now: spokeAt.getTime(),
    });
  }

  return {
    ok: true,
    duplicate: false,
    segment: {
      ...segment,
      startedAt: segment.startedAt.toISOString(),
      endedAt: segment.endedAt.toISOString(),
    },
  };
}
