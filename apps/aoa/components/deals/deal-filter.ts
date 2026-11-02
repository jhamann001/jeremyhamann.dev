import type { DealRow, DealStage } from "@/lib/data/deal-types";

// Pure client-side filter logic for the /deals table (WO ticket): stage-chip
// narrowing + free-text search over client / household / deal name — plus, per
// the D8 mockup parity (WO ticket), transferring firm, funding type and
// account last4 (the mockup's search targets). Owner was dropped from the
// search targets in D6 (WO ticket) — owners are stored but hidden from all
// /deals UI, so search must not resurface them. Extracted from DealsTable so
// vitest can exercise it without CSS-module imports; structural Pick so tests
// build minimal rows.

export type StageFilter = "all" | DealStage | "no_statements";

export type FilterableDeal = Pick<
  DealRow,
  | "name"
  | "client_first_name"
  | "client_last_name"
  | "household_name"
  | "stage"
  | "account_type"
  | "account_last4"
  | "transferring_firm"
  | "statements"
>;

export function matchesStage(stage: DealStage, filter: StageFilter): boolean {
  return filter === "all" || stage === filter;
}

// Case-insensitive substring match over the search targets; null-safe (a
// missing household/firm/type simply never matches). "Sam Stone" matches via
// the joined client name.
export function matchesQuery(deal: FilterableDeal, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystacks = [
    `${deal.client_first_name} ${deal.client_last_name}`,
    deal.household_name ?? "",
    deal.name,
    deal.account_type ?? "",
    deal.account_last4 ?? "",
    deal.transferring_firm ?? "",
  ];
  return haystacks.some((h) => h.toLowerCase().includes(q));
}

export function filterDeals<T extends FilterableDeal>(
  rows: T[],
  filter: StageFilter,
  query: string,
): T[] {
  // "no_statements" is an attribute filter (statements === false), orthogonal
  // to DealStage and cross-stage; every other value keeps matchesStage.
  return rows.filter(
    (r) =>
      (filter === "no_statements"
        ? r.statements === false
        : matchesStage(r.stage, filter)) && matchesQuery(r, query),
  );
}
