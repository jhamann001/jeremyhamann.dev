import { describe, it, expect } from 'vitest';
import { computeSectorAllocation } from '@/lib/trade-requests/drift/sector-allocation';
import type { SecurityClassification } from '@/lib/trade-requests/sources/security-sector';

const cls = (over: Partial<SecurityClassification> & { ticker: string }): SecurityClassification => ({
  ticker: over.ticker,
  kind: over.kind ?? 'equity',
  sector: over.sector ?? null,
  assetClass: over.assetClass ?? null,
  category: over.category ?? null,
  bucket: over.bucket ?? 'equity',
});

describe('computeSectorAllocation', () => {
  const map = new Map<string, SecurityClassification>([
    ['AAPL', cls({ ticker: 'AAPL', kind: 'equity', sector: 'Information Technology' })],
    ['MSFT', cls({ ticker: 'MSFT', kind: 'equity', sector: 'Information Technology' })],
    ['XOM', cls({ ticker: 'XOM', kind: 'equity', sector: 'Energy' })],
    ['VEU', cls({ ticker: 'VEU', kind: 'fund', assetClass: 'Intl Equity', bucket: 'equity' })],
  ]);

  it('aggregates same-sector holdings and sorts by pct desc', () => {
    const a = computeSectorAllocation(
      [
        { symbol: 'AAPL', positionPct: 20 },
        { symbol: 'MSFT', positionPct: 10 },
        { symbol: 'XOM', positionPct: 5 },
      ],
      map,
    );
    expect(a.slices[0]).toEqual({ label: 'Information Technology', kind: 'sector', pct: 30 });
    expect(a.slices[1]).toEqual({ label: 'Energy', kind: 'sector', pct: 5 });
    expect(a.classifiedPct).toBe(35);
    expect(a.unclassifiedPct).toBe(0);
  });

  it('labels funds by asset class, not GICS sector', () => {
    const a = computeSectorAllocation([{ symbol: 'VEU', positionPct: 15 }], map);
    expect(a.slices[0]).toEqual({ label: 'Intl Equity', kind: 'assetClass', pct: 15 });
  });

  it('buckets unknown tickers into Unclassified', () => {
    const a = computeSectorAllocation(
      [
        { symbol: 'AAPL', positionPct: 10 },
        { symbol: 'WAT', positionPct: 6 }, // not in map
      ],
      map,
    );
    expect(a.classifiedPct).toBe(10);
    expect(a.unclassifiedPct).toBe(6);
    expect(a.slices.find((s) => s.kind === 'unclassified')?.pct).toBe(6);
  });

  it('applies the normalizer to match raw symbols to cache keys', () => {
    const m = new Map([['BRK.B', cls({ ticker: 'BRK.B', kind: 'equity', sector: 'Financials' })]]);
    const a = computeSectorAllocation([{ symbol: 'BRKB', positionPct: 8 }], m, (s) => (s === 'BRKB' ? 'BRK.B' : s));
    expect(a.slices[0]).toEqual({ label: 'Financials', kind: 'sector', pct: 8 });
  });

  it('ignores zero/negative weights', () => {
    const a = computeSectorAllocation(
      [
        { symbol: 'AAPL', positionPct: 0 },
        { symbol: 'XOM', positionPct: -3 },
      ],
      map,
    );
    expect(a.slices).toHaveLength(0);
    expect(a.classifiedPct).toBe(0);
  });
});
