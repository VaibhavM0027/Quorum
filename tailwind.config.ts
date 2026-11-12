import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        panel: "var(--panel)",
        "panel-2": "var(--panel-2)",
        input: "var(--input)",
        line: "var(--border)",
        ink: "var(--text)",
        muted: "var(--muted)",
        accent: "var(--accent)",
        "accent-2": "var(--accent-2)",
        danger: "var(--danger)",
        warn: "var(--warn)",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
