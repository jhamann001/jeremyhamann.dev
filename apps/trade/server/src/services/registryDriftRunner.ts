import type { Pool, PoolClient } from 'pg';
import logger from '../lib/logger.js';
import {
  DEFAULT_TOLERANCE_PCT,
  REGISTRY_SCHEMA_VERSION,
  type DriftHouseholdResult,
  type DriftAlertResult,
} from './driftContract.js';
import { type MeridianSnapshot, SnapshotLoadError } from './meridianSnapshot.js';
import { comparePositionsToMeridian, type ComparePositionsResult } from './positionDrift.js';
import {
  fetchAccountPositions,
  fetchCostBasisData,
  fetchRealizedGainsYtd,
  fetchOwnershipTypes,
  fetchAccountTitles,
  isWarehouseQueryConfigured,
  type AccountPositions,
  type RealizedGainYtd,
} from './warehouse.js';
import { enrichAccountsWithCostBasis, type AccountTaxEnrichment } from './costBasisEnrichment.js';
import {
  evaluateCostBasisFreshness,
  evaluateSourceFreshness,
  type CostBasisFreshnessResult,
} from './costBasisFreshness.js';
import { postCostBasisFreshnessAlert } from './costBasisFreshnessAlert.js';
import { isTaxableAccount, type HouseholdConfig } from './householdConfig.js';
import type { AccountTaxSummary, CostBasisFreshnessSummary } from '@trade-request/shared';
import { loadMeridianTemplates } from './meridianTemplates.js';
import {
  loadMeridianActiveAccounts,
  toHouseholdConfig,
  ActiveAccountsLoadError,
} from './meridianActiveAccounts.js';
import { computeRunDate } from './digest.js';
import {
  comparePositionsToMeridianPerAccount,
  DEFAULT_UNINVESTED_CASH_THRESHOLD_PCT,
  type AccountDriftResult,
} from './positionDriftAccounts.js';
import { persistAccountDriftRows, ACCOUNT_DRIFT_SCHEMA_VERSION } from './positionDriftAccountsPersistence.js';
import { postAccountDriftAlert, type AccountDriftAlertResult } from './positionDriftAccountsAlert.js';
import { sweepOverrideRechecks } from './driftStatusOverrides.js';
import { getClassificationMap } from './securitySector.js';
import type { AssetCategory } from '../data/instruments.js';
import { loadMeridianTransitions } from './meridianTransitions.js';
import { computeSectorAllocation } from './sectorAllocation.js';
import { normalizeTicker } from '../data/sicToSector.js';

/**
 * Funded accounts that are absent from the Meridian active_accounts feed but
 * which the advisor does NOT want surfaced on the drift dashboard — held-away
 * / intentionally-unmanaged accounts. These ULIDs are dropped even though
 * `emitUnmappedFunded` is on for the v2 pipeline.
 */
const UNMAPPED_EXCLUDE_ACCOUNT_IDS: ReadonlySet<string> = new Set<string>([
  '01SYNTH69JZYE3TD78SPZ4PBWK',
  '01SYNTH6BDYNAGTJ07KC0SFYGY',
  '01SYNTH1B11MYXFS3Q5B5D2WNW',
  '01SYNTH85BR7BT1ZPYKBDZAC9C',
]);

/**
 * Nightly drift orchestrator. Sequence (failure-fast):
 *   1. Fetch live per-account Apex positions via `fetchAccountPositions`
 *      (blends `apex_daily_stock_record` with `apex_daily_overnight_balances`
 *      — see `warehouse.ts`). Bypasses the 30-min `getCachedClients` cache.
 *   2. Load Meridian snapshot from GCS (`loadMeridianSnapshot`). A
 *      `SnapshotLoadError` here aborts the run BEFORE any DB inserts so the
 *      `registry_drift_runs` table never carries half-finished rows. The
 *      route translates this into 503 so Cloud Scheduler retries kick in.
 *   3. Compare in-memory (`comparePositionsToMeridian`). The legacy
 *      `compareRegistryToMeridian` is no longer called from this runner;
 *      its retirement is deferred to a follow-up PR (plan §5.H).
 *   4. Persist one row per (run_date_local, household) with
 *      `ON CONFLICT (run_date_local, household_name) DO UPDATE SET
 *      run_started_at = EXCLUDED.run_started_at` and
 *      `RETURNING ..., (xmax = 0) AS inserted`. The Slack alert list is
 *      filtered on `inserted = true` so a same-day manual retry is still
 *      a no-op for Slack — the digest pattern (`digest.ts:379-394`) is
 *      the reference for "alert at most once per (run_date_local, key)".
 *      Refreshing `run_started_at` on conflict is what `driftHistoryQuery.ts
 *      HISTORY_SQL` relies on to mask stale rows from earlier same-day runs.
 *   5. Post a single Slack message for households whose insert actually
 *      wrote a row, excluding allow-listed and unmapped households.
 *
 * Shadow-mode kill switch is enforced inside `postDriftAlert` via
 * `DRIFT_ALERTS_ENABLED`, not here, so the persisted row stays the same
 * whether the alert fires or is suppressed — that's the contract product
 * relies on for "shadow mode" cutover.
 */

