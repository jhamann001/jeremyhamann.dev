import { describe, expect, it } from "vitest";

import nextConfig from "../next.config.mjs";

async function configuredHeaders() {
  const rules = await nextConfig.headers?.();
  expect(rules).toHaveLength(1);
  expect(rules?.[0]?.source).toBe("/(.*)");

  return new Map(
    (rules?.[0]?.headers ?? []).map(({ key, value }) => [key, value]),
  );
}

describe("browser security headers", () => {
  it("sets the production browser-defense baseline on every response", async () => {
    const headers = await configuredHeaders();

    expect(headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headers.get("Permissions-Policy")).toBe(
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    );
    expect(headers.get("X-DNS-Prefetch-Control")).toBe("off");
    expect(headers.get("X-XSS-Protection")).toBe("0");
  });

  it("blocks external executable content and framing without breaking Next hydration", async () => {
    const headers = await configuredHeaders();
    const csp = headers.get("Content-Security-Policy");

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("https:");
    expect(csp).not.toContain("*.");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("does not disclose the application framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
