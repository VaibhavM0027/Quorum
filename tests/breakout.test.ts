import { describe, expect, it } from "vitest";
import {
  MAX_GROUP_SIZE,
  MIN_GROUP_SIZE,
  breakoutAllocation,
  breakoutRoomCount,
  clampGroupSize,
  planBreakoutRooms,
  type BreakoutMember,
} from "@/lib/breakout";
import { breakoutControlSchema } from "@/lib/validation";

/** A student with sensible defaults, so each test states only what it cares about. */
function member(id: string, overrides: Partial<BreakoutMember> = {}): BreakoutMember {
  return {
    id,
    breakoutRoom: null,
    isHost: false,
    removed: false,
    left: false,
    seatNumber: null,
    ...overrides,
  };
}

/** `count` students sitting in seats 1..count. */
function seated(count: number, from = 1): BreakoutMember[] {
  return Array.from({ length: count }, (_, index) =>
    member(`s${from + index}`, { seatNumber: from + index }),
  );
}

describe("breakout rooms", () => {
  describe("clampGroupSize", () => {
    it("keeps a group size inside the range the schema allows", () => {
      expect(clampGroupSize(MIN_GROUP_SIZE - 1)).toBe(MIN_GROUP_SIZE);
      expect(clampGroupSize(MAX_GROUP_SIZE + 1)).toBe(MAX_GROUP_SIZE);
    });

    it("passes a sensible size through unchanged", () => {
      expect(clampGroupSize(8)).toBe(8);
    });

    it("truncates a fractional size", () => {
      expect(clampGroupSize(8.7)).toBe(8);
    });

    it("falls back to the largest group when the size is not a number", () => {
      expect(clampGroupSize(Number.NaN)).toBe(MAX_GROUP_SIZE);
      expect(clampGroupSize(Number.POSITIVE_INFINITY)).toBe(MAX_GROUP_SIZE);
    });
  });

  describe("breakoutRoomCount", () => {
    it("needs no rooms for an empty room", () => {
      expect(breakoutRoomCount(0, 8)).toBe(0);
      expect(breakoutRoomCount(-4, 8)).toBe(0);
    });

    it("needs one room while the group still fits", () => {
      expect(breakoutRoomCount(8, 8)).toBe(1);
      expect(breakoutRoomCount(1, 8)).toBe(1);
    });

    it("opens another room as soon as the group overflows", () => {
      expect(breakoutRoomCount(9, 8)).toBe(2);
      expect(breakoutRoomCount(24, 8)).toBe(3);
    });
  });

  describe("planBreakoutRooms", () => {
    it("splits 24 students at a group size of 8 into three groups of 8", () => {
      const plan = planBreakoutRooms(seated(24), 8);
      const counts = [1, 2, 3].map(
        (room) => [...plan.values()].filter((value) => value === room).length,
      );
      expect(counts).toEqual([8, 8, 8]);
    });

    it("never puts the same student in two rooms", () => {
      const students = seated(24);
      const plan = planBreakoutRooms(students, 8);
      expect(plan.size).toBe(students.length);
    });

    it("spreads everyone as evenly as the group size allows", () => {
      const plan = planBreakoutRooms(seated(10), 4);
      const counts = [1, 2, 3].map(
        (room) => [...plan.values()].filter((value) => value === room).length,
      );
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    });

    it("leaves the moderator out — they stay in the main room", () => {
      const host = member("host", { isHost: true });
      const plan = planBreakoutRooms([host, ...seated(6)], 3);
      expect(plan.has("host")).toBe(false);
      expect(plan.size).toBe(6);
    });

    it("does not count a removed or departed student", () => {
      const plan = planBreakoutRooms(
        [member("gone", { left: true }), member("kicked", { removed: true }), ...seated(4)],
        4,
      );
      expect(plan.has("gone")).toBe(false);
      expect(plan.has("kicked")).toBe(false);
      expect(plan.size).toBe(4);
    });

    it("leaves a room that is already talking undisturbed", () => {
      // Six students at a group size of three is two rooms; both are settled.
      const settled = [
        member("a", { breakoutRoom: 1, seatNumber: 1 }),
        member("b", { breakoutRoom: 1, seatNumber: 2 }),
        member("c", { breakoutRoom: 1, seatNumber: 3 }),
        member("d", { breakoutRoom: 2, seatNumber: 4 }),
        member("e", { breakoutRoom: 2, seatNumber: 5 }),
        member("f", { breakoutRoom: 2, seatNumber: 6 }),
      ];
      expect(planBreakoutRooms(settled, 3)).toEqual(
        new Map([
          ["a", 1],
          ["b", 1],
          ["c", 1],
          ["d", 2],
          ["e", 2],
          ["f", 2],
        ]),
      );
    });

    it("sends a late arrival to the emptiest room", () => {
      const rooms = [
        member("a", { breakoutRoom: 1, seatNumber: 1 }),
        member("b", { breakoutRoom: 1, seatNumber: 2 }),
        member("c", { breakoutRoom: 1, seatNumber: 3 }),
        member("d", { breakoutRoom: 1, seatNumber: 4 }),
        member("e", { breakoutRoom: 1, seatNumber: 5 }),
        member("f", { breakoutRoom: 2, seatNumber: 6 }),
        member("g", { breakoutRoom: 2, seatNumber: 7 }),
        member("h", { breakoutRoom: 2, seatNumber: 8 }),
      ];
      const plan = planBreakoutRooms([...rooms, member("late", { seatNumber: 9 })], 5);
      expect(plan.get("late")).toBe(2);
    });

    it("re-places anyone left in a room that no longer exists", () => {
      // Twelve students at a group size of three is four rooms of three.
      const fourRooms = [
        member("a1", { breakoutRoom: 1, seatNumber: 1 }),
        member("a2", { breakoutRoom: 1, seatNumber: 2 }),
        member("a3", { breakoutRoom: 1, seatNumber: 3 }),
        member("b1", { breakoutRoom: 2, seatNumber: 4 }),
        member("b2", { breakoutRoom: 2, seatNumber: 5 }),
        member("b3", { breakoutRoom: 2, seatNumber: 6 }),
        member("c1", { breakoutRoom: 3, seatNumber: 7 }),
        member("c2", { breakoutRoom: 3, seatNumber: 8 }),
        member("c3", { breakoutRoom: 3, seatNumber: 9 }),
        member("d1", { breakoutRoom: 4, seatNumber: 10 }),
        member("d2", { breakoutRoom: 4, seatNumber: 11 }),
        member("d3", { breakoutRoom: 4, seatNumber: 12 }),
      ];
      // Three students leave, so nine remain and four rooms collapse to three.
      const gone = new Set(["a3", "b3", "d3"]);
      const remaining = fourRooms.map((student) =>
        gone.has(student.id) ? { ...student, left: true } : student,
      );
      const plan = planBreakoutRooms(remaining, 3);

      expect(plan.size).toBe(9);
      expect(plan.has("d3")).toBe(false);
      // Room 4 is gone, so the two who were waiting there move to a room that exists.
      expect(Math.max(...plan.values())).toBe(3);
      expect(plan.get("d1")).not.toBe(4);
      expect(plan.get("d2")).not.toBe(4);
    });

    it("keeps the same people together however the rows are ordered", () => {
      const students = seated(12);
      const plan = planBreakoutRooms(students, 6);
      const shuffled = planBreakoutRooms([...students].reverse(), 6);
      expect([...shuffled.entries()].sort()).toEqual([...plan.entries()].sort());
    });
  });

  describe("breakoutAllocation", () => {
    it("shows the split behind 'create room 1, 2, 3…'", () => {
      const allocation = breakoutAllocation(
        seated(24).map((student) => ({ ...student, name: student.id })),
        true,
        8,
      );
      expect(allocation.enabled).toBe(true);
      expect(allocation.studentCount).toBe(24);
      expect(allocation.groupSize).toBe(8);
      expect(allocation.roomCount).toBe(3);
      expect(allocation.evenSize).toBe(8);
      expect(allocation.rooms.map((room) => room.number)).toEqual([1, 2, 3]);
      expect(allocation.rooms.every((room) => room.members.length === 8)).toBe(true);
    });

    it("orders each room by table seat", () => {
      const allocation = breakoutAllocation(
        seated(6).map((student) => ({ ...student, name: student.id })),
        true,
        3,
      );
      expect(allocation.rooms[0].members.map((m) => m.seatNumber)).toEqual([1, 3, 5]);
      expect(allocation.rooms[1].members.map((m) => m.seatNumber)).toEqual([2, 4, 6]);
    });

    it("names nobody twice across the rooms", () => {
      const allocation = breakoutAllocation(
        seated(24).map((student) => ({ ...student, name: student.id })),
        true,
        8,
      );
      const names = allocation.rooms.flatMap((room) => room.members.map((m) => m.name));
      expect(new Set(names).size).toBe(24);
    });

    it("keeps the moderator out of every room", () => {
      const allocation = breakoutAllocation(
        [{ ...member("host", { isHost: true }), name: "Host" }, ...seated(6).map((s) => ({ ...s, name: s.id }))],
        true,
        3,
      );
      const names = allocation.rooms.flatMap((room) => room.members.map((m) => m.name));
      expect(names).not.toContain("Host");
      expect(allocation.studentCount).toBe(6);
    });

    it("shows the split the host would get while the rooms are still off", () => {
      const allocation = breakoutAllocation(
        seated(9).map((student) => ({ ...student, name: student.id })),
        false,
        4,
      );
      expect(allocation.enabled).toBe(false);
      expect(allocation.roomCount).toBe(3);
    });

    it("offers no rooms when nobody is present", () => {
      const allocation = breakoutAllocation([], true, 8);
      expect(allocation.roomCount).toBe(0);
      expect(allocation.rooms).toEqual([]);
      expect(allocation.evenSize).toBe(0);
    });
  });

  describe("breakoutControlSchema", () => {
    it("accepts enabling with a group size", () => {
      expect(breakoutControlSchema.parse({ action: "enable", groupSize: 6 })).toEqual({
        action: "enable",
        groupSize: 6,
      });
    });

    it("accepts enabling without a group size", () => {
      expect(breakoutControlSchema.parse({ action: "enable" })).toEqual({ action: "enable" });
    });

    it("accepts disable and reshuffle", () => {
      expect(breakoutControlSchema.parse({ action: "disable" })).toEqual({ action: "disable" });
      expect(breakoutControlSchema.parse({ action: "reshuffle" })).toEqual({ action: "reshuffle" });
    });

    it("accepts a move", () => {
      expect(
        breakoutControlSchema.parse({ action: "move", participantId: "p1", room: 2 }),
      ).toEqual({ action: "move", participantId: "p1", room: 2 });
    });

    it("rejects a group size outside the allowed range", () => {
      expect(() => breakoutControlSchema.parse({ action: "enable", groupSize: 1 })).toThrow();
      expect(() => breakoutControlSchema.parse({ action: "enable", groupSize: 99 })).toThrow();
    });

    it("rejects a move without a participant", () => {
      expect(() => breakoutControlSchema.parse({ action: "move", room: 2 })).toThrow();
    });

    it("rejects an unknown action", () => {
      expect(() => breakoutControlSchema.parse({ action: "explode" })).toThrow();
    });
  });
});
