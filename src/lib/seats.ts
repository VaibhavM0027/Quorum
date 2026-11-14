/**
 * Numbered seats at the discussion table.
 *
 * A seat belongs to the student, not to their browser session: it is stored on
 * the participant row, so someone who reloads the page, drops off the network or
 * moves to another device comes back to the same chair. Only a permanent leave
 * (or the host removing them) frees a seat for the next person.
 *
 * Students are numbered 1..maxSeats around the table and are laid out clockwise
 * from the head. The host is not numbered: they moderate from their own
 * distinguishable place at the head of the table.
 */

/**
 * Lowest seat number in `1..maxSeats` that nobody occupies, or null when every
 * seat is taken.
 *
 * Picking the lowest free number keeps a late arrival from disturbing anybody:
 * existing students keep their seat and the newcomer fills the gap.
 */
export function allocateSeat(
  taken: Iterable<number | null | undefined>,
  maxSeats: number,
): number | null {
  const used = new Set<number>();
  for (const seat of taken) {
    if (typeof seat === "number" && Number.isInteger(seat) && seat >= 1 && seat <= maxSeats) {
      used.add(seat);
    }
  }
  for (let seat = 1; seat <= maxSeats; seat += 1) {
    if (!used.has(seat)) return seat;
  }
  return null;
}

/**
 * Degrees of the table left free at the head for the moderator, so the host's
 * place never overlaps the numbered seats beside it.
 */
const HEAD_GAP_DEGREES = 60;

/** Radii of the seat ring, as a percentage of the room view. */
const RING_X = 40;
const RING_Y = 36;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Centre of a seat on the table oval, as a percentage of the room view.
 *
 * Seats run clockwise from the moderator's left; `index` is the seat number
 * minus one and `total` is how many seats exist, so a chair never moves once it
 * has been given out.
 *
 * `spread` scales the ring: 1 places a seat at the table edge, smaller values
 * place a label on the table surface in front of that seat.
 */
export function seatPosition(
  index: number,
  total: number,
  spread = 1,
): { left: number; top: number } {
  if (total <= 0) return { left: 50, top: 50 };

  const span = 360 - HEAD_GAP_DEGREES;
  const degrees = -90 + HEAD_GAP_DEGREES / 2 + (span * (index + 0.5)) / total;
  const radians = (degrees * Math.PI) / 180;

  return {
    left: round(50 + Math.cos(radians) * RING_X * spread),
    top: round(50 + Math.sin(radians) * RING_Y * spread),
  };
}

/** The moderator's place at the head of the table. */
export function headPosition(spread = 1): { left: number; top: number } {
  return { left: 50, top: round(50 - RING_Y * spread) };
}
