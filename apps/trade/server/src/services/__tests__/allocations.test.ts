import { describe, it, expect } from 'vitest';
import {
  allowedCashTicker,
  getRiskAllocation,
  isKnownMmkTicker,
  isTemplateMmkTicker,
  KNOWN_MMK_TICKERS,
  TEMPLATE_MMK_TICKERS,
} from '@trade-request/shared/allocations';
import { selectModel } from '../../data/allocationProfiles.js';
import type { AccountType, Residence } from '@trade-request/shared';

describe('getRiskAllocation', () => {
  it('throws on NaN input', () => {
    expect(() => getRiskAllocation(NaN)).toThrow('Invalid risk score');
  });

  it('throws on Infinity input', () => {
    expect(() => getRiskAllocation(Infinity)).toThrow('Invalid risk score');
  });

  it('throws on -Infinity input', () => {
    expect(() => getRiskAllocation(-Infinity)).toThrow('Invalid risk score');
  });

  it('returns allocation for valid score 1', () => {
    const alloc = getRiskAllocation(1);
    expect(alloc.cash + alloc.fixed + alloc.equity).toBeCloseTo(100, 0);
  });

  it('returns allocation for valid score 12', () => {
    const alloc = getRiskAllocation(12);
    expect(alloc.cash + alloc.fixed + alloc.equity).toBeCloseTo(100, 0);
  });

  it('returns allocation for valid score 25', () => {
    const alloc = getRiskAllocation(25);
    expect(alloc.cash + alloc.fixed + alloc.equity).toBeCloseTo(100, 0);
  });

  it('clamps score below 1 to index 0', () => {
    const alloc = getRiskAllocation(0);
    const first = getRiskAllocation(1);
    expect(alloc).toEqual(first);
  });

  it('clamps score above 25 to index 24', () => {
    const alloc = getRiskAllocation(100);
    const last = getRiskAllocation(25);
    expect(alloc).toEqual(last);
  });

  it('rounds fractional scores', () => {
    const alloc = getRiskAllocation(5.6);
    const rounded = getRiskAllocation(6);
    expect(alloc).toEqual(rounded);
  });
});

describe('allowedCashTicker', () => {
  it('returns SWVXX for Traditional IRA regardless of residence', () => {
    expect(allowedCashTicker('Traditional IRA', 'NY')).toBe('SWVXX');
    expect(allowedCashTicker('Traditional IRA', 'CA')).toBe('SWVXX');
    expect(allowedCashTicker('Traditional IRA', 'Other')).toBe('SWVXX');
  });

  it('returns SWVXX for Roth IRA regardless of residence', () => {
    expect(allowedCashTicker('Roth IRA', 'NY')).toBe('SWVXX');
    expect(allowedCashTicker('Roth IRA', 'CA')).toBe('SWVXX');
    expect(allowedCashTicker('Roth IRA', 'Other')).toBe('SWVXX');
  });

  it('returns VYFXX for Taxable / Joint NY residents', () => {
    expect(allowedCashTicker('Taxable', 'NY')).toBe('VYFXX');
    expect(allowedCashTicker('Joint', 'NY')).toBe('VYFXX');
  });

  it('returns VCTXX for Taxable / Joint CA residents', () => {
    expect(allowedCashTicker('Taxable', 'CA')).toBe('VCTXX');
    expect(allowedCashTicker('Joint', 'CA')).toBe('VCTXX');
  });

  it('returns VMSXX for Taxable / Joint non-NY/CA residents', () => {
    expect(allowedCashTicker('Taxable', 'Other')).toBe('VMSXX');
    expect(allowedCashTicker('Joint', 'Other')).toBe('VMSXX');
  });

  it('agrees with server selectModel across the full matrix', () => {
    const accountTypes: AccountType[] = ['Taxable', 'Joint', 'Traditional IRA', 'Roth IRA'];
    const residences: Residence[] = ['NY', 'CA', 'Other'];
    const modelToTicker = {
      taxableNational: 'SWVXX',
      nationalTaxEfficient: 'VMSXX',
      newYork: 'VYFXX',
      california: 'VCTXX',
    } as const;
    for (const a of accountTypes) {
      for (const r of residences) {
        expect(allowedCashTicker(a, r)).toBe(modelToTicker[selectModel(a, r)]);
      }
    }
  });
});

describe('isTemplateMmkTicker', () => {
  it('recognizes the four template tickers case-insensitively', () => {
    for (const t of TEMPLATE_MMK_TICKERS) {
      expect(isTemplateMmkTicker(t)).toBe(true);
      expect(isTemplateMmkTicker(t.toLowerCase())).toBe(true);
      expect(isTemplateMmkTicker(`  ${t}  `)).toBe(true);
    }
  });

  it('rejects other money-market tickers', () => {
    for (const sym of ['VUSXX', 'SPAXX', 'VMFXX', 'VMRXX', 'SWKXX', 'AGG', 'SPY', '']) {
      expect(isTemplateMmkTicker(sym)).toBe(false);
    }
  });
});

describe('isKnownMmkTicker', () => {
  it('recognizes every ticker in KNOWN_MMK_TICKERS case-insensitively', () => {
    for (const t of KNOWN_MMK_TICKERS) {
      expect(isKnownMmkTicker(t)).toBe(true);
      expect(isKnownMmkTicker(t.toLowerCase())).toBe(true);
      expect(isKnownMmkTicker(`  ${t}  `)).toBe(true);
    }
  });

  it('includes the four template tickers', () => {
    for (const t of TEMPLATE_MMK_TICKERS) {
      expect(isKnownMmkTicker(t)).toBe(true);
    }
  });

  it('includes non-template MMKs that should also trigger the validator', () => {
    for (const sym of [
      'VUSXX',
      'SPAXX',
      'VMFXX',
      'VMRXX',
      'SWKXX',
      'FZFXX',
      'SPRXX',
      'FDRXX',
      'PCOXX',
      'BUPXX',
      'GMMXX',
    ]) {
      expect(isKnownMmkTicker(sym)).toBe(true);
    }
  });

  it('rejects equity / bond tickers and empty input', () => {
    for (const sym of ['AGG', 'SPY', 'VTEB', 'VGSH', 'MUB', '']) {
      expect(isKnownMmkTicker(sym)).toBe(false);
    }
  });
});
