import { afterEach, describe, expect, it, vi } from "vitest";
import { parseClientIp, rateLimit, rateLimitKey } from "./rate-limit-redis";

describe("parseClientIp", () => {
  it("returns 'unknown' for null / empty input", () => {
    expect(parseClientIp(undefined)).toBe("unknown");
    expect(parseClientIp(null)).toBe("unknown");
    expect(parseClientIp("")).toBe("unknown");
    expect(parseClientIp("   ,  ,")).toBe("unknown");
  });

  it("returns the rightmost-trusted value (default one hop for Cloud Run LB)", () => {
    // Cloud Run: `client, lb-ip`
    expect(parseClientIp("203.0.113.9, 34.111.5.5")).toBe("203.0.113.9");
  });

  it("does not trust a forged leftmost value when the header only contains one entry", () => {
    // Single entry means there was no LB hop; treat it as the client IP.
    expect(parseClientIp("203.0.113.9")).toBe("203.0.113.9");
  });

  it("discards additional hops when explicitly configured", () => {
    // Two proxies in front (e.g. Cloud Armor + Cloud Run LB):
    // `attacker-spoofed, client, lb1, lb2` with trustHops=2 -> "client"
    expect(
      parseClientIp("203.0.113.9, 198.51.100.1, 10.0.0.1, 10.0.0.2", 2)
    ).toBe("198.51.100.1");
  });

  it("returns 'unknown' when all entries are blank", () => {
    expect(parseClientIp(",,,")).toBe("unknown");
  });

  it("trims whitespace around entries", () => {
    expect(parseClientIp("   203.0.113.9  ,  34.111.5.5  ")).toBe("203.0.113.9");
  });
});

describe("rateLimitKey", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keys a signed-out caller by IP and an account by email", () => {
    expect(rateLimitKey(null, "203.0.113.9")).toBe("ip:203.0.113.9");
    expect(rateLimitKey("jordan.reyes@example.com", "203.0.113.9")).toBe("user:jordan.reyes@example.com");
  });

  it("keys a shared demo persona by account and visitor", () => {
    vi.stubEnv("PERSONA_SIGN_IN", "on");
    expect(rateLimitKey("jordan.reyes@example.com", "203.0.113.9")).toBe("user:jordan.reyes@example.com:ip:203.0.113.9");
    expect(rateLimitKey("someone@example.com", "203.0.113.9")).toBe("user:someone@example.com");
  });
});

describe("the in-memory fallback", () => {
  afterEach(() => vi.useRealTimers());

  it("refills at the bucket's own rate, not 60 per interval", async () => {
    vi.useFakeTimers();
    const opts = { maxTokens: 2, interval: 60 * 60 * 1000 };
    const key = `refill-${Math.random()}`;
    expect((await rateLimit("refill-test", key, opts)).allowed).toBe(true);
    expect((await rateLimit("refill-test", key, opts)).allowed).toBe(true);
    expect((await rateLimit("refill-test", key, opts)).allowed).toBe(false);
    // Half an hour refills half the bucket: one request, where the old default allowed thirty.
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect((await rateLimit("refill-test", key, opts)).allowed).toBe(true);
    expect((await rateLimit("refill-test", key, opts)).allowed).toBe(false);
  });
});
