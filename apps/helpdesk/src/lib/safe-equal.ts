/**
 * Constant-time string comparison — node only, layer L2.
 *
 * Why this module exists: security scanner SAST rule ("Timing Attack Vulnerability in
 * String Comparisons", CWE-208) fires on every `===` / `!==` between a request-derived value and a
 * stored secret, token, signature or identity. The remediation security scanner prescribes is
 * `crypto.timingSafeEqual`. `src/lib/integration-auth.ts` and `src/server/client-view.ts` already
 * carried that construction, written out twice, byte for byte. This is the single copy both of them
 * and every new caller share, so the two bearers cannot drift apart and a third caller cannot invent
 * a third construction.
 *
 * The construction: SHA-256 both sides, then `timingSafeEqual` over the two 32-byte digests.
 * Hashing first is what makes the comparison safe for inputs of *different lengths* —
 * `timingSafeEqual` throws on a length mismatch, and a thrown/caught length check is itself the
 * timing oracle the rule is about. The digest is not a secret: it is a fixed-width stand-in for the
 * comparison, and an attacker who can already supply one side learns nothing from it.
 *
 * What this module is NOT for: a browser. `node:crypto` is unavailable there, and a secret the
 * browser holds is already disclosed. A client-side "type the token to confirm" box must be
 * restructured (compare a server-issued confirmation token, or drop the equality) rather than
 * reaching for this
 */
import { createHash, timingSafeEqual } from "node:crypto";

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

/**
 * True when `a` and `b` are the same string, compared in time that does not depend on where they
 * first differ or on how long either one is.
 *
 * Use it for bearer tokens, API keys, webhook signatures, reply tokens and any other value where one
 * side came off the wire and the other is held by the server. Not a replacement for `===` on values
 * that are not secret — it is slower and says nothing about ordering.
 */
export function safeEqualStrings(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/**
 * The normalisation an email address gets before it is compared as an identity: surrounding
 * whitespace removed, case folded.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: the latter is locale-dependent, and under a Turkish
 * locale `I` folds to `ı`, which would make the same address compare differently on two machines.
 * Exported so a caller that has to normalise before *storing* uses the same function the comparison
 * uses — a mismatch between the two is how "the addresses are equal but the check says no" starts.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * True when two email addresses are the same identity: the SAME normalisation is applied to both
 * sides, then {@link safeEqualStrings}.
 *
 * Applying it to both sides is the part that matters. A comparison that normalises only the
 * request-derived side answers "no" for an address that differs from the stored one only in case,
 * and a comparison that normalises neither is the `===` the rule flags. Address comparison decides
 * whether a requester may see a ticket, so it is an identity check, not a string check.
 *
 * The local part is NOT case-folded by RFC 5321 in general; folding it is a deliberate product
 * decision this desk already makes everywhere it stores an address, and the point of this function
 * is that every caller makes it identically.
 */
export function safeEqualEmails(a: string, b: string): boolean {
  return safeEqualStrings(normalizeEmail(a), normalizeEmail(b));
}
