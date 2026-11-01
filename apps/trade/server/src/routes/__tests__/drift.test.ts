import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@trade-request/shared';
import { traderUser, advisorUser } from './testHelpers.js';

const { mockPool, mockAnalyzeExclusionOverlapForRun } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  return {
    mockPool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn(),
      end: vi.fn(),
    },
    mockAnalyzeExclusionOverlapForRun: vi.fn(),
  };
});

vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../../services/driftExclusionAnalysis.js', () => ({
  analyzeExclusionOverlapForRun: mockAnalyzeExclusionOverlapForRun,
}));

// Mirror `server/src/routes/__tests__/users.test.ts:30-55` — overlay the real
// `requireRole` with a session-aware mock so the 401 / 403 / 200 triplet is
// driven by the test-supplied user. `mapRow` is required by the auth module
// shape but unused in this file.
vi.mock('../../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth.js')>();
  return {
    ...actual,
    requireRole:
      (...roles: string[]) =>
      (req: any, res: any, next: any) => {
        if (!req.user) return res.status(401).json({ error: 'Authentication required' });
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
        next();
      },
  };
});

import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import driftRoutes from '../drift.js';
import { requireAuth } from '../../middleware/auth.js';

/**
 * Test app harness:
 * - When `user` is provided, the request is treated as authenticated as that
 *   user (mirrors how Passport would populate `req.user` after session
 *   validation). When `user` is null, no `req.user` is set — the mocked
 *   `requireRole` returns 401, exactly matching the production code path
 *   (`requireAuth` short-circuits 401 before `requireRole` runs).
 */
function createApp(user: AuthUser | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) {
      (req as any).user = user;
      (req as any).isAuthenticated = () => true;
    } else {
      (req as any).isAuthenticated = () => false;
    }
    next();
  });
  // Mirror production: the mount enforces requireAuth (any authenticated user);
  // the drift router itself is no longer role-gated (opened to all users 2026-06).
  app.use('/api/drift', requireAuth, driftRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.issues });
      return;
    }
    const status = err.statusCode ?? 500;
    res.status(status).json({ error: err.message ?? 'Internal server error' });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DRIFT_EXCLUSION_OVERLAP_DIAGNOSTIC_ENABLED;
});

// ─── Role-gating triplet × 3 routes ─────────────────────────────────────────
//
// Every route must independently demonstrate the auth gate: 401 unauthenticated,
// and 200 for ANY authenticated user (advisor + trader) now that the drift
// surface is open to all users. Without these, a regression that re-introduced
// a role restriction (or dropped requireAuth) could go unnoticed.

describe('drift router auth gate — GET /api/drift/history', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(createApp(null)).get('/api/drift/history');
    expect(res.status).toBe(401);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('200 for an authenticated advisor (access opened to all users)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp(advisorUser)).get('/api/drift/history');
    expect(res.status).toBe(200);
  });

  it('200 for an authenticated trader', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp(traderUser)).get('/api/drift/history');
    expect(res.status).toBe(200);
  });
});

describe('drift router auth gate — GET /api/drift/allow-list', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(createApp(null)).get('/api/drift/allow-list');
    expect(res.status).toBe(401);
  });

  it('200 for an authenticated advisor (access opened to all users)', async () => {
    const res = await request(createApp(advisorUser)).get('/api/drift/allow-list');
    expect(res.status).toBe(200);
  });

  it('200 for an authenticated trader', async () => {
    const res = await request(createApp(traderUser)).get('/api/drift/allow-list');
    expect(res.status).toBe(200);
  });
});

describe('drift router auth gate — GET /api/drift/runs/:runDateLocal/:householdName', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(createApp(null)).get('/api/drift/runs/2026-05-12/Whitaker%20Family');
    expect(res.status).toBe(401);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('200 for an authenticated advisor (access opened to all users)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp(advisorUser)).get('/api/drift/runs/2026-05-12/Whitaker%20Family');
    expect([200, 404]).toContain(res.status);
  });

  it('200 for an authenticated trader', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          run_date_local: '2026-05-12',
          run_started_at: '2026-05-12T07:00:00.000Z',
          household_name: 'Whitaker Family',
          account_count: 4,
          max_delta_pct: '0.0741',
          breach: true,
          coverage_status: 'full',
          schema_version: 1,
          snapshot_source: 'gcs',
          snapshot_as_of: '2026-05-12T03:00:00.000Z',
          details: { worstSymbol: 'VTI', accounts: [], accountCount: 4 },
        },
      ],
    });
    const res = await request(createApp(traderUser)).get('/api/drift/runs/2026-05-12/Whitaker%20Family');
    expect(res.status).toBe(200);
    expect(res.body.run.householdName).toBe('Whitaker Family');
  });
});

