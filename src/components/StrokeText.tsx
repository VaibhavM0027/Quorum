import type { CSSProperties } from "react";

type StrokeTextProps = {
  text: string;
  strokeColor?: string;
  strokeStyle?: "solid" | "dashed";
  strokeWidth?: number;
  dashLength?: number;
  drawDuration?: number;
  fillDelay?: number;
  stagger?: number;
  ease?: "power2.out" | "ease-out" | "linear";
  trigger?: "mount" | "hover";
  fillMode?: "wipe" | "fade" | "none";
  wipeFrom?: "left" | "right";
  fontSize?: number;
  fontWeight?: number;
  letterSpacing?: number;
  marching?: boolean;
  hoverRedraw?: boolean;
  shadow?: boolean;
  fillColor?: string | null;
  shadowColor?: string | null;
  className?: string;
};

type StrokeTextStyle = CSSProperties & {
  "--stroke-color": string;
  "--stroke-width": string;
  "--stroke-dash-length": string;
  "--stroke-duration": string;
  "--stroke-ease": string;
  "--stroke-wipe-start": string;
  "--stroke-wipe-end": string;
  "--stroke-fill": string;
  "--stroke-shadow-color": string;
};

type StrokeCharacterStyle = CSSProperties & {
  "--stroke-character-delay": string;
  "--stroke-character-fill-delay": string;
};

const easing = {
  "power2.out": "cubic-bezier(0.16, 1, 0.3, 1)",
  "ease-out": "ease-out",
  linear: "linear",
};

export default function StrokeText({
  text,
  strokeColor = "#A78BFA",
  strokeStyle = "solid",
  strokeWidth = 1.4,
  dashLength = 10,
  drawDuration = 1.6,
  fillDelay = 0.2,
  stagger = 0.05,
  ease = "power2.out",
  trigger = "mount",
  fillMode = "wipe",
  wipeFrom = "left",
  fontSize = 128,
  fontWeight = 800,
  letterSpacing = -4,
  marching = false,
  hoverRedraw = false,
  shadow = false,
  fillColor = null,
  shadowColor = null,
  className,
}: StrokeTextProps) {
  const chars = Array.from(text);
  const classNames = [
    "stroke-text",
    `stroke-text--trigger-${trigger}`,
    `stroke-text--fill-${fillMode}`,
    `stroke-text--wipe-${wipeFrom}`,
    strokeStyle === "dashed" ? "stroke-text--dashed" : "",
    marching ? "stroke-text--marching" : "",
    hoverRedraw ? "stroke-text--hover-redraw" : "",
    shadow ? "stroke-text--shadow" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const style: StrokeTextStyle = {
    fontSize: `${fontSize}px`,
    fontWeight,
    letterSpacing: `${letterSpacing}px`,
    "--stroke-color": strokeColor,
    "--stroke-width": `${strokeWidth}px`,
    "--stroke-dash-length": `${dashLength}px`,
    "--stroke-duration": `${drawDuration}s`,
    "--stroke-ease": easing[ease],
    "--stroke-wipe-start":
      wipeFrom === "left" ? "inset(0 100% 0 0)" : "inset(0 0 0 100%)",
    "--stroke-wipe-end": "inset(0)",
    "--stroke-fill": fillColor ?? "currentColor",
    "--stroke-shadow-color": shadowColor ?? strokeColor,
  };

  return (
    <span className={classNames} style={style}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="stroke-text__visual">
        {chars.map((character, index) => {
          const characterStyle: StrokeCharacterStyle = {
            "--stroke-character-delay": `${index * stagger}s`,
            "--stroke-character-fill-delay": `${drawDuration + fillDelay + index * stagger}s`,
          };

          return (
            <span
              key={`${index}-${character}`}
              className="stroke-text__character"
              style={characterStyle}
            >
              <span className="stroke-text__outline">
                {character === " " ? "\u00a0" : character}
              </span>
              <span className="stroke-text__fill">{character === " " ? "\u00a0" : character}</span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
