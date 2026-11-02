import type {
  AccountDriftHistoryRow,
  AccountDriftStatus,
  DriftOverrideReason,
} from "@/lib/trade-requests/shared-types";
import type { z } from "zod";
import type { exclusionExportResponseSchema } from "./schemas";

// Pure Drift-view rules ported from the standalone Drift view (trade-request d41b6c9
// client/src/components/DriftTabV2.tsx; line ranges per export below) and its CSV helper
// (client/src/utils/csv.ts:5-11). Values, labels and thresholds are unchanged so the AOA screen
// shows what the standalone screen shows for the same run.

export type ExclusionExportRow = z.infer<typeof exclusionExportResponseSchema>["data"][number];
export type DriftHistoryDays = 7 | 30 | 90 | 180;
export type ViewMode = "accounts" | "households";
export type StatusFilter = "all" | AccountDriftStatus;
export type BucketFilter = "all" | "cash" | "fixed" | "equity";
export type SortOption =
  | "delta_desc" | "delta_asc" | "gain_asc" | "gain_desc" | "value_desc" | "value_asc" | "account_az" | "household_az";
export type MinDelta = 0 | 2 | 5 | 10 | 20;
export type Bucket = "cash" | "fixed" | "equity";
export type Tone = "ok" | "caution" | "danger" | "info" | "neutral" | "muted";

// DriftTabV2.tsx:36-45
export const DAY_OPTIONS: DriftHistoryDays[] = [7, 30, 90, 180];
export const DEFAULT_DAYS: DriftHistoryDays = 30;
export function parseDays(raw: string | null): DriftHistoryDays {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return DAY_OPTIONS.includes(parsed as DriftHistoryDays) ? (parsed as DriftHistoryDays) : DEFAULT_DAYS;
}

// DriftTabV2.tsx:54-84
export const STATUS_OPTIONS: StatusFilter[] = ["all", "out", "in", "uninvested", "no_template", "negligible", "template_invalid"];
export const BUCKET_OPTIONS: BucketFilter[] = ["all", "cash", "fixed", "equity"];
export const VIEW_OPTIONS: ViewMode[] = ["accounts", "households"];
export const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "delta_desc", label: "Δpp (highest first)" },
  { value: "delta_asc", label: "Δpp (lowest first)" },
  { value: "gain_asc", label: "Unrealized G/L (lowest first — cheapest to fix)" },
  { value: "gain_desc", label: "Unrealized G/L (highest first — tax-locked)" },
  { value: "value_desc", label: "Total value (highest first)" },
  { value: "value_asc", label: "Total value (lowest first)" },
  { value: "account_az", label: "Account A→Z" },
  { value: "household_az", label: "Household A→Z" },
];
export const SORT_VALUES: SortOption[] = SORT_OPTIONS.map((o) => o.value);
export const MIN_DELTA_OPTIONS: { value: MinDelta; label: string }[] = [
  { value: 0, label: "All Δpp" },
  { value: 2, label: "Δpp > 2" },
  { value: 5, label: "Δpp > 5" },
  { value: 10, label: "Δpp > 10" },
  { value: 20, label: "Δpp > 20" },
];
export const MIN_DELTA_VALUES: MinDelta[] = MIN_DELTA_OPTIONS.map((o) => o.value);
// DriftTabV2.tsx:1406-1412 (the status filter's option labels)
export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "All accounts",
  out: "Out of tolerance only",
  in: "In tolerance only",
  uninvested: "Uninvested only",
  no_template: "No template only",
  negligible: "Negligible balance only",
  template_invalid: "Template error only",
};

// DriftTabV2.tsx:89-121 (percent-scale values: never multiplied by 100)
export function formatPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