export interface DriftRunSummary {
  runDateLocal: string;
  schemaVersion: number;
  snapshotSource: string;
  snapshotAsOf: string | null;
  totalHouseholds: number;
  breachHouseholds: number;
  insertedRows: number;
  alert: DriftAlertResult;
  /**
   * Position-side accounts not present in `households.json`. Renamed from
   * `unmappedRegistryAccounts` as part of the 2026-Q3 positions cutover —
   * consumers should treat both names as "unmapped accounts on the
   * comparison's input side" until the next consumer scrub. No external
   * dashboard or alert is keyed off this field name.
   */
  unmappedPositionsAccounts: string[];
  unmappedSnapshotAccounts: string[];
  /**
   * v2 per-account drift summary. Additive — the v1 fields above stay
   * unchanged so existing consumers (preview route, drift_run_complete
   * log, integration tests) keep working. S12: `alert` is the v2
   * `AccountDriftAlertResult`, NOT v1's `DriftAlertResult`.
   */
  accountDrift: {
    totalAccounts: number;
    outAccounts: number;
    uninvestedAccounts: number;
    insertedRows: number;
    alert: AccountDriftAlertResult;
  };
}

interface RunDriftCheckOptions {
  pool: Pool;
  now?: Date;
}

function snapshotSourceName(): string {
  return process.env.MERIDIAN_SNAPSHOT_SOURCE ?? 'gcs';
}

function snapshotAsOf(snapshot: MeridianSnapshot, fallback: Date): string {
  return snapshot.generatedAt ?? fallback.toISOString();
}

// An account is a tax-transition candidate when it's taxable, has no Meridian
// template, and a meaningful share of it is ACAT transfer-in (legacy book being
// transitioned to model). IRAs are excluded via the taxable gate — no cap-gains
// concern, so transfer-in there isn't a tax transition.
// 25%: 50% was too strict (only flagged accounts that were *mostly* transferred
// in); a quarter transferred-in is enough to warrant a transition look, while
// staying above the noise of small partial transfers.
const TRANSITION_TRANSFER_IN_PCT_THRESHOLD = 25;

function toFreshnessSummary(f: CostBasisFreshnessResult): CostBasisFreshnessSummary {
  return {
    level: f.level,
    fullProcessDate: f.full.latest,
    fullAgeDays: f.full.ageDays,
    dailyProcessDate: f.daily.latest,
    dailyAgeDays: f.daily.ageDays,
    pipelineLatest: f.pipeline.latest,
    pipelineAgeDays: f.pipeline.ageDays,
    message: f.message,
  };
}

function toTaxSummary(
  e: AccountTaxEnrichment,
  transitionCandidate: boolean,
  realized: RealizedGainYtd | undefined,
  taxable: boolean,
): AccountTaxSummary {
  return {
    investableValueUsd: e.investableValueUsd,
    basisCoveragePct: e.basisCoveragePct,
    cashEquivalentValueUsd: e.cashEquivalentValueUsd,
    unrealizedGainUsd: e.unrealizedGainUsd,
    unrealizedShortTermGainUsd: e.unrealizedShortTermGainUsd,
    unrealizedLongTermGainUsd: e.unrealizedLongTermGainUsd,
    transferInValueUsd: e.transferInValueUsd,
    transferInPct: e.transferInPct,
    hasMissingBasis: e.hasMissingBasis,
    taxable,
    transitionCandidate,
    realizedGainYtdUsd: realized?.realizedGainYtdUsd ?? 0,
    realizedShortTermYtdUsd: realized?.realizedShortTermYtdUsd ?? 0,
    realizedLongTermYtdUsd: realized?.realizedLongTermYtdUsd ?? 0,
    // Cap the per-symbol list — the UI shows top movers, not the full book.
    symbols: e.symbols.slice(0, 12).map((s) => ({
      symbol: s.symbol,
      marketValueUsd: s.marketValueUsd,
      costBasisUsd: s.costBasisUsd,
      unrealizedGainUsd: s.unrealizedGainUsd,
      unrealizedShortTermGainUsd: s.unrealizedShortTermGainUsd,
      unrealizedLongTermGainUsd: s.unrealizedLongTermGainUsd,
      transferInPct: s.transferInPct,
      hasMissingBasis: s.hasMissingBasis,
    })),
  };
}

