/**
 * VAPID (RFC 8292) — the JWS a push service checks before it accepts anything.
 *
 * The signature is VERIFIED here with `node:crypto`'s own verifier against the public key derived
 * from the private scalar, so "it produced a string of the right shape" is never mistaken for "it
 * signed correctly". The `ieee-p1363` encoding is the half that fails silently in production — a DER
 * signature is a well-formed JWT that every push service answers 401 to — so it has its own test.
 */
import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "@/lib/web-push/codec";
import {
  jwtParts,
  jwtSigningInput,
  publicKeyFromPrivate,
  VAPID_TTL_SECONDS,
  vapidAudience,
  vapidAuthorization,
  vapidJwt,
  vapidJwtAt,
  vapidKeysMatch,
} from "@/lib/web-push/vapid";

/** A fixed pair. Test-only, never deployed; the private half is a scalar with no secret to protect. */
const PRIVATE_KEY = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const PUBLIC_KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123?token=xyz";
const SUBJECT = "mailto:helpdesk@example.invalid";
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

function publicKeyObject(pointB64: string): ReturnType<typeof createPublicKey> {
  const point = fromBase64Url(pointB64, 65);
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: toBase64Url(point.subarray(1, 33)),
      y: toBase64Url(point.subarray(33, 65)),
    },
    format: "jwk",
  });
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(segment))) as Record<string, unknown>;
}

describe("VAPID", () => {
  it("derives the published public point from the private scalar", () => {
    expect(publicKeyFromPrivate(PRIVATE_KEY)).toBe(PUBLIC_KEY);
    expect(vapidKeysMatch(PUBLIC_KEY, PRIVATE_KEY)).toBe(true);
  });

  it("reports a mismatched or malformed pair rather than throwing", () => {
    const other = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    expect(vapidKeysMatch(PUBLIC_KEY, other)).toBe(false);
    expect(vapidKeysMatch(PUBLIC_KEY, "not base64url!")).toBe(false);
  });

  it("claims the push service's ORIGIN, never its path", () => {
    expect(vapidAudience(ENDPOINT)).toBe("https://fcm.googleapis.com");
    const token = vapidJwtAt(ENDPOINT, SUBJECT, PRIVATE_KEY, NOW);
    const payload = decodeSegment(jwtParts(token).payload);
    expect(payload.aud).toBe("https://fcm.googleapis.com");
    // The path is the subscription id — a capability. It must not travel in a claim.
    expect(JSON.stringify(payload)).not.toContain("abc123");
  });

  it("writes an ES256 header and an expiry inside the RFC's 24-hour ceiling", () => {
    const token = vapidJwtAt(ENDPOINT, SUBJECT, PRIVATE_KEY, NOW);
    expect(decodeSegment(jwtParts(token).header)).toEqual({ typ: "JWT", alg: "ES256" });
    const payload = decodeSegment(jwtParts(token).payload);
    expect(payload.sub).toBe(SUBJECT);
    expect(payload.exp).toBe(Math.floor(NOW / 1000) + VAPID_TTL_SECONDS);
    expect(VAPID_TTL_SECONDS).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it("produces a signature node:crypto verifies, in raw r||s (not DER)", () => {
    const token = vapidJwtAt(ENDPOINT, SUBJECT, PRIVATE_KEY, NOW);
    const signature = fromBase64Url(jwtParts(token).signature);
    // JWS ES256 is exactly 64 bytes: r and s, 32 each. A DER signature is 70-ish and variable.
    expect(signature).toHaveLength(64);
    const ok = verify(
      "sha256",
      jwtSigningInput(token),
      { key: publicKeyObject(PUBLIC_KEY), dsaEncoding: "ieee-p1363" },
      signature,
    );
    expect(ok).toBe(true);
  });

  it("does not verify against a different key", () => {
    const token = vapidJwtAt(ENDPOINT, SUBJECT, PRIVATE_KEY, NOW);
    const otherPublic = publicKeyFromPrivate("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
    const ok = verify(
      "sha256",
      jwtSigningInput(token),
      { key: publicKeyObject(otherPublic), dsaEncoding: "ieee-p1363" },
      fromBase64Url(jwtParts(token).signature),
    );
    expect(ok).toBe(false);
  });

  it("refuses a subject that is not mailto: or https:", () => {
    expect(() => vapidJwtAt(ENDPOINT, "helpdesk@example.invalid", PRIVATE_KEY, NOW)).toThrow(/mailto: or https:/);
    expect(() => vapidJwtAt(ENDPOINT, "https://wm.example.invalid/contact", PRIVATE_KEY, NOW)).not.toThrow();
  });

  it("refuses a private key of the wrong length", () => {
    expect(() => vapidJwtAt(ENDPOINT, SUBJECT, toBase64Url(new Uint8Array(31)), NOW)).toThrow(/expected 32 bytes/);
  });

  it("builds the Authorization header RFC 8292 §3 specifies", () => {
    const token = vapidJwtAt(ENDPOINT, SUBJECT, PRIVATE_KEY, NOW);
    expect(vapidAuthorization(token, PUBLIC_KEY)).toBe(`vapid t=${token}, k=${PUBLIC_KEY}`);
  });

  it("vapidJwt is vapidJwtAt with the wall clock", () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = decodeSegment(jwtParts(vapidJwt(ENDPOINT, SUBJECT, PRIVATE_KEY)).payload);
    const exp = payload.exp as number;
    expect(exp).toBeGreaterThanOrEqual(before + VAPID_TTL_SECONDS);
    expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + VAPID_TTL_SECONDS + 2);
  });

  it("rejects a three-part split that is not three parts", () => {
    expect(() => jwtParts("a.b")).toThrow(/three-part/);
  });
});
