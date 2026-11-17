import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { inviteUrl, loadDiscussionForUser } from "@/lib/discussions";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import {
  ensureRoomOrchestrator,
  generateClosingSummary,
  postWelcomeAndTopicIntro,
  stopRoomOrchestrator,
} from "@/lib/ai-assistant";
import { ensureRoomSttWorker, stopRoomSttWorker } from "@/lib/livekit-stt-worker";
import {
  expireStaleAiSpeakingLock,
  isAiSpeakingLocked,
  isMeetingPaused,
  isRoomSttActive,
  syncRoomStateSnapshot,
} from "@/lib/room-sync";
import { updateDiscussionSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Full detail for a discussion the user hosts or has joined. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;

    await expireStaleAiSpeakingLock(id);

    const access = await loadDiscussionForUser(id, user.id);
    if (!access) return fail("Discussion not found, or you do not have access to it.", 404);

    const { discussion, isHost } = access;
    const aiSpeaking = isAiSpeakingLocked(discussion);
    const paused = isMeetingPaused(discussion);

    return ok({
      discussion: {
        id: discussion.id,
        title: discussion.title,
        topic: discussion.topic,
        context: discussion.context,
        rules: discussion.rules,
        status: discussion.status,
        mode: discussion.mode,
        joinCode: discussion.joinCode,
        inviteUrl: inviteUrl(discussion.joinCode),
        scheduledAt: discussion.scheduledAt,
        durationMin: discussion.durationMin,
        maxParticipants: discussion.maxParticipants,
        aiEnabled: discussion.aiEnabled,
        transcriptionEnabled: discussion.transcriptionEnabled,
        silencePromptSec: discussion.silencePromptSec,
        inviteResponseSec: discussion.inviteResponseSec,
        conversationState: discussion.conversationState,
        conversationStateAt: discussion.conversationStateAt,
        aiSpeaking,
        aiSpeakingUntil: discussion.aiSpeakingUntil,
        activeSpeakerId: discussion.activeSpeakerId,
        paused,
        serverSttActive: isRoomSttActive(discussion.id),
        welcomePosted: discussion.welcomePosted,
        summaryPosted: discussion.summaryPosted,
        breakoutEnabled: discussion.breakoutEnabled,
        breakoutGroupSize: discussion.breakoutGroupSize,
        startedAt: discussion.startedAt,
        endedAt: discussion.endedAt,
        host: discussion.host,
        isHost,
        participants: discussion.participants.map((p) => ({
          id: p.id,
          userId: p.userId,
          name: p.displayName,
          isHost: p.isHost,
          joinedAt: p.joinedAt,
          leftAt: p.leftAt,
          removed: p.removed,
          micLocked: p.micLocked,
          transcriptionConsent: p.transcriptionConsent,
          seatNumber: p.seatNumber,
          breakoutRoom: p.breakoutRoom,
        })),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Host controls: start, pause, resume, end, cancel or reopen a discussion. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const { action } = updateDiscussionSchema.parse(await readJson(request));

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: {
        id: true,
        hostId: true,
        status: true,
        mode: true,
        aiEnabled: true,
        transcriptionEnabled: true,
        welcomePosted: true,
        summaryPosted: true,
        startedAt: true,
      },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (discussion.hostId !== user.id) {
      return fail("Only the host can control this discussion.", 403);
    }

    const now = new Date();
    const data =
      action === "start"
        ? {
            status: "LIVE" as const,
            startedAt: discussion.startedAt ?? now,
            pausedAt: null,
            conversationState: "WAITING_FOR_PARTICIPANT",
            conversationStateAt: now,
          }
        : action === "pause"
          ? {
              pausedAt: now,
              aiSpeakingUntil: null,
              activeSpeakerId: null,
              conversationState: "MEETING_PAUSED",
              conversationStateAt: now,
            }
          : action === "resume"
            ? {
                pausedAt: null,
                conversationState: "WAITING_FOR_PARTICIPANT",
                conversationStateAt: now,
              }
            : action === "end"
              ? {
                  status: "COMPLETED" as const,
                  endedAt: now,
                  pausedAt: null,
                  aiSpeakingUntil: null,
                  activeSpeakerId: null,
                  conversationState: "MEETING_ENDED",
                  conversationStateAt: now,
                }
              : action === "cancel"
                ? {
                    status: "CANCELLED" as const,
                    endedAt: now,
                    pausedAt: null,
                    aiSpeakingUntil: null,
                    activeSpeakerId: null,
                    conversationState: "MEETING_ENDED",
                    conversationStateAt: now,
                  }
                : {
                    status: "LIVE" as const,
                    endedAt: null,
                    pausedAt: null,
                    conversationState: "WAITING_FOR_PARTICIPANT",
                    conversationStateAt: now,
                  };

    const updated = await prisma.discussion.update({ where: { id }, data });

    if (action === "start" || action === "reopen") {
      await prisma.discussionParticipant.updateMany({
        where: { discussionId: id, removed: false, joinedAt: null },
        data: { joinedAt: now },
      });
      if (discussion.transcriptionEnabled) {
        void ensureRoomSttWorker(id, null);
      }
      if (discussion.aiEnabled && discussion.mode === "AI_MODERATED" && !discussion.welcomePosted) {
        await postWelcomeAndTopicIntro(id).catch((err) =>
          console.error("[ai] welcome intro failed", err),
        );
      } else {
        await syncRoomStateSnapshot(id, { broadcast: true, syncMics: true });
      }
      if (discussion.aiEnabled) {
        ensureRoomOrchestrator(id);
      }
    } else if (action === "pause") {
      stopRoomOrchestrator(id);
      await syncRoomStateSnapshot(id, { broadcast: true, syncMics: true });
    } else if (action === "resume") {
      await syncRoomStateSnapshot(id, { broadcast: true, syncMics: true });
      if (discussion.aiEnabled) {
        ensureRoomOrchestrator(id);
      }
    } else if (action === "end" || action === "cancel") {
      stopRoomOrchestrator(id);
      await prisma.discussionParticipant.updateMany({
        where: { discussionId: id, leftAt: null },
        data: { leftAt: now, speakingSince: null },
      });
      await stopRoomSttWorker(id);
      await syncRoomStateSnapshot(id, { broadcast: true, syncMics: true });
      if (action === "end" && discussion.aiEnabled && !discussion.summaryPosted) {
        await generateClosingSummary(id).catch((err) =>
          console.error("[ai] closing summary failed", err),
        );
      }
    }

    return ok({
      status: updated.status,
      conversationState: updated.conversationState,
      paused: Boolean(updated.pausedAt),
      startedAt: updated.startedAt,
      endedAt: updated.endedAt,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
