import { INSTRUMENTS, classifySymbol, type AssetCategory } from '@/lib/trade-requests/sources/data/instruments';
import { normalizeTicker } from '@/lib/trade-requests/sources/data/sic-to-sector';
import type { AccountTaxSummary, CostBasisFreshnessSummary } from '@/lib/trade-requests/shared-types';
import type { SectorAllocation } from '@/lib/trade-requests/drift/sector-allocation';
// S5 fix: import the canonical home, NOT registryDrift.js (scheduled for deletion in follow-up PR).
import type { MeridianSnapshot, MeridianSnapshotEntry } from '@/lib/trade-requests/sources/meridian-snapshot';
import type { AccountPositions } from '@/lib/trade-requests/sources/warehouse';
import type { HouseholdConfig } from '@/lib/trade-requests/sources/household-config';

/**
 * v2 per-account drift comparator. Pure function — no I/O, no DB, no Slack.
 * The runner orchestrates persistence and alerting around this entry point.
 *
 * Spec: `docs/plans/2026-q3-drift-v2-accounts.md` §4.1 (types) and §4.3
 * (comparator math). The canvas at
 * `canvases/drift-v2-mockup.canvas.tsx` is the binding UI spec.
 */

// v2-owned defaults — independent of `meridianRegistry.ts` so the
// retirement follow-up can delete `registryDrift.ts` + `meridianRegistry.ts`
// cleanly without breaking this module.
export const DEFAULT_TOLERANCE_PCT = 5.0;
export const DEFAULT_UNINVESTED_CASH_THRESHOLD_PCT = 99.0;

/**
 * Money-market-fund naming convention (3–5 uppercase letters followed by
 * a double-X suffix). Used as the safety-net gate for the
 * `drift_suspected_cash_equiv_misclassified` warn log — see §4.3 step 10.
 * Equity tickers like VOO / VEA / BRK.B / etc. fail this gate and are
 * silently routed to the equity bucket as intended.
 */
export const SUSPECTED_CASH_EQUIV_REGEX = /^[A-Z]{3,5}XX$/;

const SETTLEMENT_CASH_SYMBOL = '__SETTLEMENT_CASH__';

export type AccountDriftStatus = 'in' | 'out' | 'uninvested' | 'no_template' | 'negligible' | 'template_invalid';

/**
 * R1 — total account value at or below this (USD) is "negligible": drift math
 * is meaningless on dust, so we tag it `negligible` and exclude it from the
 * actionable count. (True $0 / closed shells are dropped earlier, before a row
 * is ever built; this catches funded-but-trivial 0 < value <= $5 accounts.)
 */
export const NEGLIGIBLE_BALANCE_THRESHOLD_USD = 5;

/**
 * R2 — an Meridian template whose target weights sum outside this band is
 * malformed: the drift denominator is wrong, so the row is tagged
 * `template_invalid` and routed to a data-quality view. The band absorbs
 * normal rounding around 100%.
 */
export const TEMPLATE_SUM_VALID_MIN_PCT = 99;
export const TEMPLATE_SUM_VALID_MAX_PCT = 101;

/** True when a template's summed target weights are within the valid band. */
export function isTemplateSumValid(templateTotalPct: number): boolean {
  return templateTotalPct >= TEMPLATE_SUM_VALID_MIN_PCT && templateTotalPct <= TEMPLATE_SUM_VALID_MAX_PCT;
}

/** Per-bucket comparison (percent-scale, 0..100). */
export interface BucketComparison {
  positionPct: number;
  templatePct: number;
  deltaPct: number;
}

/** Per-symbol drilldown row used in the inline expand. */
export interface SymbolDriftDetail {
  symbol: string;
  bucket: AssetCategory;
  positionPct: number;
  /**
   * Only set when the Meridian template carries a per-symbol target for
   * this symbol AND classifySymbol(symbol) is 'cash' or 'fixed'. Equity
   * symbols never carry a per-symbol target on the v2 spec.
   */
  targetPct?: number;
  /** Math.abs(positionPct - (targetPct ?? 0)), present whenever targetPct is set. */
  deltaPct?: number;
  /** True when targetPct is set and deltaPct > tolerancePct. */
  breach?: boolean;
}

