import { describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken, type SessionUser } from "@/lib/session-token";

const user: SessionUser = {
  id: "user_123",
  email: "host@quorum.local",
  name: "Discussion Host",
  role: "HOST",
};

describe("session tokens", () => {
  it("round-trips a signed session", async () => {
    const token = await createSessionToken(user);
    const verified = await verifySessionToken(token);
    expect(verified).toEqual(user);
  });

  it("rejects a tampered token", async () => {
    const token = await createSessionToken(user);
    const [header, payload, signature] = token.split(".");
    // Flip a character in the middle of the signature, where all bits are
    // significant, so the decoded bytes (and thus the HMAC) definitely change.
    const chars = signature.split("");
    const middle = Math.floor(chars.length / 2);
    chars[middle] = chars[middle] === "A" ? "B" : "A";
    const tampered = `${header}.${payload}.${chars.join("")}`;
    expect(await verifySessionToken(tampered)).toBeNull();
  });

  it("rejects a structurally invalid token", async () => {
    expect(await verifySessionToken("not.a.jwt")).toBeNull();
    expect(await verifySessionToken("")).toBeNull();
  });
});
