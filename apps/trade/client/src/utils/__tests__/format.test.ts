import { describe, it, expect } from 'vitest';
import { formatCurrency } from '../format';

describe('formatCurrency', () => {
  it('formats positive integers with commas and dollar sign', () => {
    expect(formatCurrency(1234567)).toBe('$1,234,567');
  });

  it('formats zero as $0', () => {
    expect(formatCurrency(0)).toBe('$0');
  });

  it('formats negative values', () => {
    expect(formatCurrency(-1234)).toBe('-$1,234');
  });

  it('returns $0 for NaN', () => {
    expect(formatCurrency(Number.NaN)).toBe('$0');
  });

  it('returns $0 for Infinity', () => {
    expect(formatCurrency(Number.POSITIVE_INFINITY)).toBe('$0');
  });

  it('returns $0 for -Infinity', () => {
    expect(formatCurrency(Number.NEGATIVE_INFINITY)).toBe('$0');
  });
});