/** JSONB blob stored in `position_drift_accounts.details`. */
export interface AccountDriftDetails {
  buckets: {
    cash: BucketComparison;
    fixed: BucketComparison;
    equity: BucketComparison;
  };
  /** Cash + fixed symbols with per-symbol targets, sorted by deltaPct desc. */
  symbolsWithTargets: SymbolDriftDetail[];
  /** Equity-bucket holdings (symbol + position % only, no targets). */
  equityHoldings: { symbol: string; positionPct: number }[];
  /** Symbols the position-side carries that the template does not have a target for. */
  positionOnlySymbols: { symbol: string; bucket: AssetCategory; positionPct: number }[];
  /**
   * Symbols that LOOK like cash-equivalent money-market mutual funds
   * (regex `/^[A-Z]{3,5}XX$/`) but routed to `equity` because they are
   * not present in `INSTRUMENTS`. Post-R1 resolution this no longer
   * flags VMFXX/VMRXX/FZFXX/SPAXX/SPRXX/FDRXX (now in INSTRUMENTS) but
   * the regex stays in place as a safety net.
   */
  suspectedCashEquivMisclassified: string[];
  /** The Meridian template/model name this account is compared against (absent for no_template). */
  templateName?: string;
  /**
   * Sum of ALL template symbol weights (= cash + fixed + equity template
   * bucket pcts). A healthy template sums to ~100. When Meridian ships a
   * malformed template (e.g. 72%), every bucket delta is distorted — the
   * account can look severely "drifted" when the template itself is the
   * problem. Surfaced so the UI can flag it. Absent for no_template rows.
   */
  templateTotalPct?: number;
  notes?: string;
  /**
   * Cost-basis tax enrichment (optional — attached by the runner's
   * `applyCostBasisEnrichment` step when the cost-basis feed is configured).
   * Absent when the feed is unconfigured or the step failed (graceful degrade).
   */
  tax?: AccountTaxSummary;
  /** Run-level cost-basis freshness, denormalized onto each account's details. */
  costBasisFreshness?: CostBasisFreshnessSummary;
  /**
   * Equity-sleeve classification breakdown (optional — attached by the runner's
   * `applySectorEnrichment` step when the security-sector cache is populated):
   * GICS sectors for individual stocks/ADRs, asset classes for ETFs/funds.
   * Absent when the cache is empty or the step failed (graceful degrade).
   */
  sectorAllocation?: SectorAllocation;
}

export interface AccountDriftResult {
  accountId: string;
  /** From the Meridian snapshot row (account_title); may be empty. */
  accountTitle: string;
  /** From households.json. Empty when unmapped. */
  household: string;
  unmapped: boolean;
  templateMissing: boolean;
  totalValue: number;
  /**
   * Max bucket Δpp across cash/fixed/equity (percent-scale, 0..100).
   * `null` ONLY for `status === 'no_template'` rows — there is no
   * allocation target to measure against, so emitting 0 here would
   * misleadingly read as "perfectly on target".
   */
  maxBucketDeltaPct: number | null;
  worstBucket: AssetCategory | null;
  symbolBreachCount: number;
  status: AccountDriftStatus;
  details: AccountDriftDetails;
}

export interface AccountDriftRun {
  runDateLocal: string;
  runStartedAt: string;
  snapshotSource: string;
  snapshotAsOf: string | null;
  tolerancePct: number;
  uninvestedCashThresholdPct: number;
  accounts: AccountDriftResult[];
  unmappedPositionsAccountIds: string[];
  unmappedSnapshotAccountIds: string[];
  suspectedCashEquivMisclassified: string[];
}

