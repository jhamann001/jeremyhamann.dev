import { describe, it, expect } from 'vitest';
import { compareRegistryToMeridian } from '../registryDrift.js';
import type { MeridianSnapshot } from '../registryDrift.js';
import type { RegistryResponse, RegistryRow } from '../meridianRegistry.js';
import type { HouseholdConfig, HouseholdEntry } from '../householdConfig.js';

function makeHouseholdConfig(entries: HouseholdEntry[]): HouseholdConfig {
  const byAccountNumber = new Map<string, HouseholdEntry>();
  for (const entry of entries) byAccountNumber.set(entry.accountNumber, entry);
  return {
    byAccountNumber,
    householdNames: new Set(entries.map((entry) => entry.householdName)),
    entries,
  };
}

function makeRegistryRow(overrides: Partial<RegistryRow> & Pick<RegistryRow, 'account' | 'weights'>): RegistryRow {
  return {
    owners: [],
    primary_client_id: 'pc',
    primary_client_name: '',
    account_type: 'Taxable',
    live_account_type: null,
    template_name: 'template',
    stored_template_name: 'template',
    model: 'taxable_national',
    risk: 20,
    tolerance_pct: 5,
    residence: 'Other',
    base_allocation_household: { equity: 50, fixed: 40, cash: 10 },
    post_trade_holdings: { cash: 0, fixed: 0, equity: 0 },
    account_value: 100_000,
    equity_breakdown: [],
    residual_pct: 0,
    flags: [],
    source_request_id: 'TR-1',
    as_of: '2026-05-12T00:00:00.000Z',
    ...overrides,
  };
}

function makeRegistry(rows: RegistryRow[]): RegistryResponse {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-12T03:00:00.000Z',
    count: rows.length,
    warnings: [],
    rows,
  };
}

function makeSnapshot(entries: MeridianSnapshot['entries']): MeridianSnapshot {
  return { generatedAt: '2026-05-12T02:00:00.000Z', entries };
}

