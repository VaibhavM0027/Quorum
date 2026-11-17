import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { loadDiscussionForUser } from "@/lib/discussions";
import { env } from "@/lib/env";
import { isAiSpeakingLocked, isMeetingPaused, isRoomSttActive } from "@/lib/room-sync";
import RoomClient, { type RoomDiscussion } from "@/components/RoomClient";

export const dynamic = "force-dynamic";

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSession();
  const { id } = await params;
  if (!user) redirect(`/login?next=${encodeURIComponent(`/room/${id}`)}`);

  const access = await loadDiscussionForUser(id, user.id);
  if (!access) notFound();

  const { discussion, isHost } = access;
  const me = discussion.participants.find((p) => p.userId === user.id);

  const payload: RoomDiscussion = {
    id: discussion.id,
    title: discussion.title,
    topic: discussion.topic,
    context: discussion.context,
    rules: discussion.rules,
    status: discussion.status,
    mode: discussion.mode,
    joinCode: discussion.joinCode,
    durationMin: discussion.durationMin,
    maxParticipants: discussion.maxParticipants,
    aiEnabled: discussion.aiEnabled && env.aiEnabled,
    transcriptionEnabled: discussion.transcriptionEnabled,
    silencePromptSec: discussion.silencePromptSec,
    inviteResponseSec: discussion.inviteResponseSec,
    conversationState: discussion.conversationState,
    aiSpeaking: isAiSpeakingLocked(discussion),
    paused: isMeetingPaused(discussion),
    activeSpeakerId: discussion.activeSpeakerId,
    serverSttActive: isRoomSttActive(discussion.id),
    breakoutEnabled: discussion.breakoutEnabled,
    breakoutGroupSize: discussion.breakoutGroupSize,
    scheduledAt: discussion.scheduledAt.toISOString(),
    startedAt: discussion.startedAt?.toISOString() ?? null,
    endedAt: discussion.endedAt?.toISOString() ?? null,
    hostName: discussion.host.name,
    isHost,
    participants: discussion.participants.map((p) => ({
      id: p.id,
      userId: p.userId,
      name: p.displayName,
      isHost: p.isHost,
      joinedAt: p.joinedAt?.toISOString() ?? null,
      leftAt: p.leftAt?.toISOString() ?? null,
      removed: p.removed,
      micLocked: p.micLocked,
      transcriptionConsent: p.transcriptionConsent,
      seatNumber: p.seatNumber,
      breakoutRoom: p.breakoutRoom,
    })),
  };

  return <RoomClient user={user} discussion={payload} participantId={me?.id ?? null} />;
}
