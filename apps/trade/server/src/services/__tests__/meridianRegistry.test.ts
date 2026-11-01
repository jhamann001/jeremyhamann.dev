import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { AccountType, BaseAllocation, EquityStrategy, Holdings, Residence } from '@trade-request/shared';
import {
  expandToWeights,
  buildRegistry,
  MODEL_REGISTRY_KEY,
  REGISTRY_SCHEMA_VERSION,
  DEFAULT_TOLERANCE_PCT,
} from '../meridianRegistry.js';
import { getProfile, type ModelKey } from '../../data/allocationProfiles.js';

// Share of a fund within a model's fixed-income sleeve at a risk level.
function fixedShare(model: ModelKey, risk: number, symbol: string): number {
  const fixed = getProfile(model, risk).positions.filter((p) => p.category === 'fixed');
  const total = fixed.reduce((t, p) => t + p.weight, 0);
  return (fixed.find((p) => p.symbol === symbol)?.weight ?? 0) / total;
}


// ─── makePool helper (mirrors digest.test.ts pattern) ───────────────────────

interface QueryCall {
  sql: string;
  args?: unknown[];
}

interface DbRowOverrides {
  request_id?: string;
  request_client_id?: string;
  request_client_name?: string | null;
  client_ids?: string[] | null;
  client_names?: string[] | null;
  residence?: Residence | null;
  risk_profile?: number;
  base_allocation?: BaseAllocation;
  equity_strategies?: EquityStrategy[] | null;
  account_metadata?: Array<{ accountNumber: string; accountType: AccountType; balance: number }> | null;
  updated_at?: string;
  plan_entry?: {
    accountNumber: string;
    accountType: AccountType;
    accountValue: number;
    templateName: string;
    modelName: string;
    postTradeHoldings: Holdings;
  };
}

function dbRow(overrides: DbRowOverrides = {}) {
  return {
    request_id: 'TR-0001',
    request_client_id: 'user-aaa',
    request_client_name: 'Jane Doe',
    client_ids: ['user-aaa'],
    client_names: ['Jane Doe'],
    residence: 'CA' as Residence,
    risk_profile: 20,
    base_allocation: { equity: 79, fixed: 20, cash: 1 } satisfies BaseAllocation,
    equity_strategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }] as EquityStrategy[],
    account_metadata: [{ accountNumber: 'AC-100', accountType: 'Taxable' as AccountType, balance: 1_000_000 }],
    updated_at: '2026-04-20T12:00:00Z',
    plan_entry: {
      accountNumber: 'AC-100',
      accountType: 'Taxable' as AccountType,
      accountValue: 1_000_000,
      templateName: 'Doe (Taxable, California, R20, SPY)',
      modelName: 'California',
      postTradeHoldings: { cash: 5_000, fixed: 145_000, equity: 850_000 },
    },
    ...overrides,
  };
}

