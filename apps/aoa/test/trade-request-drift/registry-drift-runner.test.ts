import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from '@/lib/trade-requests/pg-compat';

const {
  // Legacy mocks — kept alive for the N10 `not.toHaveBeenCalled()` assertions
  // that prove the runner no longer routes through the engine pipeline. They
  // are wired into the legacy modules so any accidental re-import inside the
  // runner would visibly call them.
  buildRegistryMock,
  compareRegistryToMeridianMock,
  // New mocks — the actual production wiring after the 2026-Q3 cutover.
  fetchAccountPositionsMock,
  comparePositionsToMeridianMock,
  loadMeridianTemplatesMock,
  loadMeridianActiveAccountsMock,
  toHouseholdConfigMock,
  postDriftAlertMock,
  // v2 per-account mocks (2026-Q3 drift v2 cutover).
  comparePositionsToMeridianPerAccountMock,
  persistAccountDriftRowsMock,
  postAccountDriftAlertMock,
  computeRunDateMock,
  loggerMock,
} = vi.hoisted(() => ({
  buildRegistryMock: vi.fn(),
  compareRegistryToMeridianMock: vi.fn(),
  fetchAccountPositionsMock: vi.fn(),
  comparePositionsToMeridianMock: vi.fn(),
  loadMeridianTemplatesMock: vi.fn(),
  loadMeridianActiveAccountsMock: vi.fn(),
  toHouseholdConfigMock: vi.fn(),
  postDriftAlertMock: vi.fn(),
  comparePositionsToMeridianPerAccountMock: vi.fn(),
  persistAccountDriftRowsMock: vi.fn(),
  postAccountDriftAlertMock: vi.fn(),
  computeRunDateMock: vi.fn(() => '2026-05-12'),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/trade-requests/sources/meridian-snapshot', async () => {
  class SnapshotLoadError extends Error {
    public readonly status = 503;
    public readonly source: string;
    constructor(message: string, source: string) {
      super(message);
      this.name = 'SnapshotLoadError';
      this.source = source;
    }
  }
  return { SnapshotLoadError };
});
vi.mock('@/lib/trade-requests/sources/meridian-templates', () => ({
  loadMeridianTemplates: loadMeridianTemplatesMock,
}));
vi.mock('@/lib/trade-requests/sources/meridian-active-accounts', async () => {
  class ActiveAccountsLoadError extends Error {
    public readonly status = 503;
    public readonly source: string;
    constructor(message: string, source: string) {
      super(message);
      this.name = 'ActiveAccountsLoadError';
      this.source = source;
    }
  }
  return {
    ActiveAccountsLoadError,
    loadMeridianActiveAccounts: loadMeridianActiveAccountsMock,
    toHouseholdConfig: toHouseholdConfigMock,
  };
});
vi.mock('@/lib/trade-requests/drift/position-drift', () => ({
  comparePositionsToMeridian: comparePositionsToMeridianMock,
}));
vi.mock('@/lib/trade-requests/sources/warehouse', () => ({
  fetchAccountPositions: fetchAccountPositionsMock,
  // Cost-basis enrichment is additive and config-gated; these unit tests focus
  // on the drift persistence/alert path, so the check reports "not configured"
  // and the step is skipped. Dedicated coverage lives in
  // costBasisEnrichment.test.ts / costBasisFreshness.test.ts.
  isWarehouseQueryConfigured: () => false,
  fetchCostBasisData: vi.fn(),
}));
vi.mock('@/lib/trade-requests/drift/position-drift-accounts', () => ({
  comparePositionsToMeridianPerAccount: comparePositionsToMeridianPerAccountMock,
  DEFAULT_UNINVESTED_CASH_THRESHOLD_PCT: 99,
  DEFAULT_TOLERANCE_PCT: 5,
}));
vi.mock('@/lib/trade-requests/drift/position-drift-accounts-persistence', () => ({
  persistAccountDriftRows: persistAccountDriftRowsMock,
  ACCOUNT_DRIFT_SCHEMA_VERSION: 1,
}));
vi.mock('@/lib/trade-requests/drift/position-drift-accounts-alert', () => ({
  postAccountDriftAlert: postAccountDriftAlertMock,
}));
vi.mock('@/lib/trade-requests/drift/run-date', () => ({
  computeRunDate: computeRunDateMock,
}));
vi.mock('@/lib/trade-requests/log', () => ({ default: loggerMock }));

import { runDriftCheck } from '@/lib/trade-requests/drift/registry-drift-runner';
import { SnapshotLoadError } from '@/lib/trade-requests/sources/meridian-snapshot';

const LIVE = { kind: 'live', stillSender: async () => true } as const;

function makePool(): {
  pool: Pool;
  clientQuery: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
} {
  const clientQuery = vi.fn();
  const release = vi.fn();
  const client = { query: clientQuery, release };
  // ticket: the port runs persistence through pool.transaction; this fake records the same BEGIN/COMMIT/ROLLBACK
  // sequence and releases once, so the standalone assertions below hold unchanged.
  const connect = vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => {
    await clientQuery('BEGIN');
    try {
      const out = await fn(client);
      await clientQuery('COMMIT');
      return out;
    } catch (err) {
      await clientQuery('ROLLBACK');
      throw err;
    } finally {
      release();
    }
  });
  const pool = { query: vi.fn(), transaction: connect, end: vi.fn() } as unknown as Pool;
  return { pool, clientQuery, release, connect };
}

