import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPool } = vi.hoisted(() => ({
  mockPool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock('../../db/pool.js', () => ({ default: mockPool }));

import { findRecentDuplicate } from '../requestQueries.js';

const probe = {
  advisorId: 'advisor-uuid',
  clientId: 'HH-001',
  tradeType: 'Raise Cash',
  tradeAmount: '$50,000',
  selectedAccounts: ['ACCT-1001', 'ACCT-1002'],
};

/**
 * The route tests stub this function at the service seam, so its SQL is only
 * covered here. What matters: the predicate is narrow enough not to suppress
 * legitimate requests, and wide enough to catch a retry that the idempotency
 * key missed.
 */
describe('findRecentDuplicate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [] });
  });

  it('returns the id of the most recent matching request', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] });

    await expect(findRecentDuplicate(probe)).resolves.toBe('REQ-12345678');
  });

  it('returns null when nothing matches', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(findRecentDuplicate(probe)).resolves.toBeNull();
  });

  it('passes the probe fields as parameters, in order, with the window last', async () => {
    await findRecentDuplicate(probe);

    const [, params] = mockPool.query.mock.calls[0];
    expect(params.slice(0, 5)).toEqual([
      probe.advisorId,
      probe.clientId,
      probe.tradeType,
      probe.tradeAmount,
      probe.selectedAccounts,
    ]);
    // Window is bounded to the retry window, not "any duplicate ever".
    expect(params[5]).toBe(300);
  });

  it('excludes Rejected requests so a legitimate resubmission is not suppressed', async () => {
    await findRecentDuplicate(probe);

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/status\s*<>\s*'Rejected'/);
  });

  it('normalizes account order on both sides of the comparison', async () => {
    await findRecentDuplicate(probe);

    const [sql] = mockPool.query.mock.calls[0];
    // Same selection submitted twice is not guaranteed to arrive in the same
    // order, and `selected_accounts` is a text[] — so both sides get sorted.
    const sortedUnnests = sql.match(/ARRAY\(SELECT unnest\([^)]*\) ORDER BY 1\)/g);
    expect(sortedUnnests).toHaveLength(2);
  });

  it('scopes to a single advisor', async () => {
    await findRecentDuplicate(probe);

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/advisor_id\s*=\s*\$1/);
  });

  it('treats a null trade amount as a match against null (not a mismatch)', async () => {
    await findRecentDuplicate({ ...probe, tradeAmount: null });

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/trade_amount IS NOT DISTINCT FROM \$4/);
    expect(params[3]).toBeNull();
  });
});
