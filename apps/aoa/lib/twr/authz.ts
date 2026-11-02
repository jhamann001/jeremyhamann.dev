// Coarse role gate for the account-level Performance report page. Kept as a
// pure, runtime-dependency-free helper (like lib/auth/roles.ts) so this
// security-critical predicate can be unit-tested in isolation.
//
// This is only the FIRST gate. Ops/Admin may open ANY account; Advisor and
// Client Service are additionally scoped PER-ACCOUNT by Postgres RLS (the
// client_account_aum_own_book policy, via apexAccountByNumber) so they see only
// accounts whose household they can see: an advisor's own book, every client
// household for Client Service. VIEWER and any unknown role are excluded here
// outright and never reach account data.

export const REPORT_ROLES = new Set([
  "ADMIN",
  "OPERATIONS",
  "ADVISOR",
  "CLIENT_SERVICE",
]);

/** True when the role is permitted to open a Performance report at all. Fails
 *  closed for null/empty/VIEWER/unknown. */
export function canOpenReport(role: string | null | undefined): boolean {
  return REPORT_ROLES.has(role ?? "");
}
