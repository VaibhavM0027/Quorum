import { describe, expect, it } from "vitest";
import {
  createDiscussionSchema,
  joinDiscussionSchema,
  joinRequestBodySchema,
  loginSchema,
  registerSchema,
  transcriptSegmentSchema,
} from "@/lib/validation";

describe("validation schemas", () => {
  describe("registerSchema", () => {
    it("accepts a valid registration and lowercases the email", () => {
      const parsed = registerSchema.parse({
        name: "Asha",
        email: "ASHA@Example.COM",
        password: "supersecret",
      });
      expect(parsed.email).toBe("asha@example.com");
      expect(parsed.name).toBe("Asha");
    });

    it("rejects short passwords", () => {
      expect(() =>
        registerSchema.parse({ name: "Asha", email: "a@b.co", password: "short" }),
      ).toThrow();
    });

    it("rejects malformed emails", () => {
      expect(() =>
        registerSchema.parse({ name: "Asha", email: "not-an-email", password: "supersecret" }),
      ).toThrow();
    });
  });

  describe("loginSchema", () => {
    it("requires a non-empty password", () => {
      expect(() => loginSchema.parse({ email: "a@b.co", password: "" })).toThrow();
    });
  });

  describe("joinDiscussionSchema", () => {
    it("uppercases and trims the join code", () => {
      const parsed = joinDiscussionSchema.parse({ code: " k7qm2p " });
      expect(parsed.code).toBe("K7QM2P");
    });
  });

  describe("joinRequestBodySchema", () => {
    it("accepts an absent body, because the code may come from the query string", () => {
      expect(joinRequestBodySchema.parse({})).toEqual({});
    });

    it("uppercases and trims a code supplied in the body", () => {
      const parsed = joinRequestBodySchema.parse({ code: " k7qm2p ", displayName: " Asha " });
      expect(parsed.code).toBe("K7QM2P");
      expect(parsed.displayName).toBe("Asha");
    });

    it("rejects a non-string code instead of throwing inside the route", () => {
      // A PowerShell/JSON client that serialises the code as an object used to
      // reach `body.code.trim()` and surface as a 500 with an internal message.
      expect(() => joinRequestBodySchema.parse({ code: { value: "K7QM2P" } })).toThrow();
      expect(() => joinRequestBodySchema.parse({ code: 1234 })).toThrow();
    });

    it("rejects a code that is too short", () => {
      expect(() => joinRequestBodySchema.parse({ code: "ab" })).toThrow();
    });
  });

  describe("createDiscussionSchema", () => {
    it("applies sensible defaults", () => {
      const parsed = createDiscussionSchema.parse({ title: "GD One", topic: "Should AI be regulated?" });
      expect(parsed.durationMin).toBe(30);
      expect(parsed.maxParticipants).toBe(8);
      expect(parsed.mode).toBe("AI_MODERATED");
      expect(parsed.aiEnabled).toBe(true);
      expect(parsed.context).toBe("");
    });

    it("rejects an out-of-range duration", () => {
      expect(() =>
        createDiscussionSchema.parse({ title: "GD One", topic: "Topic here", durationMin: 500 }),
      ).toThrow();
    });
  });

  describe("transcriptSegmentSchema", () => {
    it("coerces ISO strings into dates and defaults the duration", () => {
      const parsed = transcriptSegmentSchema.parse({
        text: "hello world",
        startedAt: "2026-01-01T10:00:00.000Z",
        endedAt: "2026-01-01T10:00:05.000Z",
      });
      expect(parsed.startedAt).toBeInstanceOf(Date);
      expect(parsed.durationMs).toBe(0);
    });

    it("rejects an empty transcript chunk", () => {
      expect(() =>
        transcriptSegmentSchema.parse({
          text: "   ",
          startedAt: new Date(),
          endedAt: new Date(),
        }),
      ).toThrow();
    });
  });
});
