import { describe, it, expect } from "vitest";
import { buildCsp, generateNonce } from "./csp";

describe("generateNonce", () => {
  it("produces distinct base64 strings", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(a.length).toBeGreaterThanOrEqual(20);
  });
});

describe("buildCsp", () => {
  const nonce = "test-nonce-abc123";

  it("emits per-request nonce and strict-dynamic in script-src", () => {
    const csp = buildCsp({ nonce });
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toContain("'unsafe-inline' 'nonce");
  });

  it("does NOT include unsafe-inline in script-src", () => {
    const csp = buildCsp({ nonce });
    const scriptSrcSection = csp
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("script-src"));
    expect(scriptSrcSection).toBeDefined();
    expect(scriptSrcSection).not.toContain("'unsafe-inline'");
  });

  it("allows unsafe-eval only in dev", () => {
    expect(buildCsp({ nonce }).includes("'unsafe-eval'")).toBe(false);
    expect(buildCsp({ nonce, isDev: true }).includes("'unsafe-eval'")).toBe(true);
  });

  it("tightens img-src to Google avatar CDN only", () => {
    const csp = buildCsp({ nonce });
    expect(csp).toContain("img-src 'self' data: https://lh3.googleusercontent.com");
    // open https: src is gone
    expect(csp).not.toMatch(/img-src[^;]*\shttps:\s/);
  });

  it("includes hardening directives", () => {
    const csp = buildCsp({ nonce });
    for (const directive of [
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
      "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
  });
});
