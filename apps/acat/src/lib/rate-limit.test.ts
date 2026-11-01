import { describe, it, expect } from "vitest";
import { rateLimit } from "./rate-limit";

describe("rateLimit", () => {
  it("allows requests within the limit", () => {
    const result = rateLimit("test-key-1", { maxTokens: 5 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("tracks remaining tokens", () => {
    const key = "test-key-2";
    rateLimit(key, { maxTokens: 3 });
    rateLimit(key, { maxTokens: 3 });
    const result = rateLimit(key, { maxTokens: 3 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("blocks when tokens are exhausted", () => {
    const key = "test-key-3";
    for (let i = 0; i < 2; i++) {
      rateLimit(key, { maxTokens: 2 });
    }
    const result = rateLimit(key, { maxTokens: 2 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("uses separate buckets for different keys", () => {
    const r1 = rateLimit("key-a", { maxTokens: 1 });
    const r2 = rateLimit("key-b", { maxTokens: 1 });
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);

    const r3 = rateLimit("key-a", { maxTokens: 1 });
    expect(r3.allowed).toBe(false);

    const r4 = rateLimit("key-b", { maxTokens: 1 });
    expect(r4.allowed).toBe(false);
  });
});
