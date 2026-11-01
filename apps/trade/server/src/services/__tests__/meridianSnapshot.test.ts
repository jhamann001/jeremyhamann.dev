import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  deriveAsOfFromFilename,
  groupMeridianRows,
  WEIGHT_SUM_TOLERANCE_PCT,
  INACTIVE_APEX_ACCOUNTS,
  CORPORATE_APEX_ACCOUNTS,
} from '../meridianSnapshot.js';
import logger from '../../lib/logger.js';

// 2026-Q3 Meridian-format cutover: the flat-row GCS loader is retired.
// The 13 loader cases (happy path / failure / fixture round-trip / from-file
// / filter) were migrated to `meridianTemplates.test.ts` against the new
// nested wire shape. What remains in this file:
//   - `deriveAsOfFromFilename` — kept; helper still used by both new loaders.
//   - `groupMeridianRows` — kept; legacy unit tests pin the grouping
//     algorithm contract so a follow-up PR can delete the helper and these
//     tests together without surprise.
//   - INACTIVE_APEX_ACCOUNTS / CORPORATE_APEX_ACCOUNTS — re-asserted by the
//     templates loader, but spot-checked here so a future PR that touches the
//     constants does not silently shrink the deny lists.

// ─── deriveAsOfFromFilename ──────────────────────────────────────────────────

describe('deriveAsOfFromFilename', () => {
  it('parses YYYY-MM-DD.json under any prefix into an ISO timestamp at UTC midnight', () => {
    expect(deriveAsOfFromFilename('meridian/snapshots/2026-05-12.json')).toBe('2026-05-12T00:00:00.000Z');
    expect(deriveAsOfFromFilename('meridian/templates/2026-05-15.json')).toBe('2026-05-15T00:00:00.000Z');
    expect(deriveAsOfFromFilename('meridian/active_accounts/2026-05-15.json')).toBe('2026-05-15T00:00:00.000Z');
    expect(deriveAsOfFromFilename('2026-05-12.json')).toBe('2026-05-12T00:00:00.000Z');
  });

  it('also accepts a bare YYYY-MM-DD basename (no .json)', () => {
    expect(deriveAsOfFromFilename('2026-05-12')).toBe('2026-05-12T00:00:00.000Z');
  });

  it('returns null when the basename is not a YYYY-MM-DD date', () => {
    expect(deriveAsOfFromFilename('meridian/templates/CedarRidge_templates.json')).toBeNull();
    expect(deriveAsOfFromFilename('meridian/templates/snapshot-latest.json')).toBeNull();
    expect(deriveAsOfFromFilename('not-a-date.json')).toBeNull();
  });
});

// ─── groupMeridianRows (legacy flat-row grouper) ───────────────────────────