export interface ComparePositionsPerAccountInput {
  positions: ReadonlyMap<string, AccountPositions>;
  snapshot: MeridianSnapshot;
  householdConfig: HouseholdConfig;
  tolerancePct?: number;
  uninvestedCashThresholdPct?: number;
  /**
   * Normalized-ticker → bucket overrides from the security-sector cache, used to
   * route bond/MMF funds that classifySymbol() defaults to 'equity' into their
   * real fixed/cash bucket. Optional — absent => pure classifySymbol behavior.
   */
  bucketOverrides?: BucketOverrides;
  /**
   * When true, funded positions accounts that are absent from the
   * Meridian active_accounts feed (no `householdConfig` row) are emitted as
   * `unmapped` no_template rows (coverage='unmapped') instead of being
   * silently dropped. This surfaces firm accounts we hold positions for but
   * have no model mapped to — they'd otherwise vanish from the drift surface
   * entirely. Default false (legacy: unmapped accounts are tracked but not
   * emitted as rows).
   */
  emitUnmappedFunded?: boolean;
  /**
   * Firm account titles keyed by Apex ULID (`apex_daily_accounts.title`).
   * Used to label emitted unmapped rows so they read as a client name rather
   * than a bare ULID. Only consulted when `emitUnmappedFunded` is on.
   */
  accountTitles?: ReadonlyMap<string, string>;
  /**
   * ULIDs to keep dropping even when `emitUnmappedFunded` is on — known
   * held-away / intentionally-unmanaged accounts the advisor doesn't want on
   * the drift surface. Only consulted when `emitUnmappedFunded` is on.
   */
  unmappedExcludeAccountIds?: ReadonlySet<string>;
}

