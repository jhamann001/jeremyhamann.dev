import type { ApexAccount, Beneficiary, ExternalAccount } from "@/lib/data/types";
import {
  summarizeHouseholdDeals,
  type DealRow,
} from "@/lib/data/deal-types";

// Pure display helpers for the Core Financial accounts stack (P1, ticket).
// Kept dependency-free so they unit-test without React (pattern:
// components/deals/stage-tone.ts).

// Sum only accounts with a known value; a null value (unknown valuation) is
// skipped, never counted as 0 — mirrors Postgres SUM() skipping NULLs at the seam.
export function apexTotal(accounts: ApexAccount[]): number {
  return accounts.reduce((sum, a) => sum +
    (a.status.trim().toUpperCase() !== "CLOSED" && a.balanceCurrent !== false ? Math.round((a.value ?? 0) * 100) : 0), 0) / 100;
}

export function apexAccountBalanceAvailable(account: ApexAccount): boolean {
  const closed = account.status.trim().toUpperCase() === "CLOSED";
  return closed || (account.balanceCurrent !== false && account.value != null);
}

/** False during the migration-to-first-import window. A mixed current/pending
 * set must not produce a plausible-looking partial total. */
export function apexBalancesAvailable(accounts: ApexAccount[]): boolean {
  return accounts.every(apexAccountBalanceAvailable);
}

export function extTotal(accounts: ExternalAccount[]): number {
  return accounts.reduce((sum, a) => sum + a.balance, 0);
}

/** Display total for the linked accounts on the card. Sums the holdings
 * total each row renders in its Total column. A row that renders no total
 * is not added. Null when every row has no holdings total, so the UI does
 * not invent a zero. Institution balance is not an input, and the result
 * is not an AUM input.
 */
export function linkedDisplayedTotal(accounts: ExternalAccount[]): number | null {
  const shown = accounts.filter((a) => typeof a.holdingsTotal === "number" && Number.isFinite(a.holdingsTotal));
  if (shown.length === 0) return accounts.length === 0 ? 0 : null;
  return shown.reduce((sum, a) => sum + Math.round(a.holdingsTotal! * 100), 0) / 100;
}

export type BeneficiaryGroup = {
  acct: string;
  num: string;
  list: Beneficiary[];
};

// Group beneficiaries by owning account (mockup renderAccounts grouping:
// keyed on the masked account number, first-seen order preserved).
export function groupBeneficiaries(bene: Beneficiary[]): BeneficiaryGroup[] {
  const groups: BeneficiaryGroup[] = [];
  for (const b of bene) {
    let g = groups.find((x) => x.num === b.num);
    if (!g) {
      g = { acct: b.acct, num: b.num, list: [] };
      groups.push(g);
    }
    g.list.push(b);
  }
  return groups;
}

// tkt-deals-client-link: the Client Portrait deals-card rollup line — total
// count + open-pipeline $. Mirrors getHousehold's dealSummary fold exactly:
// openPipeline SUMS `amount` for every stage NOT in WON/LOST. Pure (no React)
// so it unit-tests alongside the other portrait helpers.
export type ClientDealRollup = {
  count: number;
  /** Every deal that has not reached a terminal WON/LOST stage. */
  outstandingCount: number;
  outstandingAmount: number;
  /** WON is displayed as "Funded" throughout the deals UI. */
  fundedCount: number;
  fundedAmount: number;
  /** Backward-compatible name for the outstanding amount. */
  openPipeline: number;
};

export function clientDealRollup(deals: DealRow[]): ClientDealRollup {
  const summary = summarizeHouseholdDeals(deals);

  return {
    count: summary.count,
    outstandingCount: summary.outstandingCount,
    outstandingAmount: summary.outstandingAmount,
    fundedCount: summary.fundedCount,
    fundedAmount: summary.fundedAmount,
    openPipeline: summary.openPipeline,
  };
}

// tkt-deals-transferring-firm: the muted "via {firm}" subtitle under a deal
// name on the Client Portrait rollup. Returns null when the deal carries no
// transferring firm so the line is OMITTED entirely (never renders "via —").
// Pure so the omit-when-null behavior unit-tests without React.
export function dealFirmLine(transferring_firm: string | null): string | null {
  const firm = transferring_firm?.trim();
  return firm ? `via ${firm}` : null;
}
