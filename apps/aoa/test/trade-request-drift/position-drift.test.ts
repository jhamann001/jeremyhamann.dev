import { describe, it, expect } from 'vitest';
import { comparePositionsToMeridian, SETTLEMENT_CASH_SYMBOL_FOR_TESTS } from '@/lib/trade-requests/drift/position-drift';
import type { MeridianSnapshot } from '@/lib/trade-requests/sources/meridian-snapshot';
import type { AccountPositions } from '@/lib/trade-requests/sources/warehouse';
import type { HouseholdConfig, HouseholdEntry } from '@/lib/trade-requests/sources/household-config';

function makeHouseholdConfig(entries: HouseholdEntry[]): HouseholdConfig {
  const byAccountNumber = new Map<string, HouseholdEntry>();
  for (const entry of entries) byAccountNumber.set(entry.accountNumber, entry);
  return {
    byAccountNumber,
    householdNames: new Set(entries.map((entry) => entry.householdName)),
    entries,
  };
}

function makePositions(entries: AccountPositions[]): Map<string, AccountPositions> {
  const map = new Map<string, AccountPositions>();
  for (const entry of entries) map.set(entry.accountId, entry);
  return map;
}

function makeSnapshot(entries: MeridianSnapshot['entries']): MeridianSnapshot {
  return { generatedAt: '2026-05-12T02:00:00.000Z', entries };
}

function position(overrides: Partial<AccountPositions> & Pick<AccountPositions, 'accountId'>): AccountPositions {
  return {
    positionsTotal: 0,
    totalEquity: 100,
    cashEquity: 0,
    positionsBySymbol: {},
    businessDate: '2026-05-12',
    ...overrides,
  };
}

