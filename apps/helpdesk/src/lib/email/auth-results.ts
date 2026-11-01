/**
 * Authentication-Results parsing — pure (hard rule).
 *
 * The receiving MTA (Google Workspace today) writes its own verdicts into `Authentication-Results`;
 * the n8n workflow forwards that header and this module reads it. Nothing here verifies a
 * signature: we are reading the verdict of the server that actually holds the DNS answers and the
 * connection, which is the only place SPF and DKIM can be evaluated.
 *
 * **Only the topmost header, and only from a trusted authserv-id.** `Authentication-Results` is a
 * trace header field: a sender can put `Authentication-Results: mx.google.com; dmarc=pass` into the
 * message they compose, and the receiving MTA prepends its own verdict without stripping theirs, so
 * the message arrives carrying two headers that disagree. RFC 8601 §5 is explicit that only the
 * header the trusted MTA added — the topmost one — may be believed and every other occurrence must
 * be discarded unread. This module therefore reads exactly one header (the first value it is given,
 * which the workflow and the fixtures both guarantee is the topmost) and refuses to authenticate at
 * all when that header's authserv-id is not one of {@link TRUSTED_AUTHSERV_IDS}. An attacker
 * controls the text of their own header but not which host Google names in its.
 *
 * The any-pass rule survives only *within* one header, which is what RFC 8601 licenses: one message
 * signed by two domains produces two `dkim=` results of equal standing in the same header.
 *
 * **There is no benefit of the doubt.** `authenticated` is true only when DMARC says `pass` in a
 * header written by a trusted authserv-id. A missing header, an unparseable header, a header from
 * an unrecognised authserv-id, a `dmarc=none` (no published policy) and an outright `dmarc=fail`
 * are all `authenticated: false`, and the intake path then refuses to attribute the message to a
 * requester, refuses to reopen a ticket, and suspends it as UNAUTHENTICATED. Email-originated wire
 * and address-change instructions are the classic BEC vector; this is the control that answers for
 * them.
 */

export type Verdict =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "temperror"
  | "permerror"
  | "unknown";

export type SenderAuthVerdict = {
  spf: Verdict;
  dkim: Verdict;
  dmarc: Verdict;
  /** DMARC pass in a header written by a trusted authserv-id, and nothing else. */
  authenticated: boolean;
  /**
   * The authserv-id of the one header that was read, lower-cased — `"mx.google.com"` for Google
   * Workspace. Null when no header was supplied, or when the header states no authserv-id at all.
   */
  authservId: string | null;
  /** Whether {@link authservId} is one of the receiving MTAs this desk trusts. */
  trustedAuthserv: boolean;
  /**
   * How many `Authentication-Results` headers the message carried. Anything above 1 means extra
   * headers were discarded unread per RFC 8601 §5 — normal for relayed mail, and the signal a
   * reviewer wants on a SuspendedIntake row when the sender forged one.
   */
  headerCount: number;
};

/**
 * The authserv-ids whose verdicts this desk acts on: the hostname Google Workspace stamps into the
 * header it writes on delivery. A verdict from anyone else — including a sender who helpfully
 * supplied their own — is read for display but never authenticates a message.
 *
 * Adding an entry here is a security decision: it says "this host's word is enough to attribute a
 * wire instruction to a client".
 *
 * This is the DEFAULT, not the only source: `EMAIL_TRUSTED_AUTHSERV_IDS` (src/lib/env.ts) overrides it
 * per deployment, because the value is a property of the receiving MTA and changes the day desk mail
 * leaves Google Workspace. `src/server/email-intake.ts` passes `trustedAuthservIds(env.…)`, which
 * returns `undefined` — i.e. falls back to this list — for an unset or empty key: an EMPTY trusted set
 * authenticates nothing and would hold every inbound message, which is not what "unset" means.
 */
export const TRUSTED_AUTHSERV_IDS: readonly string[] = ["mx.google.com"];

const VERDICTS: readonly Verdict[] = [
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "unknown",
];

/**
 * `spf=pass`, `dkim=fail`, `dmarc=temperror`, … The lookbehind refuses a method name that is the
 * tail of a longer token (`policy.dmarc=`, `header.spf=`) so a property inside a result's own
 * comment cannot be read as a second verdict. Hyphen is excluded too: `arc-dkim=` is not dkim.
 */
