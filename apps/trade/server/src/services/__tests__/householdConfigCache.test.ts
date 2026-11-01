import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HouseholdConfig, HouseholdEntry } from '../householdConfig.js';

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const hoisted = vi.hoisted(() => ({
  loadMeridianActiveAccounts: vi.fn(),
  toHouseholdConfig: vi.fn(),
}));

vi.mock('../meridianActiveAccounts.js', () => ({
  loadMeridianActiveAccounts: hoisted.loadMeridianActiveAccounts,
  toHouseholdConfig: hoisted.toHouseholdConfig,
}));

import { loadHouseholdConfigCached, _resetHouseholdConfigCacheForTests } from '../householdConfigCache.js';

function makeConfig(tag: string): HouseholdConfig {
  const entry: HouseholdEntry = {
    accountNumber: `01JY2NPMDDS83DRA5FWXGS323${tag}`,
    householdName: `Household ${tag}`,
    accountTitle: `Title ${tag}`,
    householdId: 1000 + tag.charCodeAt(0),
  };
  const byAccountNumber = new Map<string, HouseholdEntry>([[entry.accountNumber, entry]]);
  return {
    byAccountNumber,
    householdNames: new Set([entry.householdName]),
    entries: [entry],
  };
}

beforeEach(() => {
  _resetHouseholdConfigCacheForTests();
  hoisted.loadMeridianActiveAccounts.mockReset();
  hoisted.toHouseholdConfig.mockReset();
});

afterEach(() => {
  _resetHouseholdConfigCacheForTests();
  vi.useRealTimers();
});

describe('loadHouseholdConfigCached', () => {
  it('calls the loader on first invocation and returns the result', async () => {
    const cfg = makeConfig('A');
    hoisted.loadMeridianActiveAccounts.mockResolvedValueOnce({ accounts: [] });
    hoisted.toHouseholdConfig.mockReturnValueOnce(cfg);

    const result = await loadHouseholdConfigCached();

    expect(result).toBe(cfg);
    expect(hoisted.loadMeridianActiveAccounts).toHaveBeenCalledTimes(1);
    expect(hoisted.toHouseholdConfig).toHaveBeenCalledTimes(1);
  });

  it('returns the cached config on subsequent calls within the TTL without invoking the loader', async () => {
    const cfg = makeConfig('A');
    hoisted.loadMeridianActiveAccounts.mockResolvedValueOnce({ accounts: [] });
    hoisted.toHouseholdConfig.mockReturnValueOnce(cfg);

    const first = await loadHouseholdConfigCached();
    const second = await loadHouseholdConfigCached();

    expect(first).toBe(cfg);
    expect(second).toBe(cfg);
    expect(hoisted.loadMeridianActiveAccounts).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent calls: two simultaneous callers share one loader invocation', async () => {
    const cfg = makeConfig('A');
    let resolveLoader: (value: { accounts: [] }) => void = () => {};
    hoisted.loadMeridianActiveAccounts.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoader = resolve;
      }),
    );
    hoisted.toHouseholdConfig.mockReturnValueOnce(cfg);

    const p1 = loadHouseholdConfigCached();
    const p2 = loadHouseholdConfigCached();
    resolveLoader({ accounts: [] });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(cfg);
    expect(r2).toBe(cfg);
    expect(hoisted.loadMeridianActiveAccounts).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T15:00:00.000Z'));

    const cfgA = makeConfig('A');
    const cfgB = makeConfig('B');
    hoisted.loadMeridianActiveAccounts
      .mockResolvedValueOnce({ accounts: [] })
      .mockResolvedValueOnce({ accounts: [] });
    hoisted.toHouseholdConfig.mockReturnValueOnce(cfgA).mockReturnValueOnce(cfgB);

    const first = await loadHouseholdConfigCached();
    expect(first).toBe(cfgA);

    vi.setSystemTime(new Date('2026-05-21T15:30:00.001Z'));

    const second = await loadHouseholdConfigCached();
    expect(second).toBe(cfgB);
    expect(hoisted.loadMeridianActiveAccounts).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the loader fails and there is no prior cache', async () => {
    const err = new Error('GCS exploded');
    hoisted.loadMeridianActiveAccounts.mockRejectedValueOnce(err);

    await expect(loadHouseholdConfigCached()).rejects.toBe(err);
    expect(hoisted.toHouseholdConfig).not.toHaveBeenCalled();
  });

  it('returns stale cache when the loader fails after a prior success, and extends expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T15:00:00.000Z'));

    const cfgA = makeConfig('A');
    hoisted.loadMeridianActiveAccounts.mockResolvedValueOnce({ accounts: [] });
    hoisted.toHouseholdConfig.mockReturnValueOnce(cfgA);

    await loadHouseholdConfigCached();
    vi.setSystemTime(new Date('2026-05-21T15:30:00.001Z'));

    hoisted.loadMeridianActiveAccounts.mockRejectedValueOnce(new Error('GCS exploded'));

    const stale = await loadHouseholdConfigCached();
    expect(stale).toBe(cfgA);

    hoisted.loadMeridianActiveAccounts.mockClear();
    hoisted.toHouseholdConfig.mockClear();
    vi.setSystemTime(new Date('2026-05-21T15:34:00.000Z'));

    const stillStale = await loadHouseholdConfigCached();
    expect(stillStale).toBe(cfgA);
    expect(hoisted.loadMeridianActiveAccounts).not.toHaveBeenCalled();
  });
});
