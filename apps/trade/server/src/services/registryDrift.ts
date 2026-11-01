import {
  type RegistryResponse,
  type RegistryRow,
  REGISTRY_SCHEMA_VERSION,
  DEFAULT_TOLERANCE_PCT,
} from './meridianRegistry.js';
import { classifySymbol, type AssetCategory } from '../data/instruments.js';
import type { HouseholdConfig } from './householdConfig.js';
import type { MeridianSnapshot, MeridianSnapshotEntry } from './meridianSnapshot.js';
import type { DriftCoverageStatus } from '@trade-request/shared';
import type { DriftAccountDetail, DriftHouseholdResult } from './driftContract.js';

/**
 * Pure drift comparison: registry × snapshot × household-config → per-household
 * max-delta + breach decision. No I/O, no DB, no Slack. The runner orchestrates
 * persistence and alerting around this function.
 */

// Re-export so existing in-tree consumers (`registryDriftRunner.ts`,
// `registryDriftAlert.ts`, runner tests) keep their import paths unchanged.
// The shared package is now the single source of truth for the wire shape.
export type { DriftCoverageStatus };

// v2 ownership move (docs/plans/2026-q3-drift-v2-accounts.md §4.2): the
// canonical declarations now live in `meridianSnapshot.ts` (the actual
// producer of these shapes). Re-exported here so existing v1 imports keep
// working unchanged; the retirement follow-up PR can then delete this file
// cleanly because every consumer ultimately resolves through the canonical
// home.
export type { MeridianSnapshot, MeridianSnapshotEntry } from './meridianSnapshot.js';
export type { DriftAccountDetail, DriftHouseholdResult } from './driftContract.js';

export interface DriftCompareInput {
  registry: RegistryResponse;
  snapshot: MeridianSnapshot;
  householdConfig: HouseholdConfig;
  tolerancePct?: number;
}

export interface DriftCompareResult {
  households: DriftHouseholdResult[];
  unmappedRegistryAccounts: string[];
  unmappedSnapshotAccounts: string[];
}

const UNMAPPED_PREFIX = '__unmapped__:';

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function resolveHousehold(accountNumber: string, householdConfig: HouseholdConfig): { name: string; mapped: boolean } {
  const entry = householdConfig.byAccountNumber.get(accountNumber);
  if (entry) return { name: entry.householdName, mapped: true };
  return { name: `${UNMAPPED_PREFIX}${accountNumber}`, mapped: false };
}

function computeAccountDetail(
  accountNumber: string,
  engineRow: RegistryRow | undefined,
  snapshotEntry: MeridianSnapshotEntry | undefined,
): DriftAccountDetail {
  const engineWeights = engineRow?.weights ?? {};
  const snapshotWeights = snapshotEntry?.weights ?? {};

  const coverage: DriftAccountDetail['coverage'] =
    engineRow && snapshotEntry ? 'both' : engineRow ? 'engine_only' : 'meridian_only';

  const symbols = new Set<string>([...Object.keys(engineWeights), ...Object.keys(snapshotWeights)]);

  const perSymbolDelta: DriftAccountDetail['perSymbolDelta'] = {};
  const perBucketAccumulator = new Map<AssetCategory, { engine: number; meridian: number; delta: number }>();
  let maxDeltaPct = 0;
  let worstSymbol: string | null = null;

  for (const symbol of symbols) {
    const engineWeight = engineWeights[symbol] ?? 0;
    const snapshotWeight = snapshotWeights[symbol] ?? 0;
    const delta = Math.abs(engineWeight - snapshotWeight);
    perSymbolDelta[symbol] = {
      engine: round4(engineWeight),
      meridian: round4(snapshotWeight),
      delta: round4(delta),
    };
    if (delta > maxDeltaPct + 1e-9) {
      maxDeltaPct = delta;
      worstSymbol = symbol;
    }

    const bucket = classifySymbol(symbol);
    const existing = perBucketAccumulator.get(bucket) ?? { engine: 0, meridian: 0, delta: 0 };
    existing.engine += engineWeight;
    existing.meridian += snapshotWeight;
    existing.delta += delta;
    perBucketAccumulator.set(bucket, existing);
  }

  // One-sided coverage: clamp the maxDelta to the larger total weight so the
  // household-level max-delta carries the magnitude of the missing side.
  if (coverage === 'engine_only') {
    const totalEngine = Object.values(engineWeights).reduce((sum, value) => sum + value, 0);
    maxDeltaPct = Math.max(maxDeltaPct, totalEngine);
  } else if (coverage === 'meridian_only') {
    const totalSnapshot = Object.values(snapshotWeights).reduce((sum, value) => sum + value, 0);
    maxDeltaPct = Math.max(maxDeltaPct, totalSnapshot);
  }

  const perBucketDelta: DriftAccountDetail['perBucketDelta'] = {};
  for (const [bucket, totals] of perBucketAccumulator) {
    perBucketDelta[bucket] = {
      engine: round4(totals.engine),
      meridian: round4(totals.meridian),
      delta: round4(totals.delta),
    };
  }

  return {
    accountNumber,
    maxDeltaPct: round4(maxDeltaPct),
    worstSymbol,
    perSymbolDelta,
    perBucketDelta,
    coverage,
    flags: engineRow ? [...engineRow.flags] : [],
  };
}