export function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function formatRunDate(value: string): string {
  const [y, m, d] = value.split("-").map((part) => parseInt(part, 10));
  if (!y || !m || !d) return value;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function truncTitle(title: string, max: number = 38): string {
  if (!title) return "(no title)";
  return title.length > max ? title.slice(0, max - 1) + "…" : title;
}

export function parseView(raw: string | null): ViewMode {
  return VIEW_OPTIONS.includes(raw as ViewMode) ? (raw as ViewMode) : "accounts";
}

export function parseStatus(raw: string | null): StatusFilter {
  return STATUS_OPTIONS.includes(raw as StatusFilter) ? (raw as StatusFilter) : "all";
}

export function parseBucket(raw: string | null): BucketFilter {
  return BUCKET_OPTIONS.includes(raw as BucketFilter) ? (raw as BucketFilter) : "all";
}

// DriftTabV2.tsx:123-158 (the standalone colours become AOA status tones)
export const BUCKET_LABEL: Record<Bucket, string> = { cash: "Cash", fixed: "Fixed", equity: "Equity" };

export const STATUS_LABEL: Record<AccountDriftStatus, string> = {
  in: "In tolerance",
  out: "Out of tolerance",
  uninvested: "Uninvested",
  no_template: "No template",
  negligible: "Negligible balance",
  template_invalid: "Template error",
};

export const STATUS_TONE: Record<AccountDriftStatus, Tone> = {
  in: "ok",
  out: "caution",
  uninvested: "info",
  no_template: "neutral",
  negligible: "muted",
  template_invalid: "danger",
};

export const DATA_QUALITY_STATUSES: AccountDriftStatus[] = ["negligible", "template_invalid"];
export function isDataQualityStatus(status: AccountDriftStatus): boolean {
  return DATA_QUALITY_STATUSES.includes(status);
}

// DriftTabV2.tsx:162-186
export const OVERRIDE_REASONS: { value: DriftOverrideReason; label: string }[] = [
  { value: "asset_location", label: "Asset location (household-level)" },
  { value: "tax_constraint", label: "Tax constraint (embedded gains)" },
  { value: "active_transition", label: "Active transition / transfer-in" },
  { value: "intentional_cash", label: "Intentional cash / MMF" },
  { value: "concentrated_position", label: "Concentrated position (legacy)" },
  { value: "template_error", label: "Template config error" },
  { value: "direct_index_noise", label: "Direct-index whole-share noise" },
  { value: "other", label: "Other (explain in note)" },
];

export const OVERRIDE_REASON_LABEL: Record<DriftOverrideReason, string> = Object.fromEntries(
  OVERRIDE_REASONS.map((r) => [r.value, r.label]),
) as Record<DriftOverrideReason, string>;

export const OVERRIDE_REASON_SHORT: Record<DriftOverrideReason, string> = {
  asset_location: "Asset location",
  tax_constraint: "Tax-constrained",
  active_transition: "In transition",
  intentional_cash: "Intentional cash",
  concentrated_position: "Concentrated",
  template_error: "Template error",
  direct_index_noise: "Direct-index noise",
  other: "Override",
};

// DriftTabV2.tsx:325-365 (R3 / R5 read-time suggestions)
export const SUGGEST_TRANSFER_IN_PCT = 25;
export const SUGGEST_GAIN_ABS_USD = 50_000;
export const SUGGEST_GAIN_REL_FRACTION = 0.15;

export interface OverrideSuggestion {
  reason: DriftOverrideReason;
  note: string;
}

export function suggestOverride(row: AccountDriftHistoryRow): OverrideSuggestion | null {
  if (row.status !== "out" || row.override) return null;
  if (row.taxable !== true) return null;

  if (row.transitionConfirmed === true || (row.transferInPct ?? 0) >= SUGGEST_TRANSFER_IN_PCT) {
    const pct = typeof row.transferInPct === "number" ? `, transfer-in ${Math.round(row.transferInPct)}%` : "";
    return { reason: "active_transition", note: `Auto-suggested: active transition${pct}.` };
  }

  const gain = row.unrealizedGainUsd ?? 0;
  const relTrip = row.totalValueUsd > 0 && gain >= SUGGEST_GAIN_REL_FRACTION * row.totalValueUsd;
  if (gain >= SUGGEST_GAIN_ABS_USD || relTrip) {
    const relPct = row.totalValueUsd > 0 ? Math.round((gain / row.totalValueUsd) * 100) : 0;
    return {
      reason: "tax_constraint",
      note: `Auto-suggested: embedded gain ${formatUsd(gain)} (${relPct}% of account).`,
    };
  }
  return null;
}

// DriftTabV2.tsx:472-476
export function formatSignedUsd(n: number): string {
  const rounded = Math.round(n);
  if (rounded === 0) return "$0";
  return `${rounded < 0 ? "−" : "+"}${formatUsd(Math.abs(n))}`;
}

// DriftTabV2.tsx:515-519 (the server's R2 99-101% band)
export function templateSumIssuePct(row: AccountDriftHistoryRow): number | null {
  const total = typeof row.templateTotalPct === "number" ? row.templateTotalPct : null;
  if (total === null) return null;
  return total < 99 || total > 101 ? total : null;
}

// DriftTabV2.tsx:2058
export const TOLERANCE_PCT_RENDER = 5;

// DriftTabV2.tsx:715-785
export interface HouseholdGroup {
  household: string;
  accounts: AccountDriftHistoryRow[];
  totalValue: number;
  outCount: number;
  uninvestedCount: number;
  worstDelta: number;
}

export function compareDeltaNullable(aDelta: number | null, bDelta: number | null, order: "asc" | "desc"): number | null {
  if (aDelta === null && bDelta === null) return 0;
  if (aDelta === null) return 1;
  if (bDelta === null) return -1;
  return order === "asc" ? aDelta - bDelta : bDelta - aDelta;
}

export function compareAccountRows(a: AccountDriftHistoryRow, b: AccountDriftHistoryRow, sortBy: SortOption): number {
  const aliasOptions: Intl.CollatorOptions = { sensitivity: "base" };
  switch (sortBy) {
    case "delta_desc":
      return compareDeltaNullable(a.maxBucketDeltaPct, b.maxBucketDeltaPct, "desc") ?? 0;
    case "delta_asc":
      return compareDeltaNullable(a.maxBucketDeltaPct, b.maxBucketDeltaPct, "asc") ?? 0;
    case "gain_asc":
      return compareDeltaNullable(a.unrealizedGainUsd ?? null, b.unrealizedGainUsd ?? null, "asc") ?? 0;
    case "gain_desc":
      return compareDeltaNullable(a.unrealizedGainUsd ?? null, b.unrealizedGainUsd ?? null, "desc") ?? 0;
    case "value_desc":
      return b.totalValueUsd - a.totalValueUsd;
    case "value_asc":
      return a.totalValueUsd - b.totalValueUsd;
    case "account_az":
      return (a.accountTitle ?? "").localeCompare(b.accountTitle ?? "", undefined, aliasOptions);
    case "household_az": {
      const householdCmp = (a.householdName ?? "").localeCompare(b.householdName ?? "", undefined, aliasOptions);
      if (householdCmp !== 0) return householdCmp;
      return (a.accountTitle ?? "").localeCompare(b.accountTitle ?? "", undefined, aliasOptions);
    }
  }
}

export function groupByHousehold(rows: AccountDriftHistoryRow[]): HouseholdGroup[] {
  const map = new Map<string, AccountDriftHistoryRow[]>();
  for (const r of rows) {
    const key = r.householdName || "unmapped";
    const arr = map.get(key) ?? [];
    arr.push(r);
    map.set(key, arr);
  }
  return Array.from(map.entries())
    .map(([household, accounts]) => ({
      household,
      accounts,
      totalValue: accounts.reduce((s, a) => s + a.totalValueUsd, 0),
      outCount: accounts.filter((a) => a.status === "out").length,
      uninvestedCount: accounts.filter((a) => a.status === "uninvested").length,
      worstDelta: accounts.reduce((m, a) => Math.max(m, a.status === "out" ? (a.maxBucketDeltaPct ?? 0) : 0), 0),
    }))
    .sort((a, b) => b.worstDelta - a.worstDelta);
}

// DriftTabV2.tsx:931-954 (latest date and the run-date picker's dates, newest first)
export function latestRunDateOf(rows: AccountDriftHistoryRow[]): string | null {
  let max: string | null = null;
  for (const r of rows) {
    if (max === null || r.runDateLocal > max) max = r.runDateLocal;
  }
  return max;
}

export function availableRunDatesOf(rows: AccountDriftHistoryRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) set.add(r.runDateLocal);
  return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
}

