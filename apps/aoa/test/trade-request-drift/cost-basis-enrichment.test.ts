import { describe, it, expect } from 'vitest';
import {
  enrichAccountsWithCostBasis,
  mergeOpenLotRows,
  mergeOpenLots,
  type OpenLot,
  type RawLotRow,
} from '@/lib/trade-requests/sources/cost-basis-enrichment';
import type { AccountPositions } from '@/lib/trade-requests/sources/warehouse';

function raw(partial: Partial<RawLotRow> & { openLotId: string; processDate: string }): RawLotRow {
  return {
    openLotId: partial.openLotId,
    openClosedIndicator: partial.openClosedIndicator ?? 'OPEN',
    processDate: partial.processDate,
    gluerun: partial.gluerun ?? null,
    accountId: partial.accountId ?? 'A1',
    symbol: partial.symbol ?? 'X',
    quantity: partial.quantity ?? 1,
    costBasisUsd: partial.costBasisUsd ?? 0,
    term: partial.term ?? 'long',
    acquisitionEventType: partial.acquisitionEventType ?? 'BUY',
    isTransferExternal: partial.isTransferExternal ?? false,
    missingBasis: partial.missingBasis ?? false,
    washSaleAdjustmentUsd: partial.washSaleAdjustmentUsd ?? 0,
  };
}

function acct(partial: Partial<AccountPositions> & { accountId: string }): AccountPositions {
  const positionsBySymbol = partial.positionsBySymbol ?? {};
  const positionsTotal = partial.positionsTotal ?? Object.values(positionsBySymbol).reduce((s, v) => s + v, 0);
  return {
    accountId: partial.accountId,
    positionsTotal,
    totalEquity: partial.totalEquity ?? positionsTotal + (partial.cashEquity ?? 0),
    cashEquity: partial.cashEquity ?? 0,
    positionsBySymbol,
    businessDate: partial.businessDate ?? '2026-06-01',
    ...(partial.cashEquivalentSymbols ? { cashEquivalentSymbols: partial.cashEquivalentSymbols } : {}),
  };
}

function lot(partial: Partial<OpenLot> & { accountId: string; symbol: string }): OpenLot {
  return {
    accountId: partial.accountId,
    symbol: partial.symbol,
    quantity: partial.quantity ?? 1,
    costBasisUsd: partial.costBasisUsd ?? 0,
    term: partial.term ?? 'long',
    acquisitionEventType: partial.acquisitionEventType ?? 'BUY',
    isTransferExternal: partial.isTransferExternal ?? false,
    missingBasis: partial.missingBasis ?? false,
    washSaleAdjustmentUsd: partial.washSaleAdjustmentUsd ?? 0,
  };
}

