import { z } from "zod";

/**
 * Central, validated environment configuration.
 * Import this instead of reading `process.env` directly so that a missing or
 * malformed variable fails loudly at startup rather than at request time.
 *
 * Server-only: never import this module from a client component.
 */

const DEV_FALLBACK_JWT_SECRET =
  "quorum-ai-studio-dev-fallback-jwt-secret-please-set-in-env";

const schema = z.object({
  DATABASE_URL: z.string().optional().default(""),
  JWT_SECRET: z
    .string()
    .optional()
    .transform((v) => (v && v.length >= 32 ? v : DEV_FALLBACK_JWT_SECRET)),
  APP_URL: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  TRUST_PROXY: z.string().optional().default("off"),
  COOKIE_SECURE: z.string().optional().default(""),

  AI_ENABLED: z.string().optional().default("off"),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_FLASH_API_KEY: z.string().optional().default(""),
  GEMINI_BASE_URL: z.string().default("https://generativelanguage.googleapis.com"),
  GEMINI_FAST_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_SMART_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  AI_MAX_CALLS_PER_ROOM: z.coerce.number().int().min(0).default(600),

  RUBRIC_WEIGHTS: z.string().default("25,20,20,15,10,10"),
  REPORT_VISIBILITY: z.string().optional().default("own"),

  /** Directory the session recordings are written to, relative to the app root or absolute. */
  RECORDING_DIR: z.string().optional().default("data/recordings"),
  /** Largest single recording accepted, in mebibytes. */
  RECORDING_MAX_MB: z.coerce.number().positive().default(200),

  LIVEKIT_HOST: z.string().default("http://127.0.0.1:7880"),
  LIVEKIT_API_KEY: z.string().optional().default(""),
  LIVEKIT_API_SECRET: z.string().optional().default(""),
  LIVEKIT_URL: z.string().optional().default(""),

  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASSWORD: z.string().optional().default(""),
  SMTP_FROM: z.string().default("Quorum <noreply@localhost>"),

  SEED_HOST_EMAIL: z.string().optional().default("host@quorum.local"),
  SEED_HOST_NAME: z.string().optional().default("Discussion Host"),
  SEED_PARTICIPANT_EMAIL: z.string().optional().default("participant@quorum.local"),
  SEED_PARTICIPANT_NAME: z.string().optional().default("Demo Participant"),
  SEED_PASSWORD: z.string().optional().default(""),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `Invalid environment configuration:\n${issues}\n\nFix your .env file — see .env.example for the full list.`,
  );
}

const raw = parsed.data;

const DEFAULT_RUBRIC_WEIGHTS = [25, 20, 20, 15, 10, 10];

function parseWeights(value: string): number[] {
  const weights = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return weights.length === 6 ? weights : DEFAULT_RUBRIC_WEIGHTS;
}

const geminiKey = raw.GEMINI_FLASH_API_KEY || raw.GEMINI_API_KEY;

export const env = {
  databaseUrl: raw.DATABASE_URL,
  jwtSecret: raw.JWT_SECRET,
  appUrl: (
    // Render exposes the service's public origin as RENDER_EXTERNAL_URL, so
    // invite links are correct without hardcoding the hostname. APP_URL still
    // wins when set, which is what a custom domain needs.
    raw.APP_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, ""),
  port: raw.PORT,
  trustProxy: raw.TRUST_PROXY === "on",
  cookieSecure: raw.COOKIE_SECURE === "1" || raw.COOKIE_SECURE.toLowerCase() === "true",
  isProd: process.env.NODE_ENV === "production",

  /** AI is available only when enabled AND a key is present. */
  aiEnabled: raw.AI_ENABLED !== "off" && Boolean(geminiKey),
  geminiKey,
  geminiBaseUrl: raw.GEMINI_BASE_URL,
  geminiFastModel: raw.GEMINI_FAST_MODEL,
  geminiSmartModel: raw.GEMINI_SMART_MODEL,
  geminiConcurrency: raw.GEMINI_CONCURRENCY,
  aiMaxCallsPerRoom: raw.AI_MAX_CALLS_PER_ROOM,

  rubricWeights: parseWeights(raw.RUBRIC_WEIGHTS),
  reportVisibility: raw.REPORT_VISIBILITY === "all" ? "all" : "own",

  recordingDir: raw.RECORDING_DIR,
  recordingMaxBytes: Math.round(raw.RECORDING_MAX_MB * 1024 * 1024),

  livekitHost: raw.LIVEKIT_HOST,
  livekitApiKey: raw.LIVEKIT_API_KEY,
  livekitApiSecret: raw.LIVEKIT_API_SECRET,
  livekitUrl: raw.LIVEKIT_URL,
  livekitConfigured: Boolean(raw.LIVEKIT_API_KEY && raw.LIVEKIT_API_SECRET),

  smtpConfigured: Boolean(raw.SMTP_HOST),
  smtp: {
    host: raw.SMTP_HOST,
    port: raw.SMTP_PORT,
    user: raw.SMTP_USER,
    password: raw.SMTP_PASSWORD,
    from: raw.SMTP_FROM,
  },

  seed: {
    hostEmail: raw.SEED_HOST_EMAIL.toLowerCase(),
    hostName: raw.SEED_HOST_NAME,
    participantEmail: raw.SEED_PARTICIPANT_EMAIL.toLowerCase(),
    participantName: raw.SEED_PARTICIPANT_NAME,
    password: raw.SEED_PASSWORD,
  },
} as const;

export type Env = typeof env;