/**
 * Cost-basis tax-enrichment + staleness check. Runs BEFORE persistence so the
 * tax rollup + freshness land in each account's `details` JSONB (and flow to
 * the v2 UI). Additive and fully guarded: skips when the cost-basis feed is
 * unconfigured, and any failure is logged non-fatally so a cost-basis problem
 * can NEVER abort the drift run (accounts simply persist without `details.tax`).
 */
async function applyCostBasisEnrichment(input: {
  accounts: readonly AccountDriftResult[];
  positions: ReadonlyMap<string, AccountPositions>;
  householdConfig: HouseholdConfig;
  runDateLocal: string;
  now: Date;
}): Promise<void> {
  const { accounts, positions, householdConfig, runDateLocal, now } = input;

  if (!isWarehouseQueryConfigured()) return;

  try {
    const { lots, fullRefreshLatest, dailyRefreshLatest, fullGlueRunLatest, dailyGlueRunLatest, sources } =
      await fetchCostBasisData();

    // Per-source staleness, reported SEPARATELY from the merged banner. The merge
    // can be perfectly fresh while one warehouse source is days behind — that's
    // an infrastructure problem, not a data-quality problem, and folding it into
    // the user-facing level would either cry wolf or (worse) stay silent and let
    // a dead loader rot. See evaluateSourceFreshness.
    if (sources.length > 1) {
      for (const sf of evaluateSourceFreshness(sources, now)) {
        if (sf.level === 'ok') continue;
        logger.warn(
          {
            event: 'cost_basis_source_stale',
            databaseId: sf.databaseId,
            level: sf.level,
            fullLevel: sf.fullLevel,
            fullAgeDays: sf.fullAgeDays,
            dailyLevel: sf.dailyLevel,
            dailyAgeDays: sf.dailyAgeDays,
            baselineSource: sf.baselineSource,
            runDateLocal,
          },
          'cost-basis source is stale (merged result may still be healthy)',
        );
      }
    }

    // Staleness check + Slack heads-up (gated on DRIFT_ALERTS_ENABLED).
    const freshness = evaluateCostBasisFreshness({
      fullRefreshLatest,
      dailyRefreshLatest,
      fullGlueRunLatest,
      dailyGlueRunLatest,
      asOf: now,
    });
    const freshnessSummary = toFreshnessSummary(freshness);
    await postCostBasisFreshnessAlert({ freshness, runDateLocal });

    const enrichment = enrichAccountsWithCostBasis(positions, lots);

    // Realized YTD gains (closed-lot aggregate). Independent + non-fatal: if the
    // realized query fails, unrealized enrichment still proceeds with an empty map.
    let realizedByAccount = new Map<string, RealizedGainYtd>();
    try {
      realizedByAccount = await fetchRealizedGainsYtd();
    } catch (err) {
      logger.error(
        {
          event: 'cost_basis_realized_failed',
          runDateLocal,
          message: err instanceof Error ? err.message : String(err),
        },
        'realized-gain query failed (non-fatal); proceeding without realized YTD',
      );
    }

    // Authoritative ownership type (RETIREMENT = non-taxable) for the
    // transition-candidate gate. Non-fatal: on failure the gate falls back to
    // the account_type heuristic inside isTaxableAccount.
    let ownershipByAccount = new Map<string, string>();
    try {
      ownershipByAccount = await fetchOwnershipTypes();
    } catch (err) {
      logger.error(
        {
          event: 'cost_basis_ownership_failed',
          runDateLocal,
          message: err instanceof Error ? err.message : String(err),
        },
        'ownership-type query failed (non-fatal); transition gate falls back to account_type',
      );
    }

    let enrichedAccounts = 0;
    let transitionCandidates = 0;
    let totalUnrealizedGainUsd = 0;
    let totalRealizedYtdUsd = 0;
    for (const account of accounts) {
      // Freshness is run-level — denormalize onto every account's details so
      // the UI banner can read it from any row of the latest run.
      account.details.costBasisFreshness = freshnessSummary;
      const e = enrichment.get(account.accountId);
      if (!e) continue;
      const accountType = householdConfig.byAccountNumber.get(account.accountId)?.accountType;
      const ownershipType = ownershipByAccount.get(account.accountId);
      const taxable = isTaxableAccount(ownershipType, accountType);
      const transitionCandidate =
        account.status === 'no_template' && taxable && e.transferInPct >= TRANSITION_TRANSFER_IN_PCT_THRESHOLD;
      const realized = realizedByAccount.get(account.accountId);
      account.details.tax = toTaxSummary(e, transitionCandidate, realized, taxable);
      enrichedAccounts += 1;
      totalUnrealizedGainUsd += e.unrealizedGainUsd;
      totalRealizedYtdUsd += realized?.realizedGainYtdUsd ?? 0;
      if (transitionCandidate) transitionCandidates += 1;
    }

    logger.info(
      {
        event: 'cost_basis_enrichment_complete',
        runDateLocal,
        freshnessLevel: freshness.level,
        fullRefreshLatest,
        fullAgeDays: freshness.full.ageDays,
        dailyRefreshLatest,
        dailyAgeDays: freshness.daily.ageDays,
        pipelineLatest: freshness.pipeline.latest,
        pipelineAgeDays: freshness.pipeline.ageDays,
        lotCount: lots.length,
        // Which sources answered, which supplied the baseline, and how many rows
        // each contributed — so a multi-source run is auditable from one line.
        costBasisSources: sources.map((sf) => ({
          databaseId: sf.databaseId,
          baseline: sf.baselineSource,
          rows: sf.rowsContributed,
          fullRefreshLatest: sf.fullRefreshLatest,
          dailyRefreshLatest: sf.dailyRefreshLatest,
        })),
        enrichedAccounts,
        transitionCandidates,
        totalUnrealizedGainUsd: Math.round(totalUnrealizedGainUsd),
        totalRealizedYtdUsd: Math.round(totalRealizedYtdUsd),
        realizedAccounts: realizedByAccount.size,
      },
      'cost-basis enrichment complete',
    );
  } catch (err) {
    logger.error(
      {
        event: 'cost_basis_step_failed',
        runDateLocal,
        message: err instanceof Error ? err.message : String(err),
      },
      'cost-basis step failed (non-fatal)',
    );
  }
}

