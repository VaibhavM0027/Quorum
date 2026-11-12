/**
 * Vitest global setup.
 *
 * `src/lib/env.ts` validates and freezes the environment on first import, so
 * the required variables must be present before any test module is loaded.
 * These values are throwaway defaults for the test process only; nothing here
 * connects to a real database or AI service. Vitest sets NODE_ENV to "test".
 */

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/quorum_test";
process.env.JWT_SECRET ??= "test-only-jwt-secret-value-with-enough-length";
process.env.AI_ENABLED ??= "off";
process.env.COOKIE_SECURE ??= "";
process.env.RUBRIC_WEIGHTS ??= "25,20,20,15,10,10";
process.env.REPORT_VISIBILITY ??= "own";