function deriveCoverageStatus(accounts: readonly DriftAccountDetail[]): DriftCoverageStatus {
  if (accounts.length === 0) return 'full';
  if (accounts.every((account) => account.coverage === 'engine_only')) return 'engine_only';
  if (accounts.every((account) => account.coverage === 'meridian_only')) return 'meridian_only';
  if (accounts.some((account) => account.coverage !== 'both')) return 'partial';
  return 'full';
}

interface HouseholdBuckets {
  engineRows: Map<string, RegistryRow>;
  snapshotEntries: Map<string, MeridianSnapshotEntry>;
}

export function compareRegistryToMeridian(input: DriftCompareInput): DriftCompareResult {
  if (input.registry.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `drift comparison: registry schemaVersion ${input.registry.schemaVersion} does not match expected ${REGISTRY_SCHEMA_VERSION}`,
    );
  }

  const tolerance = input.tolerancePct ?? DEFAULT_TOLERANCE_PCT;

  // Bucket engine and snapshot rows by household, including a per-household
  // bucket for "__unmapped__:<account>" entries so the dashboard surfaces
  // coverage gaps explicitly (registry row whose account is not in
  // households.json, or snapshot row likewise).
  const householdBuckets = new Map<string, HouseholdBuckets>();
  const unmappedSourcing = new Map<string, 'engine' | 'meridian'>();
  const unmappedRegistryAccounts: string[] = [];
  const unmappedSnapshotAccounts: string[] = [];

  const ensureBucket = (name: string): HouseholdBuckets => {
    let bucket = householdBuckets.get(name);
    if (!bucket) {
      bucket = { engineRows: new Map(), snapshotEntries: new Map() };
      householdBuckets.set(name, bucket);
    }
    return bucket;
  };

  for (const row of input.registry.rows) {
    const { name, mapped } = resolveHousehold(row.account, input.householdConfig);
    ensureBucket(name).engineRows.set(row.account, row);
    if (!mapped) {
      unmappedRegistryAccounts.push(row.account);
      unmappedSourcing.set(name, 'engine');
    }
  }

  for (const entry of input.snapshot.entries) {
    const { name, mapped } = resolveHousehold(entry.account, input.householdConfig);
    ensureBucket(name).snapshotEntries.set(entry.account, entry);
    if (!mapped) {
      unmappedSnapshotAccounts.push(entry.account);
      // Engine-side unmapped takes precedence; only mark meridian if no
      // engine row also pinned this synthetic bucket.
      if (!unmappedSourcing.has(name)) {
        unmappedSourcing.set(name, 'meridian');
      }
    }
  }

  const households: DriftHouseholdResult[] = [];
  for (const [householdName, bucket] of householdBuckets) {
    const isUnmapped = householdName.startsWith(UNMAPPED_PREFIX);
    const accountNumbers = new Set<string>([...bucket.engineRows.keys(), ...bucket.snapshotEntries.keys()]);

    const accounts: DriftAccountDetail[] = [];
    for (const accountNumber of accountNumbers) {
      const detail = computeAccountDetail(
        accountNumber,
        bucket.engineRows.get(accountNumber),
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
    unmappedRegistryAccounts,
    unmappedSnapshotAccounts,
  };
}
