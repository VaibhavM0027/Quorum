"use client";

import { useEffect, useState } from "react";

type TextTypeProps = {
  text: string[];
  typingSpeed?: number;
  pauseDuration?: number;
  deletingSpeed?: number;
  deleteMode?: "backspace";
  typeEffect?: "fade" | "none";
  mistakes?: number;
  cursorStyle?: "bar";
  cursorGlide?: boolean;
  showCursor?: boolean;
  className?: string;
};

export default function TextType({
  text,
  typingSpeed = 75,
  pauseDuration = 1500,
  deletingSpeed = 50,
  deleteMode = "backspace",
  typeEffect = "fade",
  mistakes = 0,
  cursorStyle = "bar",
  cursorGlide = false,
  showCursor = true,
  className,
}: TextTypeProps) {
  const [displayedText, setDisplayedText] = useState("");

  useEffect(() => {
    if (text.length === 0) return;

    let active = true;
    let timeout: ReturnType<typeof setTimeout>;
    let phraseIndex = 0;
    let position = 0;
    let deleting = false;
    let phrase = text[phraseIndex] ?? "";
    let mistakeAt = -1;
    let mistakeUsed = false;

    const chooseMistake = (value: string) => {
      if (Math.random() >= mistakes) return -1;
      const candidates = Array.from(value).flatMap((character, index) =>
        index > 0 && /[a-z]/i.test(character) ? [index] : [],
      );
      return candidates.length > 0
        ? candidates[Math.floor(Math.random() * candidates.length)] ?? -1
        : -1;
    };

    mistakeAt = chooseMistake(phrase);

    const tick = () => {
      if (!active) return;

      if (!deleting && position < phrase.length) {
        if (position === mistakeAt && !mistakeUsed) {
          mistakeUsed = true;
          const expected = phrase[position] ?? "";
          let wrong = String.fromCharCode(97 + Math.floor(Math.random() * 26));
          while (wrong === expected.toLowerCase()) {
            wrong = String.fromCharCode(97 + Math.floor(Math.random() * 26));
          }
          if (expected !== expected.toLowerCase()) wrong = wrong.toUpperCase();
          setDisplayedText(`${phrase.slice(0, position)}${wrong}`);
          timeout = setTimeout(() => {
            setDisplayedText(phrase.slice(0, position));
            timeout = setTimeout(tick, typingSpeed);
          }, typingSpeed);
          return;
        }

        position += 1;
        setDisplayedText(phrase.slice(0, position));
        timeout = setTimeout(tick, typingSpeed);
        return;
      }

      if (!deleting) {
        timeout = setTimeout(() => {
          deleting = true;
          tick();
        }, pauseDuration);
        return;
      }

      if (position > 0) {
        position -= 1;
        setDisplayedText(deleteMode === "backspace" ? phrase.slice(0, position) : "");
        timeout = setTimeout(tick, deletingSpeed);
        return;
      }

      phraseIndex = (phraseIndex + 1) % text.length;
      phrase = text[phraseIndex] ?? "";
      mistakeAt = chooseMistake(phrase);
      mistakeUsed = false;
      deleting = false;
      timeout = setTimeout(tick, typingSpeed);
    };

    setDisplayedText("");
    tick();

    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [deleteMode, deletingSpeed, mistakes, pauseDuration, text, typingSpeed]);

  return (
    <span aria-hidden="true" className={`block whitespace-pre-wrap ${className ?? ""}`}>
      {Array.from(displayedText).map((character, index) => (
        <span
          key={`${index}-${character}`}
          className={typeEffect === "fade" ? "animate-text-type-fade" : undefined}
        >
          {character}
        </span>
      ))}
      {showCursor && cursorStyle === "bar" && (
        <span
          key={displayedText.length}
          aria-hidden
          className={`ml-0.5 inline-block h-[0.9em] w-[2px] translate-y-[0.08em] bg-current align-baseline ${
            cursorGlide ? "animate-text-cursor-glide" : ""
          }`}
        />
      )}
    </span>
  );
}
