// Postgres integration test for the `client_exclusions` table.
//
// Closes the gap that pure unit tests (mocked pool) can't see: schema
// constraints — the (client_id, ticker, kind) UNIQUE, the kind CHECK, the
// VARCHAR widths, and the round-trip of every NOT NULL column. Mirrors the
// pattern established in `registryDriftRunner.integration.test.ts`.
//
// Suite skips cleanly when DATABASE_URL is unset. CI runs Postgres as a
// service container with migrations applied before tests.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

interface PgError extends Error {
  code?: string;
}

describe.skipIf(!DATABASE_URL)('client_exclusions (Postgres integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE client_exclusions RESTART IDENTITY');
  });

  it('round-trips a row with all NOT NULL columns populated', async () => {
    const { rows } = await pool.query(
      `INSERT INTO client_exclusions (client_id, ticker, kind, reason, created_by_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, client_id, ticker, kind, reason, created_by_name, created_at`,
      ['CLIENT-WAREHOUSE-UUID-1234567890', 'TSLA', 'advisor', 'Concentration risk', 'Rachel Moss'],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      client_id: 'CLIENT-WAREHOUSE-UUID-1234567890',
      ticker: 'TSLA',
      kind: 'advisor',
      reason: 'Concentration risk',
      created_by_name: 'Rachel Moss',
    });
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it('rejects a duplicate (client_id, ticker, kind) with 23505', async () => {
    await pool.query(
      `INSERT INTO client_exclusions (client_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)`,
      ['C-1', 'TSLA', 'advisor', 'Rachel'],
    );

    let err: PgError | null = null;
    try {
      await pool.query(
        `INSERT INTO client_exclusions (client_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)`,
        ['C-1', 'TSLA', 'advisor', 'Sam'],
      );
    } catch (e) {
      err = e as PgError;
    }

    expect(err).not.toBeNull();
    expect(err?.code).toBe('23505');
  });

  it('allows the same ticker on the same client when kinds differ', async () => {
    await pool.query(
      `INSERT INTO client_exclusions (client_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)`,
      ['C-1', 'TSLA', 'advisor', 'Rachel'],
    );
    await pool.query(
      `INSERT INTO client_exclusions (client_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)`,
      ['C-1', 'TSLA', 'client', 'Rachel'],
    );

    const { rows } = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM client_exclusions WHERE client_id = $1 AND ticker = $2`,
      ['C-1', 'TSLA'],
    );
    expect(rows[0].c).toBe('2');
  });

  it('rejects an invalid kind value via CHECK constraint', async () => {
    let err: PgError | null = null;
    try {
      await pool.query(
        `INSERT INTO client_exclusions (client_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)`,
        ['C-2', 'AAPL', 'bogus', 'Rachel'],
      );
    } catch (e) {
      err = e as PgError;
    }
    expect(err).not.toBeNull();
    // 23514 == check_violation
    expect(err?.code).toBe('23514');
  });

  it('accepts a 100-char client_id (matches trade_requests.client_id width)', async () => {
    const longId = 'X'.repeat(100);
    const { rowCount } = await pool.query(
      `INSERT INTO client_exclusions (client_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)`,
      [longId, 'AAPL', 'advisor', 'Rachel'],
    );
    expect(rowCount).toBe(1);
  });

  it('does not require created_by — null is allowed (audit-trail survivability)', async () => {
    const { rows } = await pool.query<{ created_by: string | null; created_by_name: string }>(
      `INSERT INTO client_exclusions (client_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)
       RETURNING created_by, created_by_name`,
      ['C-1', 'XOM', 'advisor', 'Departed User'],
    );
    expect(rows[0].created_by).toBeNull();
    expect(rows[0].created_by_name).toBe('Departed User');
  });

  // ─── v3.4 (DNB / DNS structure) ─────────────────────────────────────────

  it('defaults no_buy and no_sell to TRUE when an INSERT omits the flag columns (v3.4 backfill guard)', async () => {
    // Critical regression door: a future migration that drops the DEFAULT TRUE
    // on either column would silently change behavior for every existing
    // caller that doesn't set the flags (notably v3.3 OpenAPI consumers and
    // the pre-migration prod rows). This test verifies the DEFAULT actually
    // fires.
    const { rows } = await pool.query<{ no_buy: boolean; no_sell: boolean }>(
      `INSERT INTO client_exclusions (client_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)
       RETURNING no_buy, no_sell`,
      ['C-1', 'TSLA', 'advisor', 'Rachel'],
    );
    expect(rows[0].no_buy).toBe(true);
    expect(rows[0].no_sell).toBe(true);
  });

  it('rejects a row with both no_buy=false AND no_sell=false via CHECK (v3.4 CHECK guard)', async () => {
    // Defense-in-depth: the server's Zod schema rejects this before the DB
    // hit, but the CHECK constraint is the last line of defense for any
    // future code path that bypasses Zod (direct SQL from a script, a
    // refactor that loses the refine, etc.).
    let err: PgError | null = null;
    try {
      await pool.query(
        `INSERT INTO client_exclusions (client_id, ticker, kind, no_buy, no_sell, created_by_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['C-1', 'TSLA', 'advisor', false, false, 'Rachel'],
      );
    } catch (e) {
      err = e as PgError;
    }
    expect(err).not.toBeNull();
    // 23514 == check_violation
    expect(err?.code).toBe('23514');
  });

  it('accepts a DNB-only row (no_buy=true, no_sell=false)', async () => {
    const { rows } = await pool.query<{ no_buy: boolean; no_sell: boolean }>(
      `INSERT INTO client_exclusions (client_id, ticker, kind, no_buy, no_sell, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING no_buy, no_sell`,
      ['C-1', 'TSLA', 'advisor', true, false, 'Rachel'],
    );
    expect(rows[0]).toEqual({ no_buy: true, no_sell: false });
  });

  it('accepts a DNS-only row (no_buy=false, no_sell=true)', async () => {
    const { rows } = await pool.query<{ no_buy: boolean; no_sell: boolean }>(
      `INSERT INTO client_exclusions (client_id, ticker, kind, no_buy, no_sell, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING no_buy, no_sell`,
      ['C-1', 'AAPL', 'advisor', false, true, 'Rachel'],
    );
    expect(rows[0]).toEqual({ no_buy: false, no_sell: true });
  });
});
