import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ limit: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@upstash/redis", () => ({ Redis: class {} }));
vi.mock("@upstash/ratelimit", () => ({ Ratelimit: class {
  static slidingWindow() { return {}; }
  limit = mocks.limit;
} }));
vi.mock("./logger", () => ({ logger: { warn: mocks.warn, error: mocks.error } }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", ""); vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("RATE_LIMIT_MEMORY_FALLBACK", "");
});
afterEach(() => vi.unstubAllEnvs());
describe("sensitive preparation rate limits", () => {
  it("denies preparation when shared production limiting is unconfigured, without changing legacy fallback", async () => {
    const { rateLimit } = await import("./rate-limit-redis");
    expect((await rateLimit("prep", "actor", { failClosed: true })).allowed).toBe(false);
    expect((await rateLimit("legacy", "actor")).allowed).toBe(true);
  });
  it("denies a failing Redis check and never logs the error details for preparation", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://synthetic-redis.test"); vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "synthetic-token");
    mocks.limit.mockRejectedValue(new Error("private request metadata"));
    const { rateLimit } = await import("./rate-limit-redis");
    expect((await rateLimit("prep", "actor", { failClosed: true })).allowed).toBe(false);
    expect(mocks.error).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("private request metadata");
  });
  it("lets a fail-closed caller use the per-instance limiter only when the deploy says so", async () => {
    vi.stubEnv("RATE_LIMIT_MEMORY_FALLBACK", "true");
    const { rateLimit } = await import("./rate-limit-redis");
    expect((await rateLimit("prep", "actor", { failClosed: true })).allowed).toBe(true);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });
  it("keeps denying when the setting is anything but the exact word true", async () => {
    for (const value of ["TRUE", "1", "yes"]) {
      vi.resetModules(); vi.stubEnv("RATE_LIMIT_MEMORY_FALLBACK", value);
      const { rateLimit } = await import("./rate-limit-redis");
      expect((await rateLimit("prep", "actor", { failClosed: true })).allowed).toBe(false);
    }
  });
  it("still denies a failing Redis check when the fallback setting is on", async () => {
    vi.stubEnv("RATE_LIMIT_MEMORY_FALLBACK", "true");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://synthetic-redis.test"); vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "synthetic-token");
    mocks.limit.mockRejectedValue(new Error("private request metadata"));
    const { rateLimit } = await import("./rate-limit-redis");
    expect((await rateLimit("prep", "actor", { failClosed: true })).allowed).toBe(false);
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