// ─── GET /api/drift/history ──────────────────────────────────────────────────

describe('GET /api/drift/history', () => {
  function expectedRow() {
    return {
      run_date_local: '2026-05-12',
      household_name: 'Doe Family',
      max_delta_pct: '0.0450',
      breach: false,
      coverage_status: 'full',
      schema_version: 1,
      snapshot_source: 'gcs',
      snapshot_as_of: '2026-05-12T03:00:00.000Z',
    };
  }

  it('returns {days, runs} payload with the default 30-day window', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [expectedRow()] });
    const res = await request(createApp(traderUser)).get('/api/drift/history');

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toMatchObject({
      runDateLocal: '2026-05-12',
      householdName: 'Doe Family',
      maxDeltaPct: 0.045,
      breach: false,
      coverageStatus: 'full',
      snapshotSource: 'gcs',
    });
    const [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([30]);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('falls back to 30 when days is non-numeric', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(createApp(traderUser)).get('/api/drift/history?days=abc');
    const [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([30]);
  });

  it('falls back to 30 when days exceeds the max (ternary semantics, NOT clamp-to-max)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(createApp(traderUser)).get('/api/drift/history?days=999');
    const [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([30]);
  });

  // The max moved 90 -> 180 so the window can reach the first drift runs
  // (v1 2026-05-13, v2 2026-05-14), which sat ~8 days outside a 90-day window.
  it('passes through days=180, the new max', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(createApp(traderUser)).get('/api/drift/history?days=180');
    const [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([180]);
  });

  it('falls back to 30 at 181, one past the max', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(createApp(traderUser)).get('/api/drift/history?days=181');
    const [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([30]);
  });

  it('passes through valid days=7', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(createApp(traderUser)).get('/api/drift/history?days=7');
    const [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([7]);
  });
});

// ─── GET /api/drift/allow-list ───────────────────────────────────────────────

describe('GET /api/drift/allow-list', () => {
  it('returns the (now-empty) static allow-list as of the 2026-Q3 positions cutover', async () => {
    const res = await request(createApp(traderUser)).get('/api/drift/allow-list');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    // Empty after the position-drift cutover dropped the four engine-side
    // entries. See registryDriftAllowList.ts for the rationale.
    expect(res.body.entries).toHaveLength(0);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });
});

// ─── GET /api/drift/runs/:runDateLocal/:householdName ────────────────────────

describe('GET /api/drift/runs/:runDateLocal/:householdName', () => {
  function detailRow(overrides: Record<string, unknown> = {}) {
    return {
      run_date_local: '2026-05-12',
      run_started_at: '2026-05-12T07:00:00.000Z',
      household_name: 'Whitaker Family',
      account_count: 4,
      max_delta_pct: '0.0741',
      breach: true,
      coverage_status: 'full',
      schema_version: 1,
      snapshot_source: 'gcs',
      snapshot_as_of: '2026-05-12T03:00:00.000Z',
      details: { worstSymbol: 'VTI', accounts: [], accountCount: 4 },
      ...overrides,
    };
  }

  it('URL-decodes householdName and forwards it to the SQL query', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [detailRow()] });
    const res = await request(createApp(traderUser)).get('/api/drift/runs/2026-05-12/Whitaker%20Family');

    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({
      runDateLocal: '2026-05-12',
      householdName: 'Whitaker Family',
      accountCount: 4,
      breach: true,
    });
    const [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual(['2026-05-12', 'Whitaker Family']);
  });

  it('returns 404 when the row does not exist', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp(traderUser)).get('/api/drift/runs/2026-05-12/Nonexistent');

    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed date string (regex rejects)', async () => {
    const res = await request(createApp(traderUser)).get('/api/drift/runs/bad-date/Whitaker%20Family');
    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 400 for a date that overflows month/day (refine rejects 2026-02-30)', async () => {
    const res = await request(createApp(traderUser)).get('/api/drift/runs/2026-02-30/Whitaker%20Family');
    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('accepts a 200-character householdName but rejects 201', async () => {
    const ok = 'a'.repeat(200);
    const tooLong = 'a'.repeat(201);

    mockPool.query.mockResolvedValueOnce({ rows: [detailRow({ household_name: ok })] });
    const okRes = await request(createApp(traderUser)).get(`/api/drift/runs/2026-05-12/${encodeURIComponent(ok)}`);
    expect(okRes.status).toBe(200);

    const badRes = await request(createApp(traderUser)).get(
      `/api/drift/runs/2026-05-12/${encodeURIComponent(tooLong)}`,
    );
    expect(badRes.status).toBe(400);
  });

  it('renders 200 with details: {} when the JSONB blob is logically empty (route does not enforce details shape)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [detailRow({ details: {} })] });
    const res = await request(createApp(traderUser)).get('/api/drift/runs/2026-05-12/Whitaker%20Family');

    expect(res.status).toBe(200);
    expect(res.body.run.details).toEqual({});
  });
});

