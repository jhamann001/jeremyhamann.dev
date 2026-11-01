/**
 * Unit tests for the SSRF guard.
 *
 * These are the tests that matter most in this slice. Every other control here fails visibly when it
 * breaks — a wrong signature is rejected by the receiver, a missing audit row fails a guardrail — but
 * a hole in this module fails INVISIBLY: the request succeeds, the admin page shows HTTP 200, and the
 * desk has read something from inside its own network on an operator's behalf. So the ranges are
 * enumerated rather than sampled, and the "fails closed" cases are asserted as hard as the "refuses"
 * cases.
 */
import { describe, expect, it } from "vitest";
import {
  assertPublicHttpsUrl,
  assertResolvedAddresses,
  classifyForbiddenHostname,
  forbiddenHostnameReason,
  isForbiddenAddress,
  isForbiddenHostname,
  FORBIDDEN_HOST_SUFFIXES,
  PRIVATE_HOST_REFUSAL,
  PRIVATE_HOST_SUFFIXES,
  RESERVED_HOST_SUFFIXES,
  isForbiddenIpv4,
  isForbiddenIpv6,
  normalizeHostname,
  parseIpv4,
  parseIpv6,
  SSRF_URL_MAX_CHARS,
} from "@/lib/ssrf-guard";

describe("parseIpv4", () => {
  it("parses a canonical dotted quad", () => {
    expect(parseIpv4("192.168.1.1")).toEqual([192, 168, 1, 1]);
    expect(parseIpv4("0.0.0.0")).toEqual([0, 0, 0, 0]);
    expect(parseIpv4("255.255.255.255")).toEqual([255, 255, 255, 255]);
  });

  it("refuses the non-canonical forms that are classic filter bypasses", () => {
    // inet_aton accepts all of these and resolves them to 127.0.0.1.
    expect(parseIpv4("127.0.0.01")).toBeNull();
    expect(parseIpv4("0177.0.0.1")).toBeNull();
    expect(parseIpv4("127.1")).toBeNull();
    expect(parseIpv4("2130706433")).toBeNull();
    expect(parseIpv4("0x7f.0.0.1")).toBeNull();
    expect(parseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseIpv4("1.2.3.256")).toBeNull();
    expect(parseIpv4("1.2.3.")).toBeNull();
  });
});

describe("isForbiddenIpv4", () => {
  const forbidden: Array<[string, [number, number, number, number]]> = [
    ["this network 0/8", [0, 0, 0, 0]],
    ["RFC1918 10/8", [10, 1, 2, 3]],
    ["loopback", [127, 0, 0, 1]],
    ["loopback, not .1", [127, 255, 255, 254]],
    ["CGNAT low", [100, 64, 0, 1]],
    ["CGNAT high", [100, 127, 255, 254]],
    ["link-local", [169, 254, 1, 1]],
    ["GCP/AWS metadata", [169, 254, 169, 254]],
    ["RFC1918 172.16", [172, 16, 0, 1]],
    ["RFC1918 172.31", [172, 31, 255, 254]],
    ["IETF protocol assignments", [192, 0, 0, 8]],
    ["TEST-NET-1", [192, 0, 2, 1]],
    ["6to4 relay anycast", [192, 88, 99, 1]],
    ["RFC1918 192.168", [192, 168, 0, 1]],
    ["benchmarking 198.18", [198, 18, 0, 1]],
    ["benchmarking 198.19", [198, 19, 255, 254]],
    ["TEST-NET-2", [198, 51, 100, 1]],
    ["TEST-NET-3", [203, 0, 113, 1]],
    ["multicast", [224, 0, 0, 1]],
    ["reserved 240/4", [240, 0, 0, 1]],
    ["broadcast", [255, 255, 255, 255]],
  ];
  it.each(forbidden)("refuses %s", (_label, octets) => {
    expect(isForbiddenIpv4(octets)).toBe(true);
  });

  const allowed: Array<[string, [number, number, number, number]]> = [
    ["a public address", [93, 184, 216, 34]],
    ["just below CGNAT", [100, 63, 255, 255]],
    ["just above CGNAT", [100, 128, 0, 0]],
    ["just below 172.16", [172, 15, 255, 255]],
    ["just above 172.31", [172, 32, 0, 0]],
    ["just below multicast", [223, 255, 255, 255]],
    ["a 192.0.1 address", [192, 0, 1, 1]],
  ];
  it.each(allowed)("allows %s", (_label, octets) => {
    expect(isForbiddenIpv4(octets)).toBe(false);
  });
});

describe("parseIpv6", () => {
  it("expands :: and a trailing dotted quad", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
    expect(parseIpv6("2001:db8::1")).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("[::1]")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("refuses malformed text", () => {
    expect(parseIpv6("1:2:3:4:5:6:7")).toBeNull();
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIpv6("1::2::3")).toBeNull();
    expect(parseIpv6(":1:2:3:4:5:6:7:8")).toBeNull();
    expect(parseIpv6("gggg::1")).toBeNull();
    expect(parseIpv6("192.168.1.1")).toBeNull();
  });
});