describe('enrichAccountsWithCostBasis', () => {
  it('computes unrealized gain for a single long lot anchored to market value', () => {
    const positions = new Map([['A1', acct({ accountId: 'A1', positionsBySymbol: { NVDA: 1000 } })]]);
    const lots = [lot({ accountId: 'A1', symbol: 'NVDA', quantity: 10, costBasisUsd: 700, term: 'long' })];

    const result = enrichAccountsWithCostBasis(positions, lots).get('A1')!;

    expect(result.symbols).toHaveLength(1);
    const s = result.symbols[0];
    expect(s.marketValueUsd).toBe(1000);
    expect(s.costBasisUsd).toBe(700);
    expect(s.unrealizedGainUsd).toBe(300);
    expect(s.unrealizedLongTermGainUsd).toBe(300);
    expect(s.unrealizedShortTermGainUsd).toBe(0);
    expect(result.unrealizedGainUsd).toBe(300);
    expect(result.basisCoveragePct).toBe(100);
  });

  it('splits unrealized gain across short- and long-term lots by quantity', () => {
    // 20 shares total, MV 2000 → $100/share. LT lot: 10sh basis 500 → MV 1000, gain 500.
    // ST lot: 10sh basis 1200 → MV 1000, gain -200.
    const positions = new Map([['A1', acct({ accountId: 'A1', positionsBySymbol: { TSM: 2000 } })]]);
    const lots = [
      lot({ accountId: 'A1', symbol: 'TSM', quantity: 10, costBasisUsd: 500, term: 'long' }),
      lot({ accountId: 'A1', symbol: 'TSM', quantity: 10, costBasisUsd: 1200, term: 'short' }),
    ];

    const s = enrichAccountsWithCostBasis(positions, lots).get('A1')!.symbols[0];
    expect(s.unrealizedLongTermGainUsd).toBe(500);
    expect(s.unrealizedShortTermGainUsd).toBe(-200);
    expect(s.unrealizedGainUsd).toBe(300); // 2000 - (500+1200)
  });

  it('attributes transfer-in market value by lot quantity share', () => {
    // 100 shares, MV 5000 → $50/share. 60 shares are TRANSFER_EXTERNAL → $3000 transfer-in.
    const positions = new Map([['A1', acct({ accountId: 'A1', positionsBySymbol: { WDC: 5000 } })]]);
    const lots = [
      lot({ accountId: 'A1', symbol: 'WDC', quantity: 60, costBasisUsd: 600, isTransferExternal: true }),
      lot({ accountId: 'A1', symbol: 'WDC', quantity: 40, costBasisUsd: 1800, isTransferExternal: false }),
    ];

    const result = enrichAccountsWithCostBasis(positions, lots).get('A1')!;
    expect(result.symbols[0].transferInValueUsd).toBe(3000);
    expect(result.symbols[0].transferInPct).toBe(60);
    expect(result.transferInValueUsd).toBe(3000);
    expect(result.transferInPct).toBe(60); // 3000 / 5000 investable
  });

  it('anchors to current market value when a position was partially sold (MV < lot total)', () => {
    // Lots say 10 shares basis 700, but only 600 MV remains (half sold, price unchanged).
    // mvPerShare = 600/10 = 60; gain = 600 - 700 = -100. Anchored to held MV, not lot total.
    const positions = new Map([['A1', acct({ accountId: 'A1', positionsBySymbol: { X: 600 } })]]);
    const lots = [lot({ accountId: 'A1', symbol: 'X', quantity: 10, costBasisUsd: 700 })];

    const s = enrichAccountsWithCostBasis(positions, lots).get('A1')!.symbols[0];
    expect(s.marketValueUsd).toBe(600);
    expect(s.unrealizedGainUsd).toBe(-100);
  });

  it('treats a held symbol with no lots as a coverage miss (not enriched)', () => {
    const positions = new Map([['A1', acct({ accountId: 'A1', positionsBySymbol: { AAPL: 1000, MSFT: 500 } })]]);
    const lots = [lot({ accountId: 'A1', symbol: 'AAPL', quantity: 5, costBasisUsd: 800 })];

    const result = enrichAccountsWithCostBasis(positions, lots).get('A1')!;
    expect(result.symbols.map((s) => s.symbol)).toEqual(['AAPL']);
    // Coverage = enriched MV (1000) / investable (1500).
    expect(result.basisCoveragePct).toBeCloseTo(66.6667, 3);
  });

  it('emits an entry for an all-cash account with zero enriched symbols', () => {
    const positions = new Map([['A1', acct({ accountId: 'A1', positionsBySymbol: {}, cashEquity: 5000 })]]);
    const result = enrichAccountsWithCostBasis(positions, []).get('A1')!;
    expect(result.symbols).toHaveLength(0);
    expect(result.investableValueUsd).toBe(0);
    expect(result.basisCoveragePct).toBe(0);
    expect(result.unrealizedGainUsd).toBe(0);
  });

  it('skips symbols whose lots sum to zero quantity (no anchor)', () => {
    const positions = new Map([['A1', acct({ accountId: 'A1', positionsBySymbol: { Z: 100 } })]]);
    const lots = [lot({ accountId: 'A1', symbol: 'Z', quantity: 0, costBasisUsd: 50 })];
    const result = enrichAccountsWithCostBasis(positions, lots).get('A1')!;
    expect(result.symbols).toHaveLength(0);
  });

  it('propagates missing-basis and wash-sale flags up to the account', () => {
    const positions = new Map([['A1', acct({ accountId: 'A1', positionsBySymbol: { Q: 200 } })]]);
    const lots = [
      lot({
        accountId: 'A1',
        symbol: 'Q',
        quantity: 4,
        costBasisUsd: 0,
        missingBasis: true,
        washSaleAdjustmentUsd: 12,
      }),
    ];
    const result = enrichAccountsWithCostBasis(positions, lots).get('A1')!;
    expect(result.hasMissingBasis).toBe(true);
    expect(result.symbols[0].hasMissingBasis).toBe(true);
    expect(result.symbols[0].hasWashSaleAdjustment).toBe(true);
  });

  it('sorts symbols by absolute unrealized gain descending', () => {
    const positions = new Map([
      ['A1', acct({ accountId: 'A1', positionsBySymbol: { SMALL: 1000, BIG: 1000, LOSS: 1000 } })],
    ]);
    const lots = [
      lot({ accountId: 'A1', symbol: 'SMALL', quantity: 10, costBasisUsd: 950 }), // +50
      lot({ accountId: 'A1', symbol: 'BIG', quantity: 10, costBasisUsd: 100 }), // +900
      lot({ accountId: 'A1', symbol: 'LOSS', quantity: 10, costBasisUsd: 1500 }), // -500
    ];
    const result = enrichAccountsWithCostBasis(positions, lots).get('A1')!;
    expect(result.symbols.map((s) => s.symbol)).toEqual(['BIG', 'LOSS', 'SMALL']);
  });

  it('only iterates accounts present in the positions feed (no leaks from stale lots)', () => {
    const positions = new Map([['A1', acct({ accountId: 'A1', positionsBySymbol: { X: 100 } })]]);
    const lots = [
      lot({ accountId: 'A1', symbol: 'X', quantity: 1, costBasisUsd: 90 }),
      lot({ accountId: 'GHOST', symbol: 'Y', quantity: 1, costBasisUsd: 10 }),
    ];
    const result = enrichAccountsWithCostBasis(positions, lots);
    expect([...result.keys()]).toEqual(['A1']);
  });
});

