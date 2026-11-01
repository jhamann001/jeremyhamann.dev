/**
 * Outbound webhook signing — node, pure arithmetic over `node:crypto` (the build record B5,
 * §7.2).
 *
 * A receiver of one of our webhooks has to answer two questions before it acts on the payload: did the
 * desk send this, and did the desk send it *now*. A bare HMAC over the body answers only the first — a
 * payload captured once can be replayed forever. So the signed material is `<timestamp>.<body>` and the
 * timestamp travels in its own header: a receiver recomputes the digest over both, and refuses a
 * timestamp outside its own tolerance window.
 *
 * WHAT IS SIGNED IS THE RAW BODY, byte for byte, exactly as it is written to the socket. A receiver
 * that re-serializes the parsed JSON before verifying will get a different digest, and that is correct
 * behaviour rather than a bug to work around: the build record tells an
 * integrator to verify against the raw bytes.
 *
 * THE SIGNING KEY IS NOT IN THE DATABASE. An endpoint row holds a random per-endpoint SALT and an
 * eight-character display prefix of that salt — neither is a credential. The key both sides use is
 * `deriveEndpointSigningKey(WEBHOOK_SIGNING_KEY, salt)`, and `WEBHOOK_SIGNING_KEY` is app-held (Secret
 * Manager, env), so a `pg_dump`, a backup, a restore drill or a SQL-injection read of the table yields
 * nothing that can forge `X-WMHD-Signature`. The derived key is shown ONCE, by the create action, and
 * is never logged, never audited and never returned by a DTO; the receiver configures it VERBATIM.
 *
 * WHY NOT STORE `sha256(secret)` AND SIGN WITH THAT. §7.2's "prefix + hash" is the right shape for a
 * TOKEN, where the stored digest is only ever COMPARED against a presented value. A symmetric signature
 * USES its key, so a stored digest used as the HMAC key is a plaintext credential in a column whatever
 * it is named. This module therefore stores a salt and derives, which keeps §7.2's property — the
 * database alone is not enough — rather than its literal wording. Recorded in
 * the build record
 *
 * ROTATION. Rotating `WEBHOOK_SIGNING_KEY` re-keys every endpoint at once and each receiver has to be
 * given its new secret; rotating ONE endpoint is still creating a new endpoint and revoking the old,
 * which is why revoke is soft.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { safeEqualStrings } from "@/lib/safe-equal";

/** Header carrying `sha256=<hex>`. */
export const WEBHOOK_SIGNATURE_HEADER = "X-WMHD-Signature" as const;
/** Header carrying the unix-seconds timestamp that was folded into the digest. */
export const WEBHOOK_TIMESTAMP_HEADER = "X-WMHD-Timestamp" as const;
/** Header carrying the `WebhookDelivery.id`, so a receiver can dedupe an at-least-once redelivery. */
export const WEBHOOK_DELIVERY_HEADER = "X-WMHD-Delivery" as const;
/** Header carrying the `AuditAction` this delivery is for, so a receiver can route without parsing. */
export const WEBHOOK_EVENT_HEADER = "X-WMHD-Event" as const;

/** The prefix on the signature value. Named so a receiver can reject an unknown algorithm outright. */
export const WEBHOOK_SIGNATURE_PREFIX = "sha256=" as const;

/** Bytes of entropy in a generated signing secret. 32 bytes → 64 hex characters. */
export const WEBHOOK_SECRET_BYTES = 32;

/**
 * How many leading characters of the SALT are stored for display (§7.2 / the schema's doc comment).
 *
 * Of the salt, never of the secret: the prefix is shown on the admin page and travels in the
 * `WEBHOOK_ENDPOINT_CREATED` audit metadata, so it has to be a random non-secret label — the same
 * property `ClientApiToken.prefix` has by being a separate component.
 */
export const WEBHOOK_SECRET_PREFIX_CHARS = 8;

/** Domain separator, so this key cannot collide with any other use of `WEBHOOK_SIGNING_KEY`. */
export const WEBHOOK_SIGNING_DOMAIN = "wmhd:webhook-signing:v1" as const;

/** Separator between the timestamp and the body in the signed material. */
const SIGNED_PAYLOAD_SEPARATOR = ".";

/**
 * The exact bytes the HMAC is computed over: `<unix-seconds>.<raw body>`.
 *
 * Exported because a receiver's implementation has to reproduce it and the documentation quotes this
 * function rather than describing it in prose.
 */
