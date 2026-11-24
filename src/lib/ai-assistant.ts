import { TurnRequestSource, TurnRequestStatus, TurnState } from "@prisma/client";
import { prisma } from "./prisma";
import { env } from "./env";
import { AiRequestError, callGemini, geminiAvailable, parseJsonReply } from "./gemini";
import { countWords } from "./transcript";
import {
  decideConversationState,
  isAudioActive,
  isWithinSpeechEndGrace,
  mayModeratorSpeak,
  persistConversationState,
  type ConversationState,
} from "./conversation";
import {
  beginAiSpeaking,
  estimateAiSpeechDurationMs,
  expireStaleAiSpeakingLock,
  isAiSpeakingLocked,
  isMeetingPaused,
  syncRoomStateSnapshot,
} from "./room-sync";
import {
  buildParticipation,
  classifyParticipantResponse,
  pickInviteCandidate,
  type ParticipationRow,
  type ParticipationSnapshot,
} from "./participation";
import {
  createAiSpeechEvent,
  expireTurnIfNeeded,
  grantParticipantTx,
  nextRequestedParticipant,
  syncRoomPermissions,
} from "./turns";

/**
 * The AI moderator.
 *
 * The moderator is not a timer. It is a small engine that watches the room —
 * who is actually talking (LiveKit audio activity), what has been said (the
 * transcript), and who has been offered the floor and how they answered — and
 * decides, once the room has genuinely stalled, whether it is allowed to speak.
 * Whenever it speaks (`AI_SPEAKING`), LiveKit participant microphones are
 * authoritatively muted at the SFU until the AI finishes.
 */

export const RELEVANCE_LABELS = [
  "HIGHLY_RELEVANT",
  "RELEVANT",
  "PARTIALLY_RELEVANT",
  "IRRELEVANT",
] as const;

export type RelevanceLabel = (typeof RELEVANCE_LABELS)[number];

export type RelevanceScore = {
  relevance: RelevanceLabel;
  /** 0–100; drives the numeric relevance score stored on each segment. */
  score: number;
  reason: string;
};

const EVALUATOR_SYSTEM =
  "You are an impartial, experienced evaluator of academic and professional group discussions. " +
  "Judge only the substance of what is said against the stated topic. Ignore accent, fluency, " +
  "grammar and speaking speed. Be consistent: the same contribution must always receive the same verdict.";

const MODERATOR_SYSTEM =
  "You are a discreet, articulate round-table discussion facilitator sitting in on a live group discussion. " +
  "You speak rarely and briefly. You never lecture, never answer the topic for the group, and never " +
  "single anyone out unkindly. Every message you produce is concise, natural, and directly actionable. " +
  "You never apologise for a participant, never mention microphones or connections, and never imply " +
  "that anyone is failing.";

function clampScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function coerceLabel(value: unknown): RelevanceLabel {
  const label = String(value ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  return (RELEVANCE_LABELS as readonly string[]).includes(label)
    ? (label as RelevanceLabel)
    : "PARTIALLY_RELEVANT";
}

/**
 * Classifies a batch of utterances against the discussion topic.
 * One Gemini call scores up to `utterances.length` contributions.
 */
export async function classifyUtterances(params: {
  topic: string;
  context?: string;
  utterances: { index: number; speaker: string; text: string }[];
}): Promise<RelevanceScore[]> {
  if (params.utterances.length === 0) return [];

  const lines = params.utterances
    .map((u) => `[${u.index}] ${u.speaker}: ${u.text}`)
    .join("\n");

  const prompt = [
    `Discussion topic: ${params.topic}`,
    params.context ? `Background provided to participants: ${params.context}` : "",
    "",
    "For each numbered utterance below, judge how relevant it is to the topic.",
    'Return JSON only, shaped exactly like: {"items":[{"index":0,"relevance":"RELEVANT","score":72,"reason":"..."}]}',
    '`relevance` must be one of HIGHLY_RELEVANT, RELEVANT, PARTIALLY_RELEVANT, IRRELEVANT.',
    "`score` is 0-100 (100 = directly and substantively on topic).",
    "`reason` is at most 20 words.",
    "",
    "Utterances:",
    lines,
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await callGemini({
    prompt,
    system: EVALUATOR_SYSTEM,
    json: true,
    temperature: 0.1,
    maxOutputTokens: 2048,
  });

  const parsed = parseJsonReply<{ items?: Array<Record<string, unknown>> }>(raw);
  const items = Array.isArray(parsed.items) ? parsed.items : [];

  // Return one verdict per requested utterance, in the same order.
  return params.utterances.map((utterance, position) => {
    const match =
      items.find((item) => Number(item.index) === utterance.index) ?? items[position];
    if (!match) {
      return { relevance: "PARTIALLY_RELEVANT" as const, score: 50, reason: "No verdict returned." };
    }
    return {
      relevance: coerceLabel(match.relevance),
      score: clampScore(match.score),
      reason: String(match.reason ?? "").slice(0, 200),
    };
  });
}

/** The reasons the moderator has for speaking. Each maps to one intent. */
export type AssistantReason =
  | "WELCOME"
  | "SILENCE"
  | "PICK"
  | "BALANCE"
  | "BALANCE_DOMINANT"
  | "DRIFT"
  | "CHECK"
  | "FOLLOW_UP";

/** Asks the moderator for one short, actionable message for the room. */
export async function draftAssistantMessage(params: {
  topic: string;
  context?: string;
  rules?: string;
  reason: AssistantReason;
  recent: string[];
  previousPrompts?: string[];
  silentNames?: string[];
  pickedName?: string;
  dominantName?: string;
}): Promise<string> {
  const name = params.pickedName ?? "the participant who has spoken least";
  const intent =
    params.reason === "WELCOME"
      ? "Welcome everyone warmly to the round-table meeting, concisely introduce the topic, agenda/context, and key ground rules if provided, and ask one inviting opening question."
      : params.reason === "SILENCE"
        ? "Nobody has spoken for a while. Warn the group in one short sentence that, unless someone " +
          "continues, you will invite whichever participant has spoken least to take the floor. Do " +
          "not name anybody yet."
        : params.reason === "PICK"
          ? `The group stayed silent, so invite ${name} by name to share their view or respond to the recent points, warmly and specifically.`
          : params.reason === "BALANCE_DOMINANT"
            ? `${params.dominantName ?? "One speaker"} has shared thorough points already. Thank them briefly and invite ${name} by name to bring a fresh perspective so all voices are heard.`
            : params.reason === "CHECK"
              ? `${name} was just invited to speak and has not replied yet. Check in with them warmly and ` +
                "briefly: make it easy to say a word or to pass. Never imply they are holding the group up."
              : params.reason === "BALANCE"
                ? `These members have not spoken yet: ${params.silentNames?.join(", ") || "some participants"}. Invite one of them in warmly and specifically, without naming them as being behind.`
                : params.reason === "FOLLOW_UP"
                  ? "The group paused after recent contributions. Briefly connect or contrast the viewpoints raised (mentioning speakers by name if helpful) and ask one incisive follow-up question not yet asked."
                  : "The discussion is drifting off topic. Gently steer it back to the core agenda with one pointed question.";

  const maxWords = params.reason === "WELCOME" ? 55 : 34;
  const prompt = [
    `Topic: ${params.topic}`,
    params.context ? `Agenda & Context: ${params.context}` : "",
    params.rules ? `Ground Rules: ${params.rules}` : "",
    intent,
    params.recent.length ? `Most recent contributions:\n${params.recent.map((r) => `- ${r}`).join("\n")}` : "",
    params.previousPrompts && params.previousPrompts.length > 0
      ? `Already asked or said earlier (DO NOT repeat or rephrase these):\n${params.previousPrompts
          .map((p) => `- ${p}`)
          .join("\n")}`
      : "",
    `Return JSON only: {"message":"<one concise moderator turn, at most ${maxWords} words>"}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await callGemini({
    prompt,
    system: MODERATOR_SYSTEM,
    json: true,
    temperature: 0.6,
    maxOutputTokens: 256,
  });

  const parsed = parseJsonReply<{ message?: unknown }>(raw);
  const message = String(parsed.message ?? "").trim();
  if (!message) throw new AiRequestError("The moderator returned an empty message.");
  return message.slice(0, 450);
}

/** Summarises the discussion so far into a short checkpoint or closing wrap-up. */
export async function draftSummary(params: {
  topic: string;
  transcript: string[];
  checkpoint?: boolean;
}): Promise<string> {
  const instruction = params.checkpoint
    ? "Provide a brief mid-meeting synthesis in 2 short sentences: highlight the main agreements/disagreements across speakers so far and pose one clear guiding prompt for the next phase."
    : "Summarise the complete discussion in at most three concise sentences, noting the key viewpoints, areas of consensus or tension, and main takeaways.";

  const prompt = [
    `Topic: ${params.topic}`,
    instruction,
    'Return JSON only: {"message":"<summary>"}',
    params.transcript.length ? `Transcript:\n${params.transcript.map((t) => `- ${t}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await callGemini({
    prompt,
    system: EVALUATOR_SYSTEM,
    tier: "smart",
    json: true,
    temperature: 0.3,
    maxOutputTokens: 512,
  });

  const parsed = parseJsonReply<{ message?: unknown }>(raw);
  return String(parsed.message ?? "").trim().slice(0, 1200);
}

// ---------------------------------------------------------------------------
// Live orchestration
// ---------------------------------------------------------------------------

const CLASSIFY_BATCH = 8;

/** The moderator does not flag drift more often than this. */
const DRIFT_COOLDOWN_MS = 120_000;

/** A minimum gap between two invitations, whoever they are offered to. */
const INVITE_GAP_MS = 20_000;

/** The initial offer, plus one polite check-in before the invitation is spent. */
const MAX_INVITE_PROMPTS = 2;

/** Minimum gap between two AI follow-up questions. */
const FOLLOW_UP_COOLDOWN_MS = 90_000;

/** Minimum gap & contribution count between periodic checkpoint summaries. */
const CHECKPOINT_SUMMARY_COOLDOWN_MS = 120_000;
const CHECKPOINT_SUMMARY_MIN_SEGMENTS = 6;

/** Server-side background orchestration tick interval (ms). */
const ORCHESTRATOR_INTERVAL_MS = 3500;

export type AssistantTickResult = {
  skipped?: string;
  /** What the engine concluded about the room on this pass. */
  conversationState?: ConversationState;
  classified: number;
  eventsCreated: Array<{ kind: string; message: string; participantName?: string }>;
};

/** The transcript columns the tick works from. */
type TickSegment = {
  id: string;
  participantId: string;
  text: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  wordCount: number;
  relevance: string;
  relevanceScore: number | null;
  analysisSource: string;
  participant: { displayName: string };
};

function getInFlightTicks(): Map<string, Promise<AssistantTickResult>> {
  const g = globalThis as unknown as {
    __quorumInFlightTicks?: Map<string, Promise<AssistantTickResult>>;
  };
  if (!g.__quorumInFlightTicks) {
    g.__quorumInFlightTicks = new Map<string, Promise<AssistantTickResult>>();
  }
  return g.__quorumInFlightTicks;
}

function getOrchestrators(): Map<string, ReturnType<typeof setInterval>> {
  const g = globalThis as unknown as {
    __quorumOrchestrators?: Map<string, ReturnType<typeof setInterval>>;
  };
  if (!g.__quorumOrchestrators) {
    g.__quorumOrchestrators = new Map<string, ReturnType<typeof setInterval>>();
  }
  return g.__quorumOrchestrators;
}

/**
 * Starts a lightweight server-side orchestrator loop for a LIVE AI-moderated room
 * so lock expiration, participation tracking, and moderation prompts continue even
 * if the host refreshes or loses browser connectivity.
 */
export function ensureRoomOrchestrator(discussionId: string): void {
  if (process.env.NODE_ENV === "test") return;
  const registry = getOrchestrators();
  if (registry.has(discussionId)) return;

  const timer = setInterval(() => {
    void runAssistantTick(discussionId)
      .then((res) => {
        if (
          res.skipped === "not-found" ||
          res.skipped === "not-live" ||
          res.skipped === "ai-disabled"
        ) {
          stopRoomOrchestrator(discussionId);
        }
      })
      .catch(() => {});
  }, ORCHESTRATOR_INTERVAL_MS);

  if (typeof timer.unref === "function") timer.unref();
  registry.set(discussionId, timer);
}

/** Stops the server-side orchestrator loop for a discussion. */
export function stopRoomOrchestrator(discussionId: string): void {
  const registry = getOrchestrators();
  const timer = registry.get(discussionId);
  if (timer) {
    clearInterval(timer);
    registry.delete(discussionId);
  }
}

/**
 * Returns true if any active participant started speaking (or is within the
 * post-speech grace window), used to prevent AI from speaking right after
 * `AI_THINKING` when a human takes the floor.
 */
async function hasHumanSpeechInterrupt(discussionId: string, now: number = Date.now()): Promise<boolean> {
  const participants = await prisma.discussionParticipant.findMany({
    where: { discussionId, removed: false, leftAt: null },
    select: { speakingSince: true, lastAudioAt: true },
  });
  return participants.some(
    (p) =>
      isAudioActive(p.speakingSince, p.lastAudioAt, now) ||
      isWithinSpeechEndGrace(p.lastAudioAt, now),
  );
}

/**
 * Posts the opening welcome message, agenda, and ground-rules introduction once
 * when an AI-moderated session goes live. Synchronizes LiveKit mic locking while
 * the moderator speaks the introduction.
 */
export async function postWelcomeAndTopicIntro(
  discussionId: string,
): Promise<{ kind: string; message: string } | null> {
  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      id: true,
      title: true,
      topic: true,
      context: true,
      rules: true,
      status: true,
      mode: true,
      aiEnabled: true,
      welcomePosted: true,
      pausedAt: true,
    },
  });
  if (
    !discussion ||
    discussion.status !== "LIVE" ||
    !discussion.aiEnabled ||
    discussion.mode !== "AI_MODERATED" ||
    discussion.welcomePosted ||
    discussion.pausedAt
  ) {
    return null;
  }

  // Atomic guard so concurrent clients starting or ticking never post twice.
  const claimed = await prisma.discussion.updateMany({
    where: { id: discussionId, welcomePosted: false },
    data: { welcomePosted: true },
  });
  if (claimed.count === 0) return null;

  let message: string | null = null;
  let source = "gemini";

  if (geminiAvailable()) {
    message = await safeMessage({
      topic: discussion.topic,
      context: discussion.context,
      rules: discussion.rules,
      reason: "WELCOME",
      recent: [],
    });
  }

  if (!message) {
    source = "system";
    const agendaPart = discussion.context ? ` Agenda: ${discussion.context.slice(0, 120)}.` : "";
    const rulesPart = discussion.rules
      ? ` Please follow our ground rules: ${discussion.rules.slice(0, 100)}.`
      : "";
    message = `Welcome to "${discussion.title}". Today's topic is: ${discussion.topic}.${agendaPart}${rulesPart} Who would like to share the first perspective?`;
  }

  await prisma.aiEvent.create({
    data: {
      discussionId,
      kind: "QUESTION",
      message,
      source,
    },
  });

  await beginAiSpeaking(discussionId, estimateAiSpeechDurationMs(message));
  return { kind: "QUESTION", message };
}

/**
 * Generates and stores the AI closing summary once when a discussion ends.
 */
export async function generateClosingSummary(
  discussionId: string,
): Promise<{ kind: string; message: string } | null> {
  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      id: true,
      title: true,
      topic: true,
      aiEnabled: true,
      summaryPosted: true,
    },
  });
  if (!discussion || !discussion.aiEnabled || discussion.summaryPosted) {
    return null;
  }

  const claimed = await prisma.discussion.updateMany({
    where: { id: discussionId, summaryPosted: false },
    data: { summaryPosted: true },
  });
  if (claimed.count === 0) return null;

  const segments = await prisma.transcriptSegment.findMany({
    where: { discussionId, status: "FINAL" },
    orderBy: { startedAt: "asc" },
    select: {
      text: true,
      participant: { select: { displayName: true } },
    },
  });

  let summaryText = "";
  let source = "gemini";

  if (segments.length > 0 && geminiAvailable()) {
    try {
      summaryText = await draftSummary({
        topic: discussion.topic,
        transcript: segments.slice(-40).map((s) => `${s.participant.displayName}: ${s.text}`),
        checkpoint: false,
      });
    } catch (error) {
      console.error("[ai] closing summary generation failed", error);
    }
  }

  if (!summaryText) {
    source = "system";
    const speakers = new Set(segments.map((s) => s.participant.displayName));
    summaryText =
      segments.length > 0
        ? `Session concluded on "${discussion.topic}" with ${segments.length} recorded contributions across ${speakers.size} speaker${speakers.size === 1 ? "" : "s"}. Full analytics and rubric evaluations are now ready in the report.`
        : `Session concluded on "${discussion.topic}". No spoken transcript segments were recorded during this meeting.`;
  }

  await prisma.aiEvent.create({
    data: {
      discussionId,
      kind: "SUMMARY",
      message: summaryText,
      source,
    },
  });

  return { kind: "SUMMARY", message: summaryText };
}

/**
 * Serialized entry point for one pass of the live moderator. Concurrent ticks
 * for the same room coalesce onto the in-flight execution so two browsers or
 * background timers cannot trigger overlapping AI responses.
 */
export async function runAssistantTick(discussionId: string): Promise<AssistantTickResult> {
  const inFlight = getInFlightTicks();
  const active = inFlight.get(discussionId);
  if (active) {
    await active.catch(() => {});
    return { skipped: "in-flight", classified: 0, eventsCreated: [] };
  }

  const run = runAssistantTickInternal(discussionId).finally(() => {
    inFlight.delete(discussionId);
  });
  inFlight.set(discussionId, run);
  return run;
}

async function runAssistantTickInternal(discussionId: string): Promise<AssistantTickResult> {
  const result: AssistantTickResult = { classified: 0, eventsCreated: [] };

  await expireStaleAiSpeakingLock(discussionId);

  await expireTurnIfNeeded(discussionId);
  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      id: true,
      topic: true,
      context: true,
      rules: true,
      status: true,
      mode: true,
      aiEnabled: true,
      silencePromptSec: true,
      inviteResponseSec: true,
      conversationState: true,
      lastAiSpokeAt: true,
      aiSpeakingUntil: true,
      pausedAt: true,
      welcomePosted: true,
      turnState: true,
      startedAt: true,
      participants: {
        select: {
          id: true,
          displayName: true,
          isHost: true,
          seatNumber: true,
          joinedAt: true,
          leftAt: true,
          removed: true,
          micLocked: true,
          lastAudioAt: true,
          speakingSince: true,
          invitedCount: true,
          answeredInviteCount: true,
          unansweredInviteCount: true,
          passCount: true,
          lastInvitedAt: true,
          audioIssueAt: true,
          transcribingAt: true,
        },
      },
    },
  });

  if (!discussion) return { ...result, skipped: "not-found" };
  if (discussion.status !== "LIVE") return { ...result, skipped: "not-live" };
  if (!discussion.aiEnabled) return { ...result, skipped: "ai-disabled" };
  if (discussion.turnState === TurnState.AI_SPEAKING) {
    return { ...result, conversationState: "AI_SPEAKING" };
  }

  if (isMeetingPaused(discussion)) {
    await persistConversationState(discussionId, "MEETING_PAUSED", discussion.conversationState);
    return { ...result, conversationState: "MEETING_PAUSED", skipped: "paused" };
  }

  // Post opening welcome & topic introduction once when an AI-moderated room goes live.
  if (!discussion.welcomePosted && discussion.mode === "AI_MODERATED") {
    const welcome = await postWelcomeAndTopicIntro(discussionId);
    if (welcome) {
      result.eventsCreated.push(welcome);
      result.conversationState = "AI_SPEAKING";
      return result;
    }
  }

  const segments: TickSegment[] = await prisma.transcriptSegment.findMany({
    where: { discussionId, status: "FINAL" },
    orderBy: { startedAt: "asc" },
    select: {
      id: true,
      participantId: true,
      text: true,
      startedAt: true,
      endedAt: true,
      durationMs: true,
      wordCount: true,
      relevance: true,
      relevanceScore: true,
      analysisSource: true,
      participant: { select: { displayName: true } },
    },
  });

  // --- 1. Score contributions that have not been analysed yet ---------------
  if (geminiAvailable()) {
    const pending = segments.filter((s) => s.analysisSource === "pending").slice(0, CLASSIFY_BATCH);
    if (pending.length > 0) {
      try {
        const verdicts = await classifyUtterances({
          topic: discussion.topic,
          context: discussion.context,
          utterances: pending.map((segment, index) => ({
            index,
            speaker: segment.participant.displayName,
            text: segment.text,
          })),
        });

        for (let i = 0; i < pending.length; i += 1) {
          const segment = pending[i];
          const verdict = verdicts[i];
          await prisma.transcriptSegment.update({
            where: { id: segment.id },
            data: {
              relevance: verdict.relevance,
              relevanceScore: verdict.score,
              relevanceReason: verdict.reason,
              analysisSource: "gemini",
            },
          });
          result.classified += 1;
        }
      } catch (error) {
        // A failing analyser must not take down the room; it is retried next tick.
        console.error("[ai] relevance classification failed", error);
      }
    }
  }

  // Measured here rather than at the top of the tick: the scoring above can
  // take several seconds, and a deadline stamped from a stale clock would give
  // the room a shorter response window than the one it is counting down.
  const now = Date.now();

  // --- 2. The room, as the participation tracker sees it --------------------
  const participation = buildParticipation({ participants: discussion.participants, segments }, now);

  // --- 3. Settle whatever the moderator is still waiting on -----------------
  await resolveInvitations({ discussionId, discussion, participation, segments, now, result });

  const outstanding = await prisma.invitation.count({
    where: { discussionId, status: "PENDING" },
  });

  // --- 4. Decide what the room is doing, and record it ----------------------
  const state = decideState({
    discussion,
    participation,
    segments,
    now,
    awaitingResponse: outstanding > 0,
  });
  const stateChanged = await persistConversationState(
    discussionId,
    state,
    discussion.conversationState,
  );
  result.conversationState = state;
  if (stateChanged) {
    await syncRoomStateSnapshot(discussionId, { broadcast: true, syncMics: false });
  }

  // --- 5. Act, but only in genuine, sustained silence -----------------------
  if (!geminiAvailable()) {
    return { ...result, skipped: "ai-disabled" };
  }
  if (!mayModeratorSpeak(state) || outstanding > 0) return result;

  const budgetLeft =
    (await prisma.aiEvent.count({ where: { discussionId, source: "gemini" } })) <
    env.aiMaxCallsPerRoom;
  if (!budgetLeft) return result;

  // Transition briefly to AI_THINKING while Gemini drafts the moderator prompt.
  await persistConversationState(discussionId, "AI_THINKING", state);
  await syncRoomStateSnapshot(discussionId, { broadcast: true, syncMics: false });

  const recentEvents = await prisma.aiEvent.findMany({
    where: { discussionId },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { kind: true, message: true, createdAt: true },
  });
  const previousPrompts = recentEvents.map((e) => e.message).reverse();
  const recent = segments.slice(-6).map((s) => `${s.participant.displayName}: ${s.text}`);

  const abortIfInterrupted = async (): Promise<boolean> => {
    if (!(await hasHumanSpeechInterrupt(discussionId))) return false;
    await persistConversationState(discussionId, "PARTICIPANT_SPEAKING", "AI_THINKING");
    await syncRoomStateSnapshot(discussionId, { broadcast: true, syncMics: false });
    result.conversationState = "PARTICIPANT_SPEAKING";
    result.skipped = "human-interrupt";
    return true;
  };

  // Priority A: Invite quieter members or re-balance when one participant dominates.
  if (!(await invitedTooRecently(discussionId, now))) {
    const candidate = pickInviteCandidate(participation.rows, { now });
    if (candidate) {
      const dominant = findDominantSpeaker(participation.rows, segments.length);
      if (dominant && dominant.participantId !== candidate.participantId) {
        const message = await safeMessage({
          topic: discussion.topic,
          context: discussion.context,
          rules: discussion.rules,
          reason: "BALANCE_DOMINANT",
          recent,
          previousPrompts,
          pickedName: candidate.displayName,
          dominantName: dominant.displayName,
        });
        if (await abortIfInterrupted()) return result;
        if (message) {
          await recordCustomInvitation({
            discussionId,
            discussion,
            candidate,
            message,
            now,
            result,
          });
          if (result.eventsCreated.length > 0) {
            result.conversationState = "AI_SPEAKING";
            return result;
          }
        }
      } else {
        await openInvitation({
          discussionId,
          discussion,
          candidate,
          recent,
          previousPrompts,
          now,
          result,
          checkInterrupt: abortIfInterrupted,
        });
        if (result.skipped === "human-interrupt") return result;
        if (result.eventsCreated.length > 0) {
          result.conversationState = "AI_SPEAKING";
          return result;
        }
      }
    }
  }

  // Priority B: Periodic mid-meeting synthesis checkpoint.
  if (await shouldPostCheckpointSummary(discussionId, segments, now)) {
    const summaryMsg = await draftSummary({
      topic: discussion.topic,
      transcript: segments.slice(-24).map((s) => `${s.participant.displayName}: ${s.text}`),
      checkpoint: true,
    }).catch(() => "");
    if (await abortIfInterrupted()) return result;
    if (summaryMsg) {
      await prisma.aiEvent.create({
        data: { discussionId, kind: "SUMMARY", message: summaryMsg, source: "gemini" },
      });
      result.eventsCreated.push({ kind: "SUMMARY", message: summaryMsg });
      await beginAiSpeaking(discussionId, estimateAiSpeechDurationMs(summaryMsg));
      result.conversationState = "AI_SPEAKING";
      return result;
    }
  }

  // Priority C: Flag off-topic drift.
  if (await shouldFlagDrift(discussionId, segments, now)) {
    const message = await safeMessage({
      topic: discussion.topic,
      context: discussion.context,
      reason: "DRIFT",
      recent,
      previousPrompts,
    });
    if (await abortIfInterrupted()) return result;
    if (message) {
      await prisma.$transaction((tx) =>
        createAiSpeechEvent(tx, {
          discussionId,
          kind: "RELEVANCE",
          message,
          source: "gemini",
        }),
      );
      await syncRoomPermissions(discussionId);
      result.eventsCreated.push({ kind: "RELEVANCE", message });
      await beginAiSpeaking(discussionId, estimateAiSpeechDurationMs(message));
      result.conversationState = "AI_SPEAKING";
      return result;
    }
  }

  // Priority D: Ask a non-repetitive follow-up question connecting viewpoints.
  if (await shouldAskFollowUp(discussionId, segments, now)) {
    const message = await safeMessage({
      topic: discussion.topic,
      context: discussion.context,
      reason: "FOLLOW_UP",
      recent,
      previousPrompts,
    });
    if (await abortIfInterrupted()) return result;
    if (message) {
      await prisma.aiEvent.create({
        data: { discussionId, kind: "QUESTION", message, source: "gemini" },
      });
      result.eventsCreated.push({ kind: "QUESTION", message });
      await beginAiSpeaking(discussionId, estimateAiSpeechDurationMs(message));
      result.conversationState = "AI_SPEAKING";
      return result;
    }
  }

  // Nothing created — leave AI_THINKING cleanly back to WAITING_FOR_PARTICIPANT.
  await persistConversationState(discussionId, "WAITING_FOR_PARTICIPANT", "AI_THINKING");
  await syncRoomStateSnapshot(discussionId, { broadcast: true, syncMics: false });
  result.conversationState = "WAITING_FOR_PARTICIPANT";

  return result;
}