function insertCalls(clientQuery: ReturnType<typeof vi.fn>): unknown[][] {
  return clientQuery.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && /INSERT INTO trade_request.registry_drift_runs/.test(sql),
  );
}

function txControlCalls(clientQuery: ReturnType<typeof vi.fn>): string[] {
  return clientQuery.mock.calls
    .map(([sql]) => (typeof sql === 'string' ? sql.trim().toUpperCase() : ''))
    .filter((sql) => sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK');
}

beforeEach(() => {
  vi.clearAllMocks();
  loadMeridianActiveAccountsMock.mockResolvedValue({
    generatedAt: '2026-05-12T02:00:00.000Z',
    firmId: 'test',
    accountCount: 0,
    rawRowCount: 0,
    accounts: [],
  });
  toHouseholdConfigMock.mockReturnValue({
    byAccountNumber: new Map(),
    householdNames: new Set(),
    entries: [],
  });
  fetchAccountPositionsMock.mockResolvedValue(new Map());
  loadMeridianTemplatesMock.mockResolvedValue({
    generatedAt: '2026-05-12T02:00:00.000Z',
    entries: [],
  });
  postDriftAlertMock.mockResolvedValue({ sent: false, alertingHouseholds: [], suppressedAllowListed: [] });
  comparePositionsToMeridianPerAccountMock.mockReturnValue({
    accounts: [],
    unmappedPositionsAccountIds: [],
    unmappedSnapshotAccountIds: [],
    suspectedCashEquivMisclassified: [],
  });
  persistAccountDriftRowsMock.mockResolvedValue(new Set<string>());
  postAccountDriftAlertMock.mockResolvedValue({
    sent: false,
    alertingAccountIds: [],
    suppressedAllowListed: [],
  });
});

afterEach(() => {
  delete process.env.DRIFT_ALERTS_ENABLED;
  delete process.env.MERIDIAN_SNAPSHOT_SOURCE;
});

describe('runDriftCheck', () => {
  it('persists one row per household with ON CONFLICT DO UPDATE and returns a summary', async () => {
    const { pool, clientQuery, release, connect } = makePool();
    comparePositionsToMeridianMock.mockReturnValue({
      households: [
        {
          householdName: 'Foo',
          coverageStatus: 'full',
          accountCount: 2,
          maxDeltaPct: 12,
          breach: true,
          worstSymbol: 'equity',
          details: { accounts: [] },
        },
        {
          householdName: 'Bar',
          coverageStatus: 'full',
          accountCount: 1,
          maxDeltaPct: 1,
          breach: false,
          worstSymbol: null,
          details: { accounts: [] },
        },
      ],
      unmappedPositionsAccounts: [],
      unmappedSnapshotAccounts: [],
    });
    clientQuery.mockImplementation(async (sql: string) => {
      if (/^\s*BEGIN/i.test(sql) || /^\s*COMMIT/i.test(sql) || /^\s*ROLLBACK/i.test(sql)) {
        return { rows: [] };
      }
      // INSERT — RETURNING household_name, (xmax = 0) AS inserted. Stub both
      // calls as freshly-inserted (xmax=0 path) so both count toward the
      // returned Set; the conflict path is covered by the dedicated test
      // below ("preserves ON CONFLICT idempotency...").
      return { rows: [{ household_name: 'x', inserted: true }] };
    });

    const summary = await runDriftCheck({ pool }, LIVE);

    const inserts = insertCalls(clientQuery);
    expect(inserts).toHaveLength(2);
    expect(inserts[0][0]).toMatch(
      /ON CONFLICT \(run_date_local, household_name\) DO UPDATE\s+SET run_started_at = EXCLUDED\.run_started_at/,
    );
    expect(inserts[0][0]).toMatch(/RETURNING household_name, \(xmax = 0\) AS inserted/);
    expect(txControlCalls(clientQuery)).toEqual(['BEGIN', 'COMMIT']);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(summary.totalHouseholds).toBe(2);
    expect(summary.breachHouseholds).toBe(1);
    expect(summary.insertedRows).toBe(2);

    // N10: AC §9 Box 3 — runDriftCheck no longer calls the legacy engine
    // pipeline. Asserted explicitly so a future regression that re-wires
    // buildRegistry / compareRegistryToMeridian into the runner trips CI.
    expect(buildRegistryMock).not.toHaveBeenCalled();
    expect(compareRegistryToMeridianMock).not.toHaveBeenCalled();
    // ...and the new pipeline IS invoked.
    expect(fetchAccountPositionsMock).toHaveBeenCalledTimes(1);
    expect(comparePositionsToMeridianMock).toHaveBeenCalledTimes(1);
  });

  it('passes only inserted-household names to the alerter for idempotency', async () => {
    const { pool, clientQuery } = makePool();
    comparePositionsToMeridianMock.mockReturnValue({
      households: [
        {
          householdName: 'Already',
          coverageStatus: 'full',
          accountCount: 1,
          maxDeltaPct: 10,
          breach: true,
          worstSymbol: 'equity',
          details: { accounts: [] },
        },
        {
          householdName: 'Fresh',
          coverageStatus: 'full',
          accountCount: 1,
          maxDeltaPct: 11,
          breach: true,
          worstSymbol: 'equity',
          details: { accounts: [] },
        },
      ],
      unmappedPositionsAccounts: [],
      unmappedSnapshotAccounts: [],
    });
    let insertN = 0;
    clientQuery.mockImplementation(async (sql: string) => {
      if (/^\s*BEGIN|^\s*COMMIT|^\s*ROLLBACK/i.test(sql)) return { rows: [] };
      insertN += 1;
      // First INSERT: ON CONFLICT path. With DO UPDATE, RETURNING still
      // yields a row, but `inserted` is false (xmax != 0 = was an update).
      // This row must NOT go in the Slack-alert Set.
      if (insertN === 1) return { rows: [{ household_name: 'Already', inserted: false }] };
      // Second INSERT: brand-new row, xmax = 0, inserted = true.
      return { rows: [{ household_name: 'Fresh', inserted: true }] };
    });

    const summary = await runDriftCheck({ pool }, LIVE);

    // v1 Slack alert is retired, but the inserted-row idempotency it relied on
    // is still observable via insertedRows: the updated 'Already' row (xmax!=0)
    // is excluded, only the freshly-inserted 'Fresh' row is counted.
    expect(summary.insertedRows).toBe(1);
    expect(postDriftAlertMock).not.toHaveBeenCalled();
  });

  it('aborts without writing rows when the snapshot fails to load', async () => {
    const { pool, clientQuery, connect } = makePool();
    loadMeridianTemplatesMock.mockRejectedValueOnce(new SnapshotLoadError('boom', 'gcs'));

    await expect(runDriftCheck({ pool }, LIVE)).rejects.toBeInstanceOf(SnapshotLoadError);
    expect(clientQuery).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(postDriftAlertMock).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'drift_run_aborted' }),
      expect.any(String),
    );
  });

  it('counts unmapped-account households when computing the alert footnote', async () => {
    const { pool, clientQuery } = makePool();
    comparePositionsToMeridianMock.mockReturnValue({
      households: [
        {
          householdName: '__unmapped__:**STRAY',
          coverageStatus: 'unmapped_account',
          accountCount: 1,
          maxDeltaPct: 0,
          breach: false,
          worstSymbol: null,
          details: { accounts: [] },
        },
        {
          householdName: 'Foo',
          coverageStatus: 'full',
          accountCount: 1,
          maxDeltaPct: 10,
          breach: true,
          worstSymbol: 'equity',
          details: { accounts: [] },
        },
      ],
      unmappedPositionsAccounts: ['**STRAY'],
      unmappedSnapshotAccounts: [],
    });
    clientQuery.mockResolvedValue({ rows: [{ household_name: 'x', inserted: true }] });

    await runDriftCheck({ pool }, LIVE);

    // v1 Slack alert retired — the unmapped-account-household count now lands
    // in the drift_run_complete log as `unmappedSnapshotInBreachCount`.
    expect(postDriftAlertMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'drift_run_complete', unmappedSnapshotInBreachCount: 1 }),
      expect.any(String),
    );
  });

  it('rolls back the entire persistence loop on a mid-loop INSERT failure (no partial state)', async () => {
    const { pool, clientQuery, release, connect } = makePool();
    comparePositionsToMeridianMock.mockReturnValue({
      households: [
        {
          householdName: 'First',
          coverageStatus: 'full',
          accountCount: 1,
          maxDeltaPct: 10,
          breach: true,
          worstSymbol: 'equity',
          details: { accounts: [] },
        },
        {
          householdName: 'Second',
          coverageStatus: 'full',
          accountCount: 1,
          maxDeltaPct: 11,
          breach: true,
          worstSymbol: 'equity',
          details: { accounts: [] },
        },
        {
          householdName: 'Third',
          coverageStatus: 'full',
          accountCount: 1,
          maxDeltaPct: 12,
          breach: true,
          worstSymbol: 'equity',
          details: { accounts: [] },
        },
      ],
      unmappedPositionsAccounts: [],
      unmappedSnapshotAccounts: [],
    });

    let insertSeen = 0;
    clientQuery.mockImplementation(async (sql: string) => {
      if (/^\s*BEGIN/i.test(sql) || /^\s*COMMIT/i.test(sql) || /^\s*ROLLBACK/i.test(sql)) {
        return { rows: [] };
      }
      insertSeen += 1;
      // First INSERT lands; second throws; third must never execute.
      if (insertSeen === 1) return { rows: [{ household_name: 'First', inserted: true }] };
      if (insertSeen === 2) throw new Error('simulated pg failure on the second INSERT');
      throw new Error('third INSERT should not run after a rollback');
    });

    await expect(runDriftCheck({ pool }, LIVE)).rejects.toThrow(/simulated pg failure/);

    const inserts = insertCalls(clientQuery);
    expect(inserts).toHaveLength(2);
    const tx = txControlCalls(clientQuery);
    expect(tx).toContain('BEGIN');
    expect(tx).toContain('ROLLBACK');
    expect(tx).not.toContain('COMMIT');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(postDriftAlertMock).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'drift_run_persistence_failed' }),
      expect.any(String),
    );
  });

  it('emits drift_unmapped_detail event with the actual account ID arrays (positions side)', async () => {
    const { pool, clientQuery } = makePool();
    comparePositionsToMeridianMock.mockReturnValue({
      households: [
        {
          householdName: 'Foo',
          coverageStatus: 'full',
          accountCount: 1,
          maxDeltaPct: 1,
          breach: false,
          worstSymbol: null,
          details: { accounts: [] },
        },
      ],
      unmappedPositionsAccounts: ['POS_A', 'POS_B'],
      unmappedSnapshotAccounts: ['SNAP_X'],
    });
    clientQuery.mockResolvedValue({ rows: [{ household_name: 'Foo', inserted: true }] });

    await runDriftCheck({ pool }, LIVE);

    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'drift_unmapped_detail',
        unmappedPositionsAccounts: ['POS_A', 'POS_B'],
        unmappedSnapshotAccounts: ['SNAP_X'],
        unmappedPositionsAccountCount: 2,
        unmappedSnapshotAccountCount: 1,
      }),
      'drift unmapped detail',
    );
  });

  it('preserves ON CONFLICT idempotency inside the transaction (updated rows still commit cleanly and are excluded from the alert Set)', async () => {
    const { pool, clientQuery, release } = makePool();
    comparePositionsToMeridianMock.mockReturnValue({
      households: [
        {
          householdName: 'AlreadyToday',
          coverageStatus: 'full',
          accountCount: 1,
          maxDeltaPct: 10,
          breach: true,
          worstSymbol: 'equity',
          details: { accounts: [] },
        },
        {
          householdName: 'NewToday',
          coverageStatus: 'full',
          accountCount: 1,
          maxDeltaPct: 11,
          breach: true,
          worstSymbol: 'equity',
          details: { accounts: [] },
        },
      ],
      unmappedPositionsAccounts: [],
      unmappedSnapshotAccounts: [],
    });
    let insertN = 0;
    clientQuery.mockImplementation(async (sql: string) => {
      if (/^\s*BEGIN|^\s*COMMIT|^\s*ROLLBACK/i.test(sql)) return { rows: [] };
      insertN += 1;
      // First call simulates the ON CONFLICT DO UPDATE path (the row
      // already existed from an earlier retry today): RETURNING yields a
      // row but `inserted = false` (xmax != 0). Second call lands a brand
      // new row (xmax = 0, inserted = true).
      if (insertN === 1) return { rows: [{ household_name: 'AlreadyToday', inserted: false }] };
      return { rows: [{ household_name: 'NewToday', inserted: true }] };
    });

    const summary = await runDriftCheck({ pool }, LIVE);

    expect(insertCalls(clientQuery)).toHaveLength(2);
    expect(txControlCalls(clientQuery)).toEqual(['BEGIN', 'COMMIT']);
    // insertedRows=1 proves the updated 'AlreadyToday' row (xmax!=0) is excluded
    // and only the freshly-inserted 'NewToday' row counts — the same idempotency
    // the (now-retired) v1 Slack alert used to assert via its inserted-name Set.
    expect(summary.insertedRows).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(postDriftAlertMock).not.toHaveBeenCalled();
  });

  // ─── v2 per-account pipeline assertions (drift v2 cutover) ─────────────
  it('invokes BOTH v1 and v2 comparators exactly once per runDriftCheck', async () => {
    const { pool, clientQuery } = makePool();
    comparePositionsToMeridianMock.mockReturnValue({
      households: [],
      unmappedPositionsAccounts: [],
      unmappedSnapshotAccounts: [],
    });
    clientQuery.mockResolvedValue({ rows: [] });

    await runDriftCheck({ pool }, LIVE);

    expect(comparePositionsToMeridianMock).toHaveBeenCalledTimes(1);
    expect(comparePositionsToMeridianPerAccountMock).toHaveBeenCalledTimes(1);
  });

  it('passes the v2 comparator result.accounts straight to persistAccountDriftRows', async () => {
    const { pool, clientQuery } = makePool();
    const v2Accounts = [
      {
        accountId: 'ACCT_A',
        accountTitle: 'A',
        household: 'H',
        unmapped: false,
        templateMissing: false,
        totalValue: 100,
        maxBucketDeltaPct: 1,
        worstBucket: 'cash' as const,
        symbolBreachCount: 0,
        status: 'in' as const,
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
      },
    ];
    comparePositionsToMeridianMock.mockReturnValue({
      households: [],
      unmappedPositionsAccounts: [],
      unmappedSnapshotAccounts: [],
    });
    comparePositionsToMeridianPerAccountMock.mockReturnValue({
      accounts: v2Accounts,
      unmappedPositionsAccountIds: [],
      unmappedSnapshotAccountIds: [],
      suspectedCashEquivMisclassified: [],
    });
    clientQuery.mockResolvedValue({ rows: [] });

    await runDriftCheck({ pool }, LIVE);

    expect(persistAccountDriftRowsMock).toHaveBeenCalledTimes(1);
    const persistArgs = persistAccountDriftRowsMock.mock.calls[0][0];
    expect(persistArgs.accounts).toEqual(v2Accounts);
    expect(persistArgs.schemaVersion).toBe(1);
  });

  it('populates summary.accountDrift from the v2 comparator + persistence result', async () => {
    const { pool, clientQuery } = makePool();
    comparePositionsToMeridianMock.mockReturnValue({
      households: [],
      unmappedPositionsAccounts: [],
      unmappedSnapshotAccounts: [],
    });
    comparePositionsToMeridianPerAccountMock.mockReturnValue({
      accounts: [
        { status: 'out' } as never,
        { status: 'out' } as never,
        { status: 'uninvested' } as never,
        { status: 'in' } as never,
      ],
      unmappedPositionsAccountIds: [],
      unmappedSnapshotAccountIds: [],
      suspectedCashEquivMisclassified: [],
    });
    persistAccountDriftRowsMock.mockResolvedValue(new Set(['A', 'B', 'C']));
    postAccountDriftAlertMock.mockResolvedValue({
      sent: true,
      alertingAccountIds: ['A', 'B'],
      suppressedAllowListed: [],
    });
    clientQuery.mockResolvedValue({ rows: [] });

    const summary = await runDriftCheck({ pool }, LIVE);

    expect(summary.accountDrift.totalAccounts).toBe(4);
    expect(summary.accountDrift.outAccounts).toBe(2);
    expect(summary.accountDrift.uninvestedAccounts).toBe(1);
    expect(summary.accountDrift.insertedRows).toBe(3);
    expect(summary.accountDrift.alert).toEqual({
      sent: true,
      alertingAccountIds: ['A', 'B'],
      suppressedAllowListed: [],
    });
  });
});