describe('mergeOpenLots', () => {
  it('keeps the latest full snapshot and unions daily deltas dated after it', () => {
    const full = [
      raw({ openLotId: 'old', processDate: '2026-05-22', symbol: 'A' }), // older snapshot — dropped
      raw({ openLotId: 'L1', processDate: '2026-05-29', symbol: 'B' }),
      raw({ openLotId: 'L2', processDate: '2026-05-29', symbol: 'C' }),
    ];
    const daily = [
      raw({ openLotId: 'L3', processDate: '2026-06-02', symbol: 'D' }), // after snapshot — kept
      raw({ openLotId: 'L4', processDate: '2026-05-20', symbol: 'E' }), // before snapshot — dropped
    ];
    const merged = mergeOpenLots(full, daily);
    expect(merged.lots.map((l) => l.symbol).sort()).toEqual(['B', 'C', 'D']);
  });

  it('excludes CLOSED lots from both sides', () => {
    const full = [
      raw({ openLotId: 'L1', processDate: '2026-05-29', symbol: 'OPENONE' }),
      raw({ openLotId: 'L2', processDate: '2026-05-29', symbol: 'CLOSEDONE', openClosedIndicator: 'CLOSED' }),
    ];
    const daily = [
      raw({ openLotId: 'L3', processDate: '2026-06-02', symbol: 'CLOSEDTWO', openClosedIndicator: 'CLOSED' }),
    ];
    const merged = mergeOpenLots(full, daily);
    expect(merged.lots.map((l) => l.symbol)).toEqual(['OPENONE']);
  });

  it('dedups by open_lot_id keeping the latest process_date', () => {
    const full = [raw({ openLotId: 'L1', processDate: '2026-05-29', costBasisUsd: 100 })];
    const daily = [raw({ openLotId: 'L1', processDate: '2026-06-02', costBasisUsd: 175 })];
    const merged = mergeOpenLots(full, daily);
    expect(merged.lots).toHaveLength(1);
    expect(merged.lots[0].costBasisUsd).toBe(175);
  });

  it('derives per-table freshness (process_date + gluerundatetime) from raw rows', () => {
    const full = [
      raw({ openLotId: 'L1', processDate: '2026-05-29', gluerun: '2026-05-30T11:02:00-04:00' }),
      raw({ openLotId: 'old', processDate: '2026-05-22', gluerun: '2026-05-23T11:02:00-04:00' }),
    ];
    const daily = [raw({ openLotId: 'L3', processDate: '2026-06-03', gluerun: '2026-06-04T11:02:00-04:00' })];
    const merged = mergeOpenLots(full, daily);
    expect(merged.fullRefreshLatest).toBe('2026-05-29');
    expect(merged.dailyRefreshLatest).toBe('2026-06-03');
    expect(merged.fullGlueRunLatest).toBe('2026-05-30T11:02:00-04:00');
    expect(merged.dailyGlueRunLatest).toBe('2026-06-04T11:02:00-04:00');
  });

  it('returns null freshness and no lots for empty inputs', () => {
    const merged = mergeOpenLots([], []);
    expect(merged.lots).toEqual([]);
    expect(merged.fullRefreshLatest).toBeNull();
    expect(merged.dailyRefreshLatest).toBeNull();
  });
});

