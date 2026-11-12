/**
 * Small in-memory fixed-window rate limiter.
 *
 * This is intentionally dependency-free and process-local: it protects a single
 * Node instance. Behind multiple instances use a shared store (Redis) instead.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_KEYS = 10_000;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();

  // Guard against unbounded growth if a bot sprays random keys.
  if (buckets.size > MAX_TRACKED_KEYS) {
    for (const [k, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(k);
    }
    if (buckets.size > MAX_TRACKED_KEYS) buckets.clear();
  }

  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
  }

  bucket.count += 1;

  if (bucket.count > limit) {
    return { allowed: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
  }

  return { allowed: true, remaining: limit - bucket.count, retryAfterMs: 0 };
}

/** Best-effort client identity for rate limiting. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