describe('groupMeridianRows', () => {
  const asOf = '2026-05-12T00:00:00.000Z';

  it('groups rows by external_account_no — NOT account_id — and produces a per-account weights map', () => {
    const rows = [
      { external_account_no: 'ZZ10002', account_id: 1, security: 'SPY', alloc_pct: 60, template_name: 'T1' },
      { external_account_no: 'ZZ10002', account_id: 1, security: 'BND', alloc_pct: 40, template_name: 'T1' },
      { external_account_no: 'WXYZ123', account_id: 2, security: 'VOO', alloc_pct: 100, template_name: 'T2' },
    ];
    const entries = groupMeridianRows({ rows, sourceLabel: 'test', asOf });
    expect(entries).toHaveLength(2);
    const bh = entries.find((entry) => entry.account === 'ZZ10002')!;
    expect(bh.weights).toEqual({ SPY: 60, BND: 40 });
    expect(bh.templateName).toBe('T1');
    expect(bh.asOf).toBe(asOf);
  });

  it('preserves alloc_pct values unchanged (percent scale, matches engine registry units)', () => {
    const rows = [{ external_account_no: 'A', security: 'SPY', alloc_pct: 2.9, template_name: 'T' }];
    const entries = groupMeridianRows({ rows, sourceLabel: 'test', asOf });
    expect(entries[0].weights.SPY).toBe(2.9);
  });

  it('aggregates duplicate (account, security) rows defensively (sums alloc_pct)', () => {
    const rows = [
      { external_account_no: 'A', security: 'SPY', alloc_pct: 30, template_name: 'T' },
      { external_account_no: 'A', security: 'SPY', alloc_pct: 30, template_name: 'T' },
      { external_account_no: 'A', security: 'BND', alloc_pct: 40, template_name: 'T' },
    ];
    const entries = groupMeridianRows({ rows, sourceLabel: 'test', asOf });
    expect(entries[0].weights).toEqual({ SPY: 60, BND: 40 });
  });

  it('logs a warning when per-account weight sum is outside ±1.0pp tolerance', () => {
    const rows = [{ external_account_no: 'A', security: 'SPY', alloc_pct: 56.2, template_name: 'T' }];
    groupMeridianRows({ rows, sourceLabel: 'test', asOf });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'snapshot_weight_sum_anomaly',
        account: 'A',
        observedSumPct: 56.2,
      }),
      expect.stringContaining('outside tolerance'),
    );
  });

  it('does NOT log a warning for floating-point noise around 100 (e.g., 99.99999999999999)', () => {
    vi.mocked(logger.warn).mockClear();
    const rows = [
      { external_account_no: 'A', security: 'A', alloc_pct: 33.33333333333333, template_name: 'T' },
      { external_account_no: 'A', security: 'B', alloc_pct: 33.33333333333333, template_name: 'T' },
      { external_account_no: 'A', security: 'C', alloc_pct: 33.33333333333333, template_name: 'T' },
    ];
    groupMeridianRows({ rows, sourceLabel: 'test', asOf });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'snapshot_weight_sum_anomaly' }),
      expect.anything(),
    );
  });

  it('logs a warning and takes the LAST template_name when one account is split across templates', () => {
    const rows = [
      { external_account_no: 'A', security: 'SPY', alloc_pct: 60, template_name: 'Old Template' },
      { external_account_no: 'A', security: 'BND', alloc_pct: 40, template_name: 'New Template' },
    ];
    const entries = groupMeridianRows({ rows, sourceLabel: 'test', asOf });
    expect(entries[0].templateName).toBe('New Template');
    expect(entries[0].weights).toEqual({ SPY: 60, BND: 40 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'snapshot_multiple_templates_per_account',
        account: 'A',
        templateNames: ['Old Template', 'New Template'],
      }),
      expect.any(String),
    );
  });

  it('stamps the supplied as_of onto every entry (loader derives this from filename)', () => {
    const rows = [
      { external_account_no: 'A', security: 'SPY', alloc_pct: 100, template_name: 'T' },
      { external_account_no: 'B', security: 'BND', alloc_pct: 100, template_name: 'T' },
    ];
    const entries = groupMeridianRows({ rows, sourceLabel: 'test', asOf: '2026-04-01T00:00:00.000Z' });
    for (const entry of entries) {
      expect(entry.asOf).toBe('2026-04-01T00:00:00.000Z');
    }
  });

  it('threads account_title from the row through to entries[*].accountTitle (drift v2 §4.2)', () => {
    const rows = [
      {
        external_account_no: 'A',
        account_title: 'Whitaker Traditional IRA',
        security: 'VOO',
        alloc_pct: 60,
        template_name: 'T1',
      },
      {
        external_account_no: 'A',
        account_title: 'Whitaker Traditional IRA',
        security: 'BND',
        alloc_pct: 40,
        template_name: 'T1',
      },
    ];
    const entries = groupMeridianRows({ rows, sourceLabel: 'test', asOf: '2026-05-13T00:00:00.000Z' });
    expect(entries[0].accountTitle).toBe('Whitaker Traditional IRA');
  });
});

// ─── Deny-list constants ─────────────────────────────────────────────────────

describe('inactive + corporate deny lists', () => {
  it('keeps a demo client (01SYNTHD7WE9TKCBRPS3BQMGTG) in INACTIVE_APEX_ACCOUNTS', () => {
    expect(INACTIVE_APEX_ACCOUNTS.has('01SYNTHD7WE9TKCBRPS3BQMGTG')).toBe(true);
  });

  it('keeps the 4 corporate Apex ULIDs in CORPORATE_APEX_ACCOUNTS', () => {
    expect(CORPORATE_APEX_ACCOUNTS.size).toBe(4);
    for (const ulid of [
      '01SYNTH6BDYNAGTJ07KC0SFYGY',
      '01SYNTH1B11MYXFS3Q5B5D2WNW',
      '01SYNTH69JZYE3TD78SPZ4PBWK',
      '01SYNTH85BR7BT1ZPYKBDZAC9C',
    ]) {
      expect(CORPORATE_APEX_ACCOUNTS.has(ulid)).toBe(true);
    }
  });
});

// Re-export tolerance constant under its same name to lock the contract.
describe('WEIGHT_SUM_TOLERANCE_PCT', () => {
  it('is the ±1pp tolerance the new templates loader also enforces', () => {
    expect(WEIGHT_SUM_TOLERANCE_PCT).toBe(1.0);
  });
});
