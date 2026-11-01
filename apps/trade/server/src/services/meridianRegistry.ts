import type { Pool } from 'pg';
import type { AccountType, BaseAllocation, EquityStrategy, Holdings, Residence } from '@trade-request/shared';
import { selectModel, getProfile, type ModelKey } from '../data/allocationProfiles.js';
import { buildTemplateName } from './assetLocationEngine.js';

// ─── Public constants ───────────────────────────────────────────────────────

/** Bumped on any breaking change to RegistryResponse so consumers fail fast. */
export const REGISTRY_SCHEMA_VERSION = 1;

/** Default per-template tolerance until per-template overrides are added. */
export const DEFAULT_TOLERANCE_PCT = 5.0;

/** Snake-case model keys matching the sample registry row. */
export const MODEL_REGISTRY_KEY: Record<
  ModelKey,
  'taxable_national' | 'national_tax_efficient' | 'new_york' | 'california'
> = {
  taxableNational: 'taxable_national',
  nationalTaxEfficient: 'national_tax_efficient',
  newYork: 'new_york',
  california: 'california',
};

// ─── Public types ───────────────────────────────────────────────────────────

export type RegistryFlag =
  | 'zero_account_value'
  | 'cash_sleeve_unmapped'
  | 'fixed_sleeve_unmapped'
  | 'metadata_fallback'
  | 'owner_fallback'
  | 'over_allocation';

export interface RegistryEquitySleeve {
  sleeve: string;
  allocation_pct: number;
}

export interface RegistryOwner {
  client_id: string;
  client_name: string;
}

export interface RegistryRow {
  account: string;
  owners: RegistryOwner[];
  primary_client_id: string;
  primary_client_name: string;
  account_type: AccountType;
  live_account_type: AccountType | null;
  template_name: string;
  stored_template_name: string;
  model: (typeof MODEL_REGISTRY_KEY)[ModelKey];
  risk: number;
  tolerance_pct: number;
  residence: Residence;
  base_allocation_household: BaseAllocation;
  post_trade_holdings: Holdings;
  account_value: number;
  weights: Record<string, number>;
  equity_breakdown: RegistryEquitySleeve[];
  residual_pct: number;
  flags: RegistryFlag[];
  source_request_id: string;
  as_of: string;
}

export interface RegistryWarning {
  flag: RegistryFlag;
  count: number;
}

export interface RegistryResponse {
  schemaVersion: number;
  generatedAt: string;
  count: number;
  warnings: RegistryWarning[];
  rows: RegistryRow[];
}

// ─── Pure expansion logic ───────────────────────────────────────────────────

export interface ExpandToWeightsInput {
  postTradeHoldings: Holdings;
  accountValue: number;
  modelKey: ModelKey;
  riskLevel: number;
  equityStrategies: EquityStrategy[];
}

