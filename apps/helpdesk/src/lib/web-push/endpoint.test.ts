/**
 * What the ledger is allowed to say about a push endpoint (§3.3 rule 2).
 */
import { describe, expect, it, vi } from "vitest";
import {
  assertPushEndpointAllowed,
  assertPushEndpointResolvable,
  hashEndpoint,
  isPushServiceHost,
  pushServiceHost,
} from "@/lib/web-push/endpoint";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/cH4nG3-th15-15-4-c4p4b1l1ty";

describe("push endpoint identity", () => {
  it("hashes to stable lower-case sha256 hex that contains none of the URL", () => {
    const hash = hashEndpoint(ENDPOINT);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashEndpoint(ENDPOINT));
    expect(hash).not.toContain("fcm");
    expect(hash).not.toContain("c4p4b1l1ty");
  });

  it("separates two endpoints that differ only in their capability path", () => {
    expect(hashEndpoint(ENDPOINT)).not.toBe(hashEndpoint(`${ENDPOINT}2`));
  });

  it("keeps the vendor host and drops the path", () => {
    expect(pushServiceHost(ENDPOINT)).toBe("fcm.googleapis.com");
    expect(pushServiceHost("https://updates.push.services.mozilla.com/wpush/v2/gAAA")).toBe(
      "updates.push.services.mozilla.com",
    );
    expect(pushServiceHost("not a url")).toBeNull();
  });
});

/**
 * The SSRF guard for push endpoints. These are the tests that matter in this file: `hashEndpoint`
 * failing is visible, an endpoint guard failing open is not.
 */
describe("assertPushEndpointAllowed", () => {
  const ALLOWED = [
    "https://fcm.googleapis.com/fcm/send/cH4nG3-th15-15-4-c4p4b1l1ty",
    "https://android.googleapis.com/gcm/send/legacy-registration-id",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA_o-key",
    "https://wns2-by3p.notify.windows.com/w/?token=BQYA-+TOKEN/rest",
    "https://web.push.apple.com/QOEDbz9F4-7l0_A7s",
  ];

  it("accepts the four real push services, hyphens and base64url paths included", () => {
    for (const endpoint of ALLOWED) {
      const verdict = assertPushEndpointAllowed(endpoint);
      expect(verdict.allowed, `${endpoint} -> ${verdict.reason ?? ""}`).toBe(true);
    }
  });

  it("refuses an internal address — the blind-SSRF case the guard exists for", () => {
    for (const endpoint of [
      "https://10.0.0.5:8443/computeMetadata",
      "https://169.254.169.254/computeMetadata/v1/",
      "https://127.0.0.1/push",
      "https://[::1]/push",
      "https://192.168.1.10/push",
    ]) {
      expect(assertPushEndpointAllowed(endpoint).allowed, endpoint).toBe(false);
    }
  });

  it("refuses an internal NAME, however it is spelled", () => {
    for (const endpoint of [
      "https://localhost/push",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://helpdesk-db.internal/push",
      "https://intranet/push",
    ]) {
      expect(assertPushEndpointAllowed(endpoint).allowed, endpoint).toBe(false);
    }
  });

  it("refuses a public host that is not a push service — an allowlist, not a denylist", () => {
    for (const endpoint of [
      "https://attacker.test.invalid/collect",
      "https://evil.com/collect",
      "https://raw.githubusercontent.com/x/y",
      // The suffix match is on a DOTTED boundary: this is not googleapis.com.
      "https://notgoogleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.attacker.example.net/fcm/send/x",
    ]) {
      expect(assertPushEndpointAllowed(endpoint).allowed, endpoint).toBe(false);
    }
  });

  it("refuses http, credentials, control characters, an over-long value and a non-URL", () => {
    expect(assertPushEndpointAllowed("http://fcm.googleapis.com/fcm/send/x").allowed).toBe(false);
    expect(assertPushEndpointAllowed("https://user:pw@fcm.googleapis.com/fcm/send/x").allowed).toBe(false);
    expect(assertPushEndpointAllowed("https://fcm.googleapis.com/fcm/send/a b").allowed).toBe(false);
    expect(assertPushEndpointAllowed("https://fcm.googleapis.com/fcm/send/a\nb").allowed).toBe(false);
    expect(assertPushEndpointAllowed(`https://fcm.googleapis.com/fcm/send/${"x".repeat(2100)}`).allowed).toBe(false);
    expect(assertPushEndpointAllowed("not a url").allowed).toBe(false);
    expect(assertPushEndpointAllowed("").allowed).toBe(false);
    expect(assertPushEndpointAllowed("   ").allowed).toBe(false);
  });

  /**
   * Fix round 2, alongside `src/lib/ssrf-guard.ts`. Every denylisted NAME used to be refused with "That
   * host is internal to this network", which is false for a reserved suffix: `push.invalid` is not a
   * machine behind the firewall, it is a name that resolves nowhere at all.
   */
  it("does not call a reserved name an internal one", () => {
    const verdict = assertPushEndpointAllowed("https://push.invalid/push");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason ?? "").toMatch(/reserved/);
    expect(verdict.reason ?? "").not.toMatch(/internal to this network/);
    // The private half keeps its own sentence.
    const internal = assertPushEndpointAllowed("https://helpdesk-db.internal/push");
    expect(internal.reason ?? "").toMatch(/internal to this network/);
  });

  it("gives a reason that never echoes the capability path back", () => {
    const verdict = assertPushEndpointAllowed("https://attacker.example.com/c4p4b1l1ty-path");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason ?? "").not.toContain("c4p4b1l1ty-path");
  });
});

describe("isPushServiceHost", () => {
  it("matches the whole host or a dotted suffix, and nothing adjacent", () => {
    expect(isPushServiceHost("fcm.googleapis.com")).toBe(true);
    expect(isPushServiceHost("FCM.GoogleAPIs.com.")).toBe(true); // case and the root dot
    expect(isPushServiceHost("googleapis.com")).toBe(true);
    expect(isPushServiceHost("xgoogleapis.com")).toBe(false);
    expect(isPushServiceHost("googleapis.com.attacker.net")).toBe(false);
    expect(isPushServiceHost("")).toBe(false);
  });
});

describe("assertPushEndpointResolvable", () => {
  const publicAnswer = async () => [{ address: "142.250.72.106" }];

  it("passes an allowlisted name that resolves to a public address", async () => {
    await expect(assertPushEndpointResolvable(ENDPOINT, publicAnswer)).resolves.toMatchObject({ allowed: true });
  });

  it("refuses when ANY answer is private — one rebind record is enough", async () => {
    const rebound = async () => [{ address: "142.250.72.106" }, { address: "10.0.0.5" }];
    await expect(assertPushEndpointResolvable(ENDPOINT, rebound)).resolves.toMatchObject({ allowed: false });
  });

  it("refuses an empty answer and a resolver that throws — it never fails open", async () => {
    await expect(assertPushEndpointResolvable(ENDPOINT, async () => [])).resolves.toMatchObject({ allowed: false });
    await expect(
      assertPushEndpointResolvable(ENDPOINT, async () => {
        throw new Error("ENOTFOUND");
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("refuses a syntactically bad endpoint without consulting the resolver at all", async () => {
    const lookup = vi.fn(publicAnswer);
    await expect(assertPushEndpointResolvable("https://10.0.0.5/push", lookup)).resolves.toMatchObject({
      allowed: false,
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});
