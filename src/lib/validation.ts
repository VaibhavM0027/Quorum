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
  /**
   * How long the room may stay quiet before the moderator acts. Around six
   * seconds is the sweet spot: long enough that a thinking pause is never
   * mistaken for the end of a turn, short enough that a dead room is picked up
   * before the discussion stalls.
   */
  silencePromptSec: z.coerce.number().int().min(4).max(300).default(6),
  /** How long an invited participant has to respond before the moderator checks in. */
  inviteResponseSec: z.coerce.number().int().min(5).max(60).default(12),
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

/**
 * Body of a join request.
 *
 * The code may arrive as a query parameter instead of in the body, so both
 * fields are optional and the route decides where the code comes from. The
 * shape is still validated: a field that is not a string has to be rejected as
 * a bad request rather than thrown out of the handler as a server error.
 */
export const joinRequestBodySchema = joinDiscussionSchema.partial();

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
// Live audio activity
// ---------------------------------------------------------------------------

/**
 * A browser's report of what it can hear.
 *
 * `speaking` is this participant's own microphone; `aiSpeaking` is the
 * moderator's voice being played back; `transcribing` is whether this
 * participant's own browser is currently running speech recognition. All three
 * are optional so a heartbeat can carry whichever changed.
 */
export const presenceSchema = z.object({
  speaking: z.coerce.boolean().optional(),
  aiSpeaking: z.coerce.boolean().optional(),
  transcribing: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Host room controls
// ---------------------------------------------------------------------------

export const participantControlSchema = z.object({
  action: z.enum(["lock-mic", "unlock-mic", "remove", "restore"]),
});

// ---------------------------------------------------------------------------
// Breakout rooms
// ---------------------------------------------------------------------------

export const MIN_GROUP_SIZE = 2;
export const MAX_GROUP_SIZE = 30;

/**
 * Host control over breakout rooms.
 *
 * `enable` also carries the group size, because switching rooms on and changing
 * how big a group should be are the same decision. `move` names the student and
 * the room they are being put in.
 */
export const breakoutControlSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("enable"),
    groupSize: z.coerce.number().int().min(MIN_GROUP_SIZE).max(MAX_GROUP_SIZE).optional(),
  }),
  z.object({ action: z.literal("disable") }),
  z.object({ action: z.literal("reshuffle") }),
  z.object({
    action: z.literal("move"),
    participantId: z.string().min(1, "A participant is required"),
    room: z.coerce.number().int().min(1).max(1000),
  }),
]);
