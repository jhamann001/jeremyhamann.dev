/**
 * Reply token — the signed thread handle Cedar Ridge puts in the outbound Reply-To (node only).
 *
 * Format (binding on S2 AND S3 byte for byte):
 *
 *     wm.<base64url(ticketId)>.<base64url(hmac-sha256(secret, ticketId) first 16 BYTES)>
 *
 * lower-case `wm.` prefix, two dots, base64url with no padding. The signature half is the first
 * 16 bytes of the raw HMAC digest — truncation is over the DIGEST BYTES, not its hex text, which
 * is the only reading that yields a fixed 22-character base64url segment. S3 never re-implements
 * this: it calls `formatReplyToken`, so the two halves cannot drift.
 *
 * `REPLY_TOKEN_SECRET` unset (or empty) means `formatReplyToken` returns null and nothing
 * downstream emits a token — the fail-closed rule in §4. Verification is constant-time over the
 * signature and returns the ticket id rather than a boolean, so a caller cannot forget to read it.
 *
 * ROTATION. Signing always uses the current secret; verification may also accept retired ones
 * (`REPLY_TOKEN_PREVIOUS_SECRETS`). Without that overlap, rotating the key silently invalidates every
 * token already sitting in a client's mailbox and their replies land in suspended intake to be
 * released by hand for as long as people keep replying to old mail. `verifyReplyTokenWithRotation`
 * reports WHICH generation matched so the tail is measurable in the audit metadata and the retired
 * value can be dropped once it stops being used.
 */
import { createHmac } from "node:crypto";
import { safeEqualStrings } from "@/lib/safe-equal";

/** Raw HMAC bytes kept in the token. 16 bytes = 128 bits = 22 base64url characters. */
export const REPLY_TOKEN_SIGNATURE_BYTES = 16 as const;

/**
 * The shape of a whole token, ANCHORED: `verifyReplyToken` tests a candidate against it and
 * `extractReplyToken` tests each candidate it scans out of an address. Deliberately has no `g`
 * flag — a global regex carries `lastIndex` between calls and would make `.test` alternate.
 */
export const REPLY_TOKEN_PATTERN = /^wm\.([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{22})$/;

/** Unanchored scan used to pull a token out of `"Name" <support+wm.x.y@domain>` or a bare address. */
const REPLY_TOKEN_SCAN = /wm\.[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{22}/g;

/** A ticket id we are willing to sign or return: cuid-shaped, bounded (mirrors PLAUSIBLE_TICKET_ID). */
const PLAUSIBLE_TICKET_ID = /^[A-Za-z0-9_]{1,64}$/;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function usableSecret(secret: string | undefined): string | null {
  if (typeof secret !== "string") return null;
  return secret.length === 0 ? null : secret;
}

function signature(ticketId: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(ticketId, "utf8").digest();
  return base64url(digest.subarray(0, REPLY_TOKEN_SIGNATURE_BYTES));
}

/**
 * The token for `ticketId`, or null when the secret is unset — the caller then emits a Reply-To
 * with no token and inbound threading falls back to In-Reply-To / References.
 * An implausible ticket id is refused the same way: we never sign something we cannot round-trip.
 */
export function formatReplyToken(ticketId: string, secret: string | undefined): string | null {
  const key = usableSecret(secret);
  if (key === null) return null;
  if (typeof ticketId !== "string" || !PLAUSIBLE_TICKET_ID.test(ticketId)) return null;
  return `wm.${Buffer.from(ticketId, "utf8").toString("base64url")}.${signature(ticketId, key)}`;
}

/**
 * The ticket id carried by a valid token, or null. Constant-time over the signature: both sides are
 * hashed to a fixed 32 bytes first, so neither the comparison nor its length leaks which prefix of a
 * forged signature was correct. Returns null — never throws — for every malformed input, because the
 * caller is an unauthenticated mail path and a thrown parse error would be a denial-of-service lever.
 */
export function verifyReplyToken(token: string, secret: string | undefined): string | null {
  return verifyReplyTokenWithRotation(token, secret, [])?.ticketId ?? null;
}

/** Which generation of the signing key a token was minted under. */
export type ReplyTokenGeneration = "current" | "previous";

export type ReplyTokenMatch = {
  ticketId: string;
  generation: ReplyTokenGeneration;
  /** 0 for the current secret, then the 1-based position in the retired list. For the audit metadata. */
  secretIndex: number;
};

/**
 * `verifyReplyToken`, plus the retired secrets a rotation is still accepting. The current secret is
 * tried first, then each retired one in order; the first match wins and says which it was. Every
 * candidate runs the same constant-time comparison, so a retired-key hit is not distinguishable by
 * timing from a current-key one.
 */
export function verifyReplyTokenWithRotation(
  token: string,
  secret: string | undefined,
  previousSecrets: readonly string[],
): ReplyTokenMatch | null {
  if (typeof token !== "string") return null;
  const match = REPLY_TOKEN_PATTERN.exec(token.trim());
  if (match === null) return null;

  let ticketId: string;
  try {
    ticketId = Buffer.from(match[1], "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!PLAUSIBLE_TICKET_ID.test(ticketId)) return null;
  // base64url is not injective over arbitrary bytes once re-encoded, so re-encode and compare: a
  // token whose id half is padded or re-cased must not verify as the canonical id. Constant-time like
  // the signature half below — this half of the token is attacker-supplied too, and one `!==` beside
  // one `timingSafeEqual` is exactly the mixed shape CWE-208 is written to catch.
  if (!safeEqualStrings(Buffer.from(ticketId, "utf8").toString("base64url"), match[1])) return null;

  const candidates: readonly (string | undefined)[] = [secret, ...previousSecrets];
  for (let i = 0; i < candidates.length; i++) {
    const key = usableSecret(candidates[i]);
    if (key === null) continue;
    // `safeEqualStrings` IS the SHA-256-both-sides-then-`timingSafeEqual` construction this loop used
    // to spell out; one shared function rather than a private copy per verifier (security scanner CWE-208).
    if (safeEqualStrings(signature(ticketId, key), match[2])) {
      return { ticketId, generation: i === 0 ? "current" : "previous", secretIndex: i };
    }
  }
  return null;
}

/**
 * The first well-formed token in a Reply-To header, an envelope recipient or a bare address —
 * `"Cedar Ridge Wealth" <support+wm.aa.bb@example.com>`, `support+wm.aa.bb@…`, or the token
 * on its own. Shape only: `verifyReplyToken` still decides whether it is genuine.
 */
export function extractReplyToken(value: string): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  REPLY_TOKEN_SCAN.lastIndex = 0;
  for (const candidate of value.match(REPLY_TOKEN_SCAN) ?? []) {
    if (REPLY_TOKEN_PATTERN.test(candidate)) return candidate;
  }
  return null;
}
