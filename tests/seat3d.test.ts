import { describe, expect, it } from "vitest";
import {
  FOCUS_CAMERA_DISTANCE,
  HAIR_PALETTE,
  HEAD_HEIGHT,
  MIN_SEAT_SPACING,
  SHIRT_PALETTE,
  SKIN_PALETTE,
  appearanceFromUserId,
  computeRingRadius,
  facingOriginAngle,
  focusCameraPose,
  seatWorldPosition,
} from "@/components/table3d/seat3d";

describe("3D round-table seating & camera math", () => {
  it("places every seat on ringRadius with no NaNs and self at +z", () => {
    let prevRadius = 0;
    for (const count of [0, 1, 2, 6, 40]) {
      const r = computeRingRadius(count);
      expect(r).toBeGreaterThanOrEqual(prevRadius);
      prevRadius = r;

      if (count === 0) continue;
      const selfIndex = Math.min(1, count - 1);
      const points = Array.from({ length: count }, (_, i) =>
        seatWorldPosition(i, count, selfIndex, r),
      );

      for (const p of points) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.z)).toBe(true);
        expect(Math.hypot(p.x, p.z)).toBeCloseTo(r, 4);
      }

      expect(points[selfIndex].z).toBeGreaterThan(0);

      if (count >= 2) {
        for (let i = 0; i < count; i += 1) {
          const a = points[i];
          const b = points[(i + 1) % count];
          const dist = Math.hypot(a.x - b.x, a.z - b.z);
          expect(dist).toBeGreaterThanOrEqual(MIN_SEAT_SPACING - 0.02);
        }
      }
    }
  });

  it("faces every character toward the origin", () => {
    const r = computeRingRadius(8);
    for (let i = 0; i < 8; i += 1) {
      const p = seatWorldPosition(i, 8, 0, r);
      const angle = facingOriginAngle(p.x, p.z);
      const fx = Math.sin(angle);
      const fz = Math.cos(angle);
      const dot = fx * (-p.x / r) + fz * (-p.z / r);
      expect(dot).toBeCloseTo(1, 5);
    }
  });

  it("computes finite focus camera poses at constant distance above head height", () => {
    const r = computeRingRadius(10);
    for (let i = 0; i < 10; i += 1) {
      const p = seatWorldPosition(i, 10, 0, r);
      const pose = focusCameraPose(p.x, p.z);
      for (const v of [...pose.position, ...pose.target]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(pose.position[1]).toBeGreaterThan(HEAD_HEIGHT);
      const dist = Math.hypot(
        pose.position[0] - pose.target[0],
        pose.position[1] - pose.target[1],
        pose.position[2] - pose.target[2],
      );
      expect(dist).toBeCloseTo(FOCUS_CAMERA_DISTANCE, 4);
    }
  });

  it("produces deterministic, well-distributed character appearances", () => {
    const a = appearanceFromUserId("user-abc-123");
    const b = appearanceFromUserId("user-abc-123");
    expect(a).toEqual(b);

    const skins = new Map<string, number>();
    const hairs = new Map<string, number>();
    const shirts = new Map<string, number>();
    for (let i = 0; i < 1000; i += 1) {
      const look = appearanceFromUserId(`participant-${i}-seed`);
      skins.set(look.skinColor, (skins.get(look.skinColor) ?? 0) + 1);
      hairs.set(look.hairColor, (hairs.get(look.hairColor) ?? 0) + 1);
      shirts.set(look.shirtColor, (shirts.get(look.shirtColor) ?? 0) + 1);
    }

    for (const c of SKIN_PALETTE) expect(skins.get(c) ?? 0).toBeGreaterThan(20);
    for (const c of HAIR_PALETTE) expect(hairs.get(c) ?? 0).toBeGreaterThan(20);
    for (const c of SHIRT_PALETTE) expect(shirts.get(c) ?? 0).toBeGreaterThan(20);
  });
});
