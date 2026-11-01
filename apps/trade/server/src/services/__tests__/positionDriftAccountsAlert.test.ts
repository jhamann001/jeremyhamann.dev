import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sendDriftChannelMessageMock, infoMock } = vi.hoisted(() => ({
  sendDriftChannelMessageMock: vi.fn().mockResolvedValue(undefined),
  infoMock: vi.fn(),
}));

vi.mock('../slack.js', () => ({
  sendDriftChannelMessage: sendDriftChannelMessageMock,
  escapeSlack: (value: string) => value,
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: infoMock, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { postAccountDriftAlert } from '../positionDriftAccountsAlert.js';
import type { AccountDriftResult } from '../positionDriftAccounts.js';

function account(overrides: Partial<AccountDriftResult>): AccountDriftResult {
  return {
    accountId: '01HZ8K3M4N5P6Q7R8S9T0VWXYZ',
    accountTitle: 'Default Account Title',
    household: 'Default Household',
    unmapped: false,
    templateMissing: false,
    totalValue: 100,
    maxBucketDeltaPct: 0,
    worstBucket: null,
    symbolBreachCount: 0,
    status: 'in',
    details: {
      buckets: {
        cash: { positionPct: 0, templatePct: 0, deltaPct: 0 },
        fixed: { positionPct: 0, templatePct: 0, deltaPct: 0 },
        equity: { positionPct: 0, templatePct: 0, deltaPct: 0 },
      },
      symbolsWithTargets: [],
      equityHoldings: [],
      positionOnlySymbols: [],
      suspectedCashEquivMisclassified: [],
    },
    ...overrides,
  };
}

// Mock app-DB pool for the send-once claim. `claimed=true` → the INSERT wins
// (RETURNING a row) so the alert posts; `false` → ON CONFLICT DO NOTHING
// returned nothing, i.e. another run already claimed this date today.
function poolClaiming(claimed = true) {
  return { query: vi.fn().mockResolvedValue({ rows: claimed ? [{ run_date_local: '2026-05-13' }] : [] }) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.DRIFT_ALERTS_ENABLED;
});

describe('postAccountDriftAlert', () => {
  it('suppresses Slack and emits account_drift_alert_suppressed when DRIFT_ALERTS_ENABLED !== "true"', async () => {
    const result = await postAccountDriftAlert({
      accounts: [account({ status: 'out', worstBucket: 'equity', maxBucketDeltaPct: 27.39 })],
      pool: poolClaiming(),
      runDateLocal: '2026-05-13',
    });
    expect(result.sent).toBe(false);
    expect(sendDriftChannelMessageMock).not.toHaveBeenCalled();
    expect(infoMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'account_drift_alert_suppressed' }),
      expect.any(String),
    );
  });

  it('posts the compact report: headline + dashboard link + account row when an insert succeeded', async () => {
    process.env.DRIFT_ALERTS_ENABLED = 'true';
    const result = await postAccountDriftAlert({
      accounts: [
        account({
          accountId: '01ABC000000000000000000XYZ',
          accountTitle: 'Whitaker Traditional IRA',
          household: 'Whitaker Family',
          status: 'out',
          worstBucket: 'equity',
          maxBucketDeltaPct: 27.39,
          symbolBreachCount: 2,
        }),
      ],
      pool: poolClaiming(),
      runDateLocal: '2026-05-13',
    });
    expect(result.sent).toBe(true);
    expect(sendDriftChannelMessageMock).toHaveBeenCalledTimes(1);
    const [text] = sendDriftChannelMessageMock.mock.calls[0];
    // Headline: short date + "N of M accounts out of tolerance · worst X%".
    expect(text).toContain('*Drift report* · May 13');
    expect(text).toContain('*1* of 1 accounts out of tolerance');
    expect(text).toContain('worst is *27.4%* off target'); // self-describing headline
    expect(text).toContain('% off'); // column header explains the number
    // Account row (no " - " in the title ⇒ label used verbatim) + household.
    expect(text).toContain('Whitaker Traditional IRA');
    expect(text).toContain('Whitaker Family');
    // Dashboard link present; obsolete per-line bucket/breach copy gone.
    expect(text).toContain('/drift|drift dashboard');
    expect(text).not.toContain('worst bucket:');
    expect(text).not.toMatch(/symbol breach/);
  });

  it('emits account_drift_alert_clean and skips Slack when there are no out accounts', async () => {
    process.env.DRIFT_ALERTS_ENABLED = 'true';
    const result = await postAccountDriftAlert({
      accounts: [account({ status: 'in' })],
      pool: poolClaiming(),
      runDateLocal: '2026-05-13',
    });
    expect(result.sent).toBe(false);
    expect(sendDriftChannelMessageMock).not.toHaveBeenCalled();
    expect(infoMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'account_drift_alert_clean' }),
      expect.any(String),
    );
  });

  it('suppresses an account whose household is allow-listed but records it in suppressedAllowListed', async () => {
    // The allow list is currently empty (plan §1 decision); to exercise this
    // path without modifying the live const, we register a household name and
    // assert that an account in that household gets suppressed.
    process.env.DRIFT_ALERTS_ENABLED = 'true';
    const allowListModule = await import('../registryDriftAllowList.js');
    const original = new Set(allowListModule.DRIFT_ALLOW_LIST_NAMES);
    (allowListModule.DRIFT_ALLOW_LIST_NAMES as Set<string>).add('Whitaker Family');
    try {
      const result = await postAccountDriftAlert({
        accounts: [
          account({
            accountId: 'AAA000000000000000000000XX',
            household: 'Whitaker Family',
            status: 'out',
            worstBucket: 'equity',
            maxBucketDeltaPct: 30,
          }),
        ],
        pool: poolClaiming(),
        runDateLocal: '2026-05-13',
      });
      expect(result.alertingAccountIds).toEqual([]);
      expect(result.suppressedAllowListed).toEqual(['AAA000000000000000000000XX']);
    } finally {
      const live = allowListModule.DRIFT_ALLOW_LIST_NAMES as Set<string>;
      live.clear();
      for (const v of original) live.add(v);
    }
  });

  it('trims noisy registration titles, keeps "&" literal (code block), and lists worst-first', async () => {
    process.env.DRIFT_ALERTS_ENABLED = 'true';
    await postAccountDriftAlert({
      accounts: [
        account({
          accountId: '01ABC000000000000000000XYZ',
          accountTitle: 'Arlo Bennett & Mira Quinn - Joint Brokerage Tenants With Right Of Survivorship',
          household: 'Bennett Quinn Family',
          status: 'out',
          worstBucket: 'cash',
          maxBucketDeltaPct: 48.46,
        }),
        account({
          accountId: '01DEF000000000000000000XYZ',
          accountTitle: 'Renata Vale - Roth_Ira',
          household: 'Vale Family',
          status: 'out',
          worstBucket: 'equity',
          maxBucketDeltaPct: 60.49,
        }),
      ],
      pool: poolClaiming(),
      runDateLocal: '2026-05-13',
    });
    const [text] = sendDriftChannelMessageMock.mock.calls[0];
    // Registration collapsed to a short label; the noise is dropped.
    expect(text).toContain('Arlo Bennett & Mira Quinn — Joint');
    expect(text).not.toContain('Survivorship');
    expect(text).toContain('Renata Vale — Roth IRA');
    // Inside a code block "&" must stay literal — never HTML-escaped.
    expect(text).not.toContain('&amp;');
    // Worst-first ordering: the 60.49% Vale row precedes the 48.46% row.
    const valeIdx = text.indexOf('Renata Vale');
    const bennettIdx = text.indexOf('Arlo Bennett');
    expect(valeIdx).toBeGreaterThanOrEqual(0);
    expect(valeIdx).toBeLessThan(bennettIdx);
  });

  it('caps the inline list at the top 5 and collapses the rest to "…and N more"', async () => {
    process.env.DRIFT_ALERTS_ENABLED = 'true';
    const ids = Array.from({ length: 7 }, (_, i) => `01ACCT${String(i).padStart(20, '0')}`);
    await postAccountDriftAlert({
      accounts: ids.map((id, i) =>
        account({
          accountId: id,
          accountTitle: `Client ${i} - Brokerage`,
          household: `House ${i}`,
          status: 'out',
          worstBucket: 'equity',
          maxBucketDeltaPct: 50 - i, // 50,49,…44 — already descending
        }),
      ),
      pool: poolClaiming(),
      runDateLocal: '2026-05-13',
    });
    const [text] = sendDriftChannelMessageMock.mock.calls[0];
    expect(text).toContain('*7* of 7 accounts out of tolerance');
    expect(text).toContain('…and 2 more'); // 7 total, top 5 shown
    expect(text).toContain('Client 0 — Brokerage'); // worst is listed
    expect(text).not.toContain('Client 5 — Brokerage'); // 6th worst is collapsed
  });

  it('summarizes the secondary cohorts (uninvested + no-model, incl. unmapped) in the "Also" line', async () => {
    process.env.DRIFT_ALERTS_ENABLED = 'true';
    await postAccountDriftAlert({
      accounts: [
        account({
          accountId: '01OUT0000000000000000000XY',
          accountTitle: 'Drifted - Brokerage',
          household: 'Drift House',
          status: 'out',
          maxBucketDeltaPct: 12,
        }),
        account({ accountId: '01UNINV00000000000000000XY', status: 'uninvested', maxBucketDeltaPct: 80 }),
        account({ accountId: '01UNINV00000000000000001XY', status: 'uninvested', maxBucketDeltaPct: 75 }),
        // Mapped no-template (in the feed, template missing).
        account({ accountId: '01NOMODEL000000000000000XY', status: 'no_template', maxBucketDeltaPct: null }),
        // Unmapped funded (not in the Meridian feed yet).
        account({
          accountId: '01UNMAP0000000000000000XY',
          status: 'no_template',
          unmapped: true,
          maxBucketDeltaPct: null,
        }),
      ],
      pool: poolClaiming(),
      runDateLocal: '2026-05-13',
    });
    const [text] = sendDriftChannelMessageMock.mock.calls[0];
    // managedTotal excludes the 1 unmapped row ⇒ 4 of the 5 are managed.
    expect(text).toContain('of 4 accounts out of tolerance');
    expect(text).toContain('2 uninvested');
    expect(text).toContain('2 accounts have no model (1 not yet in Meridian)');
  });

  it('empty title/household fall back to "(no title)" and "unmapped" in the row', async () => {
    process.env.DRIFT_ALERTS_ENABLED = 'true';
    await postAccountDriftAlert({
      accounts: [
        account({
          accountId: 'XXXX111122223333444455555X',
          accountTitle: '',
          household: '',
          unmapped: false, // unmapped rows are filtered from the out cohort; keep false.
          status: 'out',
          worstBucket: 'cash',
          maxBucketDeltaPct: 30,
        }),
      ],
      pool: poolClaiming(),
      runDateLocal: '2026-05-13',
    });
    const [text] = sendDriftChannelMessageMock.mock.calls[0];
    expect(text).toContain('(no title)');
    expect(text).toContain('unmapped');
  });

  it('does NOT post when the run date was already claimed (ON CONFLICT returns no row)', async () => {
    process.env.DRIFT_ALERTS_ENABLED = 'true';
    const result = await postAccountDriftAlert({
      accounts: [
        account({
          accountId: '01OUT0000000000000000000XY',
          accountTitle: 'Drifted - Brokerage',
          household: 'Drift House',
          status: 'out',
          worstBucket: 'equity',
          maxBucketDeltaPct: 27.39,
        }),
      ],
      pool: poolClaiming(false), // another run already claimed today
      runDateLocal: '2026-05-13',
    });
    expect(result.sent).toBe(false);
    expect(sendDriftChannelMessageMock).not.toHaveBeenCalled();
    expect(infoMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'account_drift_alert_already_sent' }),
      expect.any(String),
    );
  });

  it('claims the run date then sends exactly once when DRIFT_ALERTS_ENABLED=true and a breach exists', async () => {
    process.env.DRIFT_ALERTS_ENABLED = 'true';
    const pool = poolClaiming(true);
    const result = await postAccountDriftAlert({
      accounts: [
        account({
          accountId: '01OUT0000000000000000000XY',
          accountTitle: 'Drifted - Brokerage',
          household: 'Drift House',
          status: 'out',
          worstBucket: 'equity',
          maxBucketDeltaPct: 27.39,
        }),
      ],
      pool,
      runDateLocal: '2026-05-13',
    });
    expect(result.sent).toBe(true);
    expect(sendDriftChannelMessageMock).toHaveBeenCalledTimes(1);
    // The claim INSERT ran against drift_alert_sends with the run date.
    expect((pool as unknown as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledWith(
      expect.stringContaining('drift_alert_sends'),
      ['2026-05-13'],
    );
  });
});