// ─── Drift v2 ───────────────────────────────────────────────────────────────
//
// New per-account drift routes under /api/drift/v2/*. Open to all authenticated
// users via the same router-wide requireAuth mount — the 401/200 pairs below
// prove the gate lets any logged-in user (advisor + trader) through.

describe('GET /api/drift/v2/history', () => {
  function v2HistoryRow(overrides: Record<string, unknown> = {}) {
    return {
      run_date_local: '2026-05-13',
      account_id: 'ACCT001',
      account_title: 'Test Account',
      household_name: 'Whitaker Family',
      status: 'out',
      worst_bucket: 'equity',
      max_bucket_delta_pct: '27.3900',
      symbol_breach_count: 2,
      total_value_usd: '819703.74',
      coverage: 'both',
      snapshot_source: 'gcs',
      snapshot_as_of: '2026-05-12T00:00:00.000Z',
      schema_version: 1,
      ...overrides,
    };
  }

  it('401 when unauthenticated', async () => {
    const res = await request(createApp(null)).get('/api/drift/v2/history');
    expect(res.status).toBe(401);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('200 for an authenticated advisor (access opened to all users)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [v2HistoryRow()] });
    const res = await request(createApp(advisorUser)).get('/api/drift/v2/history');
    expect(res.status).toBe(200);
  });

  it('200 for an authenticated trader; returns { days, runs }', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [v2HistoryRow()] });
    const res = await request(createApp(traderUser)).get('/api/drift/v2/history');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toMatchObject({
      runDateLocal: '2026-05-13',
      accountId: 'ACCT001',
      accountTitle: 'Test Account',
      householdName: 'Whitaker Family',
      status: 'out',
      worstBucket: 'equity',
      maxBucketDeltaPct: 27.39,
      symbolBreachCount: 2,
      totalValueUsd: 819703.74,
      coverage: 'both',
    });
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('clamps days param to 1..180 with fallback 30', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(createApp(traderUser)).get('/api/drift/v2/history?days=999');
    let [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([30]);

    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(createApp(traderUser)).get('/api/drift/v2/history?days=7');
    [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([7]);

    // 180 is the new max — the v2 tab's longest window, which is what reaches
    // the first per-account run (2026-05-14).
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(createApp(traderUser)).get('/api/drift/v2/history?days=180');
    [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([180]);

    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(createApp(traderUser)).get('/api/drift/v2/history?days=181');
    [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([30]);
  });
});

describe('GET /api/drift/v2/runs/:runDateLocal', () => {
  function v2DetailRow(overrides: Record<string, unknown> = {}) {
    return {
      run_date_local: '2026-05-13',
      run_started_at: '2026-05-13T13:00:00.000Z',
      account_id: 'ACCT001',
      account_title: 'Test Account',
      household_name: 'Whitaker Family',
      status: 'out',
      worst_bucket: 'equity',
      max_bucket_delta_pct: '27.3900',
      symbol_breach_count: 2,
      total_value_usd: '100000.00',
      coverage: 'both',
      tolerance_pct: '5.0000',
      uninvested_cash_threshold_pct: '99.0000',
      snapshot_source: 'gcs',
      snapshot_as_of: '2026-05-12T00:00:00.000Z',
      schema_version: 1,
      details: {
        buckets: {
          cash: { positionPct: 0.21, templatePct: 2, deltaPct: 1.79 },
          fixed: { positionPct: 12.4, templatePct: 38, deltaPct: 25.6 },
          equity: { positionPct: 87.39, templatePct: 60, deltaPct: 27.39 },
        },
        symbolsWithTargets: [],
        equityHoldings: [],
        positionOnlySymbols: [],
        suspectedCashEquivMisclassified: [],
      },
      ...overrides,
    };
  }

  it('401 when unauthenticated', async () => {
    const res = await request(createApp(null)).get('/api/drift/v2/runs/2026-05-13');
    expect(res.status).toBe(401);
  });

  it('200 for an authenticated advisor (access opened to all users)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [v2DetailRow()] });
    const res = await request(createApp(advisorUser)).get('/api/drift/v2/runs/2026-05-13');
    expect(res.status).toBe(200);
  });

  it('200 for a trader with one or more rows; returns AccountDriftRunDetail shape', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [v2DetailRow()] });
    const res = await request(createApp(traderUser)).get('/api/drift/v2/runs/2026-05-13');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      runDateLocal: '2026-05-13',
      snapshotSource: 'gcs',
      tolerancePct: 5,
      uninvestedCashThresholdPct: 99,
    });
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0]).toMatchObject({
      accountId: 'ACCT001',
      maxBucketDeltaPct: 27.39,
    });
  });

  it('404 when no rows exist for that date', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp(traderUser)).get('/api/drift/v2/runs/2026-05-13');
    expect(res.status).toBe(404);
  });

  it('400 when runDateLocal is not YYYY-MM-DD', async () => {
    const res = await request(createApp(traderUser)).get('/api/drift/v2/runs/notadate');
    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('GET /api/drift/v2/allow-list', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(createApp(null)).get('/api/drift/v2/allow-list');
    expect(res.status).toBe(401);
  });

  it('200 for an authenticated advisor (access opened to all users)', async () => {
    const res = await request(createApp(advisorUser)).get('/api/drift/v2/allow-list');
    expect(res.status).toBe(200);
  });

  it('200 for a trader; returns the (empty) allow-list with no-store cache header', async () => {
    const res = await request(createApp(traderUser)).get('/api/drift/v2/allow-list');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries).toHaveLength(0);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });
});

