import { describe, expect, it } from "vitest";
import { allocateSeat, headPosition, seatPosition } from "@/lib/seats";

describe("seat allocation", () => {
  describe("allocateSeat", () => {
    it("gives the first seat in an empty room", () => {
      expect(allocateSeat([], 8)).toBe(1);
    });

    it("gives the next free seat after the occupied ones", () => {
      expect(allocateSeat([1, 2], 8)).toBe(3);
    });

    it("fills a gap rather than disturbing existing seats", () => {
      expect(allocateSeat([1, 3, 4], 8)).toBe(2);
    });

    it("ignores released seats and seats outside the room", () => {
      expect(allocateSeat([null, undefined, 0, -1, 99], 4)).toBe(1);
    });

    it("returns null when every seat is taken", () => {
      expect(allocateSeat([1, 2, 3], 3)).toBeNull();
    });

    it("never hands out the same seat twice", () => {
      const taken: number[] = [];
      for (let guest = 0; guest < 12; guest += 1) {
        const seat = allocateSeat(taken, 12);
        expect(seat).not.toBeNull();
        expect(taken).not.toContain(seat);
        taken.push(seat as number);
      }
      expect(taken.sort((a, b) => a - b)).toEqual([...Array(12)].map((_, i) => i + 1));
    });
  });

  describe("seatPosition", () => {
    it("starts at the moderator's left and finishes at their right", () => {
      const first = seatPosition(0, 8);
      const last = seatPosition(7, 8);
      expect(first.left).toBeGreaterThan(50);
      expect(last.left).toBeLessThan(50);
      expect(first.top).toBeCloseTo(last.top, 5);
    });

    it("keeps every seat inside the room view", () => {
      for (let total = 2; total <= 30; total += 1) {
        for (let index = 0; index < total; index += 1) {
          const { left, top } = seatPosition(index, total);
          expect(left).toBeGreaterThan(0);
          expect(left).toBeLessThan(100);
          expect(top).toBeGreaterThan(0);
          expect(top).toBeLessThan(100);
        }
      }
    });

    it("leaves the head of the table clear for the moderator", () => {
      const head = headPosition();
      for (let total = 2; total <= 30; total += 1) {
        for (let index = 0; index < total; index += 1) {
          expect(seatPosition(index, total).top).toBeGreaterThan(head.top + 5);
        }
      }
    });

    it("gives every seat its own place", () => {
      const positions = [...Array(10)].map((_, index) => seatPosition(index, 10));
      const unique = new Set(positions.map((p) => `${p.left},${p.top}`));
      expect(unique.size).toBe(positions.length);
    });

    it("moves a seat towards the middle of the table as the spread shrinks", () => {
      const edge = seatPosition(0, 8);
      const inner = seatPosition(0, 8, 0.5);
      expect(inner.left).toBeGreaterThan(50);
      expect(inner.left).toBeLessThan(edge.left);
      expect(inner.top).toBeGreaterThan(edge.top);
      expect(inner.top).toBeLessThan(50);
    });

    it("falls back to the middle when there are no seats", () => {
      expect(seatPosition(0, 0)).toEqual({ left: 50, top: 50 });
    });
  });

  describe("headPosition", () => {
    it("sits at the top of the table", () => {
      const head = headPosition();
      expect(head.left).toBe(50);
      expect(head.top).toBeLessThan(50);
    });
  });
});