/**
 * Equity-sleeve classification enrichment. Rolls each account's equity holdings
 * into a unified sector / asset-class breakdown using the cached security-sector
 * map, and attaches it to `details.sectorAllocation` BEFORE persistence (so it
 * lands in the JSONB and flows to the v2 UI). Read-only against the cache and
 * fully guarded: an empty/unavailable cache just means accounts persist without
 * `details.sectorAllocation` — it can never abort the drift run.
 */
async function applySectorEnrichment(input: {
  pool: Pool;
  accounts: readonly AccountDriftResult[];
  runDateLocal: string;
}): Promise<void> {
  const { pool, accounts, runDateLocal } = input;
  try {
    // Every held equity symbol across all accounts, normalized to cache keys.
    const normalized = new Set<string>();
    for (const a of accounts) {
      for (const h of a.details.equityHoldings) {
        const n = normalizeTicker(h.symbol);
        if (n) normalized.add(n);
      }
    }
    if (normalized.size === 0) return;

    const classification = await getClassificationMap(pool, [...normalized]);
    if (classification.size === 0) {
      logger.info({ event: 'sector_enrichment_skipped', runDateLocal }, 'sector cache empty — skipping');
      return;
    }

    let enriched = 0;
    let totalClassifiedPct = 0;
    for (const account of accounts) {
      const alloc = computeSectorAllocation(account.details.equityHoldings, classification, normalizeTicker);
      account.details.sectorAllocation = alloc;
      if (alloc.slices.length > 0) {
        enriched += 1;
        totalClassifiedPct += alloc.classifiedPct;
      }
    }

    logger.info(
      {
        event: 'sector_enrichment_complete',
        runDateLocal,
        cacheHits: classification.size,
        heldSymbols: normalized.size,
        enrichedAccounts: enriched,
        avgClassifiedPct: enriched ? Math.round(totalClassifiedPct / enriched) : 0,
      },
      'sector enrichment complete',
    );
  } catch (err) {
    logger.error(
      { event: 'sector_enrichment_failed', runDateLocal, message: err instanceof Error ? err.message : String(err) },
      'sector enrichment step failed (non-fatal)',
    );
  }
}