describe('enrichAccountsWithCostBasis — cash equivalents (money-market funds)', () => {
  it('values an MMF at NAV with zero gain when the feed has no lots for it', () => {
    // The production case: ~$1.56M of MMF market value against $52 of MMF lots.
    const positions = new Map([
      [
        'A1',
        acct({
          accountId: 'A1',
          positionsBySymbol: { SWVXX: 15_473 },
          cashEquivalentSymbols: new Set(['SWVXX']),
        }),
      ],
    ]);

    const result = enrichAccountsWithCostBasis(positions, []).get('A1')!;

    expect(result.symbols).toHaveLength(1);
    const s = result.symbols[0];
    expect(s.symbol).toBe('SWVXX');
    expect(s.marketValueUsd).toBe(15_473);
    expect(s.costBasisUsd).toBe(15_473);
    expect(s.unrealizedGainUsd).toBe(0);
    expect(s.unrealizedShortTermGainUsd).toBe(0);
    expect(s.unrealizedLongTermGainUsd).toBe(0);
    expect(s.lotCount).toBe(0);
    expect(s.isCashEquivalent).toBe(true);
    expect(s.hasMissingBasis).toBe(false);
  });

  it('reads 100% basis coverage for an all-MMF account instead of 0%', () => {
    // Before this change three real accounts rendered "basis coverage: 0%",
    // which read as broken data rather than "there is no basis to have".
    const positions = new Map([
      [
        'A1',
        acct({
          accountId: 'A1',
          positionsBySymbol: { VMSXX: 135_400 },
          cashEquivalentSymbols: new Set(['VMSXX']),
        }),
      ],
    ]);

    const result = enrichAccountsWithCostBasis(positions, []).get('A1')!;

    expect(result.basisCoveragePct).toBe(100);
    expect(result.cashEquivalentValueUsd).toBe(135_400);
    expect(result.unrealizedGainUsd).toBe(0);
    // No securities at all → transfer-in ratio is undefined, reported as 0.
    expect(result.transferInPct).toBe(0);
  });

  it('excludes MMF from the transfer-in denominator', () => {
    // $50k of fully-transferred-in stock + $50k parked in a sweep fund. The
    // securities book is 100% transferred in; counting the sweep would halve it
    // to 50% and could drop the account below the 25% transition threshold.
    const positions = new Map([
      [
        'A1',
        acct({
          accountId: 'A1',
          positionsBySymbol: { AAPL: 50_000, SWVXX: 50_000 },
          cashEquivalentSymbols: new Set(['SWVXX']),
        }),
      ],
    ]);
    const lots = [
      lot({
        accountId: 'A1',
        symbol: 'AAPL',
        quantity: 100,
        costBasisUsd: 20_000,
        isTransferExternal: true,
        acquisitionEventType: 'TRANSFER_EXTERNAL',
      }),
    ];

    const result = enrichAccountsWithCostBasis(positions, lots).get('A1')!;

    expect(result.investableValueUsd).toBe(100_000);
    expect(result.cashEquivalentValueUsd).toBe(50_000);
    expect(result.transferInValueUsd).toBe(50_000);
    expect(result.transferInPct).toBe(100);
    expect(result.basisCoveragePct).toBe(100);
    // Only the equity carries gain; the MMF contributes exactly nothing.
    expect(result.unrealizedGainUsd).toBe(30_000);
  });

  it('does NOT invent phantom gain from a stale partial MMF lot', () => {
    // The landmine: $10,000 of a $1.00-NAV fund backed by a stale 52-share lot.
    // Prorating market value across lot quantity would imply $192/share and
    // ~$9,948 of unrealized gain on an instrument that cannot appreciate.
    const positions = new Map([
      [
        'A1',
        acct({
          accountId: 'A1',
          positionsBySymbol: { VMSXX: 10_000 },
          cashEquivalentSymbols: new Set(['VMSXX']),
        }),
      ],
    ]);
    const lots = [lot({ accountId: 'A1', symbol: 'VMSXX', quantity: 52, costBasisUsd: 52 })];

    const result = enrichAccountsWithCostBasis(positions, lots).get('A1')!;

    expect(result.symbols[0].unrealizedGainUsd).toBe(0);
    expect(result.symbols[0].costBasisUsd).toBe(10_000);
    expect(result.unrealizedGainUsd).toBe(0);
  });

  it('leaves accounts without the discriminator columns behaving exactly as before', () => {
    // Back-compat: a narrowed stock-record question yields no
    // cashEquivalentSymbols, so MMFs stay coverage misses as they were.
    const positions = new Map([['A1', acct({ accountId: 'A1', positionsBySymbol: { SWVXX: 1_000, NVDA: 1_000 } })]]);
    const lots = [lot({ accountId: 'A1', symbol: 'NVDA', quantity: 10, costBasisUsd: 600 })];

    const result = enrichAccountsWithCostBasis(positions, lots).get('A1')!;

    expect(result.symbols.map((s) => s.symbol)).toEqual(['NVDA']);
    expect(result.cashEquivalentValueUsd).toBe(0);
    expect(result.basisCoveragePct).toBe(50);
    expect(result.transferInPct).toBe(0);
  });

  it('sorts zero-gain cash equivalents below real movers', () => {
    const positions = new Map([
      [
        'A1',
        acct({
          accountId: 'A1',
          positionsBySymbol: { SWVXX: 90_000, NVDA: 10_000 },
          cashEquivalentSymbols: new Set(['SWVXX']),
        }),
      ],
    ]);
    const lots = [lot({ accountId: 'A1', symbol: 'NVDA', quantity: 10, costBasisUsd: 1_000 })];

    const result = enrichAccountsWithCostBasis(positions, lots).get('A1')!;

    expect(result.symbols.map((s) => s.symbol)).toEqual(['NVDA', 'SWVXX']);
  });
});