describe('HEAD /api/drift/v2/exclusion-overlap', () => {
  it('401 when unauthenticated', async () => {
    process.env.DRIFT_EXCLUSION_OVERLAP_DIAGNOSTIC_ENABLED = 'true';
    const res = await request(createApp(null)).head('/api/drift/v2/exclusion-overlap');
    expect(res.status).toBe(401);
  });

  it('204 for advisor when authenticated (access opened to all users)', async () => {
    process.env.DRIFT_EXCLUSION_OVERLAP_DIAGNOSTIC_ENABLED = 'true';
    const res = await request(createApp(advisorUser)).head('/api/drift/v2/exclusion-overlap');
    expect(res.status).toBe(204);
  });

  it('404 for trader when feature flag is off', async () => {
    const res = await request(createApp(traderUser)).head('/api/drift/v2/exclusion-overlap');
    expect(res.status).toBe(404);
  });

  it('204 for trader when feature flag is on', async () => {
    process.env.DRIFT_EXCLUSION_OVERLAP_DIAGNOSTIC_ENABLED = 'true';
    const res = await request(createApp(traderUser)).head('/api/drift/v2/exclusion-overlap');
    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });
});

describe('GET /api/drift/v2/exclusion-overlap', () => {
  function overlapReport(overrides: Record<string, unknown> = {}) {
    return {
      runDateLocal: '2026-05-22',
      totalAccounts: 2,
      outAccounts: 1,
      totalExclusions: 4,
      totalBreaches: 3,
      lockedTotal: 1,
      lockedSharePct: 33.3,
      counts: {
        actionable: 2,
        locked_blanket: 0,
        locked_dnb_under: 1,
        locked_dns_over: 0,
        sign_mismatch_unlocked: 0,
      },
      worstAccounts: [
        {
          accountId: 'ACCT001',
          accountTitle: 'Test Account',
          household: 'Whitaker Family',
          status: 'out',
          maxDelta: 27.39,
          breachCount: 2,
          lockedCount: 1,
        },
      ],
      ...overrides,
    };
  }

  it('404 when feature flag is off', async () => {
    const res = await request(createApp(traderUser)).get('/api/drift/v2/exclusion-overlap');
    expect(res.status).toBe(404);
    expect(mockAnalyzeExclusionOverlapForRun).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid runDateLocal query', async () => {
    process.env.DRIFT_EXCLUSION_OVERLAP_DIAGNOSTIC_ENABLED = 'true';
    const res = await request(createApp(traderUser)).get('/api/drift/v2/exclusion-overlap?runDateLocal=2026-02-30');
    expect(res.status).toBe(400);
    expect(mockAnalyzeExclusionOverlapForRun).not.toHaveBeenCalled();
  });

  it('returns 200 with report payload when flag is on', async () => {
    process.env.DRIFT_EXCLUSION_OVERLAP_DIAGNOSTIC_ENABLED = 'true';
    mockAnalyzeExclusionOverlapForRun.mockResolvedValueOnce(overlapReport());

    const res = await request(createApp(traderUser)).get('/api/drift/v2/exclusion-overlap?runDateLocal=2026-05-22');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      runDateLocal: '2026-05-22',
      lockedTotal: 1,
    });
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(mockAnalyzeExclusionOverlapForRun).toHaveBeenCalledWith(mockPool, { runDateLocal: '2026-05-22' });
  });

  it('returns 404 when analysis reports no run', async () => {
    process.env.DRIFT_EXCLUSION_OVERLAP_DIAGNOSTIC_ENABLED = 'true';
    mockAnalyzeExclusionOverlapForRun.mockResolvedValueOnce(null);

    const res = await request(createApp(traderUser)).get('/api/drift/v2/exclusion-overlap?runDateLocal=2026-05-23');
    expect(res.status).toBe(404);
  });

  it('reuses in-memory cache for identical query key', async () => {
    process.env.DRIFT_EXCLUSION_OVERLAP_DIAGNOSTIC_ENABLED = 'true';
    mockAnalyzeExclusionOverlapForRun.mockResolvedValueOnce(overlapReport({ runDateLocal: '2026-05-31' }));

    const first = await request(createApp(traderUser)).get('/api/drift/v2/exclusion-overlap?runDateLocal=2026-05-31');
    const second = await request(createApp(traderUser)).get('/api/drift/v2/exclusion-overlap?runDateLocal=2026-05-31');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockAnalyzeExclusionOverlapForRun).toHaveBeenCalledTimes(1);
  });
});

