// Distributed rate limiter backed by Upstash Redis via @upstash/ratelimit.
//
// Behaviour:
//   - If UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set, we use a
//     sliding-window rate limiter shared across every Cloud Run instance.
//   - Otherwise we fall back to the in-memory token bucket in
//     ./rate-limit.ts. This is correct for local dev and CI, and keeps the
//     app functional during rollout, but it is NOT a secure limit in
//     production (each serverless instance has its own bucket). Callers that
//     pass `failClosed` are denied instead in production unless the deploy
//     sets RATE_LIMIT_MEMORY_FALLBACK=true, which exists only until a shared
//     limiter is provisioned.
//
// Keep the return shape identical to the in-memory limiter so call sites
// don't branch.

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { rateLimit as memoryRateLimit } from "./rate-limit";
import { logger } from "./logger";
import { isPersonaEmail, personaSignInEnabled } from "./demo/personas";

export type RateLimitOptions = {
  // Sensitive machine writes must not bypass a missing/failing shared limiter.
  failClosed?: boolean;
  // Upstream in-memory API uses these names; keep them for backwards compat.
  maxTokens?: number;
  // Kept for API compatibility with rate-limit.ts; not used by the
  // sliding-window limiter below.
  refillRate?: number;
  interval?: number; // milliseconds
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
};

let redisClient: Redis | null = null;
let warnedAboutFallback = false;

const limiterCache = new Map<string, Ratelimit>();

function getRedis(): Redis | null {
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redisClient = new Redis({ url, token });
  return redisClient;
}

function getLimiter(bucket: string, limit: number, windowMs: number): Ratelimit | null {
  const redis = getRedis();
  if (!redis) return null;
  const cacheKey = `${bucket}:${limit}:${windowMs}`;
  let limiter = limiterCache.get(cacheKey);
  if (!limiter) {
    const windowSec = Math.max(1, Math.floor(windowMs / 1000));
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
      analytics: false,
      prefix: `rl:${bucket}`,
    });
    limiterCache.set(cacheKey, limiter);
  }
  return limiter;
}

// The deploy sets this only while no shared limiter is provisioned; any other
// value keeps fail-closed callers denied.
function memoryFallbackAllowed(): boolean {
  return process.env.RATE_LIMIT_MEMORY_FALLBACK === "true";
}

function warnFallbackOnce() {
  if (warnedAboutFallback) return;
  warnedAboutFallback = true;
  if (process.env.NODE_ENV === "production") {
    logger.warn(
      "UPSTASH_REDIS_REST_URL/TOKEN not set; falling back to in-memory rate limiter. Rate limits are per-instance and can be trivially bypassed in production."
    );
  }
}

/**
 * Check-and-consume a single token from `bucket` for `key`. `bucket` is a
 * stable name that describes *which limit* to apply (e.g. "api-global",
 * "acat-post", "anon-login"). `key` scopes the bucket per-user/per-IP.
 */
export async function rateLimit(
  bucket: string,
  key: string,
  options: RateLimitOptions = {}
): Promise<RateLimitResult> {
  const { maxTokens = 60, interval = 60_000 } = options;

  const limiter = getLimiter(bucket, maxTokens, interval);
  if (!limiter) {
    if (options.failClosed && process.env.NODE_ENV === "production" && !memoryFallbackAllowed()) {
      return { allowed: false, remaining: 0 };
    }
    warnFallbackOnce();
    // Refill at the stated rate: the in-memory limiter's own default is 60 per interval whatever the
    // bucket's size, which made "20 an hour" 60 an hour.
    return memoryRateLimit(`${bucket}:${key}`, { ...options, refillRate: maxTokens });
  }

  try {
    const res = await limiter.limit(key);
    return { allowed: res.success, remaining: res.remaining };
  } catch (err) {
    if (options.failClosed) {
      logger.warn({ bucket }, "Rate limiter unavailable; request denied");
      return { allowed: false, remaining: 0 };
    }
    // If Redis is transiently unavailable, fail open (allow) rather than
    // bringing the entire app down. Log so we notice.
    logger.error(
      { err, bucket, key },
      "Redis rate limiter errored; allowing request"
    );
    return { allowed: true, remaining: maxTokens };
  }
}

/**
 * Parse the rightmost-trusted IP from an `X-Forwarded-For` header.
 *
 * Cloud Run injects its own `X-Forwarded-For` entry as the last value; any
 * values to the left can be client-supplied and are untrusted. `trustHops`
 * tells us how many of the rightmost entries to discard before returning
 * the first IP we will actually trust.
 */
export function parseClientIp(
  xff: string | null | undefined,
  trustHops = 1
): string {
  if (!xff) return "unknown";
  const parts = xff
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "unknown";
  const idx = parts.length - 1 - trustHops;
  const candidate = idx >= 0 ? parts[idx] : parts[0];
  return candidate || "unknown";
}

/**
 * The key a caller's limits are counted under: the account, or the IP when signed out. A demo persona is
 * one account shared by every visitor, so its limits are kept per visitor (account and IP); otherwise one
 * visitor could use up everyone's.
 */
export function rateLimitKey(email: string | null, xForwardedFor: string | null): string {
  const ip = parseClientIp(xForwardedFor, 1);
  if (!email) return `ip:${ip}`;
  return personaSignInEnabled() && isPersonaEmail(email) ? `user:${email}:ip:${ip}` : `user:${email}`;
}
