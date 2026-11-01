import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockPool,
  sendDailyDigestMock,
  buildDailyDigestMock,
  sendDigestToTargetMock,
  requireSchedulerAuthMock,
  runDriftCheckMock,
  previewDriftCheckMock,
} = vi.hoisted(() => ({
  mockPool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), end: vi.fn() },
  sendDailyDigestMock: vi.fn(),
  buildDailyDigestMock: vi.fn(),
  sendDigestToTargetMock: vi.fn(),
  requireSchedulerAuthMock: vi.fn(),
  runDriftCheckMock: vi.fn(),
  previewDriftCheckMock: vi.fn(),
}));

vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../../services/digest.js', () => ({
  sendDailyDigest: sendDailyDigestMock,
  buildDailyDigest: buildDailyDigestMock,
  sendDigestToTarget: sendDigestToTargetMock,
  computeRunDate: () => '2026-05-12',
}));
vi.mock('../../services/registryDriftRunner.js', () => ({
  runDriftCheck: runDriftCheckMock,
  previewDriftCheck: previewDriftCheckMock,
}));
vi.mock('../../services/meridianSnapshot.js', async () => {
  class SnapshotLoadError extends Error {
    public readonly status = 503;
    public readonly source: string;
    constructor(message: string, source: string) {
      super(message);
      this.name = 'SnapshotLoadError';
      this.source = source;
    }
  }
  return {
    SnapshotLoadError,
    STALE_SNAPSHOT_THRESHOLD_DAYS: 35,
  };
});
vi.mock('../../middleware/schedulerAuth.js', () => ({
  requireSchedulerAuth: requireSchedulerAuthMock,
}));
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../lib/logger.js', () => ({ default: loggerMock }));

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';

async function createApp() {
  // Use a dynamic import so each test can toggle NODE_ENV before the router is
  // evaluated (the preview route is registered conditionally at import time).
  vi.resetModules();
  const { default: internalRoutes } = await import('../internal.js');
  const app = express();
  app.use(express.json());
  app.use('/api/internal', internalRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSchedulerAuthMock.mockImplementation((_req, _res, next) => next());
});

afterEach(() => {
  delete process.env.NODE_ENV;
});

