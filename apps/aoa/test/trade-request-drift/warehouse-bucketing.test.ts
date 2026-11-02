import { describe, it, expect } from 'vitest';
import { effectiveBucket } from '@/lib/trade-requests/sources/warehouse';
import type { AssetCategory } from '@/lib/trade-requests/sources/data/instruments';

// `effectiveBucket` mirrors the drift comparator: classifySymbol by default,
// but the security-sector cache may CORRECT a fund that classifySymbol defaults
// to 'equity' into its real fixed/cash bucket. Promote-only — never demotes a
// curated cash/fixed classification. Keeps holdings at 3 buckets.
describe('effectiveBucket', () => {
  it('falls back to classifySymbol when there are no overrides (unknown ticker → equity)', () => {
    expect(effectiveBucket('ZZQQ')).toBe('equity');
    expect(effectiveBucket('ZZQQ', new Map())).toBe('equity');
  });

  it('promotes an equity-defaulted fund to fixed when the cache classifies it as fixed', () => {
    const overrides = new Map<string, AssetCategory>([['ZZQQ', 'fixed']]);
    expect(effectiveBucket('ZZQQ', overrides)).toBe('fixed');
  });

  it('promotes an equity-defaulted fund to cash (money-market) when the cache says so', () => {
    const overrides = new Map<string, AssetCategory>([['ZZMM', 'cash']]);
    expect(effectiveBucket('ZZMM', overrides)).toBe('cash');
  });

  it('never demotes a curated cash/fixed classification (promote-only)', () => {
    // SWVXX is a curated money-market fund → classifySymbol = cash. Even a bogus
    // "equity" override must not demote it (the guard only promotes equity).
    const overrides = new Map<string, AssetCategory>([['SWVXX', 'equity']]);
    expect(effectiveBucket('SWVXX', overrides)).toBe('cash');
  });

  it('matches overrides by normalized ticker (e.g. BRKB → BRK.B)', () => {
    const overrides = new Map<string, AssetCategory>([['BRK.B', 'fixed']]);
    expect(effectiveBucket('BRKB', overrides)).toBe('fixed');
  });
});
