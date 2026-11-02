import type { TradeRequestSummary } from "./trade-requests";

// Initial-Funding coverage check for a transfer's receiving account.
//
// A receiving account that is already OPEN at Apex should appear on an Initial
// Funding trade request for the client. This matches the receiving account
// against the account lines of the client's Initial Funding requests by the
// LAST 4 of the Apex account number. A request may span MULTIPLE accounts — the
// receiving account only needs to be ONE of them; the other accounts on the
// request are ignored (they may be their own transfers, or not — owner decision
// 2026-07-23).
//
// WHY last-4 ONLY (not last-4 + registration type): the trade-request account
// number is MASKED to last-4 at the source (it never leaves that system
// unmasked), so last-4 is the strongest account identity we have. Registration
// TYPE is deliberately NOT part of the match: the receiving side's type label
// comes from the asset map, the request side's from the trade-request app, and
// the two vocabularies don't align string-for-string ("Traditional IRA" vs
// "IRA" vs "TRADITIONAL_IRA", "Joint" vs "JOINT_..._SURVIVORSHIP"). A type guard
// there produced false "not covered" flags on real, correctly-linked accounts
// (Reynold Hayes, REQ-X6S651A3, 2026-07-23). We scope to the client's OWN
// Initial Funding requests, so a last-4 collision would need the same client to
// hold two accounts sharing a last-4 — vanishingly rare, and the failure mode
// (a false "covered") is softer than suppressing a genuine match.
//
// SCOPE: Initial Funding ONLY for now (Cash Deposit may be added later — just
// extend COVERING_TYPES).
//
// PURE — no I/O. The page supplies the client's requests (from the memoized
// trade-request read) and the receiving account's masked number.

export type FundingCoverage = {
  covered: boolean;
  /** The Initial Funding request that lists this account (when covered). */
  requestId: string | null;
  status: string | null;
};

/** Trade types that satisfy the funding check. Extend (e.g. "cashdeposit") when
 *  another type should also count. Values are normalized (lower, alphanumerics). */
const COVERING_TYPES = new Set(["initialfunding"]);

const normType = (s: string | null | undefined): string =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Trailing 4 alphanumerics of a (possibly masked) account number, lower-cased;
 *  null when fewer than 4 are present. Handles both mask styles — `••••3N12`
 *  (receiving side) and `****3N12` (trade-request side): the mask chars are
 *  stripped, the account's own characters remain, so both yield the same key. */
export function accountLast4(masked: string | null | undefined): string | null {
  const alnum = (masked ?? "").replace(/[^a-zA-Z0-9]/g, "");
  return alnum.length >= 4 ? alnum.slice(-4).toLowerCase() : null;
}

/**
 * Does an Initial Funding request for the client list this receiving account?
 * `receiving.last4` is the account's (masked) Apex number. Match is by last-4
 * only (see file header). Returns the first matching request, or covered:false.
 * Not covered when there's no last-4 to match on (e.g. an account not yet open
 * at Apex).
 */
export function initialFundingCoverage(
  receiving: { last4: string | null },
  requests: TradeRequestSummary[],
): FundingCoverage {
  const none: FundingCoverage = { covered: false, requestId: null, status: null };
  const want4 = accountLast4(receiving.last4);
  if (!want4) return none;
  for (const r of requests) {
    if (!COVERING_TYPES.has(normType(r.tradeType))) continue;
    for (const a of r.accounts) {
      if (accountLast4(a.accountNumber) === want4) {
        return { covered: true, requestId: r.id, status: r.status };
      }
    }
  }
  return none;
}