// DriftTabV2.tsx:1006-1021
export type DriftFilters = {
  statusFilter: StatusFilter;
  bucketFilter: BucketFilter;
  showDataQuality: boolean;
  householdQuery: string;
  accountQuery: string;
};

export function filterDriftRows(sortedRows: AccountDriftHistoryRow[], f: DriftFilters): AccountDriftHistoryRow[] {
  const householdQuery = f.householdQuery.trim().toLowerCase();
  const accountQuery = f.accountQuery.trim().toLowerCase();
  return sortedRows.filter((row) => {
    if (f.statusFilter === "all" && !f.showDataQuality && isDataQualityStatus(row.status)) return false;
    if (f.statusFilter !== "all" && row.status !== f.statusFilter) return false;
    if (f.bucketFilter !== "all" && row.worstBucket !== f.bucketFilter) return false;
    if (householdQuery && !(row.householdName ?? "").toLowerCase().includes(householdQuery)) return false;
    if (accountQuery && !(row.accountTitle ?? "").toLowerCase().includes(accountQuery)) return false;
    return true;
  });
}

// DriftTabV2.tsx:1040-1046
export function applyMinDelta(rows: AccountDriftHistoryRow[], minDelta: MinDelta): AccountDriftHistoryRow[] {
  return minDelta > 0 ? rows.filter((row) => row.maxBucketDeltaPct !== null && row.maxBucketDeltaPct > minDelta) : rows;
}

