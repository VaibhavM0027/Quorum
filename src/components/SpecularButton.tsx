"use client";

import { useEffect } from "react";
import type { ButtonHTMLAttributes, CSSProperties } from "react";

type SpecularButtonStyle = CSSProperties & {
  "--specular-tint": string;
  "--specular-line": string;
  "--specular-fade": string;
  "--specular-size": string;
  "--specular-glow": number;
  "--specular-thickness": string;
  "--specular-radius": string;
};

type SpecularButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> & {
  size?: "sm" | "md" | "lg";
  radius?: number;
  tint?: string;
  tintOpacity?: number;
  textColor?: string;
  lineColor?: string;
  baseColor?: string;
  intensity?: number;
  idleIntensity?: number;
  shineSize?: number;
  shineFade?: number;
  thickness?: number;
  glow?: number;
  followMouse?: boolean;
  proximity?: number;
  style?: CSSProperties;
};

const sizeClasses = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-3 text-base",
};

export default function SpecularButton({
  size = "md",
  radius = 18,
  tint = "#ffffff",
  tintOpacity = 0.04,
  textColor = "#f5f5f5",
  lineColor = "#ffffff",
  baseColor = "#525252",
  intensity = 1,
  idleIntensity = 0.35,
  shineSize = 10,
  shineFade = 34,
  thickness = 1.2,
  glow = 1,
  followMouse = true,
  proximity = 250,
  type = "button",
  className,
  style,
  children,
  ...buttonProps
}: SpecularButtonProps) {
  const specularStyle: SpecularButtonStyle = {
    ...style,
    backgroundColor: baseColor,
    color: textColor,
    borderColor: lineColor,
    borderWidth: `${thickness}px`,
    borderRadius: `${radius}px`,
    "--specular-tint": tint,
    "--specular-line": lineColor,
    "--specular-fade": `${shineFade}%`,
    "--specular-size": `${shineSize}%`,
    "--specular-glow": glow,
    "--specular-thickness": `${thickness}px`,
    "--specular-radius": `${radius}px`,
  };

  return (
    <button
      {...buttonProps}
      type={type}
      className={`specular-button ${sizeClasses[size]} ${className ?? ""}`}
      style={specularStyle}
      data-specular-intensity={intensity}
      data-specular-idle-intensity={idleIntensity}
      data-specular-tint-opacity={tintOpacity}
      data-specular-proximity={proximity}
      data-specular-follow-mouse={followMouse}
    >
      {children}
    </button>
  );
}

export function SpecularButtonEffects() {
  useEffect(() => {
    const controls = () => document.querySelectorAll<HTMLElement>("button, .btn");
    let frame = 0;

    const updateControls = (pointerX: number, pointerY: number) => {
      for (const control of controls()) {
        const bounds = control.getBoundingClientRect();
        const x = Math.max(0, Math.min(bounds.width, pointerX - bounds.left));
        const y = Math.max(0, Math.min(bounds.height, pointerY - bounds.top));
        const distance = Math.hypot(pointerX - (bounds.left + x), pointerY - (bounds.top + y));
        const proximity = Number(control.dataset.specularProximity ?? 250);
        const intensity = Number(control.dataset.specularIntensity ?? 1);
        const idleIntensity = Number(control.dataset.specularIdleIntensity ?? 0.12);
        const tintOpacity = Number(control.dataset.specularTintOpacity ?? 0.18);
        const nearby = proximity > 0 ? Math.max(0, 1 - distance / proximity) : Number(distance === 0);
        const activity = idleIntensity + (intensity - idleIntensity) * nearby;

        control.style.setProperty(
          "--specular-x",
          control.dataset.specularFollowMouse === "false" || bounds.width === 0
            ? "50%"
            : `${(x / bounds.width) * 100}%`,
        );
        control.style.setProperty(
          "--specular-y",
          control.dataset.specularFollowMouse === "false" || bounds.height === 0
            ? "50%"
            : `${(y / bounds.height) * 100}%`,
        );
        control.style.setProperty("--specular-activity", String(activity));
        control.style.setProperty("--specular-opacity", `${tintOpacity * activity * 100}%`);
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => updateControls(event.clientX, event.clientY));
    };

    const resetControls = () => {
      for (const control of controls()) {
        const idleIntensity = Number(control.dataset.specularIdleIntensity ?? 0.12);
        const tintOpacity = Number(control.dataset.specularTintOpacity ?? 0.18);
        control.style.setProperty("--specular-x", "50%");
        control.style.setProperty("--specular-y", "50%");
        control.style.setProperty("--specular-activity", String(idleIntensity));
        control.style.setProperty("--specular-opacity", `${tintOpacity * idleIntensity * 100}%`);
      }
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerleave", resetControls);
    window.addEventListener("blur", resetControls);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", resetControls);
      window.removeEventListener("blur", resetControls);
    };
  }, []);

  return null;
}