const METHOD_VERDICT = /(?<![\w.\-])(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi;

/** Everything inside (...) is a human comment: `dmarc=pass (p=REJECT sp=REJECT dis=NONE)`. */
function stripComments(raw: string): string {
  let out = "";
  let depth = 0;
  for (const ch of raw) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

function asVerdict(raw: string): Verdict {
  const lowered = raw.toLowerCase();
  return (VERDICTS as readonly string[]).includes(lowered) ? (lowered as Verdict) : "unknown";
}

/**
 * Collapses the several results one method can carry **inside a single header**. A message signed by
 * two domains produces two `dkim=` results and RFC 8601 gives them equal standing, so ANY pass is a
 * pass; otherwise the first stated verdict is kept (it is the receiving MTA's primary evaluation)
 * and "unknown" only survives when the method was never mentioned.
 *
 * This is deliberately not applied across headers: see the module comment.
 */
function collapse(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return "unknown";
  if (verdicts.includes("pass")) return "pass";
  return verdicts[0];
}

/**
 * Splits the value the caller handed us into the individual header occurrences it represents.
 *
 * Repeated headers reach this module joined with "\n" — that is what the n8n workflow does for the
 * multi-valued headers it forwards, what `parseInboundEmail` does with an array-valued header, and
 * what the fixture parser does. RFC 5322 folded continuation lines are unwrapped to spaces by all
 * three before that join, so a "\n" here always separates two headers rather than splitting one.
 */
function headerOccurrences(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The authserv-id is the first token of the header, before the first ";" and before any optional
 * version number: `mx.google.com; spf=pass …` or `mx.google.com 1; spf=pass …`.
 *
 * Returns null when the header opens with something that cannot be an authserv-id — in practice a
 * header that states no authserv-id at all and begins with its first method result. Null is never
 * trusted, so a malformed header fails closed.
 */
function authservIdOf(header: string): string | null {
  const beforeSemicolon = header.split(";", 1)[0] ?? "";
  const token = beforeSemicolon.trim().split(/\s+/, 1)[0] ?? "";
  if (token.length === 0) return null;
  // `spf=pass` is a result, not an authserv-id; so is anything carrying "=" or "@".
  if (token.includes("=") || token.includes("@")) return null;
  return token.toLowerCase();
}

/**
 * Parses the message's `Authentication-Results`. Never throws.
 *
 * Only the FIRST header is read; any others are counted and discarded (RFC 8601 §5). The result is
 * `authenticated: true` only when that header was written by a trusted authserv-id and states
 * `dmarc=pass`.
 *
 * A header that is absent, empty or mentions no method at all yields `unknown` for every method —
 * deliberately distinct from `none`, which is a real verdict meaning "the domain publishes no
 * policy". Both are `authenticated: false`; the distinction is for the human reviewing the
 * SuspendedIntake row, who needs to tell "the workflow did not forward the header" from "this
 * sender's domain has no DMARC record". `authservId` and `headerCount` serve that reviewer too: an
 * untrusted authserv-id, or a `headerCount` above 1 on a message that should not have been relayed,
 * is the fingerprint of an attempted forgery rather than of a misconfigured sender.
 *
 * @param trustedAuthservIds Overridable for tests and for a future deployment key. An empty list
 *   trusts nobody, which is the fail-closed direction.
 */
export function parseAuthenticationResults(
  raw: string | null | undefined,
  trustedAuthservIds: readonly string[] = TRUSTED_AUTHSERV_IDS,
): SenderAuthVerdict {
  const found: Record<"spf" | "dkim" | "dmarc", Verdict[]> = { spf: [], dkim: [], dmarc: [] };

  const occurrences = typeof raw === "string" ? headerOccurrences(raw) : [];
  const topmost = occurrences.length > 0 ? occurrences[0] : null;

  let authservId: string | null = null;
  if (topmost !== null) {
    const scanned = stripComments(topmost);
    authservId = authservIdOf(scanned);
    METHOD_VERDICT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = METHOD_VERDICT.exec(scanned)) !== null) {
      const method = match[1].toLowerCase() as "spf" | "dkim" | "dmarc";
      found[method].push(asVerdict(match[2]));
    }
  }

  const trusted = new Set(trustedAuthservIds.map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0));
  const trustedAuthserv = authservId !== null && trusted.has(authservId);
  const dmarc = collapse(found.dmarc);

  return {
    spf: collapse(found.spf),
    dkim: collapse(found.dkim),
    dmarc,
    authenticated: trustedAuthserv && dmarc === "pass",
    authservId,
    trustedAuthserv,
    headerCount: occurrences.length,
  };
}