/**
 * Transition enrichment. Reads the Meridian transitions feed (S3) and marks
 * accounts that have an ACTIVE transition as `transitionConfirmed` — catching the
 * cases the heuristic candidate flag misses (e.g. a templated account mid-
 * transition). Surfaces the target model + estimated realized-gain budget.
 * Runs AFTER cost-basis enrichment (it writes onto `details.tax`). Guarded +
 * non-fatal; a no-op when the feed is unconfigured/empty (e.g. the GCS source).
 */
async function applyTransitionEnrichment(input: {
  accounts: readonly AccountDriftResult[];
  householdConfig: HouseholdConfig;
  runDateLocal: string;
}): Promise<void> {
  const { accounts, householdConfig, runDateLocal } = input;
  try {
    const transitions = await loadMeridianTransitions();
    if (transitions.size === 0) return;

    // Taxable gate: a transition is a TAX move (managing realized gains). The feed
    // also carries retirement accounts (~40% here) — those are just rebalances to
    // model with no cap-gains concern, so they are NOT tax transitions and must
    // not be flagged as such. Non-fatal: on failure the gate falls back to the
    // account_type heuristic inside isTaxableAccount.
    let ownershipByAccount = new Map<string, string>();
    try {
      ownershipByAccount = await fetchOwnershipTypes();
    } catch (err) {
      logger.error(
        {
          event: 'transition_ownership_failed',
          runDateLocal,
          message: err instanceof Error ? err.message : String(err),
        },
        'ownership query failed in transition enrichment (non-fatal); taxable gate falls back to account_type',
      );
    }

    // The transitions feed keys on `external_account_no`, now a full 26-char
    // ULID — the same key the comparator uses — so `transitions` joins directly.
    let confirmedTaxable = 0;
    let confirmedNonTaxable = 0;
    for (const account of accounts) {
      const t = transitions.get(account.accountId);
      if (!t || !account.details.tax) continue;
      const accountType = householdConfig.byAccountNumber.get(account.accountId)?.accountType;
      const taxable = isTaxableAccount(ownershipByAccount.get(account.accountId), accountType);
      account.details.tax.transitionConfirmed = true;
      account.details.tax.transitionCandidate = true; // light up the existing flag/chip
      account.details.tax.transitionTargetName = t.targetName;
      account.details.tax.transitionUpdatedAt = t.updatedAt;
      // The realized-gain budget is a TAX concept — only meaningful for taxable
      // accounts. Retirement transitions are real moves but carry no cap-gains,
      // so we surface the transition without the (misleading) gain estimate.
      account.details.tax.transitionEstRealizedGainUsd = taxable ? t.estNetRealizedGainUsd : null;
      if (taxable) confirmedTaxable += 1;
      else confirmedNonTaxable += 1;
    }

    logger.info(
      {
        event: 'transition_enrichment_complete',
        runDateLocal,
        feedAccounts: transitions.size,
        confirmedTaxable,
        confirmedNonTaxable,
      },
      'transition enrichment complete',
    );
  } catch (err) {
    logger.error(
      {
        event: 'transition_enrichment_failed',
        runDateLocal,
        message: err instanceof Error ? err.message : String(err),
      },
      'transition enrichment failed (non-fatal)',
    );
  }
}

interface PersistedRowIdentity {
  household_name: string;
  inserted: boolean;
}

/**
 * @internal Exported only for the integration test in
 * __tests__/registryDriftRunner.integration.test.ts. Not intended for external
 * callers.
 *
 * Persists one row per `(run_date_local, household_name)`. On conflict the
 * existing row's `run_started_at` is refreshed to the new run's value (via
 * `EXCLUDED.run_started_at`, which Postgres resolves from the column DEFAULT
 * `now()` at INSERT time, fixed for the transaction). This is the contract
 * `driftHistoryQuery.ts HISTORY_SQL` depends on to mask stale rows from
 * earlier same-day runs whose `household_name` is no longer present.
 *
 * The returned `Set<string>` contains ONLY newly-inserted household names —
 * rows that were updated on conflict are filtered out via Postgres'
 * `(xmax = 0)` trick in RETURNING. That preserves the Slack-alert idempotency
 * contract (alert at most once per `(run_date_local, household_name)`):
 * `runDriftCheck` passes the set to `postDriftAlert` as
 * `breachInsertedHouseholdNames`.
 */