export interface ComparePositionsPerAccountResult {
  accounts: AccountDriftResult[];
  unmappedPositionsAccountIds: string[];
  unmappedSnapshotAccountIds: string[];
  suspectedCashEquivMisclassified: string[];
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Exported for tests. */
export const SETTLEMENT_CASH_SYMBOL_FOR_TESTS = SETTLEMENT_CASH_SYMBOL;

interface PositionBuckets {
  cashPct: number;
  fixedPct: number;
  equityPct: number;
  /** Per-symbol percent weights (excluding settlement cash). */
  perSymbolPct: Record<string, number>;
}

/** Map a normalized ticker → bucket the security-sector cache says it belongs in. */
export type BucketOverrides = ReadonlyMap<string, AssetCategory>;

/**
 * Bucket a symbol, letting the security-sector cache CORRECT bond/MMF funds that
 * `classifySymbol()` would otherwise default to 'equity' (the curated cash/fixed
 * lists don't list every bond ETF). Only promotes equity → fixed/cash — the leak
 * direction — so curated cash/fixed classifications stay authoritative and a
 * misclassification can never demote a real equity. `overrides` is keyed by
 * NORMALIZED ticker.
 */
function effectiveBucket(symbol: string, overrides?: BucketOverrides): AssetCategory {
  const base = classifySymbol(symbol);
  if (base !== 'equity' || !overrides || overrides.size === 0) return base;
  const promoted = overrides.get(normalizeTicker(symbol) ?? symbol);
  return promoted === 'fixed' || promoted === 'cash' ? promoted : base;
}

function computePositionBuckets(account: AccountPositions | undefined, overrides?: BucketOverrides): PositionBuckets {
  if (!account || account.totalEquity <= 0) {
    return { cashPct: 0, fixedPct: 0, equityPct: 0, perSymbolPct: {} };
  }
  const perSymbolPct: Record<string, number> = {};
  let cashEquivPct = 0;
  let fixedPct = 0;
  let equityPct = 0;
  for (const [symbol, dollar] of Object.entries(account.positionsBySymbol)) {
    const weight = (dollar / account.totalEquity) * 100;
    perSymbolPct[symbol] = (perSymbolPct[symbol] ?? 0) + weight;
    const bucket = effectiveBucket(symbol, overrides);
    if (bucket === 'cash') cashEquivPct += weight;
    else if (bucket === 'fixed') fixedPct += weight;
    else equityPct += weight;
  }
  const settlementCashPct = (account.cashEquity / account.totalEquity) * 100;
  return {
    cashPct: settlementCashPct + cashEquivPct,
    fixedPct,
    equityPct,
    perSymbolPct,
  };
}

interface TemplateBuckets {
  cashPct: number;
  fixedPct: number;
  equityPct: number;
  /**
   * Sum of explicit cash-bucket symbol targets (i.e.
   * `snapshotEntry.weights[k]` where `classifySymbol(k) === 'cash'`).
   * The synthetic `__SETTLEMENT_CASH__` target is computed as
   * `cashPct - cashSymbolTargetSum` so the residual covers the
   * portion of the cash bucket not already covered by an explicit
   * cash-equiv symbol.
   */
  cashSymbolTargetSum: number;
}

function computeTemplateBuckets(
  snapshotEntry: MeridianSnapshotEntry | undefined,
  overrides?: BucketOverrides,
): TemplateBuckets {
  const empty: TemplateBuckets = { cashPct: 0, fixedPct: 0, equityPct: 0, cashSymbolTargetSum: 0 };
  if (!snapshotEntry) return empty;
  let cashPct = 0;
  let fixedPct = 0;
  let equityPct = 0;
  let cashSymbolTargetSum = 0;
  for (const [symbol, weight] of Object.entries(snapshotEntry.weights)) {
    const bucket = effectiveBucket(symbol, overrides);
    if (bucket === 'cash') {
      cashPct += weight;
      cashSymbolTargetSum += weight;
    } else if (bucket === 'fixed') {
      fixedPct += weight;
    } else {
      equityPct += weight;
    }
  }
  return { cashPct, fixedPct, equityPct, cashSymbolTargetSum };
}

interface SymbolBreakdownArgs {
  positionsBySymbolPct: Record<string, number>;
  settlementCashPct: number;
  templateWeights: Record<string, number>;
  templateCashPct: number;
  templateCashSymbolTargetSum: number;
  tolerancePct: number;
  overrides?: BucketOverrides;
}

interface SymbolBreakdown {
  symbolsWithTargets: SymbolDriftDetail[];
  symbolBreachCount: number;
}

function computeSymbolBreakdown(args: SymbolBreakdownArgs): SymbolBreakdown {
  const {
    positionsBySymbolPct,
    settlementCashPct,
    templateWeights,
    templateCashPct,
    templateCashSymbolTargetSum,
    tolerancePct,
    overrides,
  } = args;

  const rows: SymbolDriftDetail[] = [];

  // Synthetic settlement-cash row — always emitted so the drilldown
  // shows the apex settlement-cash line. targetPct is the residual cash
  // bucket weight not already covered by an explicit cash-equiv symbol.
  const settlementTarget = templateCashPct - templateCashSymbolTargetSum;
  const settlementTargetClamped = Math.max(settlementTarget, 0);
  const settlementDelta = Math.abs(settlementCashPct - settlementTargetClamped);
  const settlementBreach = settlementTargetClamped > 0 && settlementDelta > tolerancePct;
  rows.push({
    symbol: SETTLEMENT_CASH_SYMBOL,
    bucket: 'cash',
    positionPct: round4(settlementCashPct),
    targetPct: round4(settlementTargetClamped),
    deltaPct: round4(settlementDelta),
    breach: settlementBreach,
  });

  // Every template-side symbol that buckets to cash/fixed (cache-corrected).
  for (const [symbol, weight] of Object.entries(templateWeights)) {
    const bucket = effectiveBucket(symbol, overrides);
    if (bucket === 'equity') continue;
    const positionPct = positionsBySymbolPct[symbol] ?? 0;
    const targetPct = weight;
    const deltaPct = Math.abs(positionPct - targetPct);
    const breach = targetPct > 0 && deltaPct > tolerancePct;
    rows.push({
      symbol,
      bucket,
      positionPct: round4(positionPct),
      targetPct: round4(targetPct),
      deltaPct: round4(deltaPct),
      breach,
    });
  }

  // Sort by deltaPct DESC; synthetic settlement cash sits among the rest
  // by its own delta so the highest-deviation rows surface first.
  rows.sort((a, b) => (b.deltaPct ?? 0) - (a.deltaPct ?? 0) || a.symbol.localeCompare(b.symbol));

  const symbolBreachCount = rows.filter((row) => row.breach === true).length;
  return { symbolsWithTargets: rows, symbolBreachCount };
}

function deriveStatus(args: {
  totalEquity: number;
  cashPct: number;
  templateCashPct: number;
  maxBucketDeltaPct: number;
  symbolBreachCount: number;
  tolerancePct: number;
  uninvestedCashThresholdPct: number;
}): AccountDriftStatus {
  const {
    totalEquity,
    cashPct,
    templateCashPct,
    maxBucketDeltaPct,
    symbolBreachCount,
    tolerancePct,
    uninvestedCashThresholdPct,
  } = args;
  if (totalEquity > 0 && cashPct >= uninvestedCashThresholdPct && templateCashPct < 50) {
    return 'uninvested';
  }
  if (maxBucketDeltaPct > tolerancePct || symbolBreachCount > 0) {
    return 'out';
  }
  return 'in';
}

function classifyEquityHoldings(
  positionsBySymbolPct: Record<string, number>,
  overrides?: BucketOverrides,
): {
  equityHoldings: { symbol: string; positionPct: number }[];
  suspectedFromPositions: string[];
} {
  const equityHoldings: { symbol: string; positionPct: number }[] = [];
  const suspected: string[] = [];
  for (const [symbol, weight] of Object.entries(positionsBySymbolPct)) {
    if (effectiveBucket(symbol, overrides) !== 'equity') continue;
    equityHoldings.push({ symbol, positionPct: round4(weight) });
    if (INSTRUMENTS[symbol] === undefined && SUSPECTED_CASH_EQUIV_REGEX.test(symbol)) {
      suspected.push(symbol);
    }
  }
  equityHoldings.sort((a, b) => b.positionPct - a.positionPct || a.symbol.localeCompare(b.symbol));
  return { equityHoldings, suspectedFromPositions: suspected };
}

function suspectedFromTemplate(weights: Record<string, number>): string[] {
  const out: string[] = [];
  for (const symbol of Object.keys(weights)) {
    if (classifySymbol(symbol) !== 'equity') continue;
    if (INSTRUMENTS[symbol] !== undefined) continue;
    if (SUSPECTED_CASH_EQUIV_REGEX.test(symbol)) {
      out.push(symbol);
    }
  }
  return out;
}

function computePositionOnlySymbols(
  positionsBySymbolPct: Record<string, number>,
  templateWeights: Record<string, number>,
  overrides?: BucketOverrides,
): { symbol: string; bucket: AssetCategory; positionPct: number }[] {
  const out: { symbol: string; bucket: AssetCategory; positionPct: number }[] = [];
  for (const [symbol, weight] of Object.entries(positionsBySymbolPct)) {
    if (templateWeights[symbol] !== undefined) continue;
    out.push({ symbol, bucket: effectiveBucket(symbol, overrides), positionPct: round4(weight) });
  }
  out.sort((a, b) => b.positionPct - a.positionPct || a.symbol.localeCompare(b.symbol));
  return out;
}

function buildNoTemplateResult(args: {
  accountId: string;
  positionsRow: AccountPositions | undefined;
  household: string;
  unmapped: boolean;
  /**
   * Firm-sourced account title from `households.json`. Wins over the
   * Meridian snapshot title (which is undefined on this branch by
   * definition — no template). Falls back to '' when absent.
   */
  firmAccountTitle?: string;
  overrides?: BucketOverrides;
}): { result: AccountDriftResult; suspected: string[] } {
  const { accountId, positionsRow, household, unmapped, firmAccountTitle, overrides } = args;

  const totalEquity = positionsRow?.totalEquity ?? 0;
  const cashEquity = positionsRow?.cashEquity ?? 0;
  const settlementCashPct = totalEquity > 0 ? (cashEquity / totalEquity) * 100 : 0;
  const position = computePositionBuckets(positionsRow, overrides);

  const bucketRows: Record<AssetCategory, BucketComparison> = {
    cash: { positionPct: round4(position.cashPct), templatePct: 0, deltaPct: round4(position.cashPct) },
    fixed: { positionPct: round4(position.fixedPct), templatePct: 0, deltaPct: round4(position.fixedPct) },
    equity: { positionPct: round4(position.equityPct), templatePct: 0, deltaPct: round4(position.equityPct) },
  };

  // Drilldown still surfaces the position-side settlement cash row so an
  // advisor can see what the account holds. Every targetPct is omitted —
  // there is no template to compare against — so `breach` stays false.
  const symbolsWithTargets: SymbolDriftDetail[] = [];
  if (settlementCashPct > 0) {
    symbolsWithTargets.push({
      symbol: SETTLEMENT_CASH_SYMBOL,
      bucket: 'cash',
      positionPct: round4(settlementCashPct),
    });
  }

  const { equityHoldings, suspectedFromPositions } = classifyEquityHoldings(position.perSymbolPct, overrides);
  const suspected = Array.from(new Set(suspectedFromPositions)).sort((a, b) => a.localeCompare(b));

  const positionOnlySymbols = computePositionOnlySymbols(position.perSymbolPct, {}, overrides);

  const result: AccountDriftResult = {
    accountId,
    accountTitle: firmAccountTitle ?? '',
    household,
    unmapped,
    templateMissing: true,
    totalValue: round4(totalEquity),
    maxBucketDeltaPct: null,
    worstBucket: null,
    symbolBreachCount: 0,
    // R1 — even with no template to compare against, a negligible balance is
    // dust, not a "no_template" account to chase. Tag it so it's excluded.
    status: totalEquity <= NEGLIGIBLE_BALANCE_THRESHOLD_USD ? 'negligible' : 'no_template',
    details: {
      buckets: bucketRows,
      symbolsWithTargets,
      equityHoldings,
      positionOnlySymbols,
      suspectedCashEquivMisclassified: suspected,
    },
  };

  return { result, suspected };
}

function buildAccountResult(args: {
  accountId: string;
  positionsRow: AccountPositions | undefined;
  snapshotEntry: MeridianSnapshotEntry | undefined;
  household: string;
  unmapped: boolean;
  tolerancePct: number;
  uninvestedCashThresholdPct: number;
  /**
   * Firm-sourced account title from `households.json` (PR following #56).
   * Title precedence: firm wins → Meridian snapshot fallback → '' empty
   * default. The firm file is the operations source-of-truth; the
   * Meridian snapshot's `account_title` is a backstop for accounts the
   * firm export missed.
   */
  firmAccountTitle?: string;
  overrides?: BucketOverrides;
}): { result: AccountDriftResult; suspected: string[] } {
  const {
    accountId,
    positionsRow,
    snapshotEntry,
    household,
    unmapped,
    tolerancePct,
    uninvestedCashThresholdPct,
    firmAccountTitle,
    overrides,
  } = args;

  // No-template branch — account has positions + a household but no
  // Meridian allocation target. Surface as `no_template` instead of
  // synthesizing 0/0/0 targets that would falsely flag every position-only
  // account as out-of-tolerance with massive (and meaningless) Δpp. The
  // drilldown still gets the position-side rollups so an advisor can see
  // "this is what they hold" even without a target to compare against.
  if (snapshotEntry === undefined) {
    return buildNoTemplateResult({ accountId, positionsRow, household, unmapped, firmAccountTitle, overrides });
  }

  const totalEquity = positionsRow?.totalEquity ?? 0;
  const cashEquity = positionsRow?.cashEquity ?? 0;
  const settlementCashPct = totalEquity > 0 ? (cashEquity / totalEquity) * 100 : 0;

  const position = computePositionBuckets(positionsRow, overrides);
  const template = computeTemplateBuckets(snapshotEntry, overrides);

  const bucketRows: Record<AssetCategory, BucketComparison> = {
    cash: {
      positionPct: round4(position.cashPct),
      templatePct: round4(template.cashPct),
      deltaPct: round4(Math.abs(position.cashPct - template.cashPct)),
    },
    fixed: {
      positionPct: round4(position.fixedPct),
      templatePct: round4(template.fixedPct),
      deltaPct: round4(Math.abs(position.fixedPct - template.fixedPct)),
    },
    equity: {
      positionPct: round4(position.equityPct),
      templatePct: round4(template.equityPct),
      deltaPct: round4(Math.abs(position.equityPct - template.equityPct)),
    },
  };

  let maxBucketDeltaPct = 0;
  let worstBucket: AssetCategory | null = null;
  for (const bucket of ['cash', 'fixed', 'equity'] as const) {
    const delta = bucketRows[bucket].deltaPct;
    if (delta > maxBucketDeltaPct + 1e-9) {
      maxBucketDeltaPct = delta;
      worstBucket = bucket;
    }
  }
  if (totalEquity <= 0) {
    worstBucket = null;
  }

  const breakdown = computeSymbolBreakdown({
    positionsBySymbolPct: position.perSymbolPct,
    settlementCashPct,
    templateWeights: snapshotEntry?.weights ?? {},
    templateCashPct: template.cashPct,
    templateCashSymbolTargetSum: template.cashSymbolTargetSum,
    overrides,
    tolerancePct,
  });

  const templateTotalPct = round4(template.cashPct + template.fixedPct + template.equityPct);

  let status = deriveStatus({
    totalEquity,
    cashPct: position.cashPct,
    templateCashPct: template.cashPct,
    maxBucketDeltaPct,
    symbolBreachCount: breakdown.symbolBreachCount,
    tolerancePct,
    uninvestedCashThresholdPct,
  });
  // R2 — a template whose weights don't sum to ~100% has a broken denominator,
  // so its drift number is untrustworthy. Tag it `template_invalid` (keeping
  // the computed delta for inspection) so it's routed to a data-quality view
  // instead of the actionable list.
  if (!isTemplateSumValid(templateTotalPct)) status = 'template_invalid';
  // R1 — negligible balance overrides everything: don't evaluate drift on dust.
  if (totalEquity <= NEGLIGIBLE_BALANCE_THRESHOLD_USD) status = 'negligible';

  const { equityHoldings, suspectedFromPositions } = classifyEquityHoldings(position.perSymbolPct, overrides);
  const suspectedTemplate = suspectedFromTemplate(snapshotEntry?.weights ?? {});
  const suspectedSet = new Set<string>([...suspectedFromPositions, ...suspectedTemplate]);
  const suspected = Array.from(suspectedSet).sort((a, b) => a.localeCompare(b));

  const positionOnlySymbols = computePositionOnlySymbols(
    position.perSymbolPct,
    snapshotEntry?.weights ?? {},
    overrides,
  );

  const result: AccountDriftResult = {
    accountId,
    // Title precedence: firm-baked title from households.json wins over the
    // Meridian snapshot's `account_title`. Snapshot title is the fallback
    // for accounts the firm export missed; '' is the final default.
    accountTitle: firmAccountTitle ?? snapshotEntry?.accountTitle ?? '',
    household,
    unmapped,
    templateMissing: snapshotEntry === undefined,
    totalValue: round4(totalEquity),
    maxBucketDeltaPct: round4(maxBucketDeltaPct),
    worstBucket,
    symbolBreachCount: breakdown.symbolBreachCount,
    status,
    details: {
      buckets: bucketRows,
      symbolsWithTargets: breakdown.symbolsWithTargets,
      equityHoldings,
      positionOnlySymbols,
      suspectedCashEquivMisclassified: suspected,
      templateName: snapshotEntry.templateName,
      templateTotalPct,
    },
  };

  return { result, suspected };
}

export function comparePositionsToMeridianPerAccount(
  input: ComparePositionsPerAccountInput,
): ComparePositionsPerAccountResult {
  const tolerancePct = input.tolerancePct ?? DEFAULT_TOLERANCE_PCT;
  const uninvestedCashThresholdPct = input.uninvestedCashThresholdPct ?? DEFAULT_UNINVESTED_CASH_THRESHOLD_PCT;

  const snapshotByAccount = new Map<string, MeridianSnapshotEntry>();
  for (const entry of input.snapshot.entries) {
    snapshotByAccount.set(entry.account, entry);
  }

  const accountIds = new Set<string>([...input.positions.keys(), ...snapshotByAccount.keys()]);

  const accounts: AccountDriftResult[] = [];
  const unmappedPositionsAccountIds: string[] = [];
  const unmappedSnapshotAccountIds: string[] = [];
  const suspectedSet = new Set<string>();

  for (const accountId of accountIds) {
    const householdEntry = input.householdConfig.byAccountNumber.get(accountId);
    const mapped = householdEntry !== undefined;
    const positionsRow = input.positions.get(accountId);
    const snapshotEntry = snapshotByAccount.get(accountId);

    if (!mapped) {
      // Unmapped accounts (no household row in households.json) are NOT
      // emitted as `AccountDriftResult` rows. They are still tracked here
      // so the runner can surface them via the `drift_unmapped_detail` log
      // and v1's `unmappedPositionsAccountCount` metric. The v2 UI and
      // every v2 metric (totalAccounts / outAccounts / insertedRows / …)
      // count only mapped accounts; unmapped accounts must be chased
      // through households.json, not the per-account drift surface.
      if (positionsRow) unmappedPositionsAccountIds.push(accountId);
      if (snapshotEntry) unmappedSnapshotAccountIds.push(accountId);

      // Optionally surface funded-but-unmapped accounts as rows. These are
      // firm accounts we hold live positions for but that aren't in the
      // Meridian active_accounts feed — so there is no model/template to
      // compare against. They emit as `unmapped` no_template rows (which the
      // persistence layer maps to coverage='unmapped'), carrying a null
      // delta so they never pollute the worst-Δ metric. We gate on
      // totalEquity > 0 (drop closed/pre-funding shells) and skip explicitly
      // excluded ULIDs (known held-away / intentionally-unmanaged accounts).
      if (
        input.emitUnmappedFunded &&
        positionsRow &&
        positionsRow.totalEquity > 0 &&
        !input.unmappedExcludeAccountIds?.has(accountId)
      ) {
        const { result, suspected } = buildNoTemplateResult({
          accountId,
          positionsRow,
          household: '',
          unmapped: true,
          firmAccountTitle: input.accountTitles?.get(accountId),
          overrides: input.bucketOverrides,
        });
        accounts.push(result);
        for (const symbol of suspected) suspectedSet.add(symbol);
      }
      continue;
    }

    // Zero-value filter — drop accounts whose Apex balance row is missing
    // or whose `cashEquity + Σ stock_record` rolls up to ≤ $0. These are
    // closed accounts or pre-funding shells; emitting rows for them just
    // pollutes the v2 dashboard with un-actionable noise. Note that the
    // Elnora-Schmeler pattern (large cashEquity, zero equity holdings)
    // still passes — `totalEquity` is cash + equity, so a fully-cash
    // account has totalEquity > 0 and survives to be flagged as
    // `uninvested` by the downstream rule.
    if (!positionsRow || positionsRow.totalEquity <= 0) {
      continue;
    }

    const { result, suspected } = buildAccountResult({
      accountId,
      positionsRow,
      snapshotEntry,
      household: householdEntry.householdName,
      unmapped: false,
      tolerancePct,
      uninvestedCashThresholdPct,
      firmAccountTitle: householdEntry.accountTitle,
      overrides: input.bucketOverrides,
    });
    accounts.push(result);
    for (const symbol of suspected) suspectedSet.add(symbol);
  }

  // Sort by maxBucketDeltaPct DESC, accountId ASC. `no_template` rows have
  // `maxBucketDeltaPct === null` and sort to the bottom regardless of order
  // (nothing to compare against).
  accounts.sort((a, b) => {
    const aDelta = a.maxBucketDeltaPct;
    const bDelta = b.maxBucketDeltaPct;
    if (aDelta === null && bDelta === null) return a.accountId.localeCompare(b.accountId);
    if (aDelta === null) return 1;
    if (bDelta === null) return -1;
    return bDelta - aDelta || a.accountId.localeCompare(b.accountId);
  });

  const suspectedCashEquivMisclassified = Array.from(suspectedSet).sort((a, b) => a.localeCompare(b));

  return {
    accounts,
    unmappedPositionsAccountIds,
    unmappedSnapshotAccountIds,
    suspectedCashEquivMisclassified,
  };
}