describe('comparePositionsToMeridian', () => {
  it('flags a household where any per-bucket delta exceeds tolerance', () => {
    // Position side: 60% AAPL (equity), 30% BND (fixed), 10% cashEquity (cash).
    // Template side: 50% SPY (equity), 30% BND (fixed), 20% SWVXX (cash sweep).
    // Bucket totals (position vs template): equity 60 vs 50 (delta 10),
    //   fixed 30 vs 30 (delta 0), cash 10 vs 20 (delta 10).
    // Worst bucket delta = 10 > 5 tolerance → breach.
    const householdConfig = makeHouseholdConfig([
      { accountNumber: '**A1', householdName: 'Big Drift Household', accountTitle: 'A1 title' },
    ]);
    const positions = makePositions([
      position({
        accountId: '**A1',
        totalEquity: 100,
        cashEquity: 10,
        positionsBySymbol: { AAPL: 60, BND: 30 },
        positionsTotal: 90,
      }),
    ]);
    const snapshot = makeSnapshot([{ account: '**A1', weights: { SPY: 50, BND: 30, SWVXX: 20 } }]);

    const result = comparePositionsToMeridian({ positions, snapshot, householdConfig });
    expect(result.households).toHaveLength(1);
    const household = result.households[0];
    expect(household.householdName).toBe('Big Drift Household');
    expect(household.breach).toBe(true);
    expect(household.maxDeltaPct).toBeCloseTo(10, 4);
    expect(household.worstSymbol === 'equity' || household.worstSymbol === 'cash').toBe(true);
  });

  it('does NOT flag households exactly at tolerance (strictly greater-than)', () => {
    // Equity bucket delta exactly 5; cash bucket delta exactly 5; fixed = 0.
    // tolerancePct = 5 → breach=false (strictly greater-than required).
    const householdConfig = makeHouseholdConfig([{ accountNumber: '**A1', householdName: 'Edge', accountTitle: '' }]);
    const positions = makePositions([
      position({
        accountId: '**A1',
        totalEquity: 100,
        cashEquity: 5,
        positionsBySymbol: { AAPL: 95 },
        positionsTotal: 95,
      }),
    ]);
    const snapshot = makeSnapshot([{ account: '**A1', weights: { AAPL: 90, SWVXX: 10 } }]);

    const result = comparePositionsToMeridian({ positions, snapshot, householdConfig, tolerancePct: 5 });
    expect(result.households[0].breach).toBe(false);
    expect(result.households[0].maxDeltaPct).toBeCloseTo(5, 4);
  });

  it('aggregates accounts into households and emits the worst-bucket household max', () => {
    const householdConfig = makeHouseholdConfig([
      { accountNumber: '**A1', householdName: 'Bogisich Family', accountTitle: '' },
      { accountNumber: '**A2', householdName: 'Bogisich Family', accountTitle: '' },
    ]);
    const positions = makePositions([
      // **A1: bucket totals match template exactly → 0 delta.
      position({
        accountId: '**A1',
        totalEquity: 100,
        cashEquity: 0,
        positionsBySymbol: { AAPL: 50, BND: 50 },
        positionsTotal: 100,
      }),
      // **A2: 90% equity vs 60% template → 30 equity-bucket delta.
      position({
        accountId: '**A2',
        totalEquity: 100,
        cashEquity: 0,
        positionsBySymbol: { AAPL: 90, BND: 10 },
        positionsTotal: 100,
      }),
    ]);
    const snapshot = makeSnapshot([
      { account: '**A1', weights: { AAPL: 50, BND: 50 } },
      { account: '**A2', weights: { AAPL: 60, BND: 40 } },
    ]);

    const result = comparePositionsToMeridian({ positions, snapshot, householdConfig });
    expect(result.households).toHaveLength(1);
    expect(result.households[0].accountCount).toBe(2);
    expect(result.households[0].maxDeltaPct).toBeCloseTo(30, 4);
    // **A2 has equity 90 vs 60 (delta 30) AND fixed 10 vs 40 (delta 30).
    // Strict-greater comparison picks the first-seen bucket → 'fixed'
    // (cash/fixed/equity iteration order); either is acceptable as the
    // "worst" since the bucket magnitudes are tied.
    expect(['fixed', 'equity']).toContain(result.households[0].worstSymbol);
  });

  it('surfaces unmapped accounts under synthetic __unmapped__ households', () => {
    const householdConfig = makeHouseholdConfig([{ accountNumber: '**A1', householdName: 'Doe', accountTitle: '' }]);
    const positions = makePositions([
      position({
        accountId: '**A1',
        totalEquity: 100,
        cashEquity: 0,
        positionsBySymbol: { AAPL: 100 },
        positionsTotal: 100,
      }),
      position({
        accountId: '**STRAY',
        totalEquity: 100,
        cashEquity: 0,
        positionsBySymbol: { AAPL: 100 },
        positionsTotal: 100,
      }),
    ]);
    const snapshot = makeSnapshot([{ account: '**A1', weights: { AAPL: 100 } }]);

    const result = comparePositionsToMeridian({ positions, snapshot, householdConfig });
    expect(result.unmappedPositionsAccounts).toEqual(['**STRAY']);

    const unmapped = result.households.find((household) => household.householdName.startsWith('__unmapped__:'));
    expect(unmapped).toBeDefined();
    expect(unmapped!.coverageStatus).toBe('unmapped_account');
    expect(unmapped!.breach).toBe(false);
  });

  it('preserves per-symbol delta drilldown for every symbol on either side', () => {
    const householdConfig = makeHouseholdConfig([
      { accountNumber: '**A1', householdName: 'Drilldown', accountTitle: '' },
    ]);
    const positions = makePositions([
      position({
        accountId: '**A1',
        totalEquity: 100,
        cashEquity: 0,
        // 60% AAPL, 30% MSFT, 10% BND
        positionsBySymbol: { AAPL: 60, MSFT: 30, BND: 10 },
        positionsTotal: 100,
      }),
    ]);
    const snapshot = makeSnapshot([{ account: '**A1', weights: { AAPL: 50, MSFT: 30, GOOG: 10, SWVXX: 10 } }]);

    const result = comparePositionsToMeridian({ positions, snapshot, householdConfig });
    const account = result.households[0].details.accounts[0];

    // Union of symbols on either side; AAPL is on both → delta = |60 - 50| = 10.
    expect(account.perSymbolDelta.AAPL).toEqual({ positions: 60, meridian: 50, delta: 10 });
    // MSFT is identical on both sides.
    expect(account.perSymbolDelta.MSFT).toEqual({ positions: 30, meridian: 30, delta: 0 });
    // BND only on position side.
    expect(account.perSymbolDelta.BND).toEqual({ positions: 10, meridian: 0, delta: 10 });
    // GOOG only on template side.
    expect(account.perSymbolDelta.GOOG).toEqual({ positions: 0, meridian: 10, delta: 10 });
    // SWVXX only on template side.
    expect(account.perSymbolDelta.SWVXX).toEqual({ positions: 0, meridian: 10, delta: 10 });
  });

  it('routes cashEquity into the cash bucket and surfaces __SETTLEMENT_CASH__ in the per-symbol drilldown', () => {
    // Position side: cashEquity=$25k (25%), AAPL=$50k (50% equity), SWVXX=$25k (25% cash via classifySymbol).
    // Cash bucket = 25 (cashEquity) + 25 (SWVXX cash-sweep) = 50.
    // Template: SWVXX=50 cash, AAPL=50 equity → bucket cash=50, equity=50.
    // → All bucket deltas = 0; perSymbolDelta surfaces __SETTLEMENT_CASH__ at 25%.
    const householdConfig = makeHouseholdConfig([
      { accountNumber: '**A1', householdName: 'CashCheck', accountTitle: '' },
    ]);
    const positions = makePositions([
      position({
        accountId: '**A1',
        totalEquity: 100_000,
        cashEquity: 25_000,
        positionsBySymbol: { AAPL: 50_000, SWVXX: 25_000 },
        positionsTotal: 75_000,
      }),
    ]);
    const snapshot = makeSnapshot([{ account: '**A1', weights: { AAPL: 50, SWVXX: 50 } }]);

    const result = comparePositionsToMeridian({ positions, snapshot, householdConfig });
    const account = result.households[0].details.accounts[0];

    // Cash bucket = settlement cash (25%) + SWVXX cash-sweep (25%) = 50%.
    expect(account.perBucketDelta.cash).toEqual({ positions: 50, meridian: 50, delta: 0 });
    expect(account.perBucketDelta.equity).toEqual({ positions: 50, meridian: 50, delta: 0 });
    // Per-symbol drilldown carries the synthetic settlement-cash entry.
    expect(account.perSymbolDelta[SETTLEMENT_CASH_SYMBOL_FOR_TESTS]).toEqual({
      positions: 25,
      meridian: 0,
      delta: 25,
    });
    // Headline household max picks up the per-bucket max (which is 0 here).
    expect(result.households[0].maxDeltaPct).toBeCloseTo(0, 4);
  });

  it('handles positions_only and template_only coverage gaps with the larger-side clamp', () => {
    const householdConfig = makeHouseholdConfig([
      { accountNumber: '**POS', householdName: 'PositionsOnly', accountTitle: '' },
      { accountNumber: '**TPL', householdName: 'TemplateOnly', accountTitle: '' },
    ]);
    const positions = makePositions([
      position({
        accountId: '**POS',
        totalEquity: 100,
        cashEquity: 0,
        positionsBySymbol: { AAPL: 100 },
        positionsTotal: 100,
      }),
    ]);
    const snapshot = makeSnapshot([{ account: '**TPL', weights: { AAPL: 100 } }]);

    const result = comparePositionsToMeridian({ positions, snapshot, householdConfig });
    const positionsOnly = result.households.find((household) => household.householdName === 'PositionsOnly')!;
    const templateOnly = result.households.find((household) => household.householdName === 'TemplateOnly')!;

    expect(positionsOnly.coverageStatus).toBe('engine_only'); // repurposed to mean positions_only
    expect(positionsOnly.breach).toBe(true);
    expect(positionsOnly.details.accounts[0].coverage).toBe('positions_only');
    // Larger-side clamp: 100% equity on the position side with no template.
    expect(positionsOnly.maxDeltaPct).toBeCloseTo(100, 4);

    expect(templateOnly.coverageStatus).toBe('meridian_only'); // repurposed to mean template_only
    expect(templateOnly.breach).toBe(true);
    expect(templateOnly.details.accounts[0].coverage).toBe('template_only');
    expect(templateOnly.maxDeltaPct).toBeCloseTo(100, 4);
  });

  it('classifies unknown tickers as equity (defensive) but routes __SETTLEMENT_CASH__ to cash regardless', () => {
    // BRAND-NEW-TICKER unknown to instruments.ts → defaults to equity bucket.
    // The synthetic __SETTLEMENT_CASH__ entry is hard-routed to cash even
    // though classifySymbol would return equity for it.
    const householdConfig = makeHouseholdConfig([
      { accountNumber: '**A1', householdName: 'UnknownTicker', accountTitle: '' },
    ]);
    const positions = makePositions([
      position({
        accountId: '**A1',
        totalEquity: 100,
        cashEquity: 30,
        positionsBySymbol: { 'BRAND-NEW-TICKER': 70 },
        positionsTotal: 70,
      }),
    ]);
    // Template side mirrors the position side EXACTLY in bucket terms:
    //   equity = 70 (the same unknown ticker → equity by default)
    //   cash   = 30 (templated as a cash sweep symbol → cash bucket)
    // so per-bucket deltas are all 0.
    const snapshot = makeSnapshot([{ account: '**A1', weights: { 'BRAND-NEW-TICKER': 70, SWVXX: 30 } }]);

    const result = comparePositionsToMeridian({ positions, snapshot, householdConfig });
    const account = result.households[0].details.accounts[0];

    // Unknown ticker → equity bucket (defensive default).
    expect(account.perBucketDelta.equity).toEqual({ positions: 70, meridian: 70, delta: 0 });
    // cashEquity → cash bucket via the hard-coded route, NOT via classifySymbol
    // (which would default __SETTLEMENT_CASH__ to equity).
    expect(account.perBucketDelta.cash).toEqual({ positions: 30, meridian: 30, delta: 0 });
    expect(result.households[0].breach).toBe(false);
  });

  it('produces well-formed output even when input balances do not reconcile (mismatch surfaced upstream by warehouse.fetchAccountPositions)', () => {
    // Plan §5.C step 9 places the `drift_balance_mismatch` warn inside
    // warehouse.ts:fetchAccountPositions (where the input is fetched);
    // the warn-firing test lives in warehouse.test.ts. This case asserts
    // that comparePositionsToMeridian does NOT crash or emit nonsense
    // when handed a row whose cashEquity + Σ stockRecord materially diverges
    // from totalEquity (e.g. 50% gap) — bucket math just reflects whatever
    // weights the inputs imply.
    const householdConfig = makeHouseholdConfig([
      { accountNumber: '**A1', householdName: 'Mismatch', accountTitle: '' },
    ]);
    const positions = makePositions([
      // cashEquity (10) + stockRecord (40) = 50, but totalEquity = 100.
      // Weights compute against 100 → 10% cash + 40% equity = 50%; the rest
      // is implicitly "missing" relative to the denominator.
      position({
        accountId: '**A1',
        totalEquity: 100,
        cashEquity: 10,
        positionsBySymbol: { AAPL: 40 },
        positionsTotal: 40,
      }),
    ]);
    const snapshot = makeSnapshot([{ account: '**A1', weights: { AAPL: 100 } }]);

    const result = comparePositionsToMeridian({ positions, snapshot, householdConfig });
    expect(result.households).toHaveLength(1);
    const household = result.households[0];
    // Equity bucket: position 40 vs template 100 → delta 60.
    expect(household.details.accounts[0].perBucketDelta.equity).toEqual({
      positions: 40,
      meridian: 100,
      delta: 60,
    });
    // Cash bucket: position 10 vs template 0 → delta 10.
    expect(household.details.accounts[0].perBucketDelta.cash).toEqual({
      positions: 10,
      meridian: 0,
      delta: 10,
    });
    // Worst bucket = equity, magnitude 60.
    expect(household.maxDeltaPct).toBeCloseTo(60, 4);
    expect(household.worstSymbol).toBe('equity');
  });
});
