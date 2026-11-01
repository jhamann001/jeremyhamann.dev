import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getCachedClients, loadHouseholdConfigCached, mockPool, db } = vi.hoisted(() => {
  const db = { query: vi.fn(), release: vi.fn() };
  return {
    getCachedClients: vi.fn(),
    loadHouseholdConfigCached: vi.fn(),
    db,
    mockPool: { query: vi.fn(), connect: vi.fn(async () => db) },
  };
});
vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../../services/warehouse.js', () => ({ getCachedClients }));
vi.mock('../../services/householdConfigCache.js', () => ({ loadHouseholdConfigCached }));

import type { PoolClient } from 'pg';
import { holdDemoQuota, useFirmNames, withDemoQuota } from '../guards.js';

const body = (over: Record<string, unknown> = {}) => ({
  clientId: 'HH-1001',
  clientName: 'Anything a visitor typed',
  ...over,
}) as Parameters<typeof useFirmNames>[0];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PERSONA_SIGN_IN = 'on';
  getCachedClients.mockResolvedValue([
    { id: 'HH-1001', name: 'Alvarez Family', accounts: [] },
    { id: 'HH-1002', name: 'Okafor Household', accounts: [] },
  ]);
  loadHouseholdConfigCached.mockResolvedValue({ householdNames: new Set(['Alvarez Family']) });
});
afterEach(() => {
  delete process.env.PERSONA_SIGN_IN;
});

describe('useFirmNames (public demo)', () => {
  it("replaces the browser's client names with the firm's", async () => {
    const b = body({ clientIds: ['HH-1001', 'HH-1002'], clientNames: ['x', 'y'] });
    await useFirmNames(b);
    expect(b.clientName).toBe('Alvarez Family');
    expect(b.clientNames).toEqual(['Alvarez Family', 'Okafor Household']);
  });

  it('refuses an unknown client and manual entry', async () => {
    await expect(useFirmNames(body({ clientId: 'HH-9999' }))).rejects.toThrow(/Unknown client/);
    await expect(useFirmNames(body({ manualEntry: true }))).rejects.toThrow(/Manual client entry/);
    await expect(useFirmNames(body({ clientId: 'manual-123' }))).rejects.toThrow(/Manual client entry/);
  });

  it('keeps a known household tag and drops an unknown one', async () => {
    const known = body({ householdId: 7, householdName: 'Alvarez Family' });
    await useFirmNames(known);
    expect(known.householdName).toBe('Alvarez Family');
    const made_up = body({ householdId: 7, householdName: 'Some text a visitor sent' });
    await useFirmNames(made_up);
    expect([made_up.householdId, made_up.householdName]).toEqual([null, null]);
  });

  it('does nothing outside the demo', async () => {
    delete process.env.PERSONA_SIGN_IN;
    const b = body({ manualEntry: true });
    await useFirmNames(b);
    expect(b.clientName).toBe('Anything a visitor typed');
    expect(getCachedClients).not.toHaveBeenCalled();
  });
});

describe('demo caps', () => {
  const sqls = () => db.query.mock.calls.map(([sql]) => String(sql));
  const holding = (n: number) => db.query.mockImplementation(async (sql: string) => (/count\(\*\)/.test(sql) ? { rows: [{ n }] } : { rows: [] }));
  const client = db as unknown as PoolClient;

  it('locks the kind, then counts, inside the caller’s transaction', async () => {
    holding(10);
    await holdDemoQuota(client, 'requests', 1);
    expect(db.query.mock.calls[0]).toEqual(['SELECT pg_advisory_xact_lock($1::int, $2::int)', [7401, 1]]);
    expect(sqls()[1]).toMatch(/FROM trade_requests/);
  });

  it('allows a write that fills the cap exactly and refuses one that passes it', async () => {
    holding(28);
    await expect(holdDemoQuota(client, 'users', 2)).resolves.toBeUndefined();
    await expect(holdDemoQuota(client, 'users', 3)).rejects.toMatchObject({
      statusCode: 429,
      message: expect.stringMatching(/would add 3 with room for 2/),
    });
    holding(30);
    await expect(holdDemoQuota(client, 'users', 1)).rejects.toMatchObject({
      statusCode: 429,
      message: expect.stringMatching(/up to 30 users until its nightly reset .* try again tomorrow/),
    });
  });

  it('does nothing for a change that adds no rows, or outside the demo', async () => {
    await holdDemoQuota(client, 'exclusions', 0);
    await holdDemoQuota(client, 'exclusions', -3);
    delete process.env.PERSONA_SIGN_IN;
    await holdDemoQuota(client, 'exclusions', 5);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('withDemoQuota writes in the transaction that holds the cap', async () => {
    holding(3);
    const write = vi.fn(async (d: unknown) => (expect(d).toBe(db), 'row'));
    await expect(withDemoQuota('exclusions', 1, write)).resolves.toBe('row');
    expect(sqls()).toEqual(['BEGIN', expect.stringContaining('pg_advisory_xact_lock'), expect.stringMatching(/count/), 'COMMIT']);
    expect(db.release).toHaveBeenCalledTimes(1);
  });

  it('withDemoQuota rolls back without writing when the cap is full', async () => {
    holding(400);
    const write = vi.fn();
    await expect(withDemoQuota('exclusions', 1, write)).rejects.toMatchObject({ statusCode: 429 });
    expect(write).not.toHaveBeenCalled();
    expect(sqls().at(-1)).toBe('ROLLBACK');
    expect(db.release).toHaveBeenCalledTimes(1);
  });

  it('withDemoQuota writes straight to the pool outside the demo', async () => {
    delete process.env.PERSONA_SIGN_IN;
    const write = vi.fn(async () => 'row');
    await expect(withDemoQuota('users', 1, write)).resolves.toBe('row');
    expect(write).toHaveBeenCalledWith(mockPool);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });
});
