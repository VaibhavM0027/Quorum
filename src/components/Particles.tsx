"use client";

import { useEffect, useRef } from "react";

type HoverEffect = "none" | "parallax";

type ParticlesProps = {
  particleColors?: string[];
  particleCount?: number;
  particleSpread?: number;
  speed?: number;
  particleBaseSize?: number;
  glow?: number;
  twinkle?: number;
  moveParticlesOnHover?: boolean;
  hoverEffect?: HoverEffect;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  phase: number;
  twinkleSpeed: number;
  depth: number;
  color: string;
};

export default function Particles({
  particleColors = ["#ffffff"],
  particleCount = 200,
  particleSpread = 10,
  speed = 0.2,
  particleBaseSize = 100,
  glow = 0.5,
  twinkle = 0.3,
  moveParticlesOnHover = true,
  hoverEffect = "parallax",
}: ParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const colors = particleColors.length > 0 ? particleColors : ["#ffffff"];
    const count = Math.max(0, Math.floor(particleCount));
    const sizeScale = Math.max(0.5, Math.min(particleBaseSize / 100, 2));
    const glowAmount = Math.max(0, Math.min(glow, 1));
    const twinkleAmount = Math.max(0, Math.min(twinkle, 1));
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const particles: Particle[] = Array.from({ length: count }, () => {
      const angle = Math.random() * Math.PI * 2;
      const color = colors[Math.floor(Math.random() * colors.length)] ?? "#ffffff";
      return {
        x: Math.random(),
        y: Math.random(),
        vx: Math.cos(angle),
        vy: Math.sin(angle),
        radius: 0.45 + Math.random() * sizeScale * 1.35,
        phase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.7 + Math.random() * 1.8,
        depth: 0.35 + Math.random() * 0.65,
        color,
      };
    });

    let width = 0;
    let height = 0;
    let pointerX = 0;
    let pointerY = 0;
    let lastFrame = 0;
    let frameId = 0;

    const resize = () => {
      const nextWidth = window.innerWidth;
      const nextHeight = window.innerHeight;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      width = nextWidth;
      height = nextHeight;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    const trackPointer = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
    };

    const draw = (timestamp: number) => {
      const delta = lastFrame ? Math.min((timestamp - lastFrame) / 1000, 0.05) : 0;
      lastFrame = timestamp;
      context.clearRect(0, 0, width, height);

      const hoverX =
        moveParticlesOnHover && hoverEffect === "parallax"
          ? ((pointerX / Math.max(width, 1)) - 0.5) * particleSpread
          : 0;
      const hoverY =
        moveParticlesOnHover && hoverEffect === "parallax"
          ? ((pointerY / Math.max(height, 1)) - 0.5) * particleSpread
          : 0;

      for (const particle of particles) {
        if (!reduceMotion) {
          particle.x += (particle.vx * speed * 28 * delta) / width;
          particle.y += (particle.vy * speed * 28 * delta) / height;
          if (particle.x < 0) particle.x += 1;
          if (particle.x > 1) particle.x -= 1;
          if (particle.y < 0) particle.y += 1;
          if (particle.y > 1) particle.y -= 1;
        }

        const shimmer = 1 - twinkleAmount + twinkleAmount * (0.5 + 0.5 * Math.sin(timestamp / 1000 * particle.twinkleSpeed + particle.phase));
        context.globalAlpha = 0.48 * shimmer;
        context.fillStyle = particle.color;
        context.shadowColor = particle.color;
        context.shadowBlur = particle.radius * glowAmount * 3;
        context.beginPath();
        context.arc(
          particle.x * width + hoverX * particle.depth,
          particle.y * height + hoverY * particle.depth,
          particle.radius,
          0,
          Math.PI * 2,
        );
        context.fill();
      }

      context.globalAlpha = 1;
      context.shadowBlur = 0;
      if (!reduceMotion) frameId = window.requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", trackPointer, { passive: true });
    frameId = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", trackPointer);
    };
  }, [
    glow,
    hoverEffect,
    moveParticlesOnHover,
    particleBaseSize,
    particleColors,
    particleCount,
    particleSpread,
    speed,
    twinkle,
  ]);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 mix-blend-difference opacity-40">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
