import { describe, it, expect } from 'vitest';
import type { DriftHistoryRow } from '@trade-request/shared';
import { computeBreachBadge } from '../driftBadge';

const ALLOW_LIST = new Set<string>(['Whitaker Family', 'Martha and Graham Ellis']);

function row(overrides: Partial<DriftHistoryRow>): DriftHistoryRow {
  return {
    runDateLocal: '2026-05-12',
    householdName: 'Doe Family',
    maxDeltaPct: 0,
    breach: false,
    coverageStatus: 'full',
    schemaVersion: 1,
    snapshotSource: 'gcs',
    snapshotAsOf: '2026-05-12T03:00:00.000Z',
    ...overrides,
  };
}

describe('computeBreachBadge', () => {
  it('returns "clean" when !breach and coverage is full', () => {
    expect(computeBreachBadge(row({ breach: false, coverageStatus: 'full' }), ALLOW_LIST)).toBe('clean');
  });

  it('returns "would-alert" when breach && !allow-listed && coverage !== unmapped_account', () => {
    expect(
      computeBreachBadge(row({ breach: true, coverageStatus: 'full', householdName: 'Doe Family' }), ALLOW_LIST),
    ).toBe('would-alert');
  });

  it('returns "allow-listed" when breach && allow-listed && coverage !== unmapped_account', () => {
    expect(
      computeBreachBadge(row({ breach: true, coverageStatus: 'full', householdName: 'Whitaker Family' }), ALLOW_LIST),
    ).toBe('allow-listed');
  });

  it('returns "unmapped" when coverage === unmapped_account regardless of breach value', () => {
    expect(computeBreachBadge(row({ breach: false, coverageStatus: 'unmapped_account' }), ALLOW_LIST)).toBe('unmapped');
    expect(computeBreachBadge(row({ breach: true, coverageStatus: 'unmapped_account' }), ALLOW_LIST)).toBe('unmapped');
  });

  it('precedence: unmapped overrides allow-list (an allow-listed unmapped row still renders "unmapped")', () => {
    expect(
      computeBreachBadge(
        row({ breach: true, coverageStatus: 'unmapped_account', householdName: 'Whitaker Family' }),
        ALLOW_LIST,
      ),
    ).toBe('unmapped');
  });

  it('precedence: unmapped overrides would-alert (a non-allow-listed unmapped breach still renders "unmapped")', () => {
    expect(
      computeBreachBadge(
        row({ breach: true, coverageStatus: 'unmapped_account', householdName: 'Doe Family' }),
        ALLOW_LIST,
      ),
    ).toBe('unmapped');
  });

  it('handles empty allow-list — every breach renders "would-alert" except unmapped_account', () => {
    const empty = new Set<string>();
    expect(computeBreachBadge(row({ breach: true, coverageStatus: 'full' }), empty)).toBe('would-alert');
    expect(computeBreachBadge(row({ breach: true, coverageStatus: 'partial' }), empty)).toBe('would-alert');
    expect(computeBreachBadge(row({ breach: true, coverageStatus: 'unmapped_account' }), empty)).toBe('unmapped');
  });
});
