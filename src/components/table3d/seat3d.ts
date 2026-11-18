/**
 * Pure math & deterministic appearance helpers for the 3D round-table view.
 * Zero React or Three.js imports so every calculation is directly unit-testable.
 */

export const MIN_SEAT_SPACING = 1.15;
export const MIN_RING_RADIUS = 2.4;
export const HEAD_HEIGHT = 1.48;
export const FOCUS_CAMERA_DISTANCE = 2.5;
export const FOCUS_CAMERA_HEIGHT = 2.05;

export type WorldPoint = { x: number; z: number };

export type CameraPose = {
  position: [number, number, number];
  target: [number, number, number];
};

export type CharacterAppearance = {
  skinColor: string;
  hairColor: string;
  shirtColor: string;
  hairStyle: "short" | "bob" | "curly" | "bun";
  hasGlasses: boolean;
};

export const SKIN_PALETTE = [
  "#f6d6be",
  "#eab996",
  "#d69e74",
  "#b87c54",
  "#8d5738",
  "#5f3a26",
] as const;

export const HAIR_PALETTE = [
  "#1e1a18",
  "#3b2820",
  "#6e472b",
  "#a67541",
  "#c9a26b",
  "#4c4f57",
] as const;

export const SHIRT_PALETTE = [
  "#2f6f5e",
  "#356c8a",
  "#7a528a",
  "#a4583c",
  "#4d6b45",
  "#3e5578",
  "#8c6a32",
  "#7b465c",
] as const;

export const HAIR_STYLES = ["short", "bob", "curly", "bun"] as const;

export function computeRingRadius(count: number): number {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount <= 1) return MIN_RING_RADIUS;
  return Math.max(MIN_RING_RADIUS, (MIN_SEAT_SPACING * safeCount) / (2 * Math.PI));
}

export function computeTableRadius(ringRadius: number): number {
  return Math.max(1.2, ringRadius - 0.9);
}

/**
 * Places `count` seats evenly on a circle of `ringRadius`.
 * When `selfIndex` is provided, that seat lands at `+z` (nearest the camera).
 * When `selfIndex` is null, seat 0 lands at `-z` (head of table).
 */
export function seatWorldPosition(
  index: number,
  count: number,
  selfIndex: number | null,
  ringRadius: number,
): WorldPoint {
  if (count <= 0) return { x: 0, z: ringRadius };
  const step = (Math.PI * 2) / count;
  const baseAngle = selfIndex !== null ? Math.PI / 2 - selfIndex * step : -Math.PI / 2;
  const angle = baseAngle + index * step;
  return {
    x: Math.cos(angle) * ringRadius,
    z: Math.sin(angle) * ringRadius,
  };
}

/** Y-axis rotation (radians) so a character facing local +Z looks directly at the origin. */
export function facingOriginAngle(worldX: number, worldZ: number): number {
  return Math.atan2(-worldX, -worldZ);
}

export function overviewCameraPose(ringRadius: number): CameraPose {
  const dist = ringRadius * 2.15 + 1.8;
  const elevation = ringRadius * 1.35 + 1.6;
  return {
    position: [0, elevation, dist],
    target: [0, 0.65, 0],
  };
}

/**
 * Places the focus camera on the inner side of the table, above head height,
 * at a constant `FOCUS_CAMERA_DISTANCE` from the speaker's head.
 */
export function focusCameraPose(worldX: number, worldZ: number): CameraPose {
  const len = Math.hypot(worldX, worldZ) || 1;
  const ux = -worldX / len;
  const uz = -worldZ / len;
  const dy = FOCUS_CAMERA_HEIGHT - HEAD_HEIGHT;
  const horiz = Math.sqrt(Math.max(0.25, FOCUS_CAMERA_DISTANCE * FOCUS_CAMERA_DISTANCE - dy * dy));
  return {
    position: [worldX + ux * horiz, FOCUS_CAMERA_HEIGHT, worldZ + uz * horiz],
    target: [worldX, HEAD_HEIGHT, worldZ],
  };
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function appearanceFromUserId(userId: string): CharacterAppearance {
  const h1 = fnv1a(userId);
  const h2 = fnv1a(`${userId}:hair`);
  const h3 = fnv1a(`${userId}:shirt`);
  const h4 = fnv1a(`${userId}:style`);
  return {
    skinColor: SKIN_PALETTE[h1 % SKIN_PALETTE.length],
    hairColor: HAIR_PALETTE[h2 % HAIR_PALETTE.length],
    shirtColor: SHIRT_PALETTE[h3 % SHIRT_PALETTE.length],
    hairStyle: HAIR_STYLES[h4 % HAIR_STYLES.length],
    hasGlasses: (h4 >>> 8) % 4 === 0,
  };
}
