"use client";

import {
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";

type HomeInteractiveCardStyle = CSSProperties & {
  "--home-card-delay": string;
};

type HomeInteractiveCardProps = {
  children: ReactNode;
  className?: string;
  revealDelay?: number;
};

export default function HomeInteractiveCard({
  children,
  className,
  revealDelay = 0,
}: HomeInteractiveCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const cardStyle: HomeInteractiveCardStyle = {
    "--home-card-delay": `${revealDelay}ms`,
  };

  useEffect(() => {
    const card = cardRef.current;
    if (!card || !("IntersectionObserver" in window)) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        card.dataset.revealed = "true";
        observer.unobserve(card);
      },
      { threshold: 0.12 },
    );

    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch") return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));

    event.currentTarget.style.setProperty("--home-card-x", `${x * 100}%`);
    event.currentTarget.style.setProperty("--home-card-y", `${y * 100}%`);
    event.currentTarget.style.setProperty("--home-card-tilt-x", `${(0.5 - y) * 2.4}deg`);
    event.currentTarget.style.setProperty("--home-card-tilt-y", `${(x - 0.5) * 2.4}deg`);
  }

  function handlePointerLeave(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.style.setProperty("--home-card-x", "50%");
    event.currentTarget.style.setProperty("--home-card-y", "50%");
    event.currentTarget.style.setProperty("--home-card-tilt-x", "0deg");
    event.currentTarget.style.setProperty("--home-card-tilt-y", "0deg");
  }

  return (
    <div
      ref={cardRef}
      className={`home-interactive-card ${className ?? ""}`}
      style={cardStyle}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      {children}
    </div>
  );
}
