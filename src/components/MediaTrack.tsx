"use client";

import { useEffect, useRef } from "react";

/**
 * Attaches a raw MediaStreamTrack to a <video> or <audio> element.
 * LiveKit gives us tracks (not streams), so each element needs its own stream.
 */
export default function MediaTrack({
  track,
  kind,
  muted = false,
  className,
}: {
  track: MediaStreamTrack | null;
  kind: "video" | "audio";
  muted?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    if (!track) {
      element.srcObject = null;
      return;
    }

    element.srcObject = new MediaStream([track]);
    const playPromise = element.play();
    if (playPromise) playPromise.catch(() => undefined);

    return () => {
      element.srcObject = null;
    };
  }, [track]);

  if (kind === "audio") {
    return <audio ref={ref as React.RefObject<HTMLAudioElement>} autoPlay playsInline />;
  }

  return (
    <video
      ref={ref as React.RefObject<HTMLVideoElement>}
      autoPlay
      playsInline
      muted={muted}
      className={className}
    />
  );
}
