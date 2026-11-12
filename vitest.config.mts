import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Test runner configuration.
 *
 * Tests target the pure, dependency-light building blocks of the platform
 * (rubric maths, transcript handling, rate limiting, validation, session
 * tokens, the report read model and PDF rendering), so they run fast and do
 * not need a database, LiveKit or a Gemini key.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    reporters: "default",
  },
});