// DriftTabV2.tsx:1048-1076 (an active override takes the row out of the actionable count and the worst-Δ tile)
export type DriftSummary = {
  accounts: number;
  out: number;
  uninvested: number;
  noTemplate: number;
  worst: number | null;
  realizedYtd: number | null;
};

export function driftSummary(filterCohort: AccountDriftHistoryRow[]): DriftSummary | null {
  if (filterCohort.length === 0) return null;
  const out = filterCohort.filter((r) => r.status === "out" && !r.override).length;
  const uninvested = filterCohort.filter((r) => r.status === "uninvested").length;
  const noTemplate = filterCohort.filter((r) => r.status === "no_template").length;
  const outDeltas = filterCohort
    .filter((r) => r.status === "out" && !r.override)
    .map((r) => r.maxBucketDeltaPct)
    .filter((d): d is number => d !== null);
  const worst = outDeltas.length === 0 ? null : Math.max(...outDeltas);
  const realizedRows = filterCohort.filter((r) => typeof r.realizedGainYtdUsd === "number");
  const realizedYtd =
    realizedRows.length === 0 ? null : realizedRows.reduce((s, r) => s + (r.realizedGainYtdUsd as number), 0);
  return { accounts: filterCohort.length, out, uninvested, noTemplate, worst, realizedYtd };
}

// utils/csv.ts:5-11 (formula-injection guard, quoted)
export function csvEscape(value: string): string {
  let safe = value;
  if (/^[=+\-@\t\r]/.test(safe)) {
    safe = `'${safe}`;
  }
  return `"${safe.replace(/"/g, '""')}"`;
}