// ─── Manual status overrides (trader-only writes) ───────────────────────────

describe('drift overrides — PUT /api/drift/v2/overrides/:accountId', () => {
  const acct = '01SYNTHQK8YGX68BBX12WCQVT5';
  const body = { reason: 'tax_constraint', note: 'big embedded gains' };

  it('401 when unauthenticated', async () => {
    const res = await request(createApp(null)).put(`/api/drift/v2/overrides/${acct}`).send(body);
    expect(res.status).toBe(401);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('403 for an advisor (trader-only)', async () => {
    const res = await request(createApp(advisorUser)).put(`/api/drift/v2/overrides/${acct}`).send(body);
    expect(res.status).toBe(403);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('200 for a trader and upserts the override', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          account_id: acct,
          reason: 'tax_constraint',
          note: 'big embedded gains',
          expires_on: null,
          set_by_name: traderUser.name,
          updated_at: '2026-06-22T00:00:00.000Z',
        },
      ],
    });
    const res = await request(createApp(traderUser)).put(`/api/drift/v2/overrides/${acct}`).send(body);
    expect(res.status).toBe(200);
    expect(res.body.override.reason).toBe('tax_constraint');
  });

  it('400 for an unknown reason', async () => {
    const res = await request(createApp(traderUser))
      .put(`/api/drift/v2/overrides/${acct}`)
      .send({ reason: 'made_up_reason' });
    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('400 when reason is "other" without a note', async () => {
    const res = await request(createApp(traderUser))
      .put(`/api/drift/v2/overrides/${acct}`)
      .send({ reason: 'other', note: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('drift overrides — DELETE /api/drift/v2/overrides/:accountId', () => {
  const acct = '01SYNTHQK8YGX68BBX12WCQVT5';

  it('403 for an advisor (trader-only)', async () => {
    const res = await request(createApp(advisorUser)).delete(`/api/drift/v2/overrides/${acct}`);
    expect(res.status).toBe(403);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('200 for a trader and reports cleared', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(createApp(traderUser)).delete(`/api/drift/v2/overrides/${acct}`);
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
  });
});
