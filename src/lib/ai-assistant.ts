import { prisma } from "./prisma";
import { env } from "./env";
import { AiRequestError, callGemini, geminiAvailable, parseJsonReply } from "./gemini";
import { countWords } from "./transcript";
import {
  AI_SPEAKING_STALE_MS,
  decideConversationState,
  mayModeratorSpeak,
  persistConversationState,
  type ConversationState,
} from "./conversation";
import {
  buildParticipation,
  classifyParticipantResponse,
  pickInviteCandidate,
  type ParticipationRow,
  type ParticipationSnapshot,
} from "./participation";

/**
 * The AI moderator.
 *
 * The moderator is not a timer. It is a small engine that watches the room —
 * who is actually talking (LiveKit audio activity), what has been said (the
 * transcript), and who has been offered the floor and how they answered — and
 * decides, once the room has genuinely stalled, whether it is allowed to speak.
 * The decision itself lives in `conversation.ts`; the per-participant picture
 * it is fed lives in `participation.ts`. This file is the orchestration between
 * them.
 *
 * Its routine, and the order it does it in:
 *   1. Score the contributions that have not been analysed yet.
 *   2. Resolve any invitation it is still waiting on — answered, passed,
 *      lapsed, or never answered — because that outcome is what the score
 *      reads.
 *   3. Decide what the room is doing, and store that state so every browser
 *      shows the same thing.
 *   4. Only if the room has gone quiet long enough, offer the floor to whoever
 *      has spoken least, or gently steer a drifting discussion back on topic.
 *
 * The two rules that shape everything here: the moderator never talks over a
 * participant, and it never punishes a circumstance — a broken microphone, a
 * dropped connection, a late arrival or a politely declined invitation.
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
  "You are a discreet discussion facilitator sitting in on a live group discussion. " +
  "You speak rarely and briefly. You never lecture, never answer the topic for the group, and never " +
  "single anyone out unkindly. Every message you produce is one short sentence the room can act on. " +
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
export type AssistantReason = "SILENCE" | "PICK" | "BALANCE" | "DRIFT" | "CHECK";

/** Asks the moderator for one short, actionable message for the room. */
export async function draftAssistantMessage(params: {
  topic: string;
  reason: AssistantReason;
  recent: string[];
  silentNames?: string[];
  pickedName?: string;
}): Promise<string> {
  const name = params.pickedName ?? "the participant who has spoken least";
  const intent =
    params.reason === "SILENCE"
      ? "Nobody has spoken for a while. Warn the group in one short sentence that, unless someone " +
        "continues, you will invite whichever participant has spoken least to take the floor. Do " +
        "not name anybody yet."
      : params.reason === "PICK"
        ? `The group stayed silent, so you are making good on that warning. Invite ${name} by name to ` +
          "continue, warmly and specifically. This is a turn being offered, not a telling-off."
        : params.reason === "CHECK"
          ? `${name} was just invited to speak and has not replied yet. Check in with them warmly and ` +
            "briefly: make it easy to say a word or to pass. Never imply they are holding the group up."
          : params.reason === "BALANCE"
            ? `These members have not spoken yet: ${params.silentNames?.join(", ") || "some participants"}. Invite one of them in warmly and specifically, without naming them as being behind.`
            : "The discussion is drifting off topic. Gently steer it back with one pointed question.";

  const prompt = [
    `Topic: ${params.topic}`,
    intent,
    params.recent.length ? `Most recent contributions:\n${params.recent.map((r) => `- ${r}`).join("\n")}` : "",
    'Return JSON only: {"message":"<one sentence, at most 30 words>"}',
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
  return message.slice(0, 400);
}

/** Summarises the discussion so far into a short checkpoint. */
export async function draftSummary(params: { topic: string; transcript: string[] }): Promise<string> {
  const prompt = [
    `Topic: ${params.topic}`,
    "Summarise the discussion so far in at most three short sentences, noting the main points raised and any obvious gaps.",
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

/**
 * One pass of the live moderator. Safe to call repeatedly from any client:
 * the invitation record and the per-participant cooldowns suppress duplicate
 * work, so several browsers polling at once cannot ask two people at once.
 */
export async function runAssistantTick(discussionId: string): Promise<AssistantTickResult> {
  const result: AssistantTickResult = { classified: 0, eventsCreated: [] };

  if (!geminiAvailable()) {
    return { ...result, skipped: "ai-disabled" };
  }

  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      id: true,
      topic: true,
      context: true,
      status: true,
      aiEnabled: true,
      silencePromptSec: true,
      inviteResponseSec: true,
      conversationState: true,
      lastAiSpokeAt: true,
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
  await persistConversationState(discussionId, state, discussion.conversationState);
  result.conversationState = state;

  // --- 5. Act, but only in genuine, sustained silence -----------------------
  if (!mayModeratorSpeak(state) || outstanding > 0) return result;

  const budgetLeft =
    (await prisma.aiEvent.count({ where: { discussionId, source: "gemini" } })) < env.aiMaxCallsPerRoom;
  if (!budgetLeft) return result;

  const recent = segments.slice(-4).map((s) => `${s.participant.displayName}: ${s.text}`);

  if (!(await invitedTooRecently(discussionId, now))) {
    const candidate = pickInviteCandidate(participation.rows, { now });
    if (candidate) {
      await openInvitation({ discussionId, discussion, candidate, recent, now, result });
      return result;
    }
  }

  // Nobody is eligible to be asked — the floor keeps going round the same few
  // people. That is the moment a drift nudge is worth the room's attention.
  if (await shouldFlagDrift(discussionId, segments, now)) {
    const message = await safeMessage({ topic: discussion.topic, reason: "DRIFT", recent });
    if (message) {
      await prisma.aiEvent.create({
        data: { discussionId, kind: "RELEVANCE", message, source: "gemini" },
      });
      result.eventsCreated.push({ kind: "RELEVANCE", message });
    }
  }

  return result;
}

/** The context the state decision needs from the discussion row. */
type TickDiscussion = {
  id: string;
  topic: string;
  startedAt: Date | null;
  silencePromptSec: number;
  inviteResponseSec: number;
  conversationState: string;
  lastAiSpokeAt: Date | null;
};

/**
 * Works out what the room is doing from real audio activity first, the
 * transcript second, and the invitation record last.
 *
 * The ordering matters: a participant with a live audio report holds the floor
 * even before their sentence has been transcribed, which is the only way the
 * moderator can promise never to talk over them.
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
  const aiSpeaking = discussion.lastAiSpokeAt
    ? now - discussion.lastAiSpokeAt.getTime() <= AI_SPEAKING_STALE_MS
    : false;
  const heardSomeone = segments.length > 0;

  const activity: number[] = [];
  if (discussion.startedAt) activity.push(discussion.startedAt.getTime());
  for (const row of participation.rows) {
    if (!row.present) continue;
    if (row.lastAudioAt) activity.push(row.lastAudioAt.getTime());
    if (row.lastSpokeAt) activity.push(row.lastSpokeAt.getTime());
  }
  const lastActivity = activity.length > 0 ? Math.max(...activity) : now;
  const quietMs = Math.max(0, now - lastActivity);

  return decideConversationState({
    participantSpeaking,
    aiSpeaking,
    quietMs,
    silenceMs: discussion.silencePromptSec * 1000,
    countdownRunning: false,
    awaitingResponse,
    heardSomeone,
  });
}

/**
 * Settles every outstanding invitation against what has happened since it was
 * offered, in the order the outcomes should be considered:
 *
 *   - the participant spoke → answered, or passed, or reported a broken mic;
 *   - somebody else took the floor → the offer lapsed and is withdrawn, so it
 *     neither counts against them nor holds the room up;
 *   - the response window closed → one polite check-in, then, if still nothing,
 *     an unanswered invitation, which is the only outcome that is penalised.
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
        // The invitation never had a chance to be answered, so it is taken back
        // off the participant's record rather than counted against them.
        prisma.discussionParticipant.update({
          where: { id: invitation.participantId },
          data: { invitedCount: { decrement: 1 } },
        }),
      ]);
      continue;
    }

    if (now < invitation.respondByAt.getTime()) continue;

    if (invitation.prompts < MAX_INVITE_PROMPTS) {
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
        await prisma.aiEvent.create({
          data: {
            discussionId,
            participantId: invitation.participantId,
            kind: "NUDGE",
            message,
            source: "gemini",
            dueAt: nextBy,
          },
        });
        result.eventsCreated.push({ kind: "NUDGE", message, participantName });
      }
      continue;
    }

    // Asked twice and still nothing. This is the only outcome that costs a
    // participant anything, and it is deliberately small.
    await prisma.$transaction([
      prisma.invitation.update({ where: { id: invitation.id }, data: { status: "UNANSWERED" } }),
      prisma.discussionParticipant.update({
        where: { id: invitation.participantId },
        data: { unansweredInviteCount: { increment: 1 } },
      }),
    ]);
  }
}

/**
 * Settles one invitation against how the participant actually answered it.
 *
 * Exported because it is not only the tick that settles invitations: the
 * transcript route calls it the moment the invited participant speaks, so the
 * room's countdown stops on the same second the floor is taken rather than
 * waiting up to a full tick.
 *
 * The status is checked before anything is written, so a duplicate transcript
 * or a race between the route and the tick can never count one response twice,
 * and the record is only ever worth what the participant did once.
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

  return prisma.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({
      where: { id: invitationId },
      select: { status: true, aiEventId: true },
    });
    if (!invitation || invitation.status !== "PENDING") return false;

    await tx.invitation.update({
      where: { id: invitationId },
      data: { status, respondedAt: at, responseSegmentId: segmentId },
    });

    // The floor has been taken or the offer declined, so the countdown that
    // was scheduled for this invitation is over. Clearing the deadline is what
    // stops every browser counting down to a moment that has already passed.
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

    return true;
  });
}

/** Offers the floor to one participant and opens the record of that offer. */
async function openInvitation(params: {
  discussionId: string;
  discussion: TickDiscussion;
  candidate: ParticipationRow;
  recent: string[];
  now: number;
  result: AssistantTickResult;
}): Promise<void> {
  const { discussionId, discussion, candidate, recent, now, result } = params;

  const message = await safeMessage({
    topic: discussion.topic,
    reason: "PICK",
    recent,
    pickedName: candidate.displayName,
  });
  if (!message) return;

  const respondByAt = new Date(now + discussion.inviteResponseSec * 1000);

  // A transaction, with a re-check, so two clients ticking at the same instant
  // cannot both offer the floor: the second sees the first's invitation and
  // stands down.
  const created = await prisma.$transaction(async (tx) => {
    const existing = await tx.invitation.findFirst({
      where: { discussionId, status: "PENDING" },
      select: { id: true },
    });
    if (existing) return false;

    const event = await tx.aiEvent.create({
      data: {
        discussionId,
        participantId: candidate.participantId,
        kind: "NUDGE",
        message,
        source: "gemini",
        // The room counts down to this, so everybody sees the same deadline.
        dueAt: respondByAt,
      },
    });
    await tx.invitation.create({
      data: {
        discussionId,
        participantId: candidate.participantId,
        aiEventId: event.id,
        respondByAt,
      },
    });
    await tx.discussionParticipant.update({
      where: { id: candidate.participantId },
      data: { invitedCount: { increment: 1 }, lastInvitedAt: new Date(now) },
    });
    return true;
  });

  if (created) {
    result.eventsCreated.push({ kind: "NUDGE", message, participantName: candidate.displayName });
    // Record the moment the floor was handed over, so the room shows it while
    // the participant takes the floor rather than only after the next tick.
    await persistConversationState(discussionId, "PARTICIPANT_INVITED", discussion.conversationState);
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

/** Generates a message, degrading gracefully if Gemini is unavailable. */
async function safeMessage(params: {
  topic: string;
  reason: AssistantReason;
  recent: string[];
  silentNames?: string[];
  pickedName?: string;
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