/** Identifies when one participant is holding >55% of total speech once >=4 turns exist. */
function findDominantSpeaker(
  rows: ParticipationRow[],
  segmentCount: number,
): ParticipationRow | null {
  if (segmentCount < 4) return null;
  const activeSpeakers = rows.filter((r) => r.present && !r.isHost);
  if (activeSpeakers.length < 2) return null;
  const totalWords = activeSpeakers.reduce((s, r) => s + r.words, 0);
  if (totalWords < 20) return null;
  const top = [...activeSpeakers].sort((a, b) => b.words - a.words)[0];
  return top && top.words / totalWords > 0.55 ? top : null;
}

/** True when enough new contributions have occurred since the last checkpoint summary. */
async function shouldPostCheckpointSummary(
  discussionId: string,
  segments: TickSegment[],
  now: number,
): Promise<boolean> {
  if (segments.length < CHECKPOINT_SUMMARY_MIN_SEGMENTS) return false;
  const lastSummary = await prisma.aiEvent.findFirst({
    where: { discussionId, kind: "SUMMARY" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (lastSummary && now - lastSummary.createdAt.getTime() < CHECKPOINT_SUMMARY_COOLDOWN_MS) {
    return false;
  }
  const newSince = lastSummary
    ? segments.filter((s) => s.startedAt > lastSummary.createdAt).length
    : segments.length;
  return newSince >= CHECKPOINT_SUMMARY_MIN_SEGMENTS;
}

/** The context the state decision needs from the discussion row. */
type TickDiscussion = {
  id: string;
  topic: string;
  context?: string;
  rules?: string;
  startedAt: Date | null;
  silencePromptSec: number;
  inviteResponseSec: number;
  conversationState: string;
  lastAiSpokeAt: Date | null;
  aiSpeakingUntil?: Date | null;
  pausedAt?: Date | null;
  welcomePosted?: boolean;
};

/**
 * Works out what the room is doing from real audio activity first, the
 * transcript second, and the invitation record last.
 */
function decideState(params: {
  discussion: TickDiscussion;
  participation: ParticipationSnapshot;
  segments: TickSegment[];
  now: number;
  awaitingResponse: boolean;
}): ConversationState {
  const { discussion, participation, segments, now, awaitingResponse } = params;

  const participantSpeaking = participation.rows.some((row) => row.present && row.speaking);
  const aiSpeaking = isAiSpeakingLocked(discussion, now);
  const heardSomeone = segments.length > 0;

  let latestParticipantAudioAt: Date | null = null;
  const activity: number[] = [];
  if (discussion.startedAt) activity.push(discussion.startedAt.getTime());
  if (discussion.lastAiSpokeAt) activity.push(discussion.lastAiSpokeAt.getTime());
  for (const row of participation.rows) {
    if (!row.present) continue;
    if (row.lastAudioAt) {
      activity.push(row.lastAudioAt.getTime());
      if (!latestParticipantAudioAt || row.lastAudioAt > latestParticipantAudioAt) {
        latestParticipantAudioAt = row.lastAudioAt;
      }
    }
    if (row.lastSpokeAt) activity.push(row.lastSpokeAt.getTime());
  }
  const lastActivity = activity.length > 0 ? Math.max(...activity) : now;
  const quietMs = Math.max(0, now - lastActivity);
  const processingResponse =
    !participantSpeaking && !aiSpeaking && isWithinSpeechEndGrace(latestParticipantAudioAt, now);

  return decideConversationState({
    participantSpeaking,
    aiSpeaking,
    processingResponse,
    quietMs,
    silenceMs: discussion.silencePromptSec * 1000,
    countdownRunning: false,
    awaitingResponse,
    heardSomeone,
    waitingForParticipant: Boolean(discussion.welcomePosted) && !heardSomeone,
  });
}

/**
 * Settles every outstanding invitation against what has happened since it was
 * offered, in the order the outcomes should be considered.
 */
async function resolveInvitations(params: {
  discussionId: string;
  discussion: TickDiscussion;
  participation: ParticipationSnapshot;
  segments: TickSegment[];
  now: number;
  result: AssistantTickResult;
}): Promise<void> {
  const { discussionId, discussion, participation, segments, now, result } = params;

  const pending = await prisma.invitation.findMany({
    where: { discussionId, status: "PENDING" },
    select: { id: true, participantId: true, invitedAt: true, respondByAt: true, prompts: true },
  });
  if (pending.length === 0) return;

  const nameById = new Map(participation.rows.map((row) => [row.participantId, row.displayName] as const));
  const recent = segments.slice(-4).map((s) => `${s.participant.displayName}: ${s.text}`);

  for (const invitation of pending) {
    const spoken = segments.filter(
      (s) =>
        s.participantId === invitation.participantId &&
        s.startedAt.getTime() > invitation.invitedAt.getTime(),
    );

    if (spoken.length > 0) {
      const last = spoken[spoken.length - 1];
      const kind = classifyParticipantResponse(last.text);
      await applyInvitationOutcome({
        invitationId: invitation.id,
        participantId: invitation.participantId,
        kind: kind === "pass" ? "pass" : kind === "technical" ? "technical" : "answered",
        segmentId: last.id,
        now,
      });
      continue;
    }

    // Somebody else has the floor: the offer is overtaken, not ignored.
    const overtaken = participation.rows.some(
      (row) => row.present && row.speaking && row.participantId !== invitation.participantId,
    );
    if (overtaken) {
      await prisma.$transaction([
        prisma.invitation.update({ where: { id: invitation.id }, data: { status: "WITHDRAWN" } }),
        prisma.discussionParticipant.update({
          where: { id: invitation.participantId },
          data: { invitedCount: { decrement: 1 } },
        }),
      ]);
      continue;
    }

    if (now < invitation.respondByAt.getTime()) continue;

    if (invitation.prompts < MAX_INVITE_PROMPTS && geminiAvailable()) {
      const nextBy = new Date(now + discussion.inviteResponseSec * 1000);
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { prompts: { increment: 1 }, respondByAt: nextBy },
      });

      const participantName = nameById.get(invitation.participantId);
      const message = await safeMessage({
        topic: discussion.topic,
        reason: "CHECK",
        recent,
        pickedName: participantName,
      });
      if (message) {
        await prisma.$transaction((tx) =>
          createAiSpeechEvent(tx, {
            discussionId,
            participantId: invitation.participantId,
            kind: "NUDGE",
            message,
            source: "gemini",
            dueAt: nextBy,
          }),
        );
        await syncRoomPermissions(discussionId);
        result.eventsCreated.push({ kind: "NUDGE", message, participantName });
        await beginAiSpeaking(discussionId, estimateAiSpeechDurationMs(message));
      }
      continue;
    }

    // Asked twice and still nothing. This is the only outcome that costs a
    // participant anything, and it is deliberately small.
    await prisma.$transaction(async (tx) => {
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: "UNANSWERED" },
      });
      await tx.discussionParticipant.update({
        where: { id: invitation.participantId },
        data: { unansweredInviteCount: { increment: 1 } },
      });
      await tx.turnRequest.updateMany({
        where: {
          discussionId,
          participantId: invitation.participantId,
          status: { in: [TurnRequestStatus.REQUESTED, TurnRequestStatus.GRANTED] },
        },
        data: { status: TurnRequestStatus.CANCELLED, finishedAt: new Date(now) },
      });
      const current = await tx.discussion.findUnique({
        where: { id: discussionId },
        select: {
          activeTurnParticipantId: true,
          turnState: true,
          turnDurationSec: true,
        },
      });
      if (current?.activeTurnParticipantId === invitation.participantId) {
        await tx.discussion.update({
          where: { id: discussionId },
          data: {
            turnState: TurnState.OPEN,
            activeTurnParticipantId: null,
            turnStartedAt: null,
            turnEndsAt: null,
          },
        });
        const next = await nextRequestedParticipant(tx, discussionId);
        if (next) {
          await grantParticipantTx(tx, {
            discussionId,
            participantId: next.id,
            source: TurnRequestSource.PARTICIPANT,
            now: new Date(now),
            turnDurationSec: current.turnDurationSec,
          });
        }
      }
    });
    await syncRoomPermissions(discussionId);
  }
}

