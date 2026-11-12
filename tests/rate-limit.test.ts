import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, clientKey } from "@/lib/rate-limit";

describe("rate limiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the limit and blocks the next one", () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 3; i += 1) {
      expect(checkRateLimit(key, 3, 60_000).allowed).toBe(true);
    }
    const blocked = checkRateLimit(key, 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("reports remaining quota", () => {
    const key = `remaining-${Math.random()}`;
    expect(checkRateLimit(key, 5, 60_000).remaining).toBe(4);
    expect(checkRateLimit(key, 5, 60_000).remaining).toBe(3);
  });

  it("resets once the window elapses", () => {
    vi.useFakeTimers();
    const key = `window-${Math.random()}`;
    expect(checkRateLimit(key, 1, 1_000).allowed).toBe(true);
    expect(checkRateLimit(key, 1, 1_000).allowed).toBe(false);

    vi.advanceTimersByTime(1_001);
    expect(checkRateLimit(key, 1, 1_000).allowed).toBe(true);
  });

  it("tracks separate keys independently", () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    checkRateLimit(a, 1, 60_000);
    expect(checkRateLimit(a, 1, 60_000).allowed).toBe(false);
    expect(checkRateLimit(b, 1, 60_000).allowed).toBe(true);
  });
});

describe("clientKey", () => {
  it("uses the first x-forwarded-for address", () => {
    const request = new Request("http://localhost", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(clientKey(request)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    const request = new Request("http://localhost", { headers: { "x-real-ip": "198.51.100.9" } });
    expect(clientKey(request)).toBe("198.51.100.9");
  });

  it("falls back to a constant when no address is present", () => {
    expect(clientKey(new Request("http://localhost"))).toBe("unknown");
  });
});
