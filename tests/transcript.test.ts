import { describe, expect, it } from "vitest";
import { countWords, isMeaningful, normalizeTranscript } from "@/lib/transcript";

describe("transcript helpers", () => {
  describe("normalizeTranscript", () => {
    it("collapses runs of whitespace", () => {
      expect(normalizeTranscript("  hello    world \n again ")).toBe("hello world again");
    });

    it("handles empty input", () => {
      expect(normalizeTranscript("   ")).toBe("");
    });
  });

  describe("countWords", () => {
    it("counts whitespace-separated words", () => {
      expect(countWords("one two three")).toBe(3);
    });

    it("returns 0 for blank input", () => {
      expect(countWords("   ")).toBe(0);
    });

    it("does not count surrounding whitespace", () => {
      expect(countWords("  spaced   out  ")).toBe(2);
    });
  });

  describe("isMeaningful", () => {
    it("is true only when there is spoken content", () => {
      expect(isMeaningful("a real sentence")).toBe(true);
      expect(isMeaningful("   ")).toBe(false);
      expect(isMeaningful("")).toBe(false);
    });
  });
});
