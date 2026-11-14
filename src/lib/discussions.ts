import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { env } from "./env";
import { allocateSeat } from "./seats";
import { clampGroupSize, planBreakoutRooms, type BreakoutMember } from "./breakout";

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

/** Seats currently held in a room. The host holds none: they sit at the head. */
async function takenSeats(discussionId: string): Promise<number[]> {
  const rows = await prisma.discussionParticipant.findMany({
    where: { discussionId, seatNumber: { not: null } },
    select: { seatNumber: true },
  });
  return rows.map((row) => row.seatNumber as number);
}

/**
 * Gives a member the lowest free seat in the room.
 *
 * Returns the seat they already hold, so joining twice is harmless. Two people
 * can be allocated the same number at the same instant; the unique seat index
 * rejects the loser and the allocation is retried against the new occupancy.
 */
export async function assignSeat(
  discussionId: string,
  participantId: string,
  maxSeats: number,
): Promise<number | null> {
  const member = await prisma.discussionParticipant.findUnique({
    where: { id: participantId },
    select: { seatNumber: true, isHost: true, leftAt: true, removed: true },
  });
  if (!member) return null;
  // The moderator is not numbered, and someone who left or was removed gives
  // their seat up.
  if (member.isHost || member.removed || member.leftAt) return member.seatNumber;
  if (member.seatNumber !== null) return member.seatNumber;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const seat = allocateSeat(await takenSeats(discussionId), maxSeats);
    if (seat === null) return null;
    try {
      await prisma.discussionParticipant.update({
        where: { id: participantId },
        data: { seatNumber: seat },
      });
      return seat;
    } catch (error) {
      const clash =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (!clash) throw error;
    }
  }
  return null;
}

/** Seats every active member of a room that does not have one yet. Idempotent. */
export async function assignMissingSeats(discussionId: string, maxSeats: number): Promise<void> {
  const members = await prisma.discussionParticipant.findMany({
    where: { discussionId, seatNumber: null, removed: false, leftAt: null, isHost: false },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  for (const member of members) {
    await assignSeat(discussionId, member.id, maxSeats);
  }
}

/** Frees the seat a member held. Their transcript stays part of the record. */
export async function releaseSeat(discussionId: string, participantId: string): Promise<void> {
  await prisma.discussionParticipant.updateMany({
    where: { id: participantId, discussionId, seatNumber: { not: null } },
    data: { seatNumber: null },
  });
}

/**
 * Recomputes who belongs in which breakout room and stores the result.
 *
 * Safe to call at any time and the single place the allocation is written, so
 * the room the database holds can never drift from the arithmetic in
 * `planBreakoutRooms` — which is the same code the host's allocation view runs.
 *
 * Existing placements are preserved, so calling this when somebody arrives
 * seats just that person in the emptiest room instead of shuffling everybody.
 * With breakout rooms switched off it simply clears the rooms.
 */
export async function assignBreakoutRooms(discussionId: string): Promise<void> {
  const discussion = await prisma.discussion.findUnique({
    where: { id: discussionId },
    select: {
      breakoutEnabled: true,
      breakoutGroupSize: true,
      participants: {
        select: {
          id: true,
          breakoutRoom: true,
          isHost: true,
          removed: true,
          leftAt: true,
          seatNumber: true,
        },
      },
    },
  });
  if (!discussion) return;

  if (!discussion.breakoutEnabled) {
    await prisma.discussionParticipant.updateMany({
      where: { discussionId, breakoutRoom: { not: null } },
      data: { breakoutRoom: null },
    });
    return;
  }

  const members: BreakoutMember[] = discussion.participants.map((p) => ({
    id: p.id,
    breakoutRoom: p.breakoutRoom,
    isHost: p.isHost,
    removed: p.removed,
    left: p.leftAt !== null,
    seatNumber: p.seatNumber,
  }));

  const plan = planBreakoutRooms(members, clampGroupSize(discussion.breakoutGroupSize));

  // Only rows whose room actually changed are written.
  for (const p of discussion.participants) {
    const next = plan.get(p.id) ?? null;
    if (next === p.breakoutRoom) continue;
    await prisma.discussionParticipant.update({
      where: { id: p.id },
      data: { breakoutRoom: next },
    });
  }
}

/**
 * Moves one student to a room the host picked.
 *
 * A deliberate move is written as given and deliberately not rebalanced
 * afterwards: re-running the allocator would immediately undo it.
 */
export async function moveParticipantToRoom(
  discussionId: string,
  participantId: string,
  room: number,
): Promise<void> {
  await prisma.discussionParticipant.updateMany({
    where: { id: participantId, discussionId, isHost: false },
    data: { breakoutRoom: room },
  });
}

/** Sends every student back through the allocator for a fresh even split. */
export async function reshuffleBreakoutRooms(discussionId: string): Promise<void> {
  await prisma.discussionParticipant.updateMany({
    where: { discussionId, isHost: false },
    data: { breakoutRoom: null },
  });
  await assignBreakoutRooms(discussionId);
}

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

  // Seating is guaranteed for everybody in the room, including members that were
  // added before seats existed. Once every member has a seat this is a no-op.
  const unseated = discussion.participants.some(
    (p) => !p.removed && !p.isHost && !p.leftAt && p.seatNumber === null,
  );
  if (unseated) {
    await assignMissingSeats(discussion.id, discussion.maxParticipants);
    const reseated = await loadDiscussion(id);
    if (reseated) return { discussion: reseated, isHost, isMember };
  }

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
