import type { DealRow } from "@/lib/data/deal-types";
import { stageLabel } from "@/lib/data/deal-types";

// Pure client-side sort for the /deals table (D8, WO ticket — the mockup's
// sortable headers over already-fetched rows; no server round-trip). Extracted
// from DealsTable so vitest exercises it without CSS-module imports (the
// deal-filter.ts idiom). Amount sorts numerically; dates by time (absent dates
// sink to the bottom in either direction); everything else case-insensitively
// as text. Clicking the active column flips direction (mockup behavior).

export const SORTABLE_COLUMNS = [
  "client",
  "household",
  "amount",
  "stage",
  "account",
  "created",
  "close",
] as const;
export type SortKey = (typeof SORTABLE_COLUMNS)[number];

export type DealSort = { key: SortKey; dir: 1 | -1 } | null;

/** Next sort state after clicking a header (same key flips, new key = asc). */
export function nextSort(current: DealSort, key: SortKey): DealSort {
  if (current?.key === key) return { key, dir: current.dir === 1 ? -1 : 1 };
  return { key, dir: 1 };
}

type SortableDeal = Pick<
  DealRow,
  | "client_first_name"
  | "client_last_name"
  | "household_name"
  | "amount"
  | "stage"
  | "account_type"
  | "account_last4"
  | "transferring_firm"
  | "created_date"
  | "close_date"
>;

const text = (r: SortableDeal, key: SortKey): string => {
  switch (key) {
    case "client":
      return `${r.client_first_name} ${r.client_last_name}`.toLowerCase();
    case "household":
      return (r.household_name ?? "").toLowerCase();
    case "stage":
      return stageLabel(r.stage).toLowerCase();
    case "account":
      // Mirrors the rendered "type · ••last4 · firm" cell so what you see is
      // what sorts.
      return [r.account_type, r.account_last4, r.transferring_firm]
        .filter((p): p is string => p != null && p !== "")
        .join(" · ")
        .toLowerCase();
    default:
      return "";
  }
};

/** Stable sorted copy; `sort` null returns the rows untouched (server order). */
export function sortDeals<T extends SortableDeal>(
  rows: readonly T[],
  sort: DealSort,
): T[] {
  if (sort == null) return [...rows];
  const { key, dir } = sort;
  return [...rows].sort((a, b) => {
    if (key === "amount") return (a.amount - b.amount) * dir;
    if (key === "created" || key === "close") {
      const field = key === "created" ? "created_date" : "close_date";
      const at = a[field];
      const bt = b[field];
      // Missing dates always sort AFTER present ones in either direction (a
      // null close date is "no answer", not "the earliest deal").
      if (at == null && bt == null) return 0;
      if (at == null) return 1;
      if (bt == null) return -1;
      return (at.getTime() - bt.getTime()) * dir;
    }
    const av = text(a, key);
    const bv = text(b, key);
    return av < bv ? -dir : av > bv ? dir : 0;
  });
}
