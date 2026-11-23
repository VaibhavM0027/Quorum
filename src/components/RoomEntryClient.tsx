"use client";

import { useEffect, useState } from "react";
import DeviceCheck, { type RoomDevicePreferences } from "@/components/DeviceCheck";
import RoomClient, { type RoomDiscussion } from "@/components/RoomClient";
import { Loader2 } from "lucide-react";

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
  const [preferences, setPreferences] = useState<RoomDevicePreferences | null>(null);
  const [restoringPreferences, setRestoringPreferences] = useState(true);

  useEffect(() => {
    const key = `quorum-device-preferences:${discussion.id}`;
    try {
      const saved = sessionStorage.getItem(key);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<RoomDevicePreferences>;
        if (
          typeof parsed.microphoneId === "string" &&
          typeof parsed.cameraId === "string" &&
          typeof parsed.speakerId === "string" &&
          typeof parsed.cameraOn === "boolean"
        ) {
          setPreferences({
            microphoneId: parsed.microphoneId,
            cameraId: parsed.cameraId,
            speakerId: parsed.speakerId,
            cameraOn: parsed.cameraOn,
          });
        }
        sessionStorage.removeItem(key);
      }
    } catch {
      // Re-run the check when this browser cannot read temporary tab storage.
    } finally {
      setRestoringPreferences(false);
    }
  }, [discussion.id]);

  if (restoringPreferences) {
    return (
      <main className="grid min-h-dvh place-items-center text-sm text-muted" role="status">
        <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Preparing your device check…</span>
      </main>
    );
  }
  if (!preferences) {
    return (
      <DeviceCheck
        title={discussion.title}
        topic={discussion.topic}
        onContinue={setPreferences}
      />
    );
  }

  return (
    <RoomClient
      user={user}
      discussion={discussion}
      participantId={participantId}
      devicePreferences={preferences}
    />
  );
}
