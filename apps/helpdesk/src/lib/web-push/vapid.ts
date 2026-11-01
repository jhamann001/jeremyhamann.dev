/**
 * VAPID — "Voluntary Application Server Identification" (RFC 8292) — slice B10, `pwa-push`.
 *
 * A push service will not accept a message for a subscription unless the sender proves it is the
 * same application server the browser subscribed to. The proof is a JWS: an ES256 (ECDSA P-256 with
 * SHA-256) signature over `{aud, exp, sub}`, sent as
 *
 *     Authorization: vapid t=<jwt>, k=<application server public key, base64url>
 *
 * `aud` is the push service's ORIGIN (scheme + host, no path) — a token minted for one push service
 * must not be replayable at another. `exp` is capped at 24 hours by the RFC; we use 12, because a
 * token is minted per send and a long-lived one buys nothing.
 *
 * KEY FORMAT. `VAPID_PRIVATE_KEY` is the raw 32-byte P-256 private scalar in base64url and
 * `VAPID_PUBLIC_KEY` the raw uncompressed 65-byte point — the same shapes every browser and every
 * push service uses, and the shapes `src/lib/env.ts` validates. Node cannot sign with a bare scalar,
 * so the public point is derived from it with ECDH (which is what makes `publicKeyFromPrivate` the
 * right place to CHECK the configured pair actually matches).
 *
 * `node:crypto` only; no new dependency.
 */
import { createPrivateKey, createECDH, sign } from "node:crypto";
import { concatBytes, fromBase64Url, toBase64Url } from "./codec";

const CURVE = "prime256v1";
const PRIVATE_KEY_BYTES = 32;
const PUBLIC_KEY_BYTES = 65;

/** RFC 8292 §2: the token's lifetime may not exceed 24 hours. Half that is plenty for a per-send JWT. */
export const VAPID_TTL_SECONDS = 12 * 60 * 60;

/** The uncompressed public point for a raw private scalar, base64url in and base64url out. */
export function publicKeyFromPrivate(privateKeyB64: string): string {
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(fromBase64Url(privateKeyB64, PRIVATE_KEY_BYTES)));
  return toBase64Url(new Uint8Array(ecdh.getPublicKey()));
}

/** True when the configured pair belongs together. A mismatch is a 401 from every push service. */
export function vapidKeysMatch(publicKeyB64: string, privateKeyB64: string): boolean {
  try {
    return publicKeyFromPrivate(privateKeyB64) === publicKeyB64;
  } catch {
    return false;
  }
}

/** The `aud` claim: the push endpoint's origin, never its path (the path is the subscription id). */
export function vapidAudience(endpoint: string): string {
  return new URL(endpoint).origin;
}

function jwtSegment(value: object): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Node signs P-256 keys from a JWK; the JWK needs the point, which we derive from the scalar. */
function privateKeyObject(privateKeyB64: string): ReturnType<typeof createPrivateKey> {
  const d = fromBase64Url(privateKeyB64, PRIVATE_KEY_BYTES);
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(d));
  const point = new Uint8Array(ecdh.getPublicKey());
  if (point.length !== PUBLIC_KEY_BYTES || point[0] !== 0x04) throw new Error("web-push: bad VAPID private key");
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: toBase64Url(d),
      x: toBase64Url(point.subarray(1, 33)),
      y: toBase64Url(point.subarray(33, 65)),
    },
    format: "jwk",
  });
}

/**
 * The signed token, with the clock passed in.
 *
 * `vapidJwt` is the CONTRACT §10 signature and delegates here; this variant exists so the test can
 * pin `exp` instead of asserting around a moving `Date.now()`. Both produce the same bytes for the
 * same second, which is what makes the test meaningful.
 */
export function vapidJwtAt(audience: string, subject: string, privateKeyB64: string, nowMs: number): string {
  if (!/^(mailto:|https:)/.test(subject)) {
    // RFC 8292 §2.1. Some push services reject anything else outright, and a token refused at
    // delivery time is far harder to diagnose than one refused here.
    throw new Error("web-push: VAPID subject must be a mailto: or https: URI");
  }
  const header = jwtSegment({ typ: "JWT", alg: "ES256" });
  const payload = jwtSegment({
    aud: vapidAudience(audience),
    exp: Math.floor(nowMs / 1000) + VAPID_TTL_SECONDS,
    sub: subject,
  });
  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  // "ieee-p1363" is the raw r||s encoding JWS requires; Node's default is DER, which no push service
  // accepts. Getting this wrong produces a 401 that looks exactly like a wrong key.
  const signature = sign("sha256", signingInput, {
    key: privateKeyObject(privateKeyB64),
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** CONTRACT §10 B10. `audience` may be the full endpoint URL; only its origin is claimed. */
export function vapidJwt(audience: string, subject: string, privateKeyB64: string): string {
  return vapidJwtAt(audience, subject, privateKeyB64, Date.now());
}

/** The `Authorization` header value for one send. */
export function vapidAuthorization(jwt: string, publicKeyB64: string): string {
  return `vapid t=${jwt}, k=${publicKeyB64}`;
}

/** Splits a JWT into its three base64url segments. Exported for the test; verifies nothing. */
export function jwtParts(token: string): { header: string; payload: string; signature: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("web-push: not a three-part JWT");
  return { header: parts[0], payload: parts[1], signature: parts[2] };
}

/** The signing input a verifier reconstructs: `header.payload` as ASCII bytes. */
export function jwtSigningInput(token: string): Uint8Array {
  const { header, payload } = jwtParts(token);
  return concatBytes(new TextEncoder().encode(header), new TextEncoder().encode("."), new TextEncoder().encode(payload));
}