/**
 * Settles one invitation against how the participant actually answered it.
 */
export async function applyInvitationOutcome(params: {
  invitationId: string;
  participantId: string;
  kind: "answered" | "pass" | "technical";
  segmentId: string;
  now: number;
}): Promise<boolean> {
  const { invitationId, participantId, kind, segmentId, now } = params;
  const at = new Date(now);
  const status = kind === "pass" ? "PASSED" : kind === "technical" ? "TECHNICAL" : "ANSWERED";

  const applied = await prisma.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({
      where: { id: invitationId },
      select: { status: true, aiEventId: true, discussionId: true },
    });
    if (!invitation || invitation.status !== "PENDING") return false;

    await tx.invitation.update({
      where: { id: invitationId },
      data: { status, respondedAt: at, responseSegmentId: segmentId },
    });

    if (invitation.aiEventId) {
      await tx.aiEvent.update({ where: { id: invitation.aiEventId }, data: { dueAt: null } });
    }

    await tx.discussionParticipant.update({
      where: { id: participantId },
      data:
        kind === "answered"
          ? { answeredInviteCount: { increment: 1 } }
          : kind === "pass"
            ? { passCount: { increment: 1 } }
            : { audioIssueAt: at },
    });

    if (kind === "pass" || kind === "technical") {
      await tx.turnRequest.updateMany({
        where: {
          discussionId: invitation.discussionId,
          participantId,
          status: { in: [TurnRequestStatus.REQUESTED, TurnRequestStatus.GRANTED] },
        },
        data: {
          status: kind === "pass" ? TurnRequestStatus.PASSED : TurnRequestStatus.CANCELLED,
          finishedAt: at,
        },
      });
      const current = await tx.discussion.findUnique({
        where: { id: invitation.discussionId },
        select: { id: true, turnState: true, activeTurnParticipantId: true, turnDurationSec: true },
      });
      if (current?.activeTurnParticipantId === participantId) {
        await tx.discussion.update({
          where: { id: current.id },
          data: {
            turnState: TurnState.OPEN,
            activeTurnParticipantId: null,
            turnStartedAt: null,
            turnEndsAt: null,
          },
        });
        const next = await nextRequestedParticipant(tx, current.id);
        if (next) {
          await grantParticipantTx(tx, {
            discussionId: current.id,
            participantId: next.id,
            source: TurnRequestSource.PARTICIPANT,
            now: at,
            turnDurationSec: current.turnDurationSec,
          });
        }
      }
    }

    return true;
  });
  if (applied && kind !== "answered") {
    const invitation = await prisma.invitation.findUnique({
      where: { id: invitationId },
      select: { discussionId: true },
    });
    if (invitation) await syncRoomPermissions(invitation.discussionId);
  }
  return applied;
}

