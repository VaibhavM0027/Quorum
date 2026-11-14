/**
 * Breakout rooms.
 *
 * A large discussion can be split into smaller groups so that everyone gets a
 * turn to speak. The number of rooms follows from how many students are
 * actually present and the group size the host configured, so the split adapts
 * as people arrive rather than being fixed when the discussion was created.
 *
 * Everything here is pure: these functions decide *who goes where* and nothing
 * else. Persisting the decision is the caller's job (see `assignBreakoutRooms`
 * in `discussions.ts`). Because the room UI imports the same functions, the
 * host's view of the allocation is the server's own arithmetic rather than a
 * second, disagreeing implementation.
 */

/** Smallest group a room may be sized to. */
export const MIN_GROUP_SIZE = 2;
/** Largest group a room may be sized to. */
export const MAX_GROUP_SIZE = 30;

/** A discussion member, as far as room allocation is concerned. */
export type BreakoutMember = {
  id: string;
  /** The room they are already in, or null if nobody has placed them yet. */
  breakoutRoom: number | null;
  isHost: boolean;
  removed: boolean;
  /** True once they have left for good, which frees their place in a room. */
  left: boolean;
  /**
   * Their seat at the main table. Used only to order students predictably —
   * seat 1 first — so the same people always end up in the same order.
   */
  seatNumber: number | null;
};

/** A member as the room UI sees them: an id, a name and their seat. */
export type BreakoutViewMember = BreakoutMember & { name: string };

export type BreakoutRoomView = {
  number: number;
  members: BreakoutViewMember[];
};

export type BreakoutAllocation = {
  /** Whether the host has switched breakout rooms on. */
  enabled: boolean;
  /** The configured group size. */
  groupSize: number;
  /** How many rooms the present students need. */
  roomCount: number;
  /** Roughly how many go in each room: rooms differ by at most one. */
  evenSize: number;
  /** Students taking part, i.e. everyone except the moderator and absentees. */
  studentCount: number;
  rooms: BreakoutRoomView[];
};

/** Keeps a configured group size inside the range the schema allows. */
export function clampGroupSize(groupSize: number): number {
  if (!Number.isFinite(groupSize)) return MAX_GROUP_SIZE;
  return Math.min(MAX_GROUP_SIZE, Math.max(MIN_GROUP_SIZE, Math.trunc(groupSize)));
}

/**
 * Students who take part in a breakout. The moderator sits it out — they stay
 * in the main room — and someone who has left or been removed is not counted,
 * so their departure can shrink the number of rooms rather than leaving an
 * empty one behind.
 */
export function breakoutEligible(member: BreakoutMember): boolean {
  return !member.isHost && !member.removed && !member.left;
}

/** How many rooms `participantCount` students split into at this group size. */
export function breakoutRoomCount(participantCount: number, groupSize: number): number {
  if (participantCount <= 0) return 0;
  return Math.ceil(participantCount / clampGroupSize(groupSize));
}

/** The most rooms the given students could ever need, given the schema's cap. */
const MAX_ROOMS = Math.ceil(1000 / MIN_GROUP_SIZE);

/** Ordered by table seat, then by id so the result never depends on query order. */
function inSeatOrder(members: BreakoutMember[]): BreakoutMember[] {
  return [...members].sort((a, b) => {
    const seatA = a.seatNumber ?? Number.MAX_SAFE_INTEGER;
    const seatB = b.seatNumber ?? Number.MAX_SAFE_INTEGER;
    if (seatA !== seatB) return seatA - seatB;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The room holding the fewest students, lowest number wins a tie. */
function emptiestRoom(counts: number[], roomCount: number): number {
  let best = 1;
  for (let room = 2; room <= roomCount; room += 1) {
    if (counts[room] < counts[best]) best = room;
  }
  return best;
}

/**
 * Works out which room each student belongs to.
 *
 * Places already held are honoured, so a room is never disturbed unless the
 * host asks for it, and anyone without a room — a late arrival, someone just
 * restored — goes to the emptiest one. That is also exactly how a fresh set of
 * students is spread, so passing members with no placements at all produces an
 * even round-robin distribution: 24 students at a group size of 8 become
 * 8/8/8.
 *
 * A placement is only kept while its room still exists. If people leave and the
 * room count shrinks, the students who were in a room that no longer exists are
 * placed again like anybody else.
 */
export function planBreakoutRooms(
  members: BreakoutMember[],
  groupSize: number,
): Map<string, number> {
  const ordered = inSeatOrder(members.filter(breakoutEligible));
  const plan = new Map<string, number>();
  const roomCount = breakoutRoomCount(ordered.length, groupSize);
  if (roomCount <= 0) return plan;

  // counts[0] is a spare slot so room numbers can be used as indexes directly.
  const counts = new Array<number>(roomCount + 1).fill(0);

  for (const member of ordered) {
    const room = member.breakoutRoom;
    if (room !== null && room >= 1 && room <= roomCount) {
      plan.set(member.id, room);
      counts[room] += 1;
    }
  }

  for (const member of ordered) {
    if (plan.has(member.id)) continue;
    const room = emptiestRoom(counts, roomCount);
    plan.set(member.id, room);
    counts[room] += 1;
  }

  return plan;
}

/**
 * The allocation as the room UI shows it: rooms in order, each with its
 * students.
 *
 * When breakout rooms are off the stored rooms are all null, so this renders
 * the plan the host *would* get — the same view they see the moment they switch
 * them on, and the numbers behind "Automatically create room 1, 2, 3…".
 */
export function breakoutAllocation(
  members: BreakoutViewMember[],
  enabled: boolean,
  groupSize: number,
): BreakoutAllocation {
  const size = clampGroupSize(groupSize);
  const students = members.filter(breakoutEligible);
  const plan = planBreakoutRooms(members, size);

  const highest = Math.min(
    MAX_ROOMS,
    [...plan.values()].reduce((max, room) => Math.max(max, room), 0),
  );
  const roomCount = Math.max(breakoutRoomCount(students.length, size), highest);

  const rooms: BreakoutRoomView[] = Array.from({ length: roomCount }, (_, index) => ({
    number: index + 1,
    members: [],
  }));
  const byNumber = new Map(rooms.map((room) => [room.number, room]));

  for (const member of inSeatOrder(students) as BreakoutViewMember[]) {
    const room = byNumber.get(plan.get(member.id) ?? 0);
    if (room) room.members.push(member);
  }

  return {
    enabled,
    groupSize: size,
    roomCount,
    evenSize: roomCount > 0 ? Math.ceil(students.length / roomCount) : 0,
    studentCount: students.length,
    rooms,
  };
}
