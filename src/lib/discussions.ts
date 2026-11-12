import { randomInt } from "node:crypto";
import { prisma } from "./prisma";
import { env } from "./env";

/**
 * Characters that are hard to confuse when read aloud or typed from a screenshot.
 * Excludes 0/O, 1/I/L and similar.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export function generateJoinCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** Allocates a collision-free join code (retries a few times before giving up). */
export async function generateUniqueJoinCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateJoinCode();
    const clash = await prisma.discussion.findUnique({
      where: { joinCode: code },
      select: { id: true },
    });
    if (!clash) return code;
  }
  throw new Error("Could not allocate a unique join code. Please try again.");
}

export function inviteUrl(joinCode: string): string {
  return `${env.appUrl}/join?code=${joinCode}`;
}

/** Statuses in which a participant may still enter the room. */
export const JOINABLE_STATUSES = ["SCHEDULED", "LIVE"] as const;

export type DiscussionAccess = {
  discussion: NonNullable<Awaited<ReturnType<typeof loadDiscussion>>>;
  isHost: boolean;
  isMember: boolean;
};

async function loadDiscussion(id: string) {
  return prisma.discussion.findUnique({
    where: { id },
    include: {
      host: { select: { id: true, name: true, email: true } },
      participants: {
        orderBy: [{ isHost: "desc" }, { createdAt: "asc" }],
        include: { user: { select: { id: true, name: true, email: true } } },
      },
      _count: { select: { segments: true, evaluations: true } },
    },
  });
}

/**
 * Loads a discussion and checks that `userId` may see it.
 * Returns null when the discussion does not exist or the user has no access.
 */
export async function loadDiscussionForUser(
  id: string,
  userId: string,
): Promise<DiscussionAccess | null> {
  const discussion = await loadDiscussion(id);
  if (!discussion) return null;

  const isHost = discussion.hostId === userId;
  const isMember = discussion.participants.some((p) => p.userId === userId);
  if (!isHost && !isMember) return null;

  return { discussion, isHost, isMember };
}

/** Public preview of a discussion, used before a participant commits to joining. */
export async function previewByJoinCode(code: string) {
  const discussion = await prisma.discussion.findUnique({
    where: { joinCode: code.toUpperCase() },
    include: {
      host: { select: { name: true } },
      _count: { select: { participants: true } },
    },
  });
  if (!discussion) return null;
  return {
    id: discussion.id,
    title: discussion.title,
    topic: discussion.topic,
    context: discussion.context,
    rules: discussion.rules,
    status: discussion.status,
    mode: discussion.mode,
    scheduledAt: discussion.scheduledAt,
    durationMin: discussion.durationMin,
    maxParticipants: discussion.maxParticipants,
    participantCount: discussion._count.participants,
    hostName: discussion.host.name,
    allowNewJoiners:
      (JOINABLE_STATUSES as readonly string[]).includes(discussion.status) &&
      discussion._count.participants < discussion.maxParticipants,
  };
}
