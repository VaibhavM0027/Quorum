"use client";

import { useState } from "react";
import PreJoinLobby, { type PreJoinResult } from "@/components/PreJoinLobby";
import RoomClient, { type RoomDiscussion } from "@/components/RoomClient";
import type { LivekitDevicePreferences } from "@/hooks/useLivekitRoom";

type RoomUser = { id: string; name: string; email: string; role: "HOST" | "PARTICIPANT" };

export default function RoomEntryClient({
  user,
  discussion,
  participantId,
}: {
  user: RoomUser;
  discussion: RoomDiscussion;
  participantId: string | null;
}) {
  const [preferences, setPreferences] = useState<LivekitDevicePreferences | null>(null);

  if (!preferences && (discussion.status === "SCHEDULED" || discussion.status === "LIVE")) {
    return (
      <PreJoinLobby
        discussionId={discussion.id}
        title={discussion.title}
        topic={discussion.topic}
        mode={discussion.mode}
        userName={user.name}
        transcriptionEnabled={discussion.transcriptionEnabled}
        initialConsent={
          discussion.participants.find((participant) => participant.id === participantId)
            ?.transcriptionConsent ?? false
        }
        onEnter={(result: PreJoinResult) =>
          setPreferences({
            microphoneId: result.audioDeviceId ?? "",
            cameraId: result.videoDeviceId ?? "",
            speakerId: "",
            cameraOn: result.camEnabled,
            microphoneOn: result.micEnabled,
          })
        }
      />
    );
  }

  return (
    <RoomClient
      user={user}
      discussion={discussion}
      participantId={participantId}
      devicePreferences={
        preferences ?? {
          microphoneId: "",
          cameraId: "",
          speakerId: "",
          cameraOn: false,
          microphoneOn: false,
        }
      }
    />
  );
}