describe("isForbiddenIpv6", () => {
  const cases: Array<[string, boolean]> = [
    ["::", true],
    ["::1", true],
    ["fc00::1", true],
    ["fd12:3456::1", true],
    ["fe80::1", true],
    ["ff02::1", true],
    ["100::1", true],
    ["2001:db8::1", true],
    ["2001::1", true],
    ["::ffff:10.0.0.1", true],
    ["::ffff:169.254.169.254", true],
    ["::ffff:93.184.216.34", false],
    ["64:ff9b::10.0.0.1", true],
    ["64:ff9b::93.184.216.34", false],
    ["2002:0a00:0001::1", true],
    ["2002:5db8:d822::1", false],
    ["2606:2800:220:1:248:1893:25c8:1946", false],
  ];
  it.each(cases)("%s → forbidden=%s", (text, expected) => {
    const groups = parseIpv6(text);
    expect(groups).not.toBeNull();
    expect(isForbiddenIpv6(groups ?? [])).toBe(expected);
  });

  it("refuses a group list that is not eight wide — a guard must fail closed", () => {
    expect(isForbiddenIpv6([1, 2, 3])).toBe(true);
    expect(isForbiddenIpv6([])).toBe(true);
  });
});

describe("isForbiddenAddress", () => {
  it("refuses anything it cannot parse, rather than letting it through", () => {
    expect(isForbiddenAddress("")).toBe(true);
    expect(isForbiddenAddress("   ")).toBe(true);
    expect(isForbiddenAddress("example.com")).toBe(true);
    expect(isForbiddenAddress("127.0.0.01")).toBe(true);
    expect(isForbiddenAddress("2130706433")).toBe(true);
  });

  it("allows a public literal of either family", () => {
    expect(isForbiddenAddress("93.184.216.34")).toBe(false);
    expect(isForbiddenAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });
});

describe("normalizeHostname / isForbiddenHostname", () => {
  it("drops a trailing root dot and lower-cases", () => {
    expect(normalizeHostname("Example.COM.")).toBe("example.com");
    expect(normalizeHostname("[::1]")).toBe("::1");
  });

  it("refuses the never-a-third-party names", () => {
    for (const host of [
      "localhost",
      "foo.localhost",
      "printer.local",
      "api.internal",
      "metadata.google.internal",
      "metadata",
      "db.corp",
      "svc.home.arpa",
      "something.onion",
      "host.test",
      "single",
    ]) {
      expect(isForbiddenHostname(host), host).toBe(true);
    }
  });

  it("does not refuse a public name that merely contains one of them", () => {
    for (const host of ["notlocalhost.example.com", "internal-tools.example.com", "localhosting.io"]) {
      expect(isForbiddenHostname(host), host).toBe(false);
    }
  });

  /**
   * Fix round 2. `.invalid`, `.test`, `.example` and `.onion` sat on the same list as `localhost` and
   * `internal` and earned the same sentence — "That host is internal to this network" — which is a
   * false statement about the operator's own infrastructure, delivered on the screen where they are
   * working out why a registration failed. Both kinds are still REFUSED; they no longer share a reason.
   */
  it("separates a reserved name from a name inside this network", () => {
    for (const host of ["webhook.invalid", "host.test", "fixture.example", "abc.onion", "1.0.0.127.in-addr.arpa"]) {
      const classification = classifyForbiddenHostname(host);
      expect(classification?.kind, host).toBe("reserved");
      const reason = forbiddenHostnameReason(host) ?? "";
      expect(reason, host).not.toBe(PRIVATE_HOST_REFUSAL);
      expect(reason, host).not.toMatch(/internal to this network/);
      expect(reason, host).toMatch(/reserved/);
      // The sentence names the suffix the operator actually typed, not a generic "that host".
      const suffix = classification?.kind === "reserved" ? classification.suffix : "";
      expect(reason, host).toContain(`.${suffix}`);
    }
  });

  it("still calls a private, loopback or metadata name internal", () => {
    for (const host of ["localhost", "foo.localhost", "printer.local", "api.internal", "metadata.google.internal", "db.corp", "single"]) {
      expect(classifyForbiddenHostname(host)?.kind, host).toBe("private");
      expect(forbiddenHostnameReason(host), host).toBe(PRIVATE_HOST_REFUSAL);
    }
  });

  it("returns no reason for an acceptable name", () => {
    expect(classifyForbiddenHostname("hooks.example.com")).toBeNull();
    expect(forbiddenHostnameReason("hooks.example.com")).toBeNull();
  });

  it("keeps the union list callers import", () => {
    expect(FORBIDDEN_HOST_SUFFIXES).toEqual([...PRIVATE_HOST_SUFFIXES, ...RESERVED_HOST_SUFFIXES]);
    expect(new Set(FORBIDDEN_HOST_SUFFIXES).size).toBe(FORBIDDEN_HOST_SUFFIXES.length);
  });
});

describe("assertPublicHttpsUrl", () => {
  it("allows an ordinary https URL", () => {
    expect(assertPublicHttpsUrl("https://hooks.example.com/wm/ingest")).toEqual({ allowed: true });
    expect(assertPublicHttpsUrl("https://hooks.example.com:8443/wm").allowed).toBe(true);
  });

  /**
   * The character-class check is the one line in this module that a reader can get wrong, because
   * `[\s -]` and the class we actually want differ by nothing visible. These two cases pin it from
   * both sides, so a future edit that collapses the range into a literal hyphen fails here rather
   * than in production: the first would start refusing most real webhook receivers, and the second
   * would stop refusing the control characters the message promises to refuse.
   */
  it("allows hyphens — they are the norm in webhook hostnames, not a bypass", () => {
    expect(assertPublicHttpsUrl("https://my-webhook.example.com/hook").allowed).toBe(true);
    expect(assertPublicHttpsUrl("https://n8n-prod.example.com/webhook/abc-123").allowed).toBe(true);
    expect(assertPublicHttpsUrl("https://hooks.example.com/path-with-dash").allowed).toBe(true);
    // Same class, other neighbours of `-` in ASCII: a path may legitimately carry these.
    expect(assertPublicHttpsUrl("https://hooks.example.com/a,b").allowed).toBe(true);
    expect(assertPublicHttpsUrl("https://hooks.example.com/a+b").allowed).toBe(true);
  });

  it("refuses an embedded control character anywhere in the value", () => {
    // Mid-string on purpose: a trailing one is removed by `trim()` and proves nothing about the class.
    for (const ch of ["\u0000", "\u0001", "\u0009", "\u000a", "\u000d", "\u001b", "\u001f", "\u007f"]) {
      const verdict = assertPublicHttpsUrl(`https://hooks.example.com/a${ch}b`);
      expect(verdict.allowed, `U+${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).toBe(false);
    }
  });

  const refusals: Array<[string, string]> = [
    ["empty", ""],
    ["blank", "   "],
    ["not a URL", "hooks.example.com/wm"],
    ["http", "http://hooks.example.com/wm"],
    ["ftp", "ftp://hooks.example.com/wm"],
    ["file", "file:///etc/passwd"],
    ["credentials", "https://user:pass@hooks.example.com/wm"],
    ["loopback name", "https://localhost/wm"],
    ["loopback literal", "https://127.0.0.1/wm"],
    ["metadata literal", "https://169.254.169.254/computeMetadata/v1/"],
    ["private literal", "https://10.0.0.5/wm"],
    ["ipv6 loopback", "https://[::1]/wm"],
    ["ipv6 ULA", "https://[fd00::1]/wm"],
    ["ipv4-mapped private", "https://[::ffff:10.0.0.1]/wm"],
    ["single-label host", "https://intranet/wm"],
    ["internal suffix", "https://hooks.internal/wm"],
    ["embedded newline", "https://hooks.example.com/\nwm"],
  ];
  it.each(refusals)("refuses %s", (_label, url) => {
    const verdict = assertPublicHttpsUrl(url);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBeTypeOf("string");
  });

  /**
   * Fix round 2, the end-to-end half: the verdict the admin sheet renders must tell the truth about
   * WHICH refusal it is. `https://webhook.invalid/hook` is refused, and not as an internal address.
   */
  it("gives a reserved-name URL its own reason, not the internal-network one", () => {
    const reserved = assertPublicHttpsUrl("https://webhook.invalid/hook");
    expect(reserved.allowed).toBe(false);
    expect(reserved.reason).toMatch(/reserved/);
    expect(reserved.reason).toContain(".invalid");
    expect(reserved.reason).not.toMatch(/internal to this network/);

    const internal = assertPublicHttpsUrl("https://hooks.internal/wm");
    expect(internal.allowed).toBe(false);
    expect(internal.reason).toBe(PRIVATE_HOST_REFUSAL);
  });

  it("refuses an over-long URL", () => {
    const url = `https://hooks.example.com/${"a".repeat(SSRF_URL_MAX_CHARS)}`;
    expect(assertPublicHttpsUrl(url).allowed).toBe(false);
  });
});

describe("assertResolvedAddresses", () => {
  it("refuses an empty answer — no answer is not a safe answer", () => {
    expect(assertResolvedAddresses([]).allowed).toBe(false);
  });

  it("allows only when EVERY address is public", () => {
    expect(assertResolvedAddresses(["93.184.216.34"]).allowed).toBe(true);
    expect(assertResolvedAddresses(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]).allowed).toBe(true);
    // The rebind shape: one public record and one private one, and the connection could land on either.
    expect(assertResolvedAddresses(["93.184.216.34", "10.0.0.5"]).allowed).toBe(false);
    expect(assertResolvedAddresses(["169.254.169.254"]).allowed).toBe(false);
  });
});
