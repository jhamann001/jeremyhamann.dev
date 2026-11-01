// WARNING: TRUNCATE wipes position_drift_accounts. Use a dedicated test DB
// locally — do NOT point DATABASE_URL at a dev DB you care about.
//
// Postgres integration test for `persistAccountDriftRows` (the real INSERT
// INTO position_drift_accounts path) + `fetchAccountDriftHistory`. Mirrors
// the v1 pattern in `registryDriftRunner.integration.test.ts`: skips when
// DATABASE_URL is unset so devs without Postgres aren't forced to set one
// up. CI is expected to apply the v2 migration before this suite runs.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  persistAccountDriftRows,
  fetchAccountDriftHistory,
  fetchAccountDriftRun,
  fetchLatestDriftAllocationsByAccountId,
  ACCOUNT_DRIFT_SCHEMA_VERSION,
  type PersistAccountDriftRowsInput,
} from '../positionDriftAccountsPersistence.js';
import type { AccountDriftResult } from '../positionDriftAccounts.js';

const DATABASE_URL = process.env.DATABASE_URL;

// Run date is computed relative to "now" rather than hardcoded. `fetchAccountDriftHistory`
// filters on `run_date_local >= CURRENT_DATE - (lookback - 1)`, so a fixed past date
// eventually ages out of the rolling window and the happy-path fetch returns nothing.
// (That is exactly what broke on 2026-06-12: the old hardcoded '2026-05-13' fell one day
// outside the 30-day window.) A few days back keeps it safely inside any reasonable
// lookback while staying clear of the same-day timezone boundary.
const RUN_DATE_LOCAL = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 5);
  return d.toISOString().slice(0, 10);
})();

function makeAccount(overrides: Partial<AccountDriftResult> = {}): AccountDriftResult {
  return {
    accountId: 'TESTACCT001',
    accountTitle: 'Test Account',
    household: 'Test Household',
    unmapped: false,
    templateMissing: false,
    totalValue: 100,
    maxBucketDeltaPct: 0,
    worstBucket: 'cash',
    symbolBreachCount: 0,
    status: 'in',
    details: {
      buckets: {
        cash: { positionPct: 1, templatePct: 1, deltaPct: 0 },
        fixed: { positionPct: 0, templatePct: 0, deltaPct: 0 },
        equity: { positionPct: 99, templatePct: 99, deltaPct: 0 },
      },
      symbolsWithTargets: [],
      equityHoldings: [],
      positionOnlySymbols: [],
      suspectedCashEquivMisclassified: [],
    },
    ...overrides,
  };
}

interface PgError extends Error {
  code?: string;
}

describe.skipIf(!DATABASE_URL)('persistAccountDriftRows (Postgres integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE position_drift_accounts');
  });

  const baseInput = (): Omit<PersistAccountDriftRowsInput, 'accounts'> => ({
    pool,
    runDateLocal: RUN_DATE_LOCAL,
    runStartedAt: new Date('2026-05-13T13:00:00.000Z'),
    snapshotSource: 'gcs',
    snapshotAsOf: '2026-05-12T00:00:00.000Z',
    tolerancePct: 5,
    uninvestedCashThresholdPct: 99,
    schemaVersion: ACCOUNT_DRIFT_SCHEMA_VERSION,
  });

  it('Case 1 — happy path: 3 accounts inserted, schema_version persisted', async () => {
    const accounts = [
      makeAccount({ accountId: 'A1', maxBucketDeltaPct: 1.5 }),
      makeAccount({ accountId: 'A2', maxBucketDeltaPct: 12.3, status: 'out' }),
      makeAccount({ accountId: 'A3', maxBucketDeltaPct: 0.2 }),
    ];
    const inserted = await persistAccountDriftRows({ ...baseInput(), accounts });
    expect(inserted).toEqual(new Set(['A1', 'A2', 'A3']));

    const history = await fetchAccountDriftHistory(pool, 30);
    expect(history).toHaveLength(3);
    for (const row of history) {
      expect(row.schemaVersion).toBe(ACCOUNT_DRIFT_SCHEMA_VERSION);
    }
    expect(history.find((r) => r.accountId === 'A2')?.status).toBe('out');
  });

  it('Case 2 — idempotency: re-run with same (run_date_local, account_id) yields empty inserted set and refreshes run_started_at', async () => {
    const account = makeAccount({ accountId: 'A1' });
    await persistAccountDriftRows({ ...baseInput(), accounts: [account] });

    const later = new Date('2026-05-13T15:00:00.000Z');
    const inserted = await persistAccountDriftRows({
      ...baseInput(),
      runStartedAt: later,
      accounts: [account],
    });
    expect(inserted.size).toBe(0);

    // fetchAccountDriftRun returns the latest run with the refreshed timestamp.
    const run = await fetchAccountDriftRun(pool, RUN_DATE_LOCAL);
    expect(run).not.toBeNull();
    expect(new Date(run!.runStartedAt).getTime()).toBe(later.getTime());
  });

  it('Case 3 — coverage CHECK: valid values insert; bad value rejected with SQLSTATE 23514', async () => {
    // `no_template` rows carry null maxBucketDeltaPct / worstBucket. The
    // 2026-05-13-no-template-status migration both extends the status
    // CHECK and drops NOT NULL on max_bucket_delta_pct so this insert
    // works without a SQLSTATE 23502 violation.
    for (const status of ['in', 'out', 'uninvested', 'no_template'] as const) {
      const account = makeAccount(
        status === 'no_template'
          ? { accountId: `STATUS_${status}`, status, maxBucketDeltaPct: null, worstBucket: null }
          : { accountId: `STATUS_${status}`, status },
      );
      await persistAccountDriftRows({ ...baseInput(), accounts: [account] });
    }
    // Direct INSERT with bad coverage value.
    try {
      await pool.query(
        `INSERT INTO position_drift_accounts (
           run_date_local, account_id, coverage, status, schema_version, snapshot_source, details
         ) VALUES ('2026-05-13', 'BAD', 'rubbish', 'in', 1, 'gcs', '{}'::jsonb)`,
      );
      throw new Error('expected SQLSTATE 23514 violation');
    } catch (err) {
      expect((err as PgError).code).toBe('23514');
    }
  });

  it('Case 4 — status CHECK rejects an invalid status with SQLSTATE 23514', async () => {
    try {
      await pool.query(
        `INSERT INTO position_drift_accounts (
           run_date_local, account_id, coverage, status, schema_version, snapshot_source, details
         ) VALUES ('2026-05-13', 'BAD', 'both', 'rubbish', 1, 'gcs', '{}'::jsonb)`,
      );
      throw new Error('expected SQLSTATE 23514 violation');
    } catch (err) {
      expect((err as PgError).code).toBe('23514');
    }
  });

  it('Case 5 — B1 regression: schema_version NOT NULL guard rejects with SQLSTATE 23502 when omitted', async () => {
    try {
      await pool.query(
        `INSERT INTO position_drift_accounts (
           run_date_local, account_id, coverage, status, snapshot_source, details
         ) VALUES ('2026-05-13', 'BAD', 'both', 'in', 'gcs', '{}'::jsonb)`,
      );
      throw new Error('expected SQLSTATE 23502 violation');
    } catch (err) {
      expect((err as PgError).code).toBe('23502');
    }
  });
});

