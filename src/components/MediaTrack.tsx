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
    const play = () => {
      const playPromise = element.play();
      if (playPromise) playPromise.catch(() => undefined);
    };
    play();
    track.addEventListener("unmute", play);

    return () => {
      track.removeEventListener("unmute", play);
      element.srcObject = null;
    };
  }, [track]);

  if (kind === "audio") {
    return <audio ref={ref as React.RefObject<HTMLAudioElement>} autoPlay playsInline />;
  }

  // Video elements are always muted so browsers never block remote video autoplay;
  // remote audio is rendered separately via dedicated <audio> elements.
  return (
    <video
      ref={ref as React.RefObject<HTMLVideoElement>}
      autoPlay
      playsInline
      muted={kind === "video" ? true : muted}
      className={className}
    />
  );
}
