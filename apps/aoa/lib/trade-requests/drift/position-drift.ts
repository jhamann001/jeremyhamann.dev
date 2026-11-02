import { DEFAULT_TOLERANCE_PCT } from '@/lib/trade-requests/drift/drift-contract';
import { classifySymbol, type AssetCategory } from '@/lib/trade-requests/sources/data/instruments';
import type { HouseholdConfig } from '@/lib/trade-requests/sources/household-config';
import type { AccountPositions } from '@/lib/trade-requests/sources/warehouse';
import type { MeridianSnapshot, MeridianSnapshotEntry } from '@/lib/trade-requests/sources/meridian-snapshot';
import type { DriftAccountDetail, DriftHouseholdResult } from '@/lib/trade-requests/drift/drift-contract';
import type { DriftCoverageStatus } from '@/lib/trade-requests/shared-types';

/**
 * Pure positions-vs-Meridian drift comparison: per-account position
 * snapshots × snapshot × household-config → per-household max-bucket-delta +
 * breach decision. No I/O, no DB, no Slack. The runner orchestrates
 * persistence and alerting around this function.
 *
 * Headline metric is **max bucket delta** per household (`max(cash, fixed,
 * equity)`), not max per-symbol delta — see plan §5.C step 6 for the rationale.
 *
 * The output shape is intentionally identical to `compareRegistryToMeridian`'s
 * `DriftHouseholdResult` so the runner's persistence path takes the new
 * comparison without a code shift. The only inner-key difference is that
 * per-symbol/per-bucket detail entries use `{ positions, meridian, delta }`
 * instead of the legacy `{ engine, meridian, delta }`.
 */

const UNMAPPED_PREFIX = '__unmapped__:';

/**
 * Synthetic per-symbol drilldown entry name for the position-side
 * `cash_equity` (settlement cash). Only ever appears on the position side of
 * `perSymbolDelta`. Hard-routed to the `cash` bucket inside this module
 * (NOT via `classifySymbol`, which defaults unrecognised tickers to `equity`).
 */
const SETTLEMENT_CASH_SYMBOL = '__SETTLEMENT_CASH__';

export interface ComparePositionsInput {
  positions: ReadonlyMap<string, AccountPositions>;
  snapshot: MeridianSnapshot;
  householdConfig: HouseholdConfig;
  tolerancePct?: number;
}

