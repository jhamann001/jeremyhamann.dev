import { indexAoaAccounts, matchIdentity, normalizeEmail, type AoaRole } from "./identity";

export type StandaloneIdentity = { email: string; role: "advisor" | "trader"; isActive: boolean };
export type AoaAccount = { email: string | null; role: AoaRole };
export type ReconciliationCounts = {
  standaloneActive: number;
  matched: number;
  missing: number;
  roleConflicts: number;
  ambiguous: number;
  rosterMismatches: number;
  exceptionCovered: number;
  /** 1 when no active standalone identity exists (nothing copied yet): the verdict fails, whatever the exceptions. */
  noStandaloneIdentities: number;
};
export type Reconciliation = { verdict: "passed" | "failed"; counts: ReconciliationCounts };

/** Role-consistent: a standalone trader holds ADMIN or OPERATIONS; a standalone advisor holds ADVISOR. */
export function roleConsistent(standalone: "advisor" | "trader", aoa: AoaRole): boolean {
  return standalone === "trader" ? aoa === "ADMIN" || aoa === "OPERATIONS" : aoa === "ADVISOR";
}

/** Counts only. `exceptions` holds normalized emails the owner accepted; it is never echoed. */
export function computeReconciliation(
  identities: readonly StandaloneIdentity[],
  accounts: readonly AoaAccount[],
  exceptions: ReadonlySet<string>,
): Reconciliation {
  const active = identities.filter((i) => i.isActive);
  const perEmail = new Map<string, number>();
  for (const i of active) perEmail.set(normalizeEmail(i.email), (perEmail.get(normalizeEmail(i.email)) ?? 0) + 1);
  const index = indexAoaAccounts(accounts);
  const counts: ReconciliationCounts = {
    standaloneActive: active.length,
    matched: 0,
    missing: 0,
    roleConflicts: 0,
    ambiguous: 0,
    rosterMismatches: 0,
    exceptionCovered: 0,
    noStandaloneIdentities: active.length === 0 ? 1 : 0,
  };
  let blocking = 0;
  for (const i of active) {
    const email = normalizeEmail(i.email);
    const { status, account } = matchIdentity(email, index, perEmail.get(email) ?? 0);
    let isBlocking = false;
    if (status === "missing") {
      counts.missing++;
      isBlocking = true;
    } else if (status === "ambiguous") {
      counts.ambiguous++;
      isBlocking = true;
    } else {
      counts.matched++;
      if (!roleConsistent(i.role, account!.role)) {
        counts.roleConflicts++;
        isBlocking = true;
      }
    }
    if (i.role === "trader" && !(status === "matched" && roleConsistent("trader", account!.role))) counts.rosterMismatches++;
    if (isBlocking) {
      if (exceptions.has(email)) counts.exceptionCovered++;
      else blocking++;
    }
  }
  return { verdict: blocking === 0 && counts.noStandaloneIdentities === 0 ? "passed" : "failed", counts };
}
