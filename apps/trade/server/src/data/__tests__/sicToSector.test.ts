import { describe, it, expect } from 'vitest';
import { normalizeTicker, sicToSector, classifySector } from '../sicToSector.js';

describe('normalizeTicker', () => {
  it('passes through normal US tickers (uppercased/trimmed)', () => {
    expect(normalizeTicker('AAPL')).toBe('AAPL');
    expect(normalizeTicker(' nvda ')).toBe('NVDA');
  });
  it('maps Apex class shares to the dotted provider ticker', () => {
    expect(normalizeTicker('BRKB')).toBe('BRK.B');
    expect(normalizeTicker('BFB')).toBe('BF.B');
    expect(normalizeTicker('UHALB')).toBe('UHAL.B');
  });
  it('rejects non-fetchable symbols → null', () => {
    expect(normalizeTicker('#ZZ10003')).toBeNull(); // internal placeholder
    expect(normalizeTicker('BBBYWS')).toBeNull(); // warrant
    expect(normalizeTicker('')).toBeNull();
    expect(normalizeTicker('  ')).toBeNull();
    expect(normalizeTicker('FOO BAR')).toBeNull();
  });
});

describe('sicToSector', () => {
  it('maps the common tech/health/energy/financial codes', () => {
    expect(sicToSector('3674')).toBe('Information Technology'); // semiconductors
    expect(sicToSector('3571')).toBe('Information Technology'); // computers
    expect(sicToSector('7372')).toBe('Information Technology'); // prepackaged software
    expect(sicToSector('2834')).toBe('Health Care'); // pharma
    expect(sicToSector('3845')).toBe('Health Care'); // electromedical
    expect(sicToSector('8011')).toBe('Health Care'); // health services
    expect(sicToSector('2911')).toBe('Energy'); // petroleum refining
    expect(sicToSector('1311')).toBe('Energy'); // oil & gas extraction
    expect(sicToSector('6021')).toBe('Financials'); // national commercial banks
  });
  it('handles the carve-outs that differ from their broad range', () => {
    expect(sicToSector('3711')).toBe('Consumer Discretionary'); // motor vehicles (not Industrials)
    expect(sicToSector('6798')).toBe('Real Estate'); // REIT (not Financials)
    expect(sicToSector('5912')).toBe('Consumer Staples'); // drug stores (not Consumer Disc)
    expect(sicToSector('5961')).toBe('Consumer Discretionary'); // catalog/mail-order
    expect(sicToSector('4813')).toBe('Communication Services'); // telephone
    expect(sicToSector('4911')).toBe('Utilities'); // electric services
    expect(sicToSector('6500')).toBe('Real Estate');
  });
  it('returns Unclassified for empty/invalid/out-of-range codes', () => {
    expect(sicToSector('')).toBe('Unclassified');
    expect(sicToSector(null)).toBe('Unclassified');
    expect(sicToSector('0')).toBe('Unclassified');
    expect(sicToSector('9999')).toBe('Unclassified');
  });
});

describe('classifySector', () => {
  it('applies ticker overrides over the SIC range (GICS-canonical fixes)', () => {
    // SIC 7370 → IT by range, but GICS puts Alphabet/Meta in Communication Services.
    expect(classifySector('GOOGL', '7370')).toBe('Communication Services');
    expect(classifySector('META', '7370')).toBe('Communication Services');
    // SIC 6199/7389 → Financials/Industrials by range, but GICS puts Visa/MC in IT.
    expect(classifySector('V', '6199')).toBe('Information Technology');
    expect(classifySector('MA', '7389')).toBe('Information Technology');
  });
  it('falls back to the SIC range when no override exists', () => {
    expect(classifySector('AAPL', '3571')).toBe('Information Technology');
    expect(classifySector('XOM', '2911')).toBe('Energy');
    expect(classifySector('SOMETHINGNEW', '3674')).toBe('Information Technology');
  });
});
