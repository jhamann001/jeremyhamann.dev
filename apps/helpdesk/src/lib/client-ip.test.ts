import { describe, expect, it } from "vitest";
import {
  UNKNOWN_IP,
  extractRequestId,
  isPrefetchHeaders,
  normalizeIpLiteral,
  requestContextFromHeaders,
  resolveClientIp,
} from "@/lib/client-ip";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function h(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

describe("resolveClientIp — trusted hops (I9)", () => {
  it("hops 1: the last x-forwarded-for element (appended by the outermost trusted proxy)", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.5" }), 1)).toBe("203.0.113.5");
    expect(resolveClientIp(h({ "x-forwarded-for": "10.0.0.1, 203.0.113.5" }), 1)).toBe("203.0.113.5");
    expect(resolveClientIp(h({ "x-forwarded-for": "1.1.1.1,2.2.2.2 , 3.3.3.3" }), 1)).toBe("3.3.3.3");
  });

  it("Cloud Run shape (TRUSTED_PROXY_HOPS=1): the front end appends the connecting client's address as the LAST element, so a client-forged list never wins", () => {
    // A caller who sends `x-forwarded-for: 203.0.113.9` still connects from 198.51.100.7; Google's front end appends that.
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.9, 198.51.100.7" }), 1)).toBe("198.51.100.7");
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.9, 169.254.1.1" }), 1)).toBe("169.254.1.1");
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.9, 169.254.1.1" }), 1)).not.toBe("203.0.113.9");
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.9,10.0.0.1, 2001:db8::7" }), 1)).toBe("2001:db8::7");
    // No forged prefix: the single element is the connecting client itself.
    expect(resolveClientIp(h({ "x-forwarded-for": "198.51.100.7" }), 1)).toBe("198.51.100.7");
  });

  it("hops 2: the second-to-last element", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "10.0.0.1, 203.0.113.5" }), 2)).toBe("10.0.0.1");
    expect(resolveClientIp(h({ "x-forwarded-for": "spoofed, 198.51.100.9, 203.0.113.5" }), 2)).toBe("198.51.100.9");
  });

  it("a list shorter than hops → unknown (never falls back to index 0)", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.5" }), 2)).toBe(UNKNOWN_IP);
    expect(resolveClientIp(h({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }), 3)).toBe(UNKNOWN_IP);
    expect(resolveClientIp(h(), 1)).toBe(UNKNOWN_IP);
    expect(resolveClientIp(h({ "x-forwarded-for": "" }), 1)).toBe(UNKNOWN_IP);
  });

  it("the leftmost element is never used when hops >= 1 and the list is long enough", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 8.8.8.8" }), 1)).not.toBe("6.6.6.6");
    expect(resolveClientIp(h({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 8.8.8.8" }), 2)).not.toBe("6.6.6.6");
  });

  it("an invalid literal at the trusted position → unknown, not a neighbour", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.5, not-an-ip" }), 1)).toBe(UNKNOWN_IP);
    expect(resolveClientIp(h({ "x-forwarded-for": "999.1.1.1, 203.0.113.5" }), 2)).toBe(UNKNOWN_IP);
    expect(resolveClientIp(h({ "x-forwarded-for": "unknown, 203.0.113.5" }), 2)).toBe(UNKNOWN_IP);
  });

  it("hops 0: x-real-ip when valid, else unknown; x-forwarded-for is ignored", () => {
    expect(resolveClientIp(h({ "x-real-ip": "203.0.113.5" }), 0)).toBe("203.0.113.5");
    expect(resolveClientIp(h({ "x-real-ip": "[2001:db8::1]:443" }), 0)).toBe("2001:db8::1");
    expect(resolveClientIp(h({ "x-real-ip": "garbage" }), 0)).toBe(UNKNOWN_IP);
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.5" }), 0)).toBe(UNKNOWN_IP);
    expect(resolveClientIp(h(), 0)).toBe(UNKNOWN_IP);
  });

  it("never fabricates a loopback address", () => {
    expect(resolveClientIp(h(), 0)).not.toBe("127.0.0.1");
    expect(resolveClientIp(h(), 1)).not.toBe("127.0.0.1");
  });

  it("IPv6 with brackets and port, and bare IPv6", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "[2001:db8::1]:443" }), 1)).toBe("2001:db8::1");
    expect(resolveClientIp(h({ "x-forwarded-for": "2001:db8:85a3::8a2e:370:7334" }), 1)).toBe(
      "2001:db8:85a3::8a2e:370:7334",
    );
    expect(resolveClientIp(h({ "x-forwarded-for": "::ffff:203.0.113.5" }), 1)).toBe("::ffff:203.0.113.5");
  });

  it("IPv4 with a port suffix is normalized to the address", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.5:8080" }), 1)).toBe("203.0.113.5");
  });

  it("nonsensical hop counts → unknown", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.5" }), -1)).toBe(UNKNOWN_IP);
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.5" }), 1.5)).toBe(UNKNOWN_IP);
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.5" }), Number.NaN)).toBe(UNKNOWN_IP);
  });
});

