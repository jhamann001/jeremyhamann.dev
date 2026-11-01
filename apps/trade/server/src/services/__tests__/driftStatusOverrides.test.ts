import { describe, it, expect, vi, type Mock } from 'vitest';
import type { Pool } from 'pg';
import { sweepOverrideRechecks } from '../driftStatusOverrides.js';

function makePool(): Pool {
  return { query: vi.fn() } as unknown as Pool;
}

describe('sweepOverrideRechecks', () => {
  it('notifies the setter for each due override and stamps the marker (once)', async () => {
    const pool = makePool();
    const query = pool.query as unknown as Mock;
    query
      // 1) the SELECT of due re-checks
      .mockResolvedValueOnce({
        rows: [
          {
            account_id: '01ACCT0000000000000000000A',
            account_title: 'Sample Family Trust - Brokerage',
            reason: 'tax_constraint',
            set_by: 'user-1',
            expires_on: '2026-06-23',
          },
        ],
      })
      // 2) INSERT notification
      .mockResolvedValueOnce({ rows: [] })
      // 3) UPDATE recheck_notified_at
      .mockResolvedValueOnce({ rowCount: 1 });

    const sent = await sweepOverrideRechecks(pool);
    expect(sent).toBe(1);

    const calls = query.mock.calls;
    // notification inserted for the setter with a useful body
    const insert = calls.find((c) => String(c[0]).includes('INSERT INTO notifications'));
    expect(insert).toBeDefined();
    expect(insert?.[1]?.[0]).toBe('user-1');
    expect(String(insert?.[1]?.[1])).toMatch(/re-check due/i);
    expect(String(insert?.[1]?.[1])).toContain('Sample Family Trust');
    // marker stamped, guarded on recheck_notified_at IS NULL (no double-send)
    const update = calls.find((c) => String(c[0]).includes('UPDATE drift_status_overrides'));
    expect(String(update?.[0])).toMatch(/recheck_notified_at IS NULL/);
    expect(update?.[1]?.[0]).toBe('01ACCT0000000000000000000A');
  });

  it('sends nothing when no override has reached its re-check date', async () => {
    const pool = makePool();
    const query = pool.query as unknown as Mock;
    query.mockResolvedValueOnce({ rows: [] });

    const sent = await sweepOverrideRechecks(pool);
    expect(sent).toBe(0);
    // only the SELECT ran — no inserts/updates
    expect(query).toHaveBeenCalledTimes(1);
  });
});
