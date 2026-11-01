import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

interface PgError extends Error {
  code?: string;
}

describe.skipIf(!DATABASE_URL)('account_exclusions (Postgres integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE account_exclusions RESTART IDENTITY');
  });

  it('round-trips a row with all NOT NULL columns populated', async () => {
    const { rows } = await pool.query(
      `INSERT INTO account_exclusions (account_id, ticker, kind, reason, created_by_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, account_id, ticker, kind, reason, created_by_name, created_at`,
      ['01SYNTHSCGWTDXKE4Q6DRDHJNX', 'TSLA', 'client', 'Concentration risk', 'Rachel Moss'],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: '01SYNTHSCGWTDXKE4Q6DRDHJNX',
      ticker: 'TSLA',
      kind: 'client',
      reason: 'Concentration risk',
      created_by_name: 'Rachel Moss',
    });
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it('rejects a duplicate (account_id, ticker, kind) with 23505', async () => {
    await pool.query(
      `INSERT INTO account_exclusions (account_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)`,
      ['01SYNTHSCGWTDXKE4Q6DRDHJNX', 'TSLA', 'client', 'Rachel'],
    );

    let err: PgError | null = null;
    try {
      await pool.query(
        `INSERT INTO account_exclusions (account_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)`,
        ['01SYNTHSCGWTDXKE4Q6DRDHJNX', 'TSLA', 'client', 'Sam'],
      );
    } catch (e) {
      err = e as PgError;
    }

    expect(err).not.toBeNull();
    expect(err?.code).toBe('23505');
  });

  it('allows the same ticker on the same account when kinds differ', async () => {
    await pool.query(
      `INSERT INTO account_exclusions (account_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)`,
      ['01SYNTHSCGWTDXKE4Q6DRDHJNX', 'TSLA', 'advisor', 'Rachel'],
    );
    await pool.query(
      `INSERT INTO account_exclusions (account_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)`,
      ['01SYNTHSCGWTDXKE4Q6DRDHJNX', 'TSLA', 'client', 'Rachel'],
    );

    const { rows } = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM account_exclusions WHERE account_id = $1 AND ticker = $2`,
      ['01SYNTHSCGWTDXKE4Q6DRDHJNX', 'TSLA'],
    );
    expect(rows[0].c).toBe('2');
  });

  it('rejects an invalid kind value via CHECK constraint', async () => {
    let err: PgError | null = null;
    try {
      await pool.query(
        `INSERT INTO account_exclusions (account_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)`,
        ['01SYNTHSCGWTDXKE4Q6DRDHJNX', 'AAPL', 'bogus', 'Rachel'],
      );
    } catch (e) {
      err = e as PgError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('23514');
  });

  it('accepts a 100-char account_id', async () => {
    const longId = 'A'.repeat(100);
    const { rowCount } = await pool.query(
      `INSERT INTO account_exclusions (account_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)`,
      [longId, 'AAPL', 'advisor', 'Rachel'],
    );
    expect(rowCount).toBe(1);
  });

  it('does not require created_by — null is allowed', async () => {
    const { rows } = await pool.query<{ created_by: string | null; created_by_name: string }>(
      `INSERT INTO account_exclusions (account_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)
       RETURNING created_by, created_by_name`,
      ['01SYNTHSCGWTDXKE4Q6DRDHJNX', 'XOM', 'advisor', 'Departed User'],
    );
    expect(rows[0].created_by).toBeNull();
    expect(rows[0].created_by_name).toBe('Departed User');
  });

  it('defaults no_buy and no_sell to TRUE when flags are omitted', async () => {
    const { rows } = await pool.query<{ no_buy: boolean; no_sell: boolean }>(
      `INSERT INTO account_exclusions (account_id, ticker, kind, created_by_name) VALUES ($1, $2, $3, $4)
       RETURNING no_buy, no_sell`,
      ['01SYNTHSCGWTDXKE4Q6DRDHJNX', 'TSLA', 'advisor', 'Rachel'],
    );
    expect(rows[0].no_buy).toBe(true);
    expect(rows[0].no_sell).toBe(true);
  });

  it('rejects a row with both no_buy=false AND no_sell=false via CHECK', async () => {
    let err: PgError | null = null;
    try {
      await pool.query(
        `INSERT INTO account_exclusions (account_id, ticker, kind, no_buy, no_sell, created_by_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['01SYNTHSCGWTDXKE4Q6DRDHJNX', 'TSLA', 'advisor', false, false, 'Rachel'],
      );
    } catch (e) {
      err = e as PgError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('23514');
  });

  it('accepts a DNB-only row (no_buy=true, no_sell=false)', async () => {
    const { rows } = await pool.query<{ no_buy: boolean; no_sell: boolean }>(
      `INSERT INTO account_exclusions (account_id, ticker, kind, no_buy, no_sell, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING no_buy, no_sell`,
      ['01SYNTHSCGWTDXKE4Q6DRDHJNX', 'TSLA', 'advisor', true, false, 'Rachel'],
    );
    expect(rows[0]).toEqual({ no_buy: true, no_sell: false });
  });

  it('accepts a DNS-only row (no_buy=false, no_sell=true)', async () => {
    const { rows } = await pool.query<{ no_buy: boolean; no_sell: boolean }>(
      `INSERT INTO account_exclusions (account_id, ticker, kind, no_buy, no_sell, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING no_buy, no_sell`,
      ['01SYNTHSCGWTDXKE4Q6DRDHJNX', 'AAPL', 'advisor', false, true, 'Rachel'],
    );
    expect(rows[0]).toEqual({ no_buy: false, no_sell: true });
  });
});