export async function persistDriftRows(input: {
  pool: Pool;
  runDateLocal: string;
  snapshotAsOf: string;
  households: readonly DriftHouseholdResult[];
}): Promise<Set<string>> {
  const { pool, runDateLocal, snapshotAsOf: asOf, households } = input;

  const inserted = new Set<string>();
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      for (const household of households) {
        const { rows } = await client.query<PersistedRowIdentity>(
          `INSERT INTO registry_drift_runs (
             run_date_local,
             household_name,
             account_count,
             max_delta_pct,
             breach,
             coverage_status,
             schema_version,
             snapshot_source,
             snapshot_as_of,
             details
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           ON CONFLICT (run_date_local, household_name) DO UPDATE
             SET run_started_at = EXCLUDED.run_started_at
           RETURNING household_name, (xmax = 0) AS inserted`,
          [
            runDateLocal,
            household.householdName,
            household.accountCount,
            household.maxDeltaPct,
            household.breach,
            household.coverageStatus,
            REGISTRY_SCHEMA_VERSION,
            snapshotSourceName(),
            asOf,
            JSON.stringify({
              accountCount: household.accountCount,
              worstSymbol: household.worstSymbol,
              accounts: household.details.accounts,
              source: household.details.source,
            }),
          ],
        );
        if (rows.length > 0 && rows[0].inserted === true) {
          inserted.add(household.householdName);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error(
          {
            event: 'drift_run_rollback_failed',
            runDateLocal,
            message: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          },
          'drift persistence rollback failed',
        );
      }
      logger.error(
        {
          event: 'drift_run_persistence_failed',
          runDateLocal,
          message: err instanceof Error ? err.message : String(err),
        },
        'drift persistence failed, transaction rolled back',
      );
      throw err;
    }
  } finally {
    client.release();
  }

  return inserted;
}

function countUnmappedSnapshotAccountsInBreachBuckets(comparison: ComparePositionsResult): number {
  return comparison.households
    .filter((household) => household.coverageStatus === 'unmapped_account')
    .reduce((sum, household) => sum + household.accountCount, 0);
}

/**
 * Build a positions+snapshot comparison without writing anything. Used by the
 * `POST /drift/check/preview` route so engineers can review the comparison
 * shape against live data while iterating on tolerance config without
 * cluttering `registry_drift_runs`.
 *
 * The returned `positions` block summarises the position-side input
 * (accountCount + a representative `businessDate`) for the dev-only preview
 * route. The previous version returned a `registry` block sourced from the
 * legacy engine pipeline; that block has been replaced in lockstep with the
 * runner cutover.
 */
export async function previewDriftCheck(_pool: Pool): Promise<{
  comparison: ComparePositionsResult;
  positions: { accountCount: number; businessDate: string | null };
  snapshot: MeridianSnapshot;
  tolerancePct: number;
}> {
  const positions = await fetchAccountPositions();
  const snapshot = await loadMeridianTemplates();
  const activeAccounts = await loadMeridianActiveAccounts();
  const householdConfig = toHouseholdConfig(activeAccounts);
  const tolerancePct = DEFAULT_TOLERANCE_PCT;
  const comparison = comparePositionsToMeridian({
    positions,
    snapshot,
    householdConfig,
    tolerancePct,
  });

  // Pick a representative businessDate for the preview header — the latest
  // observed across all positions rows. Empty when no rows.
  let representativeDate: string | null = null;
  for (const row of positions.values()) {
    if (row.businessDate && (!representativeDate || row.businessDate > representativeDate)) {
      representativeDate = row.businessDate;
    }
  }

  return {
    comparison,
    positions: { accountCount: positions.size, businessDate: representativeDate },
    snapshot,
    tolerancePct,
  };
}

