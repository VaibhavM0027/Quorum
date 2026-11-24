import { prisma } from "@/lib/prisma";
import { generateClosingSummary, stopRoomOrchestrator } from "@/lib/ai-assistant";
import { stopRoomSttWorker } from "@/lib/livekit-stt-worker";
import { syncRoomStateSnapshot } from "@/lib/room-sync";
import { syncRoomPermissions } from "@/lib/turns";

export function meetingEndsAt(startedAt: Date, durationMin: number): Date {
  return new Date(startedAt.getTime() + durationMin * 60_000);
}

/** Ends overdue live meetings when an active room client next contacts the server. */
export async function expireMeetingIfNeeded(
  discussionId: string,
  now = new Date(),
): Promise<boolean> {
  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      id: true,
      status: true,
      startedAt: true,
      durationMin: true,
      aiEnabled: true,
      summaryPosted: true,
    },
  });
  if (!discussion || discussion.status !== "LIVE" || !discussion.startedAt) return false;

  const endedAt = meetingEndsAt(discussion.startedAt, discussion.durationMin);
  if (endedAt > now) return false;

  const ended = await prisma.discussion.updateMany({
    where: {
      id: discussionId,
      status: "LIVE",
      startedAt: discussion.startedAt,
      durationMin: discussion.durationMin,
    },
    data: {
      status: "COMPLETED",
      endedAt,
      pausedAt: null,
      aiSpeakingUntil: null,
      activeSpeakerId: null,
      conversationState: "MEETING_ENDED",
      conversationStateAt: endedAt,
      turnState: "IDLE",
      activeTurnParticipantId: null,
      turnStartedAt: null,
      turnEndsAt: null,
      activeAiSpeechEventId: null,
      aiSpeechDeadlineAt: null,
    },
  });
  if (ended.count === 0) return false;

  await prisma.discussionParticipant.updateMany({
    where: { discussionId, leftAt: null },
    data: { leftAt: endedAt, speakingSince: null },
  });
  await prisma.$transaction([
    prisma.turnRequest.updateMany({
      where: { discussionId, status: { in: ["REQUESTED", "GRANTED"] } },
      data: { status: "CANCELLED", finishedAt: endedAt },
    }),
    prisma.invitation.updateMany({
      where: { discussionId, status: "PENDING" },
      data: { status: "WITHDRAWN", respondedAt: endedAt },
    }),
  ]);

  stopRoomOrchestrator(discussionId);
  await stopRoomSttWorker(discussionId);
  await syncRoomStateSnapshot(discussionId, { broadcast: true, syncMics: true });
  await syncRoomPermissions(discussionId);

  if (discussion.aiEnabled && !discussion.summaryPosted) {
    await generateClosingSummary(discussionId).catch((error) => {
      console.error("[ai] closing summary failed after meeting expiry", error);
    });
  }

  return true;
}