// DriftTabV2.tsx:1129-1213 (the selected run date's full cohort; the first 15 columns keep their positions)
export function driftCsv(latestRunRows: AccountDriftHistoryRow[], effectiveRunDate: string): { filename: string; lines: string[] } {
  const num = (v: number | null | undefined, dp = 2) => (typeof v === "number" ? v.toFixed(dp) : "");
  const bool = (v: boolean | null | undefined) => (v == null ? "" : v ? "yes" : "no");
  const oneLine = (v: string) => v.replace(/\s*\r?\n\s*/g, " ").trim();
  const header = [
    "Run Date", "Account", "Household", "Template", "Template Sum %", "Status", "Coverage", "Max Δpp", "Worst Bucket",
    "Symbol Breaches", "Total Value USD", "Unrealized G/L USD", "Realized G/L YTD USD", "Transfer-In %", "Active Transition",
    "Account ID", "Actionable", "Overridden", "Override Reason", "Override Note", "Override Set By", "Override Set At",
    "Override Expires On", "Taxable", "Transition Candidate", "Snapshot Source", "Snapshot As Of", "Cost Basis Freshness",
  ];
  const lines = [header.map(csvEscape).join(",")];
  const sorted = [...latestRunRows].sort(
    (a, b) =>
      (b.maxBucketDeltaPct ?? -1) - (a.maxBucketDeltaPct ?? -1) ||
      (a.accountTitle ?? "").localeCompare(b.accountTitle ?? ""),
  );
  for (const r of sorted) {
    const ov = r.override ?? null;
    lines.push(
      [
        r.runDateLocal,
        r.accountTitle ?? "",
        r.householdName ?? "",
        r.templateName ?? "",
        num(r.templateTotalPct, 1),
        r.status,
        r.coverage,
        num(r.maxBucketDeltaPct),
        r.worstBucket ?? "",
        String(r.symbolBreachCount ?? 0),
        num(r.totalValueUsd),
        num(r.unrealizedGainUsd),
        num(r.realizedGainYtdUsd),
        num(r.transferInPct, 1),
        r.transitionConfirmed ? "yes" : "",
        r.accountId,
        r.status === "out" && !ov ? "yes" : "no",
        ov ? "yes" : "no",
        ov ? OVERRIDE_REASON_LABEL[ov.reason] : "",
        ov ? oneLine(ov.note) : "",
        ov?.setByName ?? "",
        ov?.setAt ?? "",
        ov?.expiresOn ?? "",
        bool(r.taxable),
        bool(r.transitionCandidate),
        r.snapshotSource ?? "",
        r.snapshotAsOf ?? "",
        r.costBasisFreshness?.level ?? "",
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }
  return { filename: `drift_${effectiveRunDate}.csv`, lines };
}

// DriftTabV2.tsx:1228-1274 (firm-wide standing exclusions: client-level rows first, then account-level)
export function exclusionsCsv(rows: ExclusionExportRow[], today: string): { filename: string; lines: string[] } {
  const header = [
    "Scope", "Client ID", "Client", "Account ID", "Account Number", "Ticker", "Kind", "Reason", "No Buy", "No Sell",
    "Created By", "Created At",
  ];
  const lines = [header.map(csvEscape).join(",")];
  const scopeRank = (s: ExclusionExportRow["scope"]) => (s === "client" ? 0 : 1);
  const sorted = [...rows].sort(
    (a, b) =>
      scopeRank(a.scope) - scopeRank(b.scope) ||
      (a.clientName || a.clientId).localeCompare(b.clientName || b.clientId) ||
      (a.accountNumber || a.accountId).localeCompare(b.accountNumber || b.accountId) ||
      a.ticker.localeCompare(b.ticker),
  );
  for (const r of sorted) {
    lines.push(
      [
        r.scope,
        r.clientId,
        r.clientName,
        r.accountId,
        r.accountNumber,
        r.ticker,
        r.kind,
        r.reason.replace(/\s*\r?\n\s*/g, " ").trim(),
        r.noBuy ? "yes" : "no",
        r.noSell ? "yes" : "no",
        r.createdByName,
        r.createdAt,
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }
  return { filename: `exclusions_${today}.csv`, lines };
}
