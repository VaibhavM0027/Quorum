import { prisma } from "./prisma";
import { countWords, isDuplicateSegment, isMeaningful, normalizeTranscript } from "./transcript";
import { applyInvitationOutcome } from "./ai-assistant";
import { classifyParticipantResponse } from "./participation";
import { transcriptLog, transcriptWarn } from "./debug-log";

/**
 * Shared ingestion for spoken chunks, whatever produced them.
 *
 * A chunk can arrive two ways: transcribed by the speaker's own browser, or
 * recorded by their browser and transcribed on the server. Both must be
 * attached to the same participant, deduplicated the same way, logged the same
 * way, and — crucially — settle a pending invitation the same way. Keeping that
 * in one place means the two paths cannot drift apart, and a fix to the
 * accounting applies to both.
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

/** The speaker a chunk belongs to, or the reason it cannot be accepted. */
export type SpeakerCheck =
  | { ok: true; member: { id: string; displayName: string } }
  | { ok: false; status: number; error: string };

/**
 * Resolves the sender as a speaker in this discussion and checks every
 * precondition for storing their speech.
 *
 * The participant is derived from the session, never from the request body, so
 * no caller can attribute speech to anybody but themselves.
 */
export async function loadSpeaker(discussionId: string, userId: string): Promise<SpeakerCheck> {
  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: { id: true, status: true, transcriptionEnabled: true },
  });
  if (!discussion) return { ok: false, status: 404, error: "Discussion not found." };
  if (discussion.status !== "LIVE") {
    return {
      ok: false,
      status: 409,
      error: "Transcription is only captured while the discussion is live.",
    };
  }
  if (!discussion.transcriptionEnabled) {
    return { ok: false, status: 409, error: "Transcription is disabled for this discussion." };
  }

  const member = await prisma.discussionParticipant.findUnique({
    where: { discussionId_userId: { discussionId, userId } },
    select: { id: true, displayName: true, removed: true, transcriptionConsent: true },
  });
  if (!member) {
    transcriptWarn("chunk rejected: sender is not a member", { discussionId, userId });
    return { ok: false, status: 403, error: "Join the discussion before sending transcript data." };
  }
  if (member.removed) {
    transcriptWarn("chunk rejected: sender was removed", { participantId: member.id });
    return { ok: false, status: 403, error: "You were removed from this discussion." };
  }
  if (!member.transcriptionConsent) {
    transcriptWarn("chunk rejected: no consent recorded", {
      participantId: member.id,
      speaker: member.displayName,
    });
    return {
      ok: false,
      status: 403,
      error: "Transcription consent is required before your speech is recorded.",
    };
  }

  return { ok: true, member: { id: member.id, displayName: member.displayName } };
}

/**
 * Validates, deduplicates and stores one spoken chunk, then settles any
 * invitation it answers.
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
}): Promise<IngestOutcome> {
  const { discussionId, participant, startedAt, endedAt, durationMs, source } = params;

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

  transcriptLog("chunk stored", {
    segmentId: segment.id,
    participantId: participant.id,
    speaker: participant.displayName,
    source,
    words: segment.wordCount,
    durationMs: segment.durationMs,
    startedAt: segment.startedAt.toISOString(),
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
