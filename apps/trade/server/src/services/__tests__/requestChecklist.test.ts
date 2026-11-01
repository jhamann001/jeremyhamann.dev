import { describe, it, expect, vi, type Mock } from 'vitest';
import type { Pool } from 'pg';
import { fetchChecklist, setChecklistItem } from '../requestChecklist.js';

function makePool(): Pool {
  return { query: vi.fn() } as unknown as Pool;
}

describe('fetchChecklist', () => {
  it('returns {} when the column is null, null when the request is missing', async () => {
    const pool = makePool();
    const q = pool.query as unknown as Mock;
    q.mockResolvedValueOnce({ rows: [{ preapproval_checklist: null }] });
    await expect(fetchChecklist(pool, 'REQ-1')).resolves.toEqual({});
    q.mockResolvedValueOnce({ rows: [] });
    await expect(fetchChecklist(pool, 'MISSING')).resolves.toBeNull();
  });
});

describe('setChecklistItem', () => {
  it('upserts the item and stamps who/when when the request is open', async () => {
    const pool = makePool();
    const q = pool.query as unknown as Mock;
    q.mockResolvedValueOnce({ rows: [{ status: 'Pending Review' }] }); // status check
    q.mockResolvedValueOnce({ rows: [{ preapproval_checklist: { transition: { checked: true } } }] }); // update

    const res = await setChecklistItem(
      pool,
      'REQ-1',
      'transition',
      { checked: true, value: 'Risk 20' },
      'Jeremy Hamann',
    );
    expect(res.ok).toBe(true);

    const update = q.mock.calls.find((c) => String(c[0]).includes('UPDATE trade_requests'));
    expect(update?.[1]?.[1]).toBe('transition'); // jsonb path key
    const stamped = JSON.parse(String(update?.[1]?.[2]));
    expect(stamped).toMatchObject({ checked: true, value: 'Risk 20', by: 'Jeremy Hamann' });
    expect(typeof stamped.at).toBe('string');
  });

  it('refuses (locked) once the request is in a terminal status', async () => {
    const pool = makePool();
    const q = pool.query as unknown as Mock;
    q.mockResolvedValueOnce({ rows: [{ status: 'Approved' }] });
    const res = await setChecklistItem(pool, 'REQ-1', 'templates', { checked: true }, 'Jeremy');
    expect(res).toEqual({ ok: false, reason: 'locked' });
    // no UPDATE issued
    expect(q.mock.calls.some((c) => String(c[0]).includes('UPDATE'))).toBe(false);
  });

  it('returns not_found when the request does not exist', async () => {
    const pool = makePool();
    const q = pool.query as unknown as Mock;
    q.mockResolvedValueOnce({ rows: [] });
    const res = await setChecklistItem(pool, 'MISSING', 'templates', { checked: true }, 'Jeremy');
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });
});
