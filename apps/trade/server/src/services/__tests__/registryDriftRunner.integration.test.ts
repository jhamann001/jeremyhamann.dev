// WARNING: TRUNCATE wipes registry_drift_runs. Use a dedicated test DB locally — do NOT point DATABASE_URL at a dev DB you care about.
//
// Postgres integration test for `persistDriftRows` (the real INSERT INTO
// registry_drift_runs path). Closes the gap that let PR #51 (households.json
// runtime path) and PR #52 (missing account_count column) ship to prod
// undetected: the existing `registryDriftRunner.test.ts` mocks `pool.query`,
// so a column-list mismatch with the real schema was invisible to CI.
//
// Suite skips cleanly when DATABASE_URL is unset so local devs without
// Postgres aren't forced to stand one up. CI always has the service
// container declared in `.github/workflows/ci.yml` and migrations applied
// before the test step.
//
// Cleanup uses TRUNCATE in `beforeEach` rather than per-test BEGIN/ROLLBACK
// because `persistDriftRows` calls `pool.connect()` internally and runs its
// own BEGIN/COMMIT on a separate connection — the runner's COMMIT lands on
// a session the test cannot roll back. See plan rationale:
// docs/plans/2026-q2-drift-runner-integration-test.md (Open Question 3).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { persistDriftRows } from '../registryDriftRunner.js';
import { fetchDriftHistory } from '../driftHistoryQuery.js';
import { REGISTRY_SCHEMA_VERSION } from '../meridianRegistry.js';
import type { DriftHouseholdResult, DriftCoverageStatus } from '../registryDrift.js';

const DATABASE_URL = process.env.DATABASE_URL;

function makeHousehold(overrides: Partial<DriftHouseholdResult> = {}): DriftHouseholdResult {
  return {
    householdName: 'Test Household',
    coverageStatus: 'full',
    accountCount: 1,
    maxDeltaPct: 0,
    breach: false,
    worstSymbol: null,
    details: { accounts: [] },
    ...overrides,
  };
}

interface PgError extends Error {
  code?: string;
}

