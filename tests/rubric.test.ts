import { describe, expect, it } from "vitest";
import {
  RUBRIC_DIMENSIONS,
  RUBRIC_TOTAL_WEIGHT,
  clampScore,
  scoreBand,
  weightedOverall,
} from "@/lib/rubric";

describe("rubric", () => {
  it("has six dimensions whose weights total 100", () => {
    expect(RUBRIC_DIMENSIONS).toHaveLength(6);
    expect(RUBRIC_TOTAL_WEIGHT).toBe(100);
  });

  describe("weightedOverall", () => {
    it("returns 100 when every dimension is perfect", () => {
      const perfect = Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d.key, 100]));
      expect(weightedOverall(perfect)).toBe(100);
    });

    it("returns 0 when nothing was scored", () => {
      expect(weightedOverall({})).toBe(0);
    });

    it("weights each dimension by its rubric weight", () => {
      // topic_relevance carries a 25% weight, so a perfect score there is 25.
      expect(weightedOverall({ topic_relevance: 100 })).toBe(25);
      // listening carries 10%.
      expect(weightedOverall({ listening: 100 })).toBe(10);
    });

    it("clamps out-of-range values instead of inflating the score", () => {
      expect(weightedOverall({ topic_relevance: 500 })).toBe(25);
      expect(weightedOverall({ topic_relevance: -100 })).toBe(0);
    });

    it("ignores non-numeric values", () => {
      expect(weightedOverall({ topic_relevance: Number.NaN })).toBe(0);
      expect(weightedOverall({ topic_relevance: "not a number" as unknown as number })).toBe(0);
    });

    it("rounds to one decimal place", () => {
      // 1/3 of the way up each dimension.
      const value = weightedOverall(
        Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d.key, 33.33])),
      );
      expect(value).toBe(33.3);
    });
  });

  describe("clampScore", () => {
    it("bounds values into 0-100", () => {
      expect(clampScore(-10)).toBe(0);
      expect(clampScore(150)).toBe(100);
      expect(clampScore(72)).toBe(72);
    });

    it("maps unparseable input to 0", () => {
      expect(clampScore("abc")).toBe(0);
      expect(clampScore(undefined)).toBe(0);
    });
  });

  describe("scoreBand", () => {
    it("uses the documented boundaries", () => {
      expect(scoreBand(80).label).toBe("Excellent");
      expect(scoreBand(65).label).toBe("Strong");
      expect(scoreBand(50).label).toBe("Developing");
      expect(scoreBand(49.9).label).toBe("Needs work");
    });

    it("maps bands to UI tones", () => {
      expect(scoreBand(90).tone).toBe("good");
      expect(scoreBand(55).tone).toBe("ok");
      expect(scoreBand(10).tone).toBe("weak");
    });
  });
});
