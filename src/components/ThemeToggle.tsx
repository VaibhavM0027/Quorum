"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import SpecularButton from "@/components/SpecularButton";

type Theme = "light" | "dark";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const savedTheme = document.documentElement.dataset.theme;
    if (savedTheme === "dark") setTheme("dark");
  }, []);

  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = nextTheme;
    setTheme(nextTheme);
    try {
      window.localStorage.setItem("quorum-theme", nextTheme);
    } catch {
      // The selected theme still applies when browser storage is unavailable.
    }
  }

  const nextTheme = theme === "light" ? "dark" : "light";

  return (
    <SpecularButton
      className="btn-ghost"
      baseColor="transparent"
      textColor="var(--text)"
      lineColor="var(--border)"
      tintOpacity={0.12}
      glow={0.45}
      radius={8}
      onClick={toggleTheme}
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
    >
      {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
      <span className="hidden sm:inline">{theme === "light" ? "Dark mode" : "Light mode"}</span>
    </SpecularButton>
  );
}