function makePool(options: {
  registryRows?: ReturnType<typeof dbRow>[];
  liveAccountTypes?: Array<{ account_number: string; account_type: AccountType; client_id: string }>;
}) {
  const calls: QueryCall[] = [];
  const pool = {
    calls,
    query: vi.fn(async (sql: string, args?: unknown[]) => {
      calls.push({ sql, args });
      if (sql.includes('FROM trade_requests tr')) {
        return { rows: options.registryRows ?? [] };
      }
      if (sql.includes('FROM accounts')) {
        return { rows: options.liveAccountTypes ?? [] };
      }
      return { rows: [] };
    }),
  };
  return pool as unknown as Pool & { calls: QueryCall[]; query: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── expandToWeights ────────────────────────────────────────────────────────

describe('expandToWeights', () => {
  it('California Risk 20 with single SPY strategy distributes per the engine ratio', () => {
    const result = expandToWeights({
      postTradeHoldings: { cash: 5_000, fixed: 145_000, equity: 850_000 },
      accountValue: 1_000_000,
      modelKey: 'california',
      riskLevel: 20,
      equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
    });

    // Cash sleeve: only VCTXX in California Risk 20, gets full 0.5%.
    expect(result.weights.VCTXX).toBeCloseTo(0.5, 4);
    // Fixed sleeve: the 14.5% splits across the model's fixed funds in proportion to their weights.
    for (const fund of ['SUB', 'VCAIX', 'MUB']) {
      expect(result.weights[fund]).toBeCloseTo(14.5 * fixedShare('california', 20, fund), 4);
    }
    expect(result.equity_breakdown).toEqual([{ sleeve: 'SPY Strategy', allocation_pct: 85 }]);
    expect(result.residual_pct).toBeCloseTo(0, 4);
    expect(result.flags).toEqual([]);
  });

  it('Roth IRA in NY is forced to taxable_national symbols (SWVXX, not VYFXX)', () => {
    // selectModel('Roth IRA', 'NY') === 'taxableNational' so the cash sleeve
    // must come from SWVXX (taxable national), not VYFXX (NY model).
    const result = expandToWeights({
      postTradeHoldings: { cash: 50_000, fixed: 400_000, equity: 550_000 },
      accountValue: 1_000_000,
      modelKey: 'taxableNational',
      riskLevel: 10,
      equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
    });

    expect(result.weights.SWVXX).toBeGreaterThan(0);
    expect(result.weights.VYFXX).toBeUndefined();
    expect(result.weights.VGSH).toBeGreaterThan(0);
  });

  it('emits Direct Index sleeve when no equity strategies are provided and equity > 0', () => {
    const result = expandToWeights({
      postTradeHoldings: { cash: 5_000, fixed: 145_000, equity: 850_000 },
      accountValue: 1_000_000,
      modelKey: 'california',
      riskLevel: 20,
      equityStrategies: [],
    });

    expect(result.equity_breakdown).toEqual([{ sleeve: 'Direct Index', allocation_pct: 85 }]);
  });

  it('short-circuits to empty equity_breakdown when post-trade equity is zero, even at risk 1 with stale strategies', () => {
    // Engine short-circuits on no equity dollars => no equity sleeve, even if
    // stale equity_strategies persist on the trade request. Gate is purely
    // dollar-based (matches `runAssetLocationEngine`'s |equityDelta| > 1).
    const result = expandToWeights({
      postTradeHoldings: { cash: 1_000_000, fixed: 0, equity: 0 },
      accountValue: 1_000_000,
      modelKey: 'taxableNational',
      riskLevel: 1,
      equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
    });

    expect(result.equity_breakdown).toEqual([]);
    expect(result.weights.SWVXX).toBeCloseTo(100, 4);
    expect(result.residual_pct).toBeCloseTo(0, 4);
  });

  it('California Risk 21 (no cash positions) flags _unmapped_cash if cash dollars exist', () => {
    // California Risk 21 has cash=0 in the profile, so sumCash === 0. If the
    // engine left non-zero cash dollars in the post-trade holdings, surface it.
    const result = expandToWeights({
      postTradeHoldings: { cash: 10_000, fixed: 120_000, equity: 870_000 },
      accountValue: 1_000_000,
      modelKey: 'california',
      riskLevel: 21,
      equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
    });

    expect(result.weights._unmapped_cash).toBeCloseTo(1, 4);
    expect(result.flags).toContain('cash_sleeve_unmapped');
    // Fixed sleeve still maps cleanly across the model's fixed funds.
    expect(result.weights.VCAIX).toBeCloseTo(12 * fixedShare('california', 21, 'VCAIX'), 4);
  });

  it('California Risk 25 (no fixed positions) flags _unmapped_fixed if fixed dollars exist', () => {
    // California Risk 25 has only the synthetic Stock equity position.
    const result = expandToWeights({
      postTradeHoldings: { cash: 0, fixed: 5_000, equity: 995_000 },
      accountValue: 1_000_000,
      modelKey: 'california',
      riskLevel: 25,
      equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
    });

    expect(result.weights._unmapped_fixed).toBeCloseTo(0.5, 4);
    expect(result.flags).toContain('fixed_sleeve_unmapped');
  });

  it('reports under-allocation slack via residual_pct without flagging', () => {
    // postTradeHoldings sums to 980k of 1M: 2% residual slack.
    const result = expandToWeights({
      postTradeHoldings: { cash: 5_000, fixed: 145_000, equity: 830_000 },
      accountValue: 1_000_000,
      modelKey: 'california',
      riskLevel: 20,
      equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
    });

    expect(result.residual_pct).toBeCloseTo(2, 4);
    expect(result.flags).not.toContain('over_allocation');
  });

  it('aggregates duplicate equity benchmarks before normalizing', () => {
    const result = expandToWeights({
      postTradeHoldings: { cash: 0, fixed: 0, equity: 1_000_000 },
      accountValue: 1_000_000,
      modelKey: 'taxableNational',
      riskLevel: 25,
      equityStrategies: [
        { id: 1, benchmark: 'SPY', allocation: 50, rationale: '' },
        { id: 2, benchmark: 'SPY', allocation: 30, rationale: '' },
        { id: 3, benchmark: 'QQQ', allocation: 20, rationale: '' },
      ],
    });

    expect(result.equity_breakdown).toHaveLength(2);
    const spy = result.equity_breakdown.find((e) => e.sleeve === 'SPY Strategy');
    const qqq = result.equity_breakdown.find((e) => e.sleeve === 'QQQ Strategy');
    expect(spy?.allocation_pct).toBeCloseTo(80, 4);
    expect(qqq?.allocation_pct).toBeCloseTo(20, 4);
  });

  it('normalizes equity strategies that do not sum to 100 (off by 0.3) to fill equity exactly', () => {
    // Strategy allocations 60 + 39.7 = 99.7. equityPct = 100. After
    // normalization: SPY = 100 * (60/99.7) = 60.18054, QQQ = 100 * (39.7/99.7)
    // = 39.81946. Round to 4dp.
    const result = expandToWeights({
      postTradeHoldings: { cash: 0, fixed: 0, equity: 1_000_000 },
      accountValue: 1_000_000,
      modelKey: 'taxableNational',
      riskLevel: 25,
      equityStrategies: [
        { id: 1, benchmark: 'SPY', allocation: 60, rationale: '' },
        { id: 2, benchmark: 'QQQ', allocation: 39.7, rationale: '' },
      ],
    });

    const spy = result.equity_breakdown.find((e) => e.sleeve === 'SPY Strategy');
    const qqq = result.equity_breakdown.find((e) => e.sleeve === 'QQQ Strategy');
    expect(spy?.allocation_pct).toBe(60.1805);
    expect(qqq?.allocation_pct).toBe(39.8195);
  });

  it('returns zero_account_value flag and empty payload when accountValue <= 0', () => {
    const result = expandToWeights({
      postTradeHoldings: { cash: 0, fixed: 0, equity: 0 },
      accountValue: 0,
      modelKey: 'california',
      riskLevel: 20,
      equityStrategies: [],
    });

    expect(result.flags).toEqual(['zero_account_value']);
    expect(result.weights).toEqual({});
    expect(result.equity_breakdown).toEqual([]);
    expect(result.residual_pct).toBe(0);
  });

  it('emits weights with deterministic insertion order matching the profile positions', () => {
    // Same inputs must produce the same key order across runs.
    const a = expandToWeights({
      postTradeHoldings: { cash: 50_000, fixed: 400_000, equity: 550_000 },
      accountValue: 1_000_000,
      modelKey: 'taxableNational',
      riskLevel: 10,
      equityStrategies: [],
    });
    const b = expandToWeights({
      postTradeHoldings: { cash: 50_000, fixed: 400_000, equity: 550_000 },
      accountValue: 1_000_000,
      modelKey: 'taxableNational',
      riskLevel: 10,
      equityStrategies: [],
    });

    expect(Object.keys(a.weights)).toEqual(Object.keys(b.weights));
    // taxableNational risk 10 cash position (SWVXX) appears before fixed
    // positions (VGSH, VCSH, AGG, SCHR), matching the profile order.
    const keys = Object.keys(a.weights);
    expect(keys[0]).toBe('SWVXX');
    expect(keys.slice(1)).toEqual(['VGSH', 'VCSH', 'AGG', 'SCHR']);
  });

  it('flags over_allocation when post-trade sleeves exceed the account value', () => {
    // Pathological input: weights exceed 100.5%.
    const result = expandToWeights({
      postTradeHoldings: { cash: 50_000, fixed: 400_000, equity: 600_000 },
      accountValue: 1_000_000,
      modelKey: 'taxableNational',
      riskLevel: 10,
      equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
    });

    expect(result.flags).toContain('over_allocation');
    expect(result.residual_pct).toBe(0);
  });

  it('produces identical weights for priority-mode and mirror-mode post-trade holdings with the same ratios', () => {
    // Mirror mode generates per-account postTradeHoldings that already match
    // the household ratio (e.g. 0.5% cash / 19.5% fixed / 80% equity). Verify
    // expandToWeights is purely a function of those dollars — not the mode —
    // by feeding two equivalent inputs and asserting parity.
    const priorityHoldings = { cash: 5_000, fixed: 195_000, equity: 800_000 };
    const mirrorHoldings = { cash: 5_000, fixed: 195_000, equity: 800_000 };

    const fromPriority = expandToWeights({
      postTradeHoldings: priorityHoldings,
      accountValue: 1_000_000,
      modelKey: 'california',
      riskLevel: 20,
      equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
    });
    const fromMirror = expandToWeights({
      postTradeHoldings: mirrorHoldings,
      accountValue: 1_000_000,
      modelKey: 'california',
      riskLevel: 20,
      equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
    });

    expect(fromMirror.weights).toEqual(fromPriority.weights);
    expect(fromMirror.equity_breakdown).toEqual(fromPriority.equity_breakdown);
    expect(fromMirror.residual_pct).toBeCloseTo(fromPriority.residual_pct, 4);
    expect(fromMirror.flags).toEqual(fromPriority.flags);
  });
});

// ─── buildRegistry ──────────────────────────────────────────────────────────

describe('buildRegistry', () => {
  it('happy path: assembles a single California Risk 20 row from snapshots', async () => {
    const pool = makePool({ registryRows: [dbRow()] });

    const response = await buildRegistry(pool);

    expect(response.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION);
    expect(response.count).toBe(1);
    expect(response.rows[0].account).toBe('AC-100');
    expect(response.rows[0].account_type).toBe('Taxable');
    expect(response.rows[0].model).toBe(MODEL_REGISTRY_KEY.california);
    expect(response.rows[0].risk).toBe(20);
    expect(response.rows[0].tolerance_pct).toBe(DEFAULT_TOLERANCE_PCT);
    expect(response.rows[0].owners).toEqual([{ client_id: 'user-aaa', client_name: 'Jane Doe' }]);
    expect(response.rows[0].source_request_id).toBe('TR-0001');
    expect(response.rows[0].live_account_type).toBeNull();
    expect(response.rows[0].flags).not.toContain('metadata_fallback');
    // Verifies the SQL we send still includes the WITH ORDINALITY guard.
    const registryCall = pool.calls.find((c) => c.sql.includes('FROM trade_requests tr'));
    expect(registryCall?.sql).toContain('WITH ORDINALITY');
    expect(registryCall?.sql).toContain('jsonb_typeof(tr.execution_plan)');
  });

  it('flags metadata_fallback when account_metadata is missing the account', async () => {
    const pool = makePool({
      registryRows: [
        dbRow({
          account_metadata: [{ accountNumber: 'AC-OTHER', accountType: 'Joint', balance: 1 }],
        }),
      ],
    });

    const response = await buildRegistry(pool);

    expect(response.rows[0].flags).toContain('metadata_fallback');
    // Falls back to plan entry's accountType.
    expect(response.rows[0].account_type).toBe('Taxable');
  });

  it('enriches live_account_type via the accounts table when populated', async () => {
    const pool = makePool({
      registryRows: [dbRow()],
      liveAccountTypes: [{ account_number: 'AC-100', account_type: 'Joint', client_id: 'user-aaa' }],
    });

    const response = await buildRegistry(pool);

    expect(response.rows[0].live_account_type).toBe('Joint');
    // Account-type used for model selection is still the metadata snapshot.
    expect(response.rows[0].account_type).toBe('Taxable');
    expect(response.rows[0].model).toBe(MODEL_REGISTRY_KEY.california);
    // accounts row was found, so no owner_fallback flag.
    expect(response.rows[0].flags).not.toContain('owner_fallback');
  });

  it('flags owner_fallback when the live accounts row is missing', async () => {
    const pool = makePool({
      registryRows: [dbRow()],
      liveAccountTypes: [],
    });

    const response = await buildRegistry(pool);

    expect(response.rows[0].flags).toContain('owner_fallback');
  });

  it('aggregates warnings across rows', async () => {
    const pool = makePool({
      registryRows: [
        dbRow({
          plan_entry: {
            accountNumber: 'AC-100',
            accountType: 'Taxable',
            accountValue: 0,
            templateName: 'x',
            modelName: 'California',
            postTradeHoldings: { cash: 0, fixed: 0, equity: 0 },
          },
        }),
        dbRow({
          request_id: 'TR-0002',
          plan_entry: {
            accountNumber: 'AC-200',
            accountType: 'Taxable',
            accountValue: 0,
            templateName: 'x',
            modelName: 'California',
            postTradeHoldings: { cash: 0, fixed: 0, equity: 0 },
          },
        }),
      ],
    });

    const response = await buildRegistry(pool);

    const zero = response.warnings.find((w) => w.flag === 'zero_account_value');
    expect(zero?.count).toBe(2);
  });

  it('SQL ORDER BY locks in the deterministic latest-per-account winner-selection rule', async () => {
    // We cannot exercise PG's DISTINCT ON in a unit test with a mocked pool —
    // assert instead that the SQL we send has the precise ORDER BY clause that
    // makes "latest per account" deterministic in real Postgres. This guards
    // against accidental edits that would silently change the winner-selection
    // rule (e.g., dropping the `id DESC` tie-breaker would make the result
    // unstable when two requests share the same updated_at).
    const pool = makePool({ registryRows: [dbRow()] });
    await buildRegistry(pool);

    const registryCall = pool.calls.find((c) => c.sql.includes('FROM trade_requests tr'));
    const sql = (registryCall?.sql ?? '').replace(/\s+/g, ' ').trim();
    expect(sql).toContain("DISTINCT ON (plan_entry->>'accountNumber')");
    expect(sql).toContain("ORDER BY plan_entry->>'accountNumber' ASC, updated_at DESC, id DESC, ord DESC");
    expect(sql).toContain("status IN ('Approved', 'Completed')");
    expect(sql).toContain("trade_type IN ('Initial Funding', 'Rebalance')");
  });
});