export interface ExpandToWeightsResult {
  weights: Record<string, number>;
  equity_breakdown: RegistryEquitySleeve[];
  residual_pct: number;
  flags: RegistryFlag[];
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * Convert a per-account post-trade sleeve breakdown into per-symbol weight
 * percentages, mirroring the asset-location engine's intra-sleeve scaling.
 *
 * Outputs only real cash + fixed tickers in `weights`; the equity sleeve is
 * surfaced separately in `equity_breakdown` because per-ticker DI baskets are
 * not modelled in this app's data. Residual slack from the priority matrix
 * (when post-trade sleeves don't sum to accountValue) is reported as
 * `residual_pct`. Flags surface diagnostic conditions for the drift script.
 *
 * @remarks
 * This function is **mode-agnostic**: it operates purely on the
 * `postTradeHoldings` cash/fixed/equity dollar amounts produced by the engine,
 * so it works identically for `assetLocationMode: 'priority'` (cross-account
 * asset location) and `assetLocationMode: 'mirror'` (per-account proportional
 * allocation). For mirror-mode plans every account's cash/fixed/equity ratios
 * already match the household base allocation, which simply causes the
 * residual term to converge near zero — no special-casing required here.
 */
export function expandToWeights(input: ExpandToWeightsInput): ExpandToWeightsResult {
  const { postTradeHoldings, accountValue, modelKey, riskLevel, equityStrategies } = input;
  const flags: RegistryFlag[] = [];

  if (!Number.isFinite(accountValue) || accountValue <= 0) {
    return { weights: {}, equity_breakdown: [], residual_pct: 0, flags: ['zero_account_value'] };
  }

  const profile = getProfile(modelKey, riskLevel);
  const cashPositions = profile.positions.filter((p) => p.category === 'cash');
  const fixedPositions = profile.positions.filter((p) => p.category === 'fixed');
  const sumCash = cashPositions.reduce((s, p) => s + p.weight, 0);
  const sumFixed = fixedPositions.reduce((s, p) => s + p.weight, 0);

  const cashPct = (postTradeHoldings.cash / accountValue) * 100;
  const fixedPct = (postTradeHoldings.fixed / accountValue) * 100;
  const equityPct = (postTradeHoldings.equity / accountValue) * 100;

  const weights: Record<string, number> = {};

  // Cash sleeve — engine-parity guard for sumCash === 0 (e.g. California risk 21+).
  for (const p of cashPositions) {
    weights[p.symbol] = round4(cashPct * (sumCash > 0 ? p.weight / sumCash : 0));
  }
  if (sumCash === 0 && cashPct > 0.001) {
    weights._unmapped_cash = round4(cashPct);
    flags.push('cash_sleeve_unmapped');
  }

  // Fixed sleeve — same guard (e.g. California risk 25 in profiles with no bonds).
  for (const p of fixedPositions) {
    weights[p.symbol] = round4(fixedPct * (sumFixed > 0 ? p.weight / sumFixed : 0));
  }
  if (sumFixed === 0 && fixedPct > 0.001) {
    weights._unmapped_fixed = round4(fixedPct);
    flags.push('fixed_sleeve_unmapped');
  }

  // Equity — short-circuit on zero post-trade equity dollars BEFORE consulting
  // strategies, so a Risk 1 row (or any row with no equity allocated) emits
  // `equity_breakdown: []` regardless of stale equity_strategies state. This
  // matches `runAssetLocationEngine`, which only emits equity sleeves when
  // there is an equity delta to trade.
  let equity_breakdown: RegistryEquitySleeve[] = [];
  if (postTradeHoldings.equity > 0.001) {
    if (equityStrategies.length === 0) {
      equity_breakdown = [{ sleeve: 'Direct Index', allocation_pct: round4(equityPct) }];
    } else {
      // Aggregate duplicate benchmarks (e.g., two SPY entries) by normalized name.
      const byBenchmark = new Map<string, number>();
      for (const s of equityStrategies) {
        const key = s.benchmark.trim();
        byBenchmark.set(key, (byBenchmark.get(key) ?? 0) + s.allocation);
      }
      const sumStrat = [...byBenchmark.values()].reduce((s, v) => s + v, 0) || 1;
      // Normalize so equity_breakdown sums to exactly equityPct (engine accepts ±0.5).
      equity_breakdown = [...byBenchmark.entries()].map(([benchmark, allocation]) => ({
        sleeve: `${benchmark} Strategy`,
        allocation_pct: round4(equityPct * (allocation / sumStrat)),
      }));
    }
  }

  // Residual — clamp to non-negative; flag over-allocation.
  const sumWeights = Object.values(weights).reduce((s, v) => s + v, 0);
  const sumEquity = equity_breakdown.reduce((s, e) => s + e.allocation_pct, 0);
  const total = sumWeights + sumEquity;
  if (total > 100.5) flags.push('over_allocation');
  const residual_pct = Math.max(0, round4(100 - total));

  return { weights, equity_breakdown, residual_pct, flags };
}

// ─── DB query and registry assembly ─────────────────────────────────────────

interface DbRegistryRow {
  request_id: string;
  request_client_id: string;
  request_client_name: string | null;
  client_ids: string[] | null;
  client_names: string[] | null;
  residence: Residence | null;
  risk_profile: number;
  base_allocation: BaseAllocation;
  equity_strategies: EquityStrategy[] | null;
  account_metadata: Array<{ accountNumber: string; accountType: AccountType; balance: number }> | null;
  updated_at: Date | string;
  plan_entry: {
    accountNumber: string;
    accountType: AccountType;
    accountValue: number;
    templateName: string;
    modelName: string;
    postTradeHoldings: Holdings;
  };
}

const REGISTRY_SQL = `
  WITH eligible AS (
    SELECT
      tr.id,
      tr.client_id,
      tr.client_name,
      tr.client_ids,
      tr.client_names,
      tr.residence,
      tr.risk_profile,
      tr.base_allocation,
      tr.equity_strategies,
      tr.account_metadata,
      tr.updated_at,
      tr.execution_plan
    FROM trade_requests tr
    WHERE tr.status IN ('Approved', 'Completed')
      AND tr.trade_type IN ('Initial Funding', 'Rebalance')
      AND tr.risk_profile IS NOT NULL
      AND tr.base_allocation IS NOT NULL
      AND jsonb_typeof(tr.execution_plan) = 'array'
      AND jsonb_array_length(tr.execution_plan) > 0
  ),
  exploded AS (
    SELECT
      e.*,
      elem AS plan_entry,
      ord
    FROM eligible e
    CROSS JOIN LATERAL jsonb_array_elements(e.execution_plan)
      WITH ORDINALITY AS x(elem, ord)
    WHERE NULLIF(trim(elem->>'accountNumber'), '') IS NOT NULL
  )
  SELECT DISTINCT ON (plan_entry->>'accountNumber')
    id AS request_id,
    client_id AS request_client_id,
    client_name AS request_client_name,
    client_ids,
    client_names,
    residence,
    risk_profile,
    base_allocation,
    equity_strategies,
    account_metadata,
    updated_at,
    plan_entry
  FROM exploded
  ORDER BY plan_entry->>'accountNumber' ASC, updated_at DESC, id DESC, ord DESC
`;

const LIVE_ACCOUNT_SQL = `
  SELECT account_number, account_type, client_id
  FROM accounts
  WHERE account_number = ANY($1::text[])
`;

function toIsoString(val: Date | string | null | undefined): string {
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') return val;
  return new Date().toISOString();
}

function buildOwners(
  clientIds: string[] | null,
  clientNames: string[] | null,
  fallbackId: string,
  fallbackName: string,
): RegistryOwner[] {
  if (clientIds && clientIds.length > 0) {
    return clientIds.map((id, idx) => ({
      client_id: id,
      client_name: clientNames?.[idx] ?? '',
    }));
  }
  return [{ client_id: fallbackId, client_name: fallbackName }];
}

/**
 * Build the clientId → clientName lookup the engine uses to pick the right
 * last-name for a non-Joint account that belongs to a non-primary owner. The
 * engine zips `clientIds` and `clientNames` the same way at submit time.
 */
function buildClientNameMap(
  clientIds: string[] | null,
  clientNames: string[] | null,
): Record<string, string> | undefined {
  if (!clientIds || clientIds.length === 0) return undefined;
  const map: Record<string, string> = {};
  for (let i = 0; i < clientIds.length; i++) {
    const name = clientNames?.[i];
    if (name) map[clientIds[i]] = name;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

function aggregateWarnings(rows: RegistryRow[]): RegistryWarning[] {
  const counts = new Map<RegistryFlag, number>();
  for (const row of rows) {
    for (const flag of row.flags) {
      counts.set(flag, (counts.get(flag) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([flag, count]) => ({ flag, count }));
}

/**
 * Build the Meridian registry from the latest approved Initial Funding /
 * Rebalance per account. Per-account metadata comes from frozen JSONB
 * snapshots on `trade_requests` (`account_metadata`, `client_ids`,
 * `client_names`) so the export does not depend on the local `accounts`
 * table being populated (which it is not in Warehouse production mode). The
 * `accounts` table is consulted only to populate `live_account_type` for
 * downstream drift detection.
 */
export async function buildRegistry(pool: Pool): Promise<RegistryResponse> {
  const { rows: dbRows } = await pool.query<DbRegistryRow>(REGISTRY_SQL);

  const accountNumbers = dbRows.map((r) => r.plan_entry.accountNumber);
  const liveAccountTypes = new Map<string, AccountType>();
  const liveAccountClientIds = new Map<string, string>();
  if (accountNumbers.length > 0) {
    const { rows: liveRows } = await pool.query<{
      account_number: string;
      account_type: AccountType;
      client_id: string;
    }>(LIVE_ACCOUNT_SQL, [accountNumbers]);
    for (const row of liveRows) {
      liveAccountTypes.set(row.account_number, row.account_type);
      liveAccountClientIds.set(row.account_number, row.client_id);
    }
  }

  const rows: RegistryRow[] = dbRows.map((r) => {
    const plan = r.plan_entry;
    const accountNumber = plan.accountNumber;

    // Resolve account_type from the snapshot, falling back to the plan entry
    // (older requests pre-`account_metadata` column) and tracking the fallback.
    let accountType: AccountType;
    let metadataFallback = false;
    const metadataEntry = r.account_metadata?.find((m) => m.accountNumber === accountNumber);
    if (metadataEntry) {
      accountType = metadataEntry.accountType;
    } else {
      accountType = plan.accountType;
      metadataFallback = true;
    }

    const residence: Residence = r.residence ?? 'Other';
    const modelKey = selectModel(accountType, residence);
    const equityStrategies = r.equity_strategies ?? [];

    const expansion = expandToWeights({
      postTradeHoldings: plan.postTradeHoldings,
      accountValue: plan.accountValue,
      modelKey,
      riskLevel: r.risk_profile,
      equityStrategies,
    });

    if (metadataFallback) expansion.flags.push('metadata_fallback');

    const owners = buildOwners(r.client_ids, r.client_names, r.request_client_id, r.request_client_name ?? '');

    // Pass the per-account clientId→clientName map so non-Joint accounts that
    // belong to a secondary owner get the right last name in `template_name`,
    // matching the engine output stored at submit/run-engine time. The
    // per-account clientId comes from the live `accounts` table when
    // available; otherwise we fall back to the request's primary client_id
    // and surface `owner_fallback` so a downstream drift script can ignore
    // template_name mismatches in that case.
    const liveAccountClientId = liveAccountClientIds.get(accountNumber);
    let accountClientId: string;
    if (liveAccountClientId) {
      accountClientId = liveAccountClientId;
    } else {
      accountClientId = r.request_client_id;
      expansion.flags.push('owner_fallback');
    }
    const templateName = buildTemplateName(
      r.request_client_name ?? '',
      buildClientNameMap(r.client_ids, r.client_names),
      accountClientId,
      accountType,
      modelKey,
      r.risk_profile,
      equityStrategies,
    );

    return {
      account: accountNumber,
      owners,
      primary_client_id: r.request_client_id,
      primary_client_name: r.request_client_name ?? '',
      account_type: accountType,
      live_account_type: liveAccountTypes.get(accountNumber) ?? null,
      template_name: templateName,
      stored_template_name: plan.templateName,
      model: MODEL_REGISTRY_KEY[modelKey],
      risk: r.risk_profile,
      tolerance_pct: DEFAULT_TOLERANCE_PCT,
      residence,
      base_allocation_household: r.base_allocation,
      post_trade_holdings: plan.postTradeHoldings,
      account_value: plan.accountValue,
      weights: expansion.weights,
      equity_breakdown: expansion.equity_breakdown,
      residual_pct: expansion.residual_pct,
      flags: expansion.flags,
      source_request_id: r.request_id,
      as_of: toIsoString(r.updated_at),
    };
  });

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    count: rows.length,
    warnings: aggregateWarnings(rows),
    rows,
  };
}