describe.skipIf(!DATABASE_URL)('fetchLatestDriftAllocationsByAccountId (Postgres integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE position_drift_accounts');
  });

  const baseInput = (): Omit<PersistAccountDriftRowsInput, 'accounts'> => ({
    pool,
    runDateLocal: '2026-05-13',
    runStartedAt: new Date('2026-05-13T13:00:00.000Z'),
    snapshotSource: 'gcs',
    snapshotAsOf: '2026-05-12T00:00:00.000Z',
    tolerancePct: 5,
    uninvestedCashThresholdPct: 99,
    schemaVersion: ACCOUNT_DRIFT_SCHEMA_VERSION,
  });

  it('returns current allocation + target + drift keyed by accountId, only for requested ids', async () => {
    await persistAccountDriftRows({
      ...baseInput(),
      accounts: [
        makeAccount({
          accountId: 'SIB1',
          maxBucketDeltaPct: 8,
          worstBucket: 'equity',
          totalValue: 250_000,
          details: {
            buckets: {
              cash: { positionPct: 5, templatePct: 2, deltaPct: 3 },
              fixed: { positionPct: 27, templatePct: 30, deltaPct: 3 },
              equity: { positionPct: 68, templatePct: 60, deltaPct: 8 },
            },
            symbolsWithTargets: [],
            equityHoldings: [],
            positionOnlySymbols: [],
            suspectedCashEquivMisclassified: [],
          },
        }),
        makeAccount({ accountId: 'OTHER', maxBucketDeltaPct: 1 }),
      ],
    });

    const map = await fetchLatestDriftAllocationsByAccountId(pool, ['SIB1']);
    expect(map.size).toBe(1);
    const sib = map.get('SIB1');
    expect(sib).toMatchObject({
      runDateLocal: '2026-05-13',
      status: 'in',
      totalValueUsd: 250_000,
      positionCashPct: 5,
      positionFixedPct: 27,
      positionEquityPct: 68,
      templateCashPct: 2,
      templateFixedPct: 30,
      templateEquityPct: 60,
      maxBucketDeltaPct: 8,
      worstBucket: 'equity',
    });
    expect(map.has('OTHER')).toBe(false);
  });

  it('reads from the latest run date only', async () => {
    await persistAccountDriftRows({
      ...baseInput(),
      runDateLocal: '2026-05-12',
      runStartedAt: new Date('2026-05-12T13:00:00.000Z'),
      accounts: [makeAccount({ accountId: 'SIB1', maxBucketDeltaPct: 99 })],
    });
    await persistAccountDriftRows({
      ...baseInput(),
      runDateLocal: '2026-05-13',
      runStartedAt: new Date('2026-05-13T13:00:00.000Z'),
      accounts: [makeAccount({ accountId: 'SIB1', maxBucketDeltaPct: 3 })],
    });

    const map = await fetchLatestDriftAllocationsByAccountId(pool, ['SIB1']);
    expect(map.get('SIB1')?.runDateLocal).toBe('2026-05-13');
    expect(map.get('SIB1')?.maxBucketDeltaPct).toBe(3);
  });

  it('returns a no_template row with a null drift delta', async () => {
    await persistAccountDriftRows({
      ...baseInput(),
      accounts: [
        makeAccount({ accountId: 'NOTPL', status: 'no_template', maxBucketDeltaPct: null, worstBucket: null }),
      ],
    });
    const map = await fetchLatestDriftAllocationsByAccountId(pool, ['NOTPL']);
    expect(map.get('NOTPL')).toMatchObject({ status: 'no_template', maxBucketDeltaPct: null, worstBucket: null });
  });

  it('returns an empty map for empty input without querying', async () => {
    const map = await fetchLatestDriftAllocationsByAccountId(pool, []);
    expect(map.size).toBe(0);
  });

  it('returns an empty map when no rows match', async () => {
    await persistAccountDriftRows({ ...baseInput(), accounts: [makeAccount({ accountId: 'SIB1' })] });
    const map = await fetchLatestDriftAllocationsByAccountId(pool, ['NOPE']);
    expect(map.size).toBe(0);
  });
});