describe('POST /api/internal/digest/daily', () => {
  it('returns 200 and sent=true on first call', async () => {
    sendDailyDigestMock.mockResolvedValueOnce({
      sent: true,
      summary: { runDate: '2026-04-21' },
    });

    const app = await createApp();
    const res = await request(app).post('/api/internal/digest/daily');

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(sendDailyDigestMock).toHaveBeenCalledTimes(1);
    expect(requireSchedulerAuthMock).toHaveBeenCalled();
  });

  it('returns 200 and sent=false when already posted (idempotency)', async () => {
    sendDailyDigestMock.mockResolvedValueOnce({
      sent: false,
      summary: { runDate: '2026-04-21' },
      reason: 'already_posted',
    });

    const app = await createApp();
    const res = await request(app).post('/api/internal/digest/daily');

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(false);
    expect(res.body.reason).toBe('already_posted');
  });

  it('returns 401 when requireSchedulerAuth rejects', async () => {
    requireSchedulerAuthMock.mockImplementation((_req, res, _next) => {
      res.status(401).json({ error: 'Invalid token' });
    });

    const app = await createApp();
    const res = await request(app).post('/api/internal/digest/daily');

    expect(res.status).toBe(401);
    expect(sendDailyDigestMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/digest/test-send', () => {
  it('sends digest to supplied target without writing to digest_runs', async () => {
    sendDigestToTargetMock.mockResolvedValueOnce({
      sent: true,
      target: 'U123',
      summary: { runDate: '2026-04-21', total: 3 },
    });

    const app = await createApp();
    const res = await request(app).post('/api/internal/digest/test-send').send({ target: 'U123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, target: 'U123', total: 3 });
    expect(sendDigestToTargetMock).toHaveBeenCalledWith(mockPool, 'U123');
  });

  it('returns 400 when target is missing', async () => {
    const app = await createApp();
    const res = await request(app).post('/api/internal/digest/test-send').send({});

    expect(res.status).toBe(400);
    expect(sendDigestToTargetMock).not.toHaveBeenCalled();
  });

  it('returns 401 when requireSchedulerAuth rejects', async () => {
    requireSchedulerAuthMock.mockImplementation((_req, res, _next) => {
      res.status(401).json({ error: 'Invalid token' });
    });

    const app = await createApp();
    const res = await request(app).post('/api/internal/digest/test-send').send({ target: 'U123' });

    expect(res.status).toBe(401);
    expect(sendDigestToTargetMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/internal/digest/preview', () => {
  it('returns 200 with rendered text in non-production', async () => {
    process.env.NODE_ENV = 'test';
    buildDailyDigestMock.mockResolvedValueOnce({
      text: '*Trade Request — Daily Digest*',
      summary: { runDate: '2026-04-21' },
    });

    const app = await createApp();
    const res = await request(app).get('/api/internal/digest/preview');

    expect(res.status).toBe(200);
    expect(res.body.text).toContain('Daily Digest');
    expect(buildDailyDigestMock).toHaveBeenCalled();
  });

  it('returns 404 in production (route is not registered)', async () => {
    process.env.NODE_ENV = 'production';

    const app = await createApp();
    const res = await request(app).get('/api/internal/digest/preview');

    expect(res.status).toBe(404);
    expect(buildDailyDigestMock).not.toHaveBeenCalled();
  });
});

describe('retired execution-plan registry export', () => {
  it('refuses GET /api/internal/meridian-registry with 404 even when scheduler auth passes', async () => {
    const app = await createApp();
    const res = await request(app).get('/api/internal/meridian-registry');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('refuses the development preview with 404 in the test environment', async () => {
    process.env.NODE_ENV = 'test';
    const app = await createApp();
    const res = await request(app).get('/api/internal/meridian-registry/preview');
    expect(res.status).toBe(404);
  });

  it('refuses before scheduler authentication runs', async () => {
    const app = await createApp();
    await request(app).get('/api/internal/meridian-registry');
    expect(requireSchedulerAuthMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/drift/check', () => {
  beforeEach(() => {
    process.env.DRIFT_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.DRIFT_ENABLED;
  });

  it('returns 200 with the run summary on success', async () => {
    runDriftCheckMock.mockResolvedValueOnce({
      runDateLocal: '2026-05-12',
      schemaVersion: 1,
      snapshotSource: 'gcs',
      snapshotAsOf: '2026-05-12T03:00:00.000Z',
      totalHouseholds: 5,
      breachHouseholds: 1,
      insertedRows: 5,
      alert: { sent: false, alertingHouseholds: ['Foo'], suppressedAllowListed: [] },
      unmappedPositionsAccounts: [],
      unmappedSnapshotAccounts: [],
    });

    const app = await createApp();
    const res = await request(app).post('/api/internal/drift/check');

    expect(res.status).toBe(200);
    expect(res.body.totalHouseholds).toBe(5);
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(runDriftCheckMock).toHaveBeenCalledWith({ pool: mockPool });
    expect(requireSchedulerAuthMock).toHaveBeenCalled();
  });

  it('returns 204 and skips runDriftCheck when DRIFT_ENABLED!=true (build-time merge gate)', async () => {
    delete process.env.DRIFT_ENABLED;
    const app = await createApp();
    const res = await request(app).post('/api/internal/drift/check');

    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(runDriftCheckMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'drift_disabled' }),
      expect.any(String),
    );
  });

  it('also returns 204 when DRIFT_ENABLED is the literal string "false"', async () => {
    process.env.DRIFT_ENABLED = 'false';
    const app = await createApp();
    const res = await request(app).post('/api/internal/drift/check');

    expect(res.status).toBe(204);
    expect(runDriftCheckMock).not.toHaveBeenCalled();
  });

  it('returns 503 when the snapshot cannot be loaded', async () => {
    const { SnapshotLoadError } = await import('../../services/meridianSnapshot.js');
    runDriftCheckMock.mockRejectedValueOnce(new SnapshotLoadError('bucket missing', 'gcs'));

    const app = await createApp();
    const res = await request(app).post('/api/internal/drift/check');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('snapshot_unavailable');
    expect(res.body.source).toBe('gcs');
  });

  it('propagates non-snapshot errors to the default handler (500)', async () => {
    runDriftCheckMock.mockRejectedValueOnce(new Error('pg pool died'));

    const app = await createApp();
    const res = await request(app).post('/api/internal/drift/check');

    expect(res.status).toBe(500);
  });

  it('returns 401 when requireSchedulerAuth rejects', async () => {
    requireSchedulerAuthMock.mockImplementation((_req, res, _next) => {
      res.status(401).json({ error: 'Invalid token' });
    });

    const app = await createApp();
    const res = await request(app).post('/api/internal/drift/check');

    expect(res.status).toBe(401);
    expect(runDriftCheckMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/drift/check/preview', () => {
  it('returns 200 with comparison + metadata and does not persist in development env', async () => {
    process.env.NODE_ENV = 'development';
    previewDriftCheckMock.mockResolvedValueOnce({
      positions: { accountCount: 3, businessDate: '2026-05-12' },
      snapshot: { generatedAt: '2026-05-12T02:00:00.000Z', entries: [] },
      comparison: { households: [], unmappedPositionsAccounts: [], unmappedSnapshotAccounts: [] },
      tolerancePct: 5,
    });

    const app = await createApp();
    const res = await request(app).post('/api/internal/drift/check/preview');

    expect(res.status).toBe(200);
    expect(res.body.tolerancePct).toBe(5);
    // B2: preview shape now exposes a `positions` block (replacing the old
    // engine-side `registry` block) — accountCount + a representative
    // businessDate. The `rows` property is gone with the registry block.
    expect(res.body.positions).toEqual({
      accountCount: 3,
      businessDate: '2026-05-12',
    });
    expect(res.body).not.toHaveProperty('registry');
    expect(previewDriftCheckMock).toHaveBeenCalledWith(mockPool);
  });

  it('returns 200 in the test env (allow-list includes "test")', async () => {
    process.env.NODE_ENV = 'test';
    previewDriftCheckMock.mockResolvedValueOnce({
      positions: { accountCount: 0, businessDate: null },
      snapshot: { generatedAt: '2026-05-12T02:00:00.000Z', entries: [] },
      comparison: { households: [], unmappedPositionsAccounts: [], unmappedSnapshotAccounts: [] },
      tolerancePct: 5,
    });

    const app = await createApp();
    const res = await request(app).post('/api/internal/drift/check/preview');

    expect(res.status).toBe(200);
    expect(previewDriftCheckMock).toHaveBeenCalled();
  });

  it('returns 404 in production (NODE_ENV allow-list, defense-in-depth on top of OIDC)', async () => {
    process.env.NODE_ENV = 'production';

    const app = await createApp();
    const res = await request(app).post('/api/internal/drift/check/preview');

    expect(res.status).toBe(404);
    expect(previewDriftCheckMock).not.toHaveBeenCalled();
  });

  it('returns 404 when NODE_ENV is unset (explicit allow-list, not negative gate)', async () => {
    delete process.env.NODE_ENV;

    const app = await createApp();
    const res = await request(app).post('/api/internal/drift/check/preview');

    expect(res.status).toBe(404);
    expect(previewDriftCheckMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/internal/drift/allow-list', () => {
  it('returns the (now-empty) static allow-list as of the 2026-Q3 positions cutover', async () => {
    const app = await createApp();
    const res = await request(app).get('/api/internal/drift/allow-list');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    // Empty after the position-drift cutover dropped the four engine-side
    // entries. See registryDriftAllowList.ts for the rationale.
    expect(res.body.entries).toEqual([]);
  });
});

describe('GET /api/internal/drift/history', () => {
  it('returns the rows for the default 30-day window', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          run_date_local: '2026-05-12',
          household_name: 'Doe Family',
          max_delta_pct: '4.50',
          breach: false,
          coverage_status: 'full',
          schema_version: 1,
          snapshot_source: 'gcs',
          snapshot_as_of: '2026-05-12T03:00:00.000Z',
        },
      ],
    });

    const app = await createApp();
    const res = await request(app).get('/api/internal/drift/history');

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toMatchObject({
      runDateLocal: '2026-05-12',
      householdName: 'Doe Family',
      maxDeltaPct: 4.5,
      breach: false,
      coverageStatus: 'full',
    });
    const [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([30]);
  });

  it('clamps days to 1..90', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const app = await createApp();
    await request(app).get('/api/internal/drift/history?days=999');
    let [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([30]);

    await request(app).get('/api/internal/drift/history?days=0');
    [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([30]);

    await request(app).get('/api/internal/drift/history?days=7');
    [, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(params).toEqual([7]);
  });
});