describe("normalizeIpLiteral", () => {
  it("valid IPv4", () => {
    expect(normalizeIpLiteral("203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeIpLiteral("  203.0.113.5  ")).toBe("203.0.113.5");
    expect(normalizeIpLiteral("203.0.113.5:12345")).toBe("203.0.113.5");
    expect(normalizeIpLiteral("0.0.0.0")).toBe("0.0.0.0");
    expect(normalizeIpLiteral("255.255.255.255")).toBe("255.255.255.255");
  });

  it("invalid IPv4 shapes", () => {
    expect(normalizeIpLiteral("256.0.0.1")).toBeNull();
    expect(normalizeIpLiteral("1.2.3")).toBeNull();
    expect(normalizeIpLiteral("1.2.3.4.5")).toBeNull();
    expect(normalizeIpLiteral("01.2.3.4")).toBeNull();
    expect(normalizeIpLiteral("1.2.3.4abc")).toBeNull();
    expect(normalizeIpLiteral("1.2.3.4:")).toBeNull();
    expect(normalizeIpLiteral("1.2.3.4:123456")).toBeNull();
  });

  it("valid IPv6, bracketed and bare, with optional port and zone", () => {
    expect(normalizeIpLiteral("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeIpLiteral("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(normalizeIpLiteral("[::1]")).toBe("::1");
    expect(normalizeIpLiteral("::1")).toBe("::1");
    expect(normalizeIpLiteral("::")).toBe("::");
    expect(normalizeIpLiteral("2001:0db8:0000:0000:0000:ff00:0042:8329")).toBe("2001:0db8:0000:0000:0000:ff00:0042:8329");
    expect(normalizeIpLiteral("fe80::1%eth0")).toBe("fe80::1%eth0");
    expect(normalizeIpLiteral("::ffff:203.0.113.5")).toBe("::ffff:203.0.113.5");
    expect(normalizeIpLiteral("64:ff9b::203.0.113.5")).toBe("64:ff9b::203.0.113.5");
  });

  it("invalid IPv6 shapes", () => {
    expect(normalizeIpLiteral("2001:db8:::1")).toBeNull();
    expect(normalizeIpLiteral("2001:db8::1::2")).toBeNull();
    expect(normalizeIpLiteral("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(normalizeIpLiteral("1:2:3:4:5:6:7")).toBeNull();
    expect(normalizeIpLiteral("12345::1")).toBeNull();
    expect(normalizeIpLiteral("gggg::1")).toBeNull();
    expect(normalizeIpLiteral("[2001:db8::1")).toBeNull();
    expect(normalizeIpLiteral("[2001:db8::1]x")).toBeNull();
    expect(normalizeIpLiteral("[203.0.113.5]")).toBeNull();
    expect(normalizeIpLiteral("1:2:3:4:5:6:7:8::")).toBeNull();
    expect(normalizeIpLiteral("::ffff:203.0.113.5:1")).toBeNull();
  });

  it("garbage", () => {
    expect(normalizeIpLiteral("")).toBeNull();
    expect(normalizeIpLiteral("   ")).toBeNull();
    expect(normalizeIpLiteral("unknown")).toBeNull();
    expect(normalizeIpLiteral("localhost")).toBeNull();
    expect(normalizeIpLiteral("http://1.2.3.4")).toBeNull();
    expect(normalizeIpLiteral(undefined as unknown as string)).toBeNull();
  });
});

describe("isPrefetchHeaders (I11)", () => {
  it("detects each prefetch signal", () => {
    expect(isPrefetchHeaders(h({ "next-router-prefetch": "1" }))).toBe(true);
    expect(isPrefetchHeaders(h({ purpose: "prefetch" }))).toBe(true);
    expect(isPrefetchHeaders(h({ Purpose: "Prefetch" }))).toBe(true);
    expect(isPrefetchHeaders(h({ "sec-purpose": "prefetch;prerender" }))).toBe(true);
    expect(isPrefetchHeaders(h({ "sec-purpose": "prefetch" }))).toBe(true);
  });

  it("ignores non-prefetch values and plain requests", () => {
    expect(isPrefetchHeaders(h())).toBe(false);
    expect(isPrefetchHeaders(h({ "next-router-prefetch": "0" }))).toBe(false);
    expect(isPrefetchHeaders(h({ purpose: "navigation" }))).toBe(false);
    expect(isPrefetchHeaders(h({ "sec-purpose": "prerender" }))).toBe(false);
    expect(isPrefetchHeaders(h({ "user-agent": "prefetch" }))).toBe(false);
  });
});

describe("extractRequestId", () => {
  it("accepts a well-formed x-request-id", () => {
    expect(extractRequestId(h({ "x-request-id": "req_2026-09-16:abc.DEF" }))).toBe("req_2026-09-16:abc.DEF");
    expect(extractRequestId(h({ "x-request-id": "12345678" }))).toBe("12345678");
    expect(extractRequestId(h({ "x-request-id": "a".repeat(128) }))).toBe("a".repeat(128));
  });

  it("mints a UUID when the header is missing or malformed", () => {
    expect(extractRequestId(h())).toMatch(UUID);
    expect(extractRequestId(h({ "x-request-id": "short" }))).toMatch(UUID);
    expect(extractRequestId(h({ "x-request-id": "a".repeat(129) }))).toMatch(UUID);
    expect(extractRequestId(h({ "x-request-id": "has space here" }))).toMatch(UUID);
    expect(extractRequestId(h({ "x-request-id": "bad/chars;here" }))).toMatch(UUID);
    expect(extractRequestId(h({ "x-request-id": "<script>alert(1)</script>" }))).toMatch(UUID);
  });

  it("mints a fresh UUID per call", () => {
    expect(extractRequestId(h())).not.toBe(extractRequestId(h()));
  });
});

describe("requestContextFromHeaders", () => {
  it("assembles the evidentiary context", () => {
    const ctx = requestContextFromHeaders(
      h({
        "x-forwarded-for": "10.0.0.1, 203.0.113.5",
        "user-agent": "Mozilla/5.0 (test)",
        "x-request-id": "req-abcdef-123",
        "next-router-prefetch": "1",
      }),
      1,
    );
    expect(ctx).toEqual({
      ipAddress: "203.0.113.5",
      userAgent: "Mozilla/5.0 (test)",
      requestId: "req-abcdef-123",
      isPrefetch: true,
    });
  });

  it("userAgent is null when missing or empty and truncated to 512 chars", () => {
    expect(requestContextFromHeaders(h(), 0).userAgent).toBeNull();
    expect(requestContextFromHeaders(h({ "user-agent": "   " }), 0).userAgent).toBeNull();
    const long = "U".repeat(1000);
    const ctx = requestContextFromHeaders(h({ "user-agent": long }), 0);
    expect(ctx.userAgent).toHaveLength(512);
    expect(ctx.userAgent).toBe("U".repeat(512));
  });

  it("defaults: unknown ip, fresh request id, not a prefetch", () => {
    const ctx = requestContextFromHeaders(h(), 1);
    expect(ctx.ipAddress).toBe(UNKNOWN_IP);
    expect(ctx.requestId).toMatch(UUID);
    expect(ctx.isPrefetch).toBe(false);
  });
});