export async function runDriftCheck(opts: RunDriftCheckOptions): Promise<DriftRunSummary> {
  const now = opts.now ?? new Date();
  const runDateLocal = computeRunDate(now);

  const positions = await fetchAccountPositions();

  let snapshot: MeridianSnapshot;
  try {
    snapshot = await loadMeridianTemplates(now);
  } catch (err) {
    if (err instanceof SnapshotLoadError) {
      logger.error(
        {
          event: 'drift_run_aborted',
          reason: 'snapshot_load_failed',
          runDateLocal,
          source: err.source,
          message: err.message,
        },
        'drift run aborted before persistence',
      );
    }
    throw err;
  }

  let householdConfig;
  try {
    const activeAccounts = await loadMeridianActiveAccounts(now);
    householdConfig = toHouseholdConfig(activeAccounts);
  } catch (err) {
    if (err instanceof ActiveAccountsLoadError) {
      logger.error(
        {
          event: 'drift_run_aborted',
          reason: 'active_accounts_load_failed',
          runDateLocal,
          source: err.source,
          message: err.message,
        },
        'drift run aborted before persistence (active_accounts)',
      );
    }
    throw err;
  }

  // Both the Meridian S3 feed and the GCS feed now emit full 26-char ULIDs as
  // the account key — the same key the comparator joins on — so no remapping is
  // needed before comparison.
  const tolerancePct = DEFAULT_TOLERANCE_PCT;
  const comparison = comparePositionsToMeridian({
    positions,
    snapshot,
    householdConfig,
    tolerancePct,
  });

  const snapshotAsOfIso = snapshotAsOf(snapshot, now);
  const insertedHouseholdNames = await persistDriftRows({
    pool: opts.pool,
    runDateLocal,
    snapshotAsOf: snapshotAsOfIso,
    households: comparison.households,
  });

  const breachHouseholds = comparison.households.filter((household) => household.breach).length;
  const unmappedAccountCount = countUnmappedSnapshotAccountsInBreachBuckets(comparison);

  // v1 household-level Slack alert RETIRED (2026-06): the account-level v2
  // message below is now the single drift notification — the v1 household
  // rollup duplicated it in the same channel. v1 rows are still persisted
  // above (persistDriftRows) for history/back-compat; we just no longer post
  // the household message to Slack.
  const alert: DriftAlertResult = { sent: false, alertingHouseholds: [], suppressedAllowListed: [] };

  // ─── v2 per-account pipeline (additive) ──────────────────────────────────
  // Runs alongside v1 on every cron tick. Shares the in-memory `positions`
  // Map and the same `snapshot`. The two pipelines coexist until the
  // retirement follow-up PR (plan §9).
  // Cache-backed bucket corrections: route bond/MMF funds that classifySymbol()
  // defaults to 'equity' into their real fixed/cash bucket. Guarded — an empty or
  // unavailable cache yields no overrides, i.e. pure classifySymbol behavior.
  let bucketOverrides: Map<string, AssetCategory> | undefined;
  try {
    const classification = await getClassificationMap(opts.pool);
    const m = new Map<string, AssetCategory>();
    for (const c of classification.values()) {
      if (c.kind === 'fund' && (c.bucket === 'fixed' || c.bucket === 'cash')) m.set(c.ticker, c.bucket);
    }
    if (m.size > 0) bucketOverrides = m;
    logger.info({ event: 'bucket_overrides_built', runDateLocal, count: m.size }, 'cache bucket overrides built');
  } catch (err) {
    logger.error(
      { event: 'bucket_overrides_failed', runDateLocal, message: err instanceof Error ? err.message : String(err) },
      'bucket overrides failed (non-fatal); using classifySymbol only',
    );
  }

  // Firm account titles (apex_daily_accounts.title) so funded-but-unmapped
  // accounts surface with a client name rather than a bare ULID. Guarded:
  // a fetch failure just leaves unmapped rows titled by ULID, never aborts.
  let accountTitles = new Map<string, string>();
  try {
    accountTitles = await fetchAccountTitles();
    logger.info({ event: 'account_titles_loaded', runDateLocal, count: accountTitles.size }, 'account titles loaded');
  } catch (err) {
    logger.error(
      { event: 'account_titles_failed', runDateLocal, message: err instanceof Error ? err.message : String(err) },
      'account titles fetch failed (non-fatal); unmapped rows fall back to ULID',
    );
  }

  const v2Result = comparePositionsToMeridianPerAccount({
    positions,
    snapshot,
    householdConfig,
    tolerancePct,
    uninvestedCashThresholdPct: DEFAULT_UNINVESTED_CASH_THRESHOLD_PCT,
    bucketOverrides,
    emitUnmappedFunded: true,
    accountTitles,
    unmappedExcludeAccountIds: UNMAPPED_EXCLUDE_ACCOUNT_IDS,
  });

  // Cost-basis tax enrichment + staleness check — BEFORE persistence so the
  // tax rollup + freshness land in `details` and flow to the v2 UI. Fully
  // guarded: never aborts the run.
  await applyCostBasisEnrichment({
    accounts: v2Result.accounts,
    positions,
    householdConfig,
    runDateLocal,
    now,
  });

  // Confirm transitions from the Meridian feed (writes onto details.tax, so
  // AFTER cost-basis enrichment). Guarded; never aborts the run.
  await applyTransitionEnrichment({
    accounts: v2Result.accounts,
    householdConfig,
    runDateLocal,
  });

  // Equity-sleeve sector / asset-class breakdown — also BEFORE persistence so it
  // lands in `details` and flows to the v2 UI. Guarded; never aborts the run.
  await applySectorEnrichment({
    pool: opts.pool,
    accounts: v2Result.accounts,
    runDateLocal,
  });

  const v2RunStartedAt = now;
  const insertedAccountIds = await persistAccountDriftRows({
    pool: opts.pool,
    runDateLocal,
    runStartedAt: v2RunStartedAt,
    snapshotSource: snapshotSourceName(),
    snapshotAsOf: snapshotAsOfIso,
    tolerancePct,
    uninvestedCashThresholdPct: DEFAULT_UNINVESTED_CASH_THRESHOLD_PCT,
    schemaVersion: ACCOUNT_DRIFT_SCHEMA_VERSION,
    accounts: v2Result.accounts,
  });

  const v2OutAccounts = v2Result.accounts.filter((account) => account.status === 'out').length;
  const v2UninvestedAccounts = v2Result.accounts.filter((account) => account.status === 'uninvested').length;

  const v2Alert = await postAccountDriftAlert({
    accounts: v2Result.accounts,
    runDateLocal,
    pool: opts.pool,
  });

  // Re-check reminders: notify the trader who set an override once its
  // `expires_on` date has arrived (the account is now back on the action list).
  // Non-fatal — a notification failure must not abort the drift run.
  try {
    const remindersSent = await sweepOverrideRechecks(opts.pool);
    if (remindersSent > 0) {
      logger.info(
        { event: 'drift_override_recheck_reminders', runDateLocal, remindersSent },
        'override re-check reminders sent',
      );
    }
  } catch (err) {
    logger.error(
      {
        event: 'drift_override_recheck_failed',
        runDateLocal,
        message: err instanceof Error ? err.message : String(err),
      },
      'override re-check reminder sweep failed (non-fatal)',
    );
  }

  // Emit one structured warn per distinct suspected cash-equiv symbol (per
  // §4.3 step 10). The comparator already deduplicated the array.
  for (const symbol of v2Result.suspectedCashEquivMisclassified) {
    logger.warn(
      {
        event: 'drift_suspected_cash_equiv_misclassified',
        runDateLocal,
        symbol,
      },
      'drift v2: symbol looks like a money-market fund but routed to equity (not in INSTRUMENTS)',
    );
  }

  logger.info(
    {
      event: 'drift_unmapped_detail',
      runDateLocal,
      unmappedPositionsAccounts: comparison.unmappedPositionsAccounts,
      unmappedSnapshotAccounts: comparison.unmappedSnapshotAccounts,
      unmappedPositionsAccountCount: comparison.unmappedPositionsAccounts.length,
      unmappedSnapshotAccountCount: comparison.unmappedSnapshotAccounts.length,
    },
    'drift unmapped detail',
  );

  logger.info(
    {
      event: 'drift_run_complete',
      runDateLocal,
      totalHouseholds: comparison.households.length,
      breachHouseholds,
      insertedRows: insertedHouseholdNames.size,
      // v1 Slack alert retired — always false now; kept for log-shape stability.
      alertSent: alert.sent,
      unmappedSnapshotInBreachCount: unmappedAccountCount,
      unmappedPositionsAccountCount: comparison.unmappedPositionsAccounts.length,
      unmappedSnapshotAccountCount: comparison.unmappedSnapshotAccounts.length,
      snapshotSource: snapshotSourceName(),
      snapshotAsOf: snapshotAsOfIso,
      tolerancePct,
      // v2 per-account additive fields.
      v2TotalAccounts: v2Result.accounts.length,
      v2OutAccounts,
      v2UninvestedAccounts,
      v2InsertedRows: insertedAccountIds.size,
      v2AlertSent: v2Alert.sent,
      v2AlertingAccountCount: v2Alert.alertingAccountIds.length,
      v2SuspectedCashEquivMisclassifiedCount: v2Result.suspectedCashEquivMisclassified.length,
    },
    'drift run complete',
  );

  return {
    runDateLocal,
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    snapshotSource: snapshotSourceName(),
    snapshotAsOf: snapshot.generatedAt ?? null,
    totalHouseholds: comparison.households.length,
    breachHouseholds,
    insertedRows: insertedHouseholdNames.size,
    alert,
    unmappedPositionsAccounts: comparison.unmappedPositionsAccounts,
    unmappedSnapshotAccounts: comparison.unmappedSnapshotAccounts,
    accountDrift: {
      totalAccounts: v2Result.accounts.length,
      outAccounts: v2OutAccounts,
      uninvestedAccounts: v2UninvestedAccounts,
      insertedRows: insertedAccountIds.size,
      alert: v2Alert,
    },
  };
}
