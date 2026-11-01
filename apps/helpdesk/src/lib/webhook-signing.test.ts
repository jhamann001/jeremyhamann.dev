/**
 * Unit tests for webhook signing.
 *
 * The FIXED VECTOR below is the contract with every receiver. If a change to this module changes that
 * digest, every integration that has already implemented verification breaks silently — their requests
 * start failing signature checks and ours keep returning 200 from our side. So the vector is written
 * out longhand, with the exact secret, body and timestamp that produced it, and it is not regenerated
 * from the implementation.
 */
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SECRET_PREFIX_CHARS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_PREFIX,
  WEBHOOK_SIGNING_DOMAIN,
  WEBHOOK_TIMESTAMP_HEADER,
  deriveEndpointSigningKey,
  mintWebhookSecret,
  sha256Hex,
  signWebhookBody,
  webhookSignatureMatches,
  webhookSignedPayload,
} from "@/lib/webhook-signing";

// --- The fixed vector -------------------------------------------------------
const VECTOR = {
  secret: "b3f1c0d2e4a5968778695a4b3c2d1e0f1122334455667788990011223344556677",
  body: '{"id":"wdl_test","event":"TICKET_STATUS_CHANGED"}',
  timestamp: 1_789_000_000,
  signedPayload: '1789000000.{"id":"wdl_test","event":"TICKET_STATUS_CHANGED"}',
  signature: "sha256=ec955fa3fdd8485f0ebf452780b480a19fea3d693bdd1ade0a58a0fb4c2fb15c",
  bodyHash: "f5998f25335f08bd24e91b86c0f6a80fa75d94163b4431928491b22cd3df4360",
} as const;

/**
 * The app-held key the derivation tests use, DERIVED PER RUN.
 *
 * It was the literal `"app-held-key-at-least-32-characters-long"`, which security scanner reports as "Usage of
 * Hardcoded HMAC Key" (CWE-798) the moment it reaches `createHmac` —
 * the build record applies that rule to tests too, and `src/lib/email/reply-token.test.ts`
 * already derives its keys this way. Nothing below asserts a digest OF this key: every assertion is a
 * property (reproducible, domain-separated, different from the salt, 64 hex), so a key that changes on
 * every run is also the stronger test.
 *
 * The FIXED VECTOR above is untouched and stays a literal: it is the published contract with every
 * receiver, and it is checked against `createHmac` with the vector's own secret, not with this key.
 */
const APP_KEY = `app-held-key-${randomBytes(24).toString("base64url")}`;

describe("the fixed vector", () => {
  it("composes the signed payload as <timestamp>.<raw body>", () => {
    expect(webhookSignedPayload(VECTOR.body, VECTOR.timestamp)).toBe(VECTOR.signedPayload);
  });

  it("produces the documented signature", () => {
    expect(signWebhookBody(VECTOR.secret, VECTOR.body, VECTOR.timestamp)).toBe(VECTOR.signature);
  });

  it("is reproducible by a receiver implementing it from the documentation alone", () => {
    // Exactly what the build record tells an integrator to write.
    const expected =
      "sha256=" +
      createHmac("sha256", VECTOR.secret)
        .update(`${VECTOR.timestamp}.${VECTOR.body}`, "utf8")
        .digest("hex");
    expect(expected).toBe(VECTOR.signature);
  });

  it("hashes the body to the documented digest", () => {
    expect(sha256Hex(VECTOR.body)).toBe(VECTOR.bodyHash);
  });
});

describe("signWebhookBody", () => {
  it("carries the algorithm prefix so a receiver can reject an unknown one", () => {
    expect(signWebhookBody("s", "b", 1)).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(WEBHOOK_SIGNATURE_PREFIX).toBe("sha256=");
  });

  it("changes when the timestamp changes — a captured payload cannot be replayed with a new stamp", () => {
    const a = signWebhookBody(VECTOR.secret, VECTOR.body, VECTOR.timestamp);
    const b = signWebhookBody(VECTOR.secret, VECTOR.body, VECTOR.timestamp + 1);
    expect(a).not.toBe(b);
  });

  it("changes when a single byte of the body changes", () => {
    const a = signWebhookBody(VECTOR.secret, VECTOR.body, VECTOR.timestamp);
    const b = signWebhookBody(VECTOR.secret, `${VECTOR.body} `, VECTOR.timestamp);
    expect(a).not.toBe(b);
  });

  it("changes when the secret changes", () => {
    const a = signWebhookBody(VECTOR.secret, VECTOR.body, VECTOR.timestamp);
    const b = signWebhookBody(`${VECTOR.secret}0`, VECTOR.body, VECTOR.timestamp);
    expect(a).not.toBe(b);
  });

  it("truncates a fractional timestamp rather than producing a digest nobody can reproduce", () => {
    expect(signWebhookBody(VECTOR.secret, VECTOR.body, VECTOR.timestamp + 0.75)).toBe(VECTOR.signature);
  });

  it("is stable across a unicode body", () => {
    const body = '{"note":"café — naïve"}';
    expect(signWebhookBody("s", body, 1)).toBe(signWebhookBody("s", body, 1));
  });
});