/** Offers the floor to one participant and opens the record of that offer. */
async function openInvitation(params: {
  discussionId: string;
  discussion: TickDiscussion;
  candidate: ParticipationRow;
  recent: string[];
  previousPrompts?: string[];
  now: number;
  result: AssistantTickResult;
  checkInterrupt?: () => Promise<boolean>;
}): Promise<void> {
  const {
    discussionId,
    discussion,
    candidate,
    recent,
    previousPrompts,
    now,
    result,
    checkInterrupt,
  } = params;

  const message = await safeMessage({
    topic: discussion.topic,
    context: discussion.context,
    rules: discussion.rules,
    reason: "PICK",
    recent,
    previousPrompts,
    pickedName: candidate.displayName,
  });
  if (!message) return;
  if (checkInterrupt && (await checkInterrupt())) return;

  await recordCustomInvitation({
    discussionId,
    discussion,
    candidate,
    message,
    now,
    result,
  });
}

async function recordCustomInvitation(params: {
  discussionId: string;
  discussion: TickDiscussion;
  candidate: ParticipationRow;
  message: string;
  now: number;
  result: AssistantTickResult;
}): Promise<void> {
  const { discussionId, discussion, candidate, message, now, result } = params;
  const respondByAt = new Date(now + discussion.inviteResponseSec * 1000);

  const created = await prisma.$transaction(async (tx) => {
    const existing = await tx.invitation.findFirst({
      where: { discussionId, status: "PENDING" },
      select: { id: true },
    });
    if (existing) return false;

    const event = await createAiSpeechEvent(tx, {
        discussionId,
        participantId: candidate.participantId,
        kind: "NUDGE",
        message,
        source: "gemini",
        dueAt: respondByAt,
    });
    await tx.invitation.create({
      data: {
        discussionId,
        participantId: candidate.participantId,
        aiEventId: event.id,
        respondByAt,
      },
    });
    const pendingRequest = await tx.turnRequest.findFirst({
      where: {
        discussionId,
        participantId: candidate.participantId,
        status: TurnRequestStatus.REQUESTED,
      },
      select: { id: true },
    });
    if (!pendingRequest) {
      await tx.turnRequest.create({
        data: {
          discussionId,
          participantId: candidate.participantId,
          source: TurnRequestSource.AI,
        },
      });
    }
    await tx.discussionParticipant.update({
      where: { id: candidate.participantId },
      data: { invitedCount: { increment: 1 }, lastInvitedAt: new Date(now) },
    });
    return true;
  });

  if (created) {
    await syncRoomPermissions(discussionId);
    result.eventsCreated.push({ kind: "NUDGE", message, participantName: candidate.displayName });
    await beginAiSpeaking(discussionId, estimateAiSpeechDurationMs(message));
  }
}