describe.skipIf(!DATABASE_URL)('persistDriftRows (Postgres integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Ensure the snapshot source is the documented default for assertions
    // below. The runner reads MERIDIAN_SNAPSHOT_SOURCE at insert time and
    // defaults to 'gcs' when unset.
    delete process.env.MERIDIAN_SNAPSHOT_SOURCE;
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE registry_drift_runs RESTART IDENTITY');
  });

  it('happy path: round-trips all 9 NOT NULL columns + nullable snapshot_as_of', async () => {
    // Regression intent: PR #52 — INSERT was missing the `account_count`
    // column, which is NOT NULL with CHECK (account_count >= 0). The
    // existing mocked test could not see this because pool.query was a
    // vi.fn() that accepted any arguments. This test executes the real
    // INSERT against the real schema and asserts every column the runner
    // is supposed to populate actually receives a non-null, type-correct
    // value.
    const runDateLocal = '2099-01-01';
    const snapshotAsOf = '2099-01-01T02:00:00.000Z';
    const household = makeHousehold({
      householdName: 'Whitaker Family',
      coverageStatus: 'full',
      accountCount: 3,
      maxDeltaPct: 12.5,
      breach: true,
      // 2026-Q3 cutover: worstSymbol now carries the bucket label
      // ('cash' | 'fixed' | 'equity'), not a ticker symbol.
      worstSymbol: 'equity',
      details: {
        accounts: [
          {
            accountNumber: 'ACC-001',
            maxDeltaPct: 12.5,
            // Bucket label, not ticker.
            worstSymbol: 'equity',
            // Inner-detail keys: { positions, meridian, delta } per S5.
            perSymbolDelta: { AAPL: { positions: 0.6, meridian: 0.475, delta: 0.125 } },
            perBucketDelta: { equity: { positions: 0.6, meridian: 0.475, delta: 0.125 } },
            coverage: 'both',
            flags: [],
          },
        ],
      },
    });

    const inserted = await persistDriftRows({
      pool,
      runDateLocal,
      snapshotAsOf,
      households: [household],
    });

    expect(inserted).toEqual(new Set(['Whitaker Family']));

    const { rows } = await pool.query(
      `SELECT
         to_char(run_date_local, 'YYYY-MM-DD') AS run_date_local,
         household_name,
         account_count,
         max_delta_pct::text AS max_delta_pct,
         breach,
         coverage_status,
         schema_version,
         snapshot_source,
         snapshot_as_of,
         details
       FROM registry_drift_runs
       WHERE household_name = $1`,
      ['Whitaker Family'],
    );

    expect(rows).toHaveLength(1);
    const row = rows[0] as {
      run_date_local: string;
      household_name: string;
      account_count: number;
      max_delta_pct: string;
      breach: boolean;
      coverage_status: string;
      schema_version: number;
      snapshot_source: string;
      snapshot_as_of: Date;
      details: Record<string, unknown>;
    };

    expect(row.run_date_local).toBe('2099-01-01');
    expect(row.household_name).toBe('Whitaker Family');
    expect(row.account_count).toBe(3);
    expect(row.max_delta_pct).toBe('12.5000');
    expect(row.breach).toBe(true);
    expect(row.coverage_status).toBe('full');
    expect(row.schema_version).toBe(REGISTRY_SCHEMA_VERSION);
    expect(row.snapshot_source).toBe('gcs');
    expect(row.snapshot_as_of).toBeInstanceOf(Date);
    expect(row.snapshot_as_of.toISOString()).toBe(snapshotAsOf);
    expect(row.details).toMatchObject({
      accountCount: 3,
      // 2026-Q3 cutover: worstSymbol carries the bucket label.
      worstSymbol: 'equity',
      accounts: [
        expect.objectContaining({
          accountNumber: 'ACC-001',
          maxDeltaPct: 12.5,
          worstSymbol: 'equity',
          coverage: 'both',
        }),
      ],
    });
  });

  it('idempotency: same-day re-run with same (run_date_local, household_name) returns empty inserted set', async () => {
    // Regression intent: the runner's ON CONFLICT DO NOTHING on the unique
    // constraint (run_date_local, household_name) is the contract Slack
    // alerting depends on — only "newly inserted" households generate an
    // alert, so a manual same-day retry must NOT re-fire alerts. A future
    // refactor that drops ON CONFLICT, drops the UNIQUE constraint, or
    // changes the conflict target would silently break that contract.
    // This test asserts the empty `inserted` set on the second call.
    const runDateLocal = '2099-02-01';
    const snapshotAsOf = '2099-02-01T02:00:00.000Z';
    const household = makeHousehold({ householdName: 'Example Household', breach: true });

    const firstInserted = await persistDriftRows({
      pool,
      runDateLocal,
      snapshotAsOf,
      households: [household],
    });
    expect(firstInserted).toEqual(new Set(['Example Household']));

    const secondInserted = await persistDriftRows({
      pool,
      runDateLocal,
      snapshotAsOf,
      households: [household],
    });
    expect(secondInserted).toEqual(new Set());

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM registry_drift_runs WHERE household_name = $1`, [
      'Example Household',
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('bulk insert: 5 households in a single call all land and all names returned in inserted set', async () => {
    // Regression intent: the runner persists households in a single
    // BEGIN/COMMIT loop. A future refactor that batches into a single
    // multi-row INSERT (or splits the loop across transactions) must still
    // return the correct set of household names AND must still write all
    // rows. Asserting both prevents silent regressions in the contract
    // that the alerter consumes (see registryDriftRunner.ts:229-234).
    const runDateLocal = '2099-03-01';
    const snapshotAsOf = '2099-03-01T02:00:00.000Z';
    const households = Array.from({ length: 5 }, (_, i) =>
      makeHousehold({
        householdName: `Bulk_Household_${i + 1}`,
        accountCount: i + 1,
        maxDeltaPct: i,
        breach: i % 2 === 0,
      }),
    );

    const inserted = await persistDriftRows({
      pool,
      runDateLocal,
      snapshotAsOf,
      households,
    });

    expect(inserted.size).toBe(5);
    for (const household of households) {
      expect(inserted.has(household.householdName)).toBe(true);
    }

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM registry_drift_runs WHERE run_date_local = $1`, [
      runDateLocal,
    ]);
    expect(rows[0].n).toBe(5);
  });

  it('coverage_status enum guard: every allowed value (full, partial, engine_only, meridian_only, unmapped_account) inserts cleanly', async () => {
    // Regression intent: the migration's CHECK constraint pins the allowed
    // coverage_status values to exactly the five `DriftCoverageStatus` TS
    // union members. If TS adds a sixth value or renames one, the schema
    // CHECK will reject it at INSERT time — this test enumerates each
    // value so the next reviewer of `DriftCoverageStatus` sees the
    // schema↔code coupling explicitly.
    const runDateLocal = '2099-04-01';
    const snapshotAsOf = '2099-04-01T02:00:00.000Z';
    const statuses: readonly DriftCoverageStatus[] = [
      'full',
      'partial',
      'engine_only',
      'meridian_only',
      'unmapped_account',
    ];
    const households = statuses.map((status) =>
      makeHousehold({ householdName: `Household_${status}`, coverageStatus: status }),
    );

    const inserted = await persistDriftRows({
      pool,
      runDateLocal,
      snapshotAsOf,
      households,
    });

    expect(inserted.size).toBe(statuses.length);

    const { rows } = await pool.query<{ coverage_status: string }>(
      `SELECT coverage_status FROM registry_drift_runs WHERE run_date_local = $1 ORDER BY coverage_status`,
      [runDateLocal],
    );
    expect(rows.map((r) => r.coverage_status).sort()).toEqual([...statuses].sort());
  });

  it('JSONB round-trip: details payload preserves shape including worstSymbol: null', async () => {
    // Regression intent: production code emits `worstSymbol: string | null`
    // (registryDrift.ts:46). A previous bug pattern to defend against:
    // serializing a JS undefined into the JSONB payload silently strips
    // the key, masking households with no per-symbol delta. This test
    // asserts BOTH a non-null worstSymbol AND an explicit null worstSymbol
    // round-trip with shape preserved.
    const runDateLocal = '2099-05-01';
    const snapshotAsOf = '2099-05-01T02:00:00.000Z';
    const withWorst = makeHousehold({
      householdName: 'WithWorst',
      worstSymbol: 'AAPL',
      maxDeltaPct: 8.25,
      breach: true,
      details: {
        accounts: [
          {
            accountNumber: 'ACC-AAA',
            maxDeltaPct: 8.25,
            worstSymbol: 'AAPL',
            perSymbolDelta: { AAPL: { engine: 0.5, meridian: 0.4175, delta: 0.0825 } },
            perBucketDelta: {},
            coverage: 'both',
            flags: ['fractional'],
          },
        ],
      },
    });
    const withoutWorst = makeHousehold({
      householdName: 'WithoutWorst',
      worstSymbol: null,
      details: {
        accounts: [
          {
            accountNumber: 'ACC-BBB',
            maxDeltaPct: 0,
            worstSymbol: null,
            perSymbolDelta: {},
            perBucketDelta: {},
            coverage: 'engine_only',
            flags: [],
          },
        ],
      },
    });

    await persistDriftRows({
      pool,
      runDateLocal,
      snapshotAsOf,
      households: [withWorst, withoutWorst],
    });

    const { rows } = await pool.query<{ household_name: string; details: Record<string, unknown> }>(
      `SELECT household_name, details FROM registry_drift_runs WHERE run_date_local = $1 ORDER BY household_name`,
      [runDateLocal],
    );
    expect(rows).toHaveLength(2);

    const withWorstRow = rows.find((r) => r.household_name === 'WithWorst');
    const withoutWorstRow = rows.find((r) => r.household_name === 'WithoutWorst');

    expect(withWorstRow?.details).toMatchObject({
      accountCount: 1,
      worstSymbol: 'AAPL',
      accounts: [
        expect.objectContaining({
          accountNumber: 'ACC-AAA',
          worstSymbol: 'AAPL',
          flags: ['fractional'],
        }),
      ],
    });

    // The null must round-trip as JSON null (not undefined / missing key).
    expect(withoutWorstRow?.details).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(withoutWorstRow!.details, 'worstSymbol')).toBe(true);
    expect(withoutWorstRow!.details.worstSymbol).toBeNull();
    expect(withoutWorstRow!.details).toMatchObject({
      accountCount: 1,
      worstSymbol: null,
      accounts: [
        expect.objectContaining({
          accountNumber: 'ACC-BBB',
          worstSymbol: null,
          coverage: 'engine_only',
        }),
      ],
    });
  });

  it('CHECK constraint guard: account_count: -1 is rejected by Postgres CHECK (account_count >= 0)', async () => {
    // Regression intent: the migration declares
    //   CHECK (account_count >= 0)
    // (server/migrations/20260512000002_registry-drift-runs.sql:17). This
    // exists to defend against a future refactor that computes
    // `accountCount` differently than `accounts.length` and produces a
    // negative value. PR #52's class of bug — schema↔code mismatch — is
    // exactly what this test catches at CI time.
    const runDateLocal = '2099-06-01';
    const snapshotAsOf = '2099-06-01T02:00:00.000Z';
    const malformed = makeHousehold({
      householdName: 'Malformed',
      accountCount: -1,
    });

    const err = (await persistDriftRows({
      pool,
      runDateLocal,
      snapshotAsOf,
      households: [malformed],
    }).catch((e: unknown) => e)) as PgError;

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('23514'); // pg check_violation SQLSTATE

    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM registry_drift_runs WHERE household_name = $1`,
      ['Malformed'],
    );
    expect(rows[0].n).toBe(0);
  });

  it('fetchDriftHistory returns only the latest run per run_date_local', async () => {
    // Regression intent: HISTORY_SQL must scope each calendar date to rows
    // from the latest run_started_at. The runner uses
    // `ON CONFLICT (run_date_local, household_name) DO NOTHING` (preserves
    // Slack idempotency on same-day retries), so when the household_name
    // set changes between runs (e.g. a mid-day deploy that re-keys
    // households.json) the older runs' rows for households dropped from
    // later runs persist forever in the table. Without the dedup join the
    // dashboard stacks pre-deploy + post-deploy data on the same date.
    // See docs/plans/2026-q3-drift-refresh-and-dedup.md.
    await pool.query('TRUNCATE registry_drift_runs RESTART IDENTITY CASCADE');

    // Far-future run_date so the row never ages out of fetchDriftHistory's
    // rolling 30-day window (mirrors the 2099 dates used by the other cases in
    // this file). run_started_at only needs morning < evening for ordering.
    const runDateLocal = '2099-06-12';
    const morningStartedAt = '2026-05-12 22:00:00Z';
    const eveningStartedAt = '2026-05-13 02:00:00Z';
    const insertSql = `INSERT INTO registry_drift_runs (
        run_date_local, run_started_at, household_name, account_count,
        max_delta_pct, breach, coverage_status, schema_version,
        snapshot_source, snapshot_as_of, details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

    // Morning run: a stale unmapped bucket that no longer appears after
    // the post-deploy run.
    await pool.query(insertSql, [
      runDateLocal,
      morningStartedAt,
      '__unmapped__:01OLD1',
      1,
      0,
      false,
      'unmapped_account',
      REGISTRY_SCHEMA_VERSION,
      'gcs',
      '2026-05-12T22:00:00.000Z',
      { accounts: [] },
    ]);

    // Evening (post-deploy) run: a real household plus a different
    // unmapped bucket. The morning's `__unmapped__:01OLD1` does not
    // collide and would otherwise persist.
    await pool.query(insertSql, [
      runDateLocal,
      eveningStartedAt,
      'Real Household',
      3,
      4.5,
      false,
      'full',
      REGISTRY_SCHEMA_VERSION,
      'gcs',
      '2026-05-13T02:00:00.000Z',
      { accounts: [] },
    ]);
    await pool.query(insertSql, [
      runDateLocal,
      eveningStartedAt,
      '__unmapped__:01NEW1',
      1,
      0,
      false,
      'unmapped_account',
      REGISTRY_SCHEMA_VERSION,
      'gcs',
      '2026-05-13T02:00:00.000Z',
      { accounts: [] },
    ]);

    const history = await fetchDriftHistory(pool, 30);
    const namesForDate = history
      .filter((row) => row.runDateLocal === runDateLocal)
      .map((row) => row.householdName)
      .sort();

    expect(namesForDate).toEqual(['Real Household', '__unmapped__:01NEW1']);
    expect(namesForDate).not.toContain('__unmapped__:01OLD1');
  });

  it('fetchDriftHistory returns rows from the latest run when household names overlap', async () => {
    // Regression intent: this is the exact production bug pattern that
    // PR #57's HISTORY_SQL change exposed. After PR #57, the dashboard
    // filters rows by MAX(run_started_at) per run_date_local. The runner
    // used to do `ON CONFLICT (run_date_local, household_name) DO NOTHING`,
    // which left rows from the *prior* same-day run with their original
    // run_started_at — and those overlapping-name rows then got silently
    // masked by the dashboard. Operators saw 17 rows instead of 78.
    //
    // The fix: ON CONFLICT DO UPDATE SET run_started_at = EXCLUDED.run_started_at
    // refreshes the timestamp on overlapping households so they show up in
    // the latest-run view; (xmax = 0) AS inserted RETURNING keeps Slack
    // alerts idempotent (only newly-inserted rows go in the Set).
    //
    // This case asserts both halves end-to-end:
    //   1. persistDriftRows' returned Set excludes UPDATED households.
    //   2. fetchDriftHistory returns the overlapping household (because its
    //      run_started_at was refreshed to the evening run) AND the
    //      brand-new evening household, while still masking the
    //      morning-only stale row.
    await pool.query('TRUNCATE registry_drift_runs RESTART IDENTITY CASCADE');

    // Far-future run_date so the row never ages out of fetchDriftHistory's
    // rolling 30-day window (mirrors the 2099 dates used by the other cases in
    // this file). run_started_at only needs morning < evening for ordering.
    const runDateLocal = '2099-07-12';
    const morningStartedAt = '2026-05-12 22:00:00Z';
    const eveningStartedAt = '2026-05-13 02:00:00Z';
    const morningInsertSql = `INSERT INTO registry_drift_runs (
        run_date_local, run_started_at, household_name, account_count,
        max_delta_pct, breach, coverage_status, schema_version,
        snapshot_source, snapshot_as_of, details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

    // Morning run: a real household whose name will repeat in the evening
    // run (this is what triggered the production bug — its run_started_at
    // never got refreshed, so HISTORY_SQL masked it), and a stale unmapped
    // bucket whose name will NOT appear in the evening run.
    await pool.query(morningInsertSql, [
      runDateLocal,
      morningStartedAt,
      'Real Household A',
      2,
      0,
      false,
      'full',
      REGISTRY_SCHEMA_VERSION,
      'gcs',
      '2026-05-12T22:00:00.000Z',
      { accounts: [] },
    ]);
    await pool.query(morningInsertSql, [
      runDateLocal,
      morningStartedAt,
      '__unmapped__:01OLD1',
      1,
      0,
      false,
      'unmapped_account',
      REGISTRY_SCHEMA_VERSION,
      'gcs',
      '2026-05-12T22:00:00.000Z',
      { accounts: [] },
    ]);

    // Evening run via the production code path. Note we cannot pin
    // run_started_at via persistDriftRows (it relies on the column DEFAULT
    // now()), so we assert the relative ordering after the call: the
    // 'Real Household A' row must end up with a run_started_at AFTER the
    // morning timestamp (the UPDATE happened) and at-or-after the
    // brand-new 'Real Household B' row in the same call (same transaction
    // → same now()).
    const insertedSet = await persistDriftRows({
      pool,
      runDateLocal,
      snapshotAsOf: '2026-05-13T02:00:00.000Z',
      households: [
        makeHousehold({
          householdName: 'Real Household A',
          coverageStatus: 'full',
          accountCount: 2,
          maxDeltaPct: 4.5,
        }),
        makeHousehold({
          householdName: 'Real Household B',
          coverageStatus: 'full',
          accountCount: 3,
          maxDeltaPct: 1.0,
        }),
      ],
    });

    // Half 1: Slack-alert idempotency — only the genuinely-new household
    // is in the returned Set. 'Real Household A' was UPDATEd on conflict
    // (xmax != 0), so it is excluded.
    expect(insertedSet).toEqual(new Set(['Real Household B']));

    // Half 2: HISTORY_SQL returns both real households (because the UPDATE
    // refreshed Real Household A's run_started_at to match Real Household
    // B's), and excludes the morning-only stale unmapped bucket.
    const history = await fetchDriftHistory(pool, 30);
    const namesForDate = history
      .filter((row) => row.runDateLocal === runDateLocal)
      .map((row) => row.householdName)
      .sort();
    expect(namesForDate).toEqual(['Real Household A', 'Real Household B']);
    expect(namesForDate).not.toContain('__unmapped__:01OLD1');

    // Direct SQL verification: the UPDATE actually moved Real Household
    // A's run_started_at past the morning timestamp. This is the
    // observable invariant that proves the fix at the row level.
    const { rows: timestampRows } = await pool.query<{
      household_name: string;
      run_started_at: Date;
    }>(
      `SELECT household_name, run_started_at
         FROM registry_drift_runs
         WHERE run_date_local = $1
         ORDER BY household_name`,
      [runDateLocal],
    );
    const byName = new Map(timestampRows.map((r) => [r.household_name, r.run_started_at]));
    const morningDate = new Date(morningStartedAt);
    expect(byName.get('Real Household A')!.getTime()).toBeGreaterThan(morningDate.getTime());
    expect(byName.get('Real Household B')!.getTime()).toBeGreaterThan(morningDate.getTime());
    // Same-transaction now(): A and B should share the evening timestamp.
    expect(byName.get('Real Household A')!.getTime()).toBe(byName.get('Real Household B')!.getTime());
    // The stale morning-only row keeps its original timestamp — that's
    // what causes HISTORY_SQL to mask it.
    expect(byName.get('__unmapped__:01OLD1')!.getTime()).toBe(morningDate.getTime());
  });
});