export interface ComparePositionsResult {
  households: DriftHouseholdResult[];
  /** Position-side accounts not present in households.json. */
  unmappedPositionsAccounts: string[];
  /** Snapshot-side accounts not present in households.json. */
  unmappedSnapshotAccounts: string[];
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function resolveHousehold(accountNumber: string, householdConfig: HouseholdConfig): { name: string; mapped: boolean } {
  const entry = householdConfig.byAccountNumber.get(accountNumber);
  if (entry) return { name: entry.householdName, mapped: true };
  return { name: `${UNMAPPED_PREFIX}${accountNumber}`, mapped: false };
}

interface PositionWeights {
  /** symbol → percent weight (trade_position_value / totalEquity * 100). */
  perSymbol: Record<string, number>;
  /** bucket → bucket total in percent, computed directly from authoritative sources. */
  perBucket: Record<AssetCategory, number>;
}

/**
 * Convert raw position dollar values + cashEquity into percent weights.
 *
 * Per plan §5.C step 1: bucket totals are computed DIRECTLY from authoritative
 * sources (cashEquity for the cash component, classifySymbol over stock_record
 * symbols for cash-sweep / fixed / equity components). They are NOT
 * re-aggregated from `perSymbol` because `perSymbol` includes the synthetic
 * `__SETTLEMENT_CASH__` entry which would double-count cashEquity if folded
 * into a stock_record-derived cash sum.
 */
function computePositionWeights(account: AccountPositions): PositionWeights {
  const perBucket: Record<AssetCategory, number> = { cash: 0, fixed: 0, equity: 0 };
  const perSymbol: Record<string, number> = {};

  if (account.totalEquity <= 0) {
    return { perSymbol, perBucket };
  }

  // Synthetic settlement-cash drilldown entry. Hard-routed to `cash` bucket
  // independently of classifySymbol so a future classifier change cannot
  // accidentally re-route it.
  if (account.cashEquity > 0) {
    perSymbol[SETTLEMENT_CASH_SYMBOL] = (account.cashEquity / account.totalEquity) * 100;
  }
  perBucket.cash = (account.cashEquity / account.totalEquity) * 100;

  for (const [symbol, dollarValue] of Object.entries(account.positionsBySymbol)) {
    const weight = (dollarValue / account.totalEquity) * 100;
    perSymbol[symbol] = (perSymbol[symbol] ?? 0) + weight;
    const bucket = classifySymbol(symbol);
    perBucket[bucket] = (perBucket[bucket] ?? 0) + weight;
  }

  return { perSymbol, perBucket };
}

function computeTemplateBuckets(weights: Record<string, number>): Record<AssetCategory, number> {
  const out: Record<AssetCategory, number> = { cash: 0, fixed: 0, equity: 0 };
  for (const [symbol, weight] of Object.entries(weights)) {
    const bucket = classifySymbol(symbol);
    out[bucket] = (out[bucket] ?? 0) + weight;
  }
  return out;
}

function computeAccountDetail(
  accountNumber: string,
  positionsRow: AccountPositions | undefined,
  snapshotEntry: MeridianSnapshotEntry | undefined,
): DriftAccountDetail {
  const snapshotWeights = snapshotEntry?.weights ?? {};
  const coverage: DriftAccountDetail['coverage'] =
    positionsRow && snapshotEntry ? 'both' : positionsRow ? 'positions_only' : 'template_only';

  const positionWeights: PositionWeights = positionsRow
    ? computePositionWeights(positionsRow)
    : { perSymbol: {}, perBucket: { cash: 0, fixed: 0, equity: 0 } };

  // Per-symbol delta drilldown — union of position-side and template-side
  // symbol keys. The synthetic `__SETTLEMENT_CASH__` only appears on the
  // position side; the template side carries its own cash-sweep symbols
  // (e.g. VMFXX, VMSXX). Both contribute to the per-symbol drilldown
  // independently — no synthetic merging.
  const symbols = new Set<string>([...Object.keys(positionWeights.perSymbol), ...Object.keys(snapshotWeights)]);

  const perSymbolDelta: DriftAccountDetail['perSymbolDelta'] = {};
  for (const symbol of symbols) {
    const positionWeight = positionWeights.perSymbol[symbol] ?? 0;
    const snapshotWeight = snapshotWeights[symbol] ?? 0;
    const delta = Math.abs(positionWeight - snapshotWeight);
    perSymbolDelta[symbol] = {
      positions: round4(positionWeight),
      meridian: round4(snapshotWeight),
      delta: round4(delta),
    };
  }

  // Bucket-side math per §5.C step 5: position bucket totals come straight
  // from `computePositionWeights` (NOT from re-aggregating `perSymbolDelta`,
  // which would double-count cashEquity via the synthetic settlement entry).
  // Template bucket totals are computed by aggregating template per-symbol
  // weights via `classifySymbol`.
  const templateBuckets = computeTemplateBuckets(snapshotWeights);

  const perBucketDelta: DriftAccountDetail['perBucketDelta'] = {};
  let maxBucketDelta = 0;
  let worstBucket: AssetCategory | null = null;
  const allBuckets: readonly AssetCategory[] = ['cash', 'fixed', 'equity'];
  for (const bucket of allBuckets) {
    const positionTotal = positionWeights.perBucket[bucket] ?? 0;
    const templateTotal = templateBuckets[bucket] ?? 0;
    if (positionTotal === 0 && templateTotal === 0) continue;
    const delta = Math.abs(positionTotal - templateTotal);
    perBucketDelta[bucket] = {
      positions: round4(positionTotal),
      meridian: round4(templateTotal),
      delta: round4(delta),
    };
    if (delta > maxBucketDelta + 1e-9) {
      maxBucketDelta = delta;
      worstBucket = bucket;
    }
  }

  // One-sided coverage: clamp the maxDelta to the larger total weight so the
  // household-level max-delta carries the magnitude of the missing side
  // (mirrors `registryDrift.ts:124-130`).
  if (coverage === 'positions_only') {
    const totalPositions =
      (positionWeights.perBucket.cash ?? 0) +
      (positionWeights.perBucket.fixed ?? 0) +
      (positionWeights.perBucket.equity ?? 0);
    maxBucketDelta = Math.max(maxBucketDelta, totalPositions);
  } else if (coverage === 'template_only') {
    const totalSnapshot = Object.values(snapshotWeights).reduce((sum, value) => sum + value, 0);
    maxBucketDelta = Math.max(maxBucketDelta, totalSnapshot);
  }

  return {
    accountNumber,
    maxDeltaPct: round4(maxBucketDelta),
    // Carry the bucket label in the legacy `worstSymbol` field (the dashboard
    // and Slack alert both render this as a plain string). See §5.D and §5.E.
    worstSymbol: worstBucket,
    perSymbolDelta,
    perBucketDelta,
    coverage,
    flags: [],
  };
}

function deriveCoverageStatus(accounts: readonly DriftAccountDetail[]): DriftCoverageStatus {
  if (accounts.length === 0) return 'full';
  // Reuse the existing `engine_only` / `meridian_only` enum values per §4
  // (CHECK-constraint reuse, repurposed semantics: engine_only = positions_only,
  // meridian_only = template_only). UI label refresh is a follow-up PR.
  if (accounts.every((account) => account.coverage === 'positions_only')) return 'engine_only';
  if (accounts.every((account) => account.coverage === 'template_only')) return 'meridian_only';
  if (accounts.some((account) => account.coverage !== 'both')) return 'partial';
  return 'full';
}

interface HouseholdBuckets {
  positionsRows: Map<string, AccountPositions>;
  snapshotEntries: Map<string, MeridianSnapshotEntry>;
}

export function comparePositionsToMeridian(input: ComparePositionsInput): ComparePositionsResult {
  const tolerance = input.tolerancePct ?? DEFAULT_TOLERANCE_PCT;

  const householdBuckets = new Map<string, HouseholdBuckets>();
  const unmappedSourcing = new Map<string, 'positions' | 'meridian'>();
  const unmappedPositionsAccounts: string[] = [];
  const unmappedSnapshotAccounts: string[] = [];

  const ensureBucket = (name: string): HouseholdBuckets => {
    let bucket = householdBuckets.get(name);
    if (!bucket) {
      bucket = { positionsRows: new Map(), snapshotEntries: new Map() };
      householdBuckets.set(name, bucket);
    }
    return bucket;
  };

  for (const [accountId, row] of input.positions) {
    const { name, mapped } = resolveHousehold(accountId, input.householdConfig);
    ensureBucket(name).positionsRows.set(accountId, row);
    if (!mapped) {
      unmappedPositionsAccounts.push(accountId);
      unmappedSourcing.set(name, 'positions');
    }
  }

  for (const entry of input.snapshot.entries) {
    const { name, mapped } = resolveHousehold(entry.account, input.householdConfig);
    ensureBucket(name).snapshotEntries.set(entry.account, entry);
    if (!mapped) {
      unmappedSnapshotAccounts.push(entry.account);
      // Position-side unmapped takes precedence; only mark meridian if no
      // position-side row also pinned this synthetic bucket.
      if (!unmappedSourcing.has(name)) {
        unmappedSourcing.set(name, 'meridian');
      }
    }
  }

  const households: DriftHouseholdResult[] = [];
  for (const [householdName, bucket] of householdBuckets) {
    const isUnmapped = householdName.startsWith(UNMAPPED_PREFIX);
    const accountNumbers = new Set<string>([...bucket.positionsRows.keys(), ...bucket.snapshotEntries.keys()]);

    const accounts: DriftAccountDetail[] = [];
    for (const accountNumber of accountNumbers) {
      const detail = computeAccountDetail(
        accountNumber,
        bucket.positionsRows.get(accountNumber),
        bucket.snapshotEntries.get(accountNumber),
      );
      accounts.push(detail);
    }

    accounts.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

    const coverageStatus: DriftCoverageStatus = isUnmapped ? 'unmapped_account' : deriveCoverageStatus(accounts);

    let householdMaxDelta = 0;
    let householdWorstSymbol: string | null = null;
    for (const account of accounts) {
      if (account.maxDeltaPct > householdMaxDelta + 1e-9) {
        householdMaxDelta = account.maxDeltaPct;
        householdWorstSymbol = account.worstSymbol;
      }
    }

    const breach = !isUnmapped && householdMaxDelta > tolerance;

    const details: DriftHouseholdResult['details'] = { accounts };
    if (isUnmapped && unmappedSourcing.get(householdName) === 'meridian') {
      details.source = 'meridian_only_unmapped';
    }

    households.push({
      householdName,
      coverageStatus,
      accountCount: accounts.length,
      maxDeltaPct: round4(householdMaxDelta),
      breach,
      worstSymbol: householdWorstSymbol,
      details,
    });
  }

  households.sort((a, b) => a.householdName.localeCompare(b.householdName));

  return {
    households,
    unmappedPositionsAccounts,
    unmappedSnapshotAccounts,
  };
}

/** Exported for tests that want to assert the synthetic settlement-cash routing. */
export const SETTLEMENT_CASH_SYMBOL_FOR_TESTS = SETTLEMENT_CASH_SYMBOL;