/** True when an invitation was offered so recently that another would nag. */
async function invitedTooRecently(discussionId: string, now: number): Promise<boolean> {
  const last = await prisma.invitation.findFirst({
    where: { discussionId },
    orderBy: { invitedAt: "desc" },
    select: { invitedAt: true },
  });
  return Boolean(last && now - last.invitedAt.getTime() < INVITE_GAP_MS);
}

/** True when the last few analysed contributions have mostly drifted off topic. */
async function shouldFlagDrift(
  discussionId: string,
  segments: TickSegment[],
  now: number,
): Promise<boolean> {
  const analysed = segments.filter((s) => s.analysisSource === "gemini").slice(-6);
  const offTopic = analysed.filter(
    (s) => s.relevance === "IRRELEVANT" || s.relevance === "PARTIALLY_RELEVANT",
  );
  if (analysed.length < 4 || offTopic.length < 3) return false;

  const since = new Date(now - DRIFT_COOLDOWN_MS);
  const recent = await prisma.aiEvent.findFirst({
    where: { discussionId, kind: "RELEVANCE", createdAt: { gte: since } },
    select: { id: true },
  });
  return !recent;
}

/** True when substantive turns exist and a follow-up question has not been asked recently. */
async function shouldAskFollowUp(
  discussionId: string,
  segments: TickSegment[],
  now: number,
): Promise<boolean> {
  if (segments.length < 2) return false;
  const since = new Date(now - FOLLOW_UP_COOLDOWN_MS);
  const recentQuestion = await prisma.aiEvent.findFirst({
    where: { discussionId, kind: "QUESTION", createdAt: { gte: since } },
    select: { id: true },
  });
  return !recentQuestion;
}

/** Generates a message, degrading gracefully if Gemini is unavailable. */
async function safeMessage(params: {
  topic: string;
  context?: string;
  rules?: string;
  reason: AssistantReason;
  recent: string[];
  previousPrompts?: string[];
  silentNames?: string[];
  pickedName?: string;
  dominantName?: string;
}): Promise<string | null> {
  try {
    return await draftAssistantMessage(params);
  } catch (error) {
    console.error("[ai] moderator message failed", error);
    return null;
  }
}

/** Word count helper re-exported for callers that only need stats. */
export { countWords };
