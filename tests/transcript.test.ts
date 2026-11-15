import { describe, expect, it } from "vitest";
import {
  countWords,
  DUPLICATE_WINDOW_MS,
  isDuplicateSegment,
  isMeaningful,
  leastSpokenParticipant,
  mergeTranscriptText,
  normalizeTranscript,
  shouldApplyTranscriptDraft,
  shouldClearTranscriptDraft,
  shouldUseGeminiAudioFallback,
  speakingTotals,
  TRANSCRIPT_CSV_COLUMNS,
  transcriptToCsv,
  type SpeakingSegment,
  type TranscriptExportRow,
} from "@/lib/transcript";

describe("transcript helpers", () => {
  describe("normalizeTranscript", () => {
    it("collapses runs of whitespace", () => {
      expect(normalizeTranscript("  hello    world \n again ")).toBe("hello world again");
    });

    describe("mergeTranscriptText", () => {
      it("replaces cumulative partials without repeating their words", () => {
        expect(mergeTranscriptText("Hello", "Hello everyone")).toBe("Hello everyone");
        expect(mergeTranscriptText("Hello everyone", "Hello everyone today")).toBe(
          "Hello everyone today",
        );
      });

      it("joins overlapping final hypotheses and preserves the final punctuation", () => {
        expect(mergeTranscriptText("Hello everyone", "everyone, today.")).toBe(
          "Hello everyone, today.",
        );
        expect(mergeTranscriptText("Hello everyone, today", "Hello everyone, today.")).toBe(
          "Hello everyone, today.",
        );
      });

      it.each([
        "Hello everyone.",
        "Artificial Intelligence is transforming the world.",
        "Today we are discussing the applications of machine learning.",
        "I believe technology will change the future.",
        "There are several advantages and disadvantages of artificial intelligence.",
      ])("keeps the complete sentence as recognition results grow: %s", (sentence) => {
        const words = sentence.split(" ");
        const partials = words.map((_, index) => words.slice(0, index + 1).join(" "));
        const merged = partials.reduce((current, partial) => mergeTranscriptText(current, partial), "");
        expect(mergeTranscriptText(merged, sentence)).toBe(sentence);
      });
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

  describe("isDuplicateSegment", () => {
    const base = new Date("2026-01-01T10:00:00.000Z");
    const at = (offsetMs: number) => new Date(base.getTime() + offsetMs);
    const previous = { text: "I agree with that point", startedAt: base };

    it("is false when there is nothing to compare against", () => {
      expect(isDuplicateSegment(null, previous.text, base)).toBe(false);
      expect(isDuplicateSegment(undefined, previous.text, base)).toBe(false);
    });

    describe("live transcript revisions", () => {
      it("ignores an older draft packet", () => {
        expect(shouldApplyTranscriptDraft({ status: "PARTIAL", revision: 4 }, 3)).toBe(false);
      });

      describe("transcription provider fallback", () => {
        it("uses Gemini when browser streaming is unsupported", () => {
          expect(shouldUseGeminiAudioFallback(false, null)).toBe(true);
        });

        it("uses Gemini when streaming and on-device recognition are unavailable", () => {
          expect(
            shouldUseGeminiAudioFallback(
              true,
              "On-device recognition unavailable: no language pack.",
            ),
          ).toBe(true);
        });

        it("keeps streaming recognition as the only provider when it is working", () => {
          expect(shouldUseGeminiAudioFallback(true, null)).toBe(false);
        });
      });

      it("does not allow a draft packet to replace a final segment", () => {
        expect(shouldApplyTranscriptDraft({ status: "FINAL", revision: 4 }, 5)).toBe(false);
      });

      it("accepts a newer draft and clears only its current revision", () => {
        expect(shouldApplyTranscriptDraft({ status: "PARTIAL", revision: 4 }, 5)).toBe(true);
        expect(shouldClearTranscriptDraft({ status: "PARTIAL", revision: 4 }, 4)).toBe(true);
        expect(shouldClearTranscriptDraft({ status: "PARTIAL", revision: 5 }, 4)).toBe(false);
      });
    });

    it("treats an identical chunk inside the window as the same utterance", () => {
      expect(isDuplicateSegment(previous, previous.text, at(0))).toBe(true);
      expect(isDuplicateSegment(previous, previous.text, at(DUPLICATE_WINDOW_MS - 1))).toBe(true);
    });

    it("keeps an identical chunk that arrives after the window", () => {
      expect(isDuplicateSegment(previous, previous.text, at(DUPLICATE_WINDOW_MS))).toBe(false);
      expect(isDuplicateSegment(previous, previous.text, at(DUPLICATE_WINDOW_MS + 1))).toBe(false);
    });

    it("keeps a different chunk inside the window", () => {
      expect(isDuplicateSegment(previous, "No, I disagree", at(1000))).toBe(false);
    });

    it("compares wall clock distance, not direction", () => {
      expect(isDuplicateSegment(previous, previous.text, at(-1000))).toBe(true);
    });
  });

  describe("transcriptToCsv", () => {
    const segment = (overrides: Partial<TranscriptExportRow> = {}): TranscriptExportRow => ({
      discussionId: "gd1",
      userId: "user1",
      studentName: "Asha Rao",
      startedAt: new Date("2026-01-01T10:00:00.000Z"),
      endedAt: new Date("2026-01-01T10:00:08.000Z"),
      text: "I think the motion is sound",
      durationMs: 8000,
      wordCount: 6,
      ...overrides,
    });

    it("writes the stored fields as the header row", () => {
      expect(TRANSCRIPT_CSV_COLUMNS.join(",")).toBe(
        "Session ID,Student ID,Student name,Start timestamp,End timestamp,Transcript text,Speaking duration (ms),Word count",
      );
      expect(transcriptToCsv([])).toBe(`${TRANSCRIPT_CSV_COLUMNS.join(",")}\r\n`);
    });

    it("writes one entry per line in the stored order", () => {
      const csv = transcriptToCsv([segment()]);
      expect(csv.split("\r\n")[1]).toBe(
        "gd1,user1,Asha Rao,2026-01-01T10:00:00.000Z,2026-01-01T10:00:08.000Z,I think the motion is sound,8000,6",
      );
    });

    it("quotes a field that contains a comma", () => {
      const csv = transcriptToCsv([segment({ text: "First, second" })]);
      expect(csv.split("\r\n")[1]).toContain('"First, second"');
    });

    it("doubles quotes inside a field", () => {
      const csv = transcriptToCsv([segment({ text: 'He said "no"' })]);
      expect(csv.split("\r\n")[1]).toContain('"He said ""no"""');
    });

    it("quotes a field that spans lines", () => {
      const csv = transcriptToCsv([segment({ text: "one\ntwo" })]);
      expect(csv).toContain('"one\ntwo"');
    });

    it("quotes a name that needs escaping", () => {
      const csv = transcriptToCsv([segment({ studentName: 'Rao, "Asha"' })]);
      expect(csv.split("\r\n")[1]).toContain('"Rao, ""Asha"""');
    });

    it("keeps every entry, including repeated speakers", () => {
      const csv = transcriptToCsv([segment(), segment({ text: "And again" })]);
      expect(csv.trimEnd().split("\r\n")).toHaveLength(3);
    });
  });
});

describe("participation totals", () => {
  const chunk = (participantId: string, durationMs: number, wordCount: number): SpeakingSegment => ({
    participantId,
    durationMs,
    wordCount,
  });

  describe("speakingTotals", () => {
    it("is empty when nothing has been said", () => {
      expect(speakingTotals([]).size).toBe(0);
    });

    it("sums each participant's chunks", () => {
      const totals = speakingTotals([
        chunk("a", 4000, 10),
        chunk("b", 1000, 3),
        chunk("a", 2000, 6),
      ]);

      expect(totals.get("a")).toEqual({ durationMs: 6000, words: 16, contributions: 2 });
      expect(totals.get("b")).toEqual({ durationMs: 1000, words: 3, contributions: 1 });
    });

    it("leaves out anybody who has not spoken", () => {
      const totals = speakingTotals([chunk("a", 500, 2)]);
      expect(totals.has("b")).toBe(false);
    });
  });

  describe("leastSpokenParticipant", () => {
    const seat = (id: string, seatNumber: number | null = null) => ({ id, seatNumber });

    it("returns null when there is nobody to ask", () => {
      expect(leastSpokenParticipant([], new Map())).toBeNull();
    });

    it("picks a participant who has never spoken", () => {
      const totals = speakingTotals([chunk("a", 9000, 30), chunk("b", 4000, 12)]);
      expect(leastSpokenParticipant([seat("a"), seat("b"), seat("c")], totals)?.id).toBe("c");
    });

    it("picks the shortest talking time when everybody has spoken", () => {
      const totals = speakingTotals([
        chunk("a", 9000, 30),
        chunk("b", 2500, 40),
        chunk("c", 6000, 15),
      ]);
      expect(leastSpokenParticipant([seat("a"), seat("b"), seat("c")], totals)?.id).toBe("b");
    });

    it("breaks a tie on talking time with the lower word count", () => {
      const totals = speakingTotals([chunk("a", 5000, 40), chunk("b", 5000, 8)]);
      expect(leastSpokenParticipant([seat("a"), seat("b")], totals)?.id).toBe("b");
    });

    it("breaks a full tie by seat order", () => {
      const totals = speakingTotals([chunk("a", 5000, 20), chunk("b", 5000, 20)]);
      const chosen = leastSpokenParticipant([seat("b", 4), seat("a", 1)], totals);
      expect(chosen?.id).toBe("a");
    });

    it("puts a participant with no seat last on a full tie", () => {
      const totals = speakingTotals([chunk("a", 5000, 20), chunk("b", 5000, 20)]);
      const chosen = leastSpokenParticipant([seat("b", null), seat("a", 7)], totals);
      expect(chosen?.id).toBe("a");
    });

    it("only considers the candidates it is given", () => {
      // "z" has spoken least overall but is not at the table.
      const totals = speakingTotals([chunk("z", 0, 0), chunk("a", 9000, 30), chunk("b", 3000, 9)]);
      expect(leastSpokenParticipant([seat("a"), seat("b")], totals)?.id).toBe("b");
    });

    it("carries the rest of the candidate through, not just the id", () => {
      const totals = speakingTotals([chunk("a", 9000, 30)]);
      const chosen = leastSpokenParticipant(
        [
          { id: "a", seatNumber: 1, displayName: "Asha" },
          { id: "b", seatNumber: 2, displayName: "Bilal" },
        ],
        totals,
      );
      expect(chosen?.displayName).toBe("Bilal");
    });
  });
});
