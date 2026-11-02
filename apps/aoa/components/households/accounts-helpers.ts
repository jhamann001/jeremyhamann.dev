import type { PillTone } from "@/components/ui";

// Pure logic behind the household detail "Combined accounts" card and the
// households-list per-row report link (TKT household-report consolidation).
// Node-testable — no React, no DOM — mirroring the deal-form.ts idiom.

// The serializable, lean account shape the RSC page passes into
// HouseholdOverview (mapped from lib/data/account-aum.ts ApexAccountAum — the
// Dates are serialized as YYYY-MM-DD strings at the RSC boundary. `value` is
// the authoritative total and remains as a compatibility alias.
export type CombinedAccount = {
  id?: string;
  custodian?: "Apex" | "Schwab";
  owner: string; // account owner's display name (resolved from household members)
  type: string;
  num: string;
  status: string | null;
  value: number | null;
  cash: number | null;
  securities: number | null;
  balanceAsOf: string | null;
  balanceCurrent: boolean;
  closeDate: string | null;
  closeDateSource: "APEX" | "PROVISIONAL_OVERRIDE" | null;
};

// Map a (free-text) Apex account_status to a Pill tone — same ruling as the
// per-account portrait table (client-portrait/AccountsSection):
//   OPEN/ACTIVE             → green
//   FUNDING/PENDING         → amber
//   CLOSED/RESTRICTED/other → gray  (null/unknown too)
export function accountStatusTone(status: string | null): PillTone {
  switch ((status ?? "").trim().toUpperCase()) {
    case "OPEN":
    case "ACTIVE":
      return "green";
    case "FUNDING":
    case "PENDING":
      return "amber";
    default:
      return "gray";
  }
}

/** Sum of the accounts' values, matching the KPI convention: a null value is
 *  unknown and skipped (treated as 0 in the roll-up), a genuine $0 counts.
 *  All-null (or empty) → 0. */
export function accountsTotal(accounts: readonly { value: number | null }[]): number {
  return accounts.reduce((s, a) => s + (a.value ?? 0), 0);
}

/** Current visible balance only. Closed/stale rows never enter an AUM total. */
export function currentAccountsTotal(
  accounts: readonly { value: number | null; balanceCurrent: boolean }[],
): number {
  return accounts.reduce((sum, account) =>
    sum + (account.balanceCurrent ? Math.round((account.value ?? 0) * 100) : 0), 0) / 100;
}

export type CurrentAccountsSummary =
  | { available: true; value: number }
  | { available: false; value: null };

/** A pending open/unknown-lifecycle row makes the whole aggregate unavailable.
 * Never display a partial current sum as if it were the complete household. */
export function currentAccountsSummary(
  accounts: readonly {
    value: number | null;
    status: string | null;
    balanceCurrent: boolean;
  }[],
): CurrentAccountsSummary {
  if (accounts.some((account) => accountBalanceState(account) === "REFRESH_PENDING" ||
    (accountBalanceState(account) === "CURRENT" && account.value == null))) {
    return { available: false, value: null };
  }
  return { available: true, value: currentAccountsTotal(accounts) };
}

export type AccountBalanceState = "CURRENT" | "CLOSED" | "REFRESH_PENDING";

/** Lifecycle and valuation freshness are separate. A non-current OPEN account
 * during rollout is pending, never mislabeled as closed. */
export function accountBalanceState(account: {
  status: string | null;
  balanceCurrent: boolean;
}): AccountBalanceState {
  if ((account.status ?? "").trim().toUpperCase() === "CLOSED") return "CLOSED";
  return account.balanceCurrent ? "CURRENT" : "REFRESH_PENDING";
}

/** Empty means current, known cash, securities and total are each exactly zero.
 * A zero net total alone is insufficient; stale/unknown balances stay visible. */
export function isEmptyAccount(
  account: Pick<CombinedAccount, "cash" | "securities" | "value" | "status" | "balanceCurrent">,
): boolean {
  return account.balanceCurrent === true && accountBalanceState(account) === "CURRENT" &&
    [account.cash, account.securities, account.value]
      .every((balance) => Number.isFinite(balance) && balance === 0);
}

/** Count pill label, e.g. 0 → "0 accounts", 1 → "1 account", 3 → "3 accounts". */
export function accountCountLabel(n: number): string {
  return `${n} account${n === 1 ? "" : "s"}`;
}