export function webhookSignedPayload(body: string, timestamp: number): string {
  return `${Math.trunc(timestamp)}${SIGNED_PAYLOAD_SEPARATOR}${body}`;
}

/**
 * `sha256=<lower-case hex>` — HMAC-SHA256 of `webhookSignedPayload(body, timestamp)` under `secret`.
 *
 * `timestamp` is UNIX SECONDS, not milliseconds: it is a header value an integrator reads, and every
 * comparable scheme in the wild uses seconds. A fractional value is truncated rather than rejected, so
 * `Date.now() / 1000` cannot silently produce a digest nobody can reproduce.
 */
export function signWebhookBody(secret: string, body: string, timestamp: number): string {
  const digest = createHmac("sha256", secret).update(webhookSignedPayload(body, timestamp), "utf8").digest("hex");
  return `${WEBHOOK_SIGNATURE_PREFIX}${digest}`;
}

/**
 * Constant-time comparison of two signature header values, for the tests and for any future inbound
 * verification. Length-safe: two values of different lengths compare false without throwing, and
 * without a length branch that would time differently — `safeEqualStrings` hashes both sides to 32
 * bytes first, so there is nothing left to compare but two fixed-width digests.
 */
export function webhookSignatureMatches(expected: string, actual: string): boolean {
  // `safeEqualStrings` rather than a local `timingSafeEqual`: the explicit length guard this used to
  // carry returned early on a length mismatch, which answers "how long is the real signature?" in the
  // time it takes to return. Hashing both sides first makes the two operands fixed-width, so there is
  // no length branch left to time — and it keeps this module on the ONE construction
  // the build record names, alongside `storage.ts` and `email/reply-token.ts`.
  return safeEqualStrings(expected, actual);
}

/** sha256 hex of a UTF-8 string. Used for `WebhookDelivery.payloadHash` and for delivery ids. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The key one endpoint signs with: `HMAC-SHA256(appKey, "<domain>:<salt>")` as 64 hex characters.
 *
 * Null — never a fallback — when `appKey` is unset or empty, which is the fail-closed rule §4 applies
 * to `REPLY_TOKEN_SECRET`: a desk that cannot sign does not send. The salt is not a secret and the
 * app key never touches the database, so BOTH halves are required to produce a valid signature.
 *
 * Pure, and the app key is a parameter rather than an `env` read, so this module stays importable from
 * anywhere and the callers (`createWebhookEndpoint`, the dispatcher) own the configuration read.
 */
export function deriveEndpointSigningKey(appKey: string | undefined, salt: string): string | null {
  if (typeof appKey !== "string" || appKey.length === 0) return null;
  if (typeof salt !== "string" || salt.length === 0) return null;
  return createHmac("sha256", appKey).update(`${WEBHOOK_SIGNING_DOMAIN}:${salt}`, "utf8").digest("hex");
}

export type MintedWebhookSecret = {
  /** Shown ONCE, by the create action, and never again. The receiver uses it VERBATIM. */
  plaintext: string;
  /**
   * Stored on the row: a random per-endpoint salt, 64 hex characters, which satisfies the DB CHECK
   * `^[0-9a-f]{64}$` that the column (still named `secretHash`) carries. It is NOT a digest of the
   * secret and it is not signable on its own.
   */
  secretSalt: string;
  /** Stored: the first eight characters OF THE SALT — a random label, not part of any credential. */
  secretPrefix: string;
};

/**
 * A fresh endpoint secret: mint a salt, derive the key from it and the app-held key.
 *
 * 32 random bytes of salt and a 256-bit derived key, both rendered as 64 hex characters — long enough
 * that an offline attack on a captured signature is not a consideration, and printable so an operator
 * can paste the secret into the receiving system without an encoding question.
 *
 * Null when `appKey` is unset: creating an endpoint whose deliveries could never be signed would be
 * handing an operator a credential that does not work, so the create action refuses instead.
 */
export function mintWebhookSecret(appKey: string | undefined): MintedWebhookSecret | null {
  const secretSalt = randomBytes(WEBHOOK_SECRET_BYTES).toString("hex");
  const plaintext = deriveEndpointSigningKey(appKey, secretSalt);
  if (plaintext === null) return null;
  return {
    plaintext,
    secretSalt,
    secretPrefix: secretSalt.slice(0, WEBHOOK_SECRET_PREFIX_CHARS),
  };
}
