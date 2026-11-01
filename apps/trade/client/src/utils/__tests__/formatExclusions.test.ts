import { describe, it, expect } from 'vitest';
import type { ClientExclusion } from '@trade-request/shared';
import { formatExclusionSide, formatExclusionsForTextarea, formatRestrictionReason } from '../formatExclusions';

function ex(overrides: Partial<ClientExclusion> = {}): ClientExclusion {
  return {
    id: 'fake-id',
    clientId: 'hh-1',
    ticker: 'TSLA',
    kind: 'advisor',
    reason: '',
    noBuy: true,
    noSell: true,
    createdByName: 'Rachel',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('formatExclusionSide (v3.4)', () => {
  it('returns DNB+DNS for blanket (both flags true)', () => {
    expect(formatExclusionSide({ noBuy: true, noSell: true })).toBe('DNB+DNS');
  });

  it('returns DNB for buy-only', () => {
    expect(formatExclusionSide({ noBuy: true, noSell: false })).toBe('DNB');
  });

  it('returns DNS for sell-only', () => {
    expect(formatExclusionSide({ noBuy: false, noSell: true })).toBe('DNS');
  });
});

describe('formatExclusionsForTextarea (v3.4)', () => {
  const johnOnly = [{ id: 'hh-1', name: 'John Smith' }];
  const household = [
    { id: 'hh-1', name: 'John Smith' },
    { id: 'hh-2', name: 'Jane Smith' },
  ];

  it('formats a single-client, single-exclusion case with the DNB+DNS prefix and a reason', () => {
    const out = formatExclusionsForTextarea(
      { 'hh-1': [ex({ ticker: 'TSLA', reason: 'Concentration risk', noBuy: true, noSell: true })] },
      johnOnly,
      'advisor',
    );
    expect(out).toBe('TSLA (DNB+DNS - Concentration risk)');
  });

  it('formats a DNB-only exclusion with no reason as TICKER (DNB)', () => {
    const out = formatExclusionsForTextarea(
      { 'hh-1': [ex({ ticker: 'TSLA', reason: '', noBuy: true, noSell: false })] },
      johnOnly,
      'advisor',
    );
    expect(out).toBe('TSLA (DNB)');
  });

  it('formats a DNS-only exclusion with a reason as TICKER (DNS - reason)', () => {
    const out = formatExclusionsForTextarea(
      { 'hh-1': [ex({ ticker: 'AAPL', reason: 'Low basis', noBuy: false, noSell: true })] },
      johnOnly,
      'advisor',
    );
    expect(out).toBe('AAPL (DNS - Low basis)');
  });

  it('appends household attribution inside the parens for multi-client households', () => {
    const out = formatExclusionsForTextarea(
      {
        'hh-1': [ex({ ticker: 'TSLA', reason: 'Concentration risk', noBuy: true, noSell: false })],
        'hh-2': [ex({ id: 'ex-2', clientId: 'hh-2', ticker: 'GOOG', reason: '', noBuy: false, noSell: true })],
      },
      household,
      'advisor',
    );
    // Concrete household example from the plan:
    //   single client, reason   → `TSLA (DNB - Concentration risk – John Smith)`
    //   no reason, attributed   → `GOOG (DNS – Jane Smith)`
    expect(out).toBe('TSLA (DNB - Concentration risk – John Smith); GOOG (DNS – Jane Smith)');
  });

  it('filters by kind — passing kind="advisor" excludes client-kind rows', () => {
    const out = formatExclusionsForTextarea(
      {
        'hh-1': [
          ex({ ticker: 'TSLA', kind: 'advisor' }),
          ex({ id: 'ex-2', ticker: 'AAPL', kind: 'client', reason: 'Employer' }),
        ],
      },
      johnOnly,
      'advisor',
    );
    expect(out).toBe('TSLA (DNB+DNS)');
    expect(out).not.toContain('AAPL');
  });

  it('returns empty string when no exclusions match the requested kind', () => {
    const out = formatExclusionsForTextarea({ 'hh-1': [ex({ kind: 'client' })] }, johnOnly, 'advisor');
    expect(out).toBe('');
  });
});

describe('formatRestrictionReason', () => {
  it('normalizes meridian import reasons to concise source text', () => {
    expect(formatRestrictionReason('Imported from /tmp/meridian/restrictions.csv line 22')).toBe(
      'Imported from Meridian restrictions file',
    );
    expect(formatRestrictionReason('MERIDIAN import: restrictions.csv row 5')).toBe(
      'Imported from Meridian restrictions file',
    );
  });

  it('keeps regular hand-written reasons unchanged', () => {
    expect(formatRestrictionReason('Employer stock')).toBe('Employer stock');
  });
});