describe('mergeOpenLotRows (multi-source)', () => {
  it('keeps one row per open_lot_id, newest process_date winning', () => {
    // Same lot from two warehouse sources at different snapshot dates.
    const rows = [
      raw({ openLotId: 'L1', processDate: '2026-08-21', quantity: 10, costBasisUsd: 100 }),
      raw({ openLotId: 'L1', processDate: '2026-08-26', quantity: 4, costBasisUsd: 40 }),
    ];
    const merged = mergeOpenLotRows(rows);
    expect(merged).toHaveLength(1);
    expect(merged[0].quantity).toBe(4);
    expect(merged[0].costBasisUsd).toBe(40);
  });

  it('is idempotent when two sources carry identical rows', () => {
    // Production shape on 2026-08-27: db 4 and db 101 both held the same
    // 08-22..08-25 deltas; only db 4 had 08-26.
    const shared = [
      raw({ openLotId: 'A', processDate: '2026-08-22' }),
      raw({ openLotId: 'B', processDate: '2026-08-25' }),
    ];
    const dbFourOnly = [raw({ openLotId: 'C', processDate: '2026-08-26' })];
    const merged = mergeOpenLotRows([...shared, ...shared, ...dbFourOnly]);
    expect(merged.map((l) => l.symbol)).toHaveLength(3);
  });

  it('drops non-OPEN rows regardless of source', () => {
    const merged = mergeOpenLotRows([
      raw({ openLotId: 'OPEN1', processDate: '2026-08-26' }),
      raw({ openLotId: 'CLOSED1', processDate: '2026-08-26', openClosedIndicator: 'CLOSED' }),
    ]);
    expect(merged).toHaveLength(1);
  });

  it('returns an empty array for no input', () => {
    expect(mergeOpenLotRows([])).toEqual([]);
  });

  it('combines a baseline snapshot with deltas layered on top', () => {
    // Baseline lot X unchanged; lot Y superseded by a later delta; lot Z is new.
    const baseline = [
      raw({ openLotId: 'X', processDate: '2026-08-21', quantity: 1 }),
      raw({ openLotId: 'Y', processDate: '2026-08-21', quantity: 1 }),
    ];
    const deltas = [
      raw({ openLotId: 'Y', processDate: '2026-08-26', quantity: 9 }),
      raw({ openLotId: 'Z', processDate: '2026-08-26', quantity: 5 }),
    ];
    const merged = mergeOpenLotRows([...baseline, ...deltas]);
    expect(merged).toHaveLength(3);
    const byQty = merged.map((l) => l.quantity).sort((a, b) => a - b);
    expect(byQty).toEqual([1, 5, 9]);
  });
});
