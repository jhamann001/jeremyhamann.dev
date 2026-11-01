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

import { postDriftAlert } from '../registryDriftAlert.js';
import type { DriftHouseholdResult } from '../registryDrift.js';

function household(overrides: Partial<DriftHouseholdResult>): DriftHouseholdResult {
  return {
    householdName: 'Default',
    coverageStatus: 'full',
    accountCount: 1,
    maxDeltaPct: 0,
    breach: false,
    worstSymbol: null,
    details: { accounts: [] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DRIFT_ALERTS_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.DRIFT_ALERTS_ENABLED;
});

describe('postDriftAlert', () => {
  it('posts when there is a non-allow-listed breach whose insert succeeded', async () => {
    const result = await postDriftAlert({
      households: [
        household({
          householdName: 'Real Drift Co',
          breach: true,
          maxDeltaPct: 12.3,
          worstSymbol: 'equity',
          details: {
            accounts: [
              {
                accountNumber: 'ACC-1',
                maxDeltaPct: 12.3,
                worstSymbol: 'equity',
                perSymbolDelta: {
                  AAPL: { positions: 60, meridian: 47.7, delta: 12.3 },
                  BND: { positions: 30, meridian: 32.7, delta: 2.7 },
                },
                perBucketDelta: {},
                coverage: 'both',
                flags: [],
              },
            ],
          },
        }),
      ],
      breachInsertedHouseholdNames: new Set(['Real Drift Co']),
      runDateLocal: '2026-05-12',
      unmappedAccountCount: 0,
    });

    expect(result.sent).toBe(true);
    expect(result.alertingHouseholds).toEqual(['Real Drift Co']);
    expect(sendDriftChannelMessageMock).toHaveBeenCalledTimes(1);
    const [text] = sendDriftChannelMessageMock.mock.calls[0];
    expect(text).toContain('Real Drift Co');
    expect(text).toContain('12.30%');
    // S9: bucket-aware copy + worst-account top-symbol drilldown line.
    expect(text).toContain('worst bucket:');
    expect(text).toContain('worst bucket: equity');
    expect(text).toContain('↳ top symbol: AAPL');
    expect(text).toContain('↳ top symbol: AAPL (12.30%)');
  });

  it('emits "↳ top symbol: n/a" when the worst account has no per-symbol delta', async () => {
    const result = await postDriftAlert({
      households: [
        household({
          householdName: 'Empty Drilldown Household',
          breach: true,
          maxDeltaPct: 8.5,
          worstSymbol: 'cash',
          details: {
            accounts: [
              {
                accountNumber: 'ACC-EMPTY',
                maxDeltaPct: 8.5,
                worstSymbol: 'cash',
                // Empty perSymbolDelta — exercise the n/a branch.
                perSymbolDelta: {},
                perBucketDelta: {},
                coverage: 'both',
                flags: [],
              },
            ],
          },
        }),
      ],
      breachInsertedHouseholdNames: new Set(['Empty Drilldown Household']),
      runDateLocal: '2026-05-12',
      unmappedAccountCount: 0,
    });

    expect(result.sent).toBe(true);
    const [text] = sendDriftChannelMessageMock.mock.calls[0];
    expect(text).toContain('worst bucket: cash');
    expect(text).toContain('↳ top symbol: n/a');
  });

  it('does NOT post when DRIFT_ALERTS_ENABLED!=true (shadow mode)', async () => {
    delete process.env.DRIFT_ALERTS_ENABLED;
    const result = await postDriftAlert({
      households: [household({ householdName: 'X', breach: true })],
      breachInsertedHouseholdNames: new Set(['X']),
      runDateLocal: '2026-05-12',
      unmappedAccountCount: 0,
    });
    expect(result.sent).toBe(false);
    expect(sendDriftChannelMessageMock).not.toHaveBeenCalled();
    expect(infoMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'drift_alert_suppressed' }),
      expect.any(String),
    );
  });

  it('skips households whose row was NOT inserted (idempotency belt-and-braces)', async () => {
    const result = await postDriftAlert({
      households: [household({ householdName: 'Late Retry Co', breach: true })],
      breachInsertedHouseholdNames: new Set(),
      runDateLocal: '2026-05-12',
      unmappedAccountCount: 0,
    });
    expect(result.sent).toBe(false);
    expect(sendDriftChannelMessageMock).not.toHaveBeenCalled();
  });

  it('appends an unmapped-account footnote when count > 0', async () => {
    const result = await postDriftAlert({
      households: [household({ householdName: 'Real Drift Co', breach: true, maxDeltaPct: 12, worstSymbol: 'SPY' })],
      breachInsertedHouseholdNames: new Set(['Real Drift Co']),
      runDateLocal: '2026-05-12',
      unmappedAccountCount: 3,
    });
    expect(result.sent).toBe(true);
    const [text] = sendDriftChannelMessageMock.mock.calls[0];
    expect(text).toContain('3 unmapped accounts');
  });
});