describe("webhookSignatureMatches", () => {
  it("is true only for an identical value", () => {
    expect(webhookSignatureMatches(VECTOR.signature, VECTOR.signature)).toBe(true);
    expect(webhookSignatureMatches(VECTOR.signature, VECTOR.signature.replace(/.$/, "0"))).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    expect(webhookSignatureMatches(VECTOR.signature, "sha256=")).toBe(false);
    expect(webhookSignatureMatches("", VECTOR.signature)).toBe(false);
  });
});

describe("deriveEndpointSigningKey", () => {
  it("is 64 hex characters and reproducible from the two halves", () => {
    const salt = "a".repeat(64);
    const key = deriveEndpointSigningKey(APP_KEY, salt);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveEndpointSigningKey(APP_KEY, salt)).toBe(key);
  });

  it("changes with either half — the salt alone signs nothing", () => {
    const a = deriveEndpointSigningKey(APP_KEY, "a".repeat(64));
    const b = deriveEndpointSigningKey(APP_KEY, "b".repeat(64));
    const c = deriveEndpointSigningKey(`${APP_KEY}!`, "a".repeat(64));
    expect(new Set([a, b, c]).size).toBe(3);
    // The stored salt is not the key: reading the column yields nothing signable.
    expect(a).not.toBe("a".repeat(64));
  });

  it("is null — never a fallback — when the app-held key is missing", () => {
    expect(deriveEndpointSigningKey(undefined, "a".repeat(64))).toBeNull();
    expect(deriveEndpointSigningKey("", "a".repeat(64))).toBeNull();
    expect(deriveEndpointSigningKey(APP_KEY, "")).toBeNull();
  });

  it("is domain-separated, so the same app key cannot collide with another use", () => {
    const salt = "a".repeat(64);
    expect(deriveEndpointSigningKey(APP_KEY, salt)).not.toBe(
      createHmac("sha256", APP_KEY).update(salt, "utf8").digest("hex"),
    );
    expect(WEBHOOK_SIGNING_DOMAIN).toBe("wmhd:webhook-signing:v1");
  });
});

describe("mintWebhookSecret", () => {
  it("returns a 64-hex secret, a 64-hex salt and an eight-character prefix OF THE SALT", () => {
    const minted = mintWebhookSecret(APP_KEY);
    expect(minted).not.toBeNull();
    if (minted === null) return;
    expect(minted.plaintext).toMatch(/^[0-9a-f]{64}$/);
    // The DB CHECK on WebhookEndpoint.secretHash (which holds the salt) is exactly this shape.
    expect(minted.secretSalt).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.secretPrefix).toHaveLength(WEBHOOK_SECRET_PREFIX_CHARS);
    expect(minted.secretSalt.startsWith(minted.secretPrefix)).toBe(true);
    // The prefix is a label on the salt and never a window on to the secret.
    expect(minted.plaintext.startsWith(minted.secretPrefix)).toBe(false);
  });

  it("derives the secret from the app key and the stored salt", () => {
    const minted = mintWebhookSecret(APP_KEY);
    expect(minted).not.toBeNull();
    if (minted === null) return;
    expect(minted.plaintext).toBe(deriveEndpointSigningKey(APP_KEY, minted.secretSalt));
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 50 }, () => mintWebhookSecret(APP_KEY)?.plaintext));
    expect(seen.size).toBe(50);
  });

  it("stores a salt that is neither the secret nor a digest of it", () => {
    const minted = mintWebhookSecret(APP_KEY);
    expect(minted).not.toBeNull();
    if (minted === null) return;
    expect(minted.secretSalt).not.toBe(minted.plaintext);
    expect(minted.secretSalt).not.toBe(sha256Hex(minted.plaintext));
  });

  it("refuses to mint at all when the app-held key is unset", () => {
    expect(mintWebhookSecret(undefined)).toBeNull();
    expect(mintWebhookSecret("")).toBeNull();
  });
});

describe("header names", () => {
  it("are the four the contract and the integrator documentation name", () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("X-WMHD-Signature");
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe("X-WMHD-Timestamp");
    expect(WEBHOOK_DELIVERY_HEADER).toBe("X-WMHD-Delivery");
    expect(WEBHOOK_EVENT_HEADER).toBe("X-WMHD-Event");
  });
});
