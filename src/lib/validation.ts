import { z } from "zod";

/** Pragmatic email check — identical result across Zod versions. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailSchema = z
  .string()
  .trim()
  .min(3, "Email is required")
  .max(254)
  .regex(EMAIL_PATTERN, "Enter a valid email address")
  .transform((value) => value.toLowerCase());

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(200, "Password is too long");

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required").max(200),
});

export const provisionSchema = z.object({
  password: passwordSchema,
});

// ---------------------------------------------------------------------------
// Discussions
// ---------------------------------------------------------------------------

export const createDiscussionSchema = z.object({
  title: z.string().trim().min(3, "Give the discussion a title").max(120),
  topic: z.string().trim().min(5, "Describe the topic").max(300),
  context: z.string().trim().max(4000).default(""),
  rules: z.string().trim().max(4000).default(""),
  scheduledAt: z.coerce.date().optional(),
  durationMin: z.coerce.number().int().min(5).max(180).default(30),
  maxParticipants: z.coerce.number().int().min(2).max(30).default(8),
  mode: z.enum(["FREE_FLOW", "AI_MODERATED"]).default("AI_MODERATED"),
  aiEnabled: z.coerce.boolean().default(true),
  transcriptionEnabled: z.coerce.boolean().default(true),
  silencePromptSec: z.coerce.number().int().min(10).max(300).default(30),
});

export const updateDiscussionSchema = z.object({
  action: z.enum(["start", "end", "cancel", "reopen"]),
});

export const joinDiscussionSchema = z.object({
  code: z
    .string()
    .trim()
    .min(4, "Enter the join code")
    .max(12)
    .transform((value) => value.toUpperCase()),
  displayName: z.string().trim().max(80).optional(),
});

// ---------------------------------------------------------------------------
// Live transcription
// ---------------------------------------------------------------------------

export const consentSchema = z.object({
  consent: z.coerce.boolean(),
});

export const transcriptSegmentSchema = z.object({
  text: z.string().trim().min(1, "Transcript chunk is empty").max(2000),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  durationMs: z.coerce.number().int().min(0).max(600_000).default(0),
});

// ---------------------------------------------------------------------------
// Host room controls
// ---------------------------------------------------------------------------

export const participantControlSchema = z.object({
  action: z.enum(["lock-mic", "unlock-mic", "remove", "restore"]),
});