describe('compareRegistryToMeridian', () => {
  it('flags a household where any per-symbol delta exceeds tolerance', () => {
    const householdConfig = makeHouseholdConfig([
      { accountNumber: '**A1', householdName: 'Big Drift Household', accountTitle: 'A1 title' },
    ]);
    const registry = makeRegistry([makeRegistryRow({ account: '**A1', weights: { SPY: 60, BND: 30, VMFXX: 10 } })]);
    const snapshot = makeSnapshot([{ account: '**A1', weights: { SPY: 50, BND: 30, VMFXX: 20 } }]);

    const result = compareRegistryToMeridian({ registry, snapshot, householdConfig });
    expect(result.households).toHaveLength(1);
    const household = result.households[0];
    expect(household.householdName).toBe('Big Drift Household');
    expect(household.breach).toBe(true);
    expect(household.maxDeltaPct).toBeCloseTo(10, 4);
    expect(household.worstSymbol).toBe('SPY');
  });

  it('does NOT flag households exactly at tolerance (strictly greater-than)', () => {
    const householdConfig = makeHouseholdConfig([{ accountNumber: '**A1', householdName: 'Edge', accountTitle: '' }]);
    const registry = makeRegistry([makeRegistryRow({ account: '**A1', weights: { SPY: 55 } })]);
    const snapshot = makeSnapshot([{ account: '**A1', weights: { SPY: 50 } }]);

    const result = compareRegistryToMeridian({ registry, snapshot, householdConfig, tolerancePct: 5 });
    expect(result.households[0].breach).toBe(false);
  });

  it('aggregates accounts into households and emits the worst-account delta', () => {
    const householdConfig = makeHouseholdConfig([
      { accountNumber: '**A1', householdName: 'Whitaker Family', accountTitle: '' },
      { accountNumber: '**A2', householdName: 'Whitaker Family', accountTitle: '' },
    ]);
    const registry = makeRegistry([
      makeRegistryRow({ account: '**A1', weights: { SPY: 50, BND: 50 } }),
      makeRegistryRow({ account: '**A2', weights: { SPY: 90, BND: 10 } }),
    ]);
    const snapshot = makeSnapshot([
      { account: '**A1', weights: { SPY: 50, BND: 50 } },
      { account: '**A2', weights: { SPY: 60, BND: 40 } },
    ]);

    const result = compareRegistryToMeridian({ registry, snapshot, householdConfig });
    expect(result.households).toHaveLength(1);
    expect(result.households[0].accountCount).toBe(2);
    expect(result.households[0].maxDeltaPct).toBeCloseTo(30, 4);
  });

  it('surfaces unmapped accounts under synthetic __unmapped__ households', () => {
    const householdConfig = makeHouseholdConfig([{ accountNumber: '**A1', householdName: 'Doe', accountTitle: '' }]);
    const registry = makeRegistry([
      makeRegistryRow({ account: '**A1', weights: { SPY: 100 } }),
      makeRegistryRow({ account: '**STRAY', weights: { SPY: 100 } }),
    ]);
    const snapshot = makeSnapshot([{ account: '**A1', weights: { SPY: 100 } }]);

    const result = compareRegistryToMeridian({ registry, snapshot, householdConfig });
    expect(result.unmappedRegistryAccounts).toEqual(['**STRAY']);

    const unmapped = result.households.find((household) => household.householdName.startsWith('__unmapped__:'));
    expect(unmapped).toBeDefined();
    expect(unmapped!.coverageStatus).toBe('unmapped_account');
    expect(unmapped!.breach).toBe(false);
  });

  it('throws when the registry schema version does not match', () => {
    const householdConfig = makeHouseholdConfig([{ accountNumber: '**A1', householdName: 'X', accountTitle: '' }]);
    const registry: RegistryResponse = {
      schemaVersion: 999,
      generatedAt: '2026-05-12T03:00:00.000Z',
      count: 0,
      warnings: [],
      rows: [],
    };
    expect(() => compareRegistryToMeridian({ registry, snapshot: makeSnapshot([]), householdConfig })).toThrow(
      /schemaVersion/,
    );
  });

  it('classifies the unknown ticker case as equity (defensive default; P1 will extend classifier)', () => {
    const householdConfig = makeHouseholdConfig([{ accountNumber: '**A1', householdName: 'P1', accountTitle: '' }]);
    const registry = makeRegistry([makeRegistryRow({ account: '**A1', weights: { 'BRAND-NEW-TICKER': 50, SPY: 50 } })]);
    const snapshot = makeSnapshot([{ account: '**A1', weights: { 'BRAND-NEW-TICKER': 50, SPY: 50 } }]);

    const result = compareRegistryToMeridian({ registry, snapshot, householdConfig });
    const household = result.households[0];
    const details = household.details.accounts[0];
    expect(details.perBucketDelta.equity).toBeDefined();
    expect(details.perBucketDelta.equity!.engine).toBeCloseTo(100, 4);
    expect(household.breach).toBe(false);
  });

  it('handles engine_only and meridian_only coverage gaps', () => {
    const householdConfig = makeHouseholdConfig([
      { accountNumber: '**ENG', householdName: 'EngineOnly', accountTitle: '' },
      { accountNumber: '**ALP', householdName: 'AlphaOnly', accountTitle: '' },
    ]);
    const registry = makeRegistry([makeRegistryRow({ account: '**ENG', weights: { SPY: 100 } })]);
    const snapshot = makeSnapshot([{ account: '**ALP', weights: { SPY: 100 } }]);

    const result = compareRegistryToMeridian({ registry, snapshot, householdConfig });
    const engineOnly = result.households.find((household) => household.householdName === 'EngineOnly')!;
    const alphaOnly = result.households.find((household) => household.householdName === 'AlphaOnly')!;
    expect(engineOnly.coverageStatus).toBe('engine_only');
    expect(engineOnly.breach).toBe(true);
    expect(alphaOnly.coverageStatus).toBe('meridian_only');
    expect(alphaOnly.breach).toBe(true);
  });
});
