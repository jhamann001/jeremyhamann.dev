import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthUser } from '@trade-request/shared';
import { traderUser, advisorUser } from './testHelpers.js';

const {
  mockPool,
  mockDbClient,
  notifyExclusionChangeMock,
  notifyExclusionBatchChangeMock,
  fetchActiveTraderUserIdsMock,
  notifyUsersSafeMock,
  warehouseMock,
} = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  const dbClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return {
    mockPool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue(dbClient),
      end: vi.fn(),
    },
    mockDbClient: dbClient,
    notifyExclusionChangeMock: vi.fn(),
    notifyExclusionBatchChangeMock: vi.fn(),
    fetchActiveTraderUserIdsMock: vi.fn().mockResolvedValue(['trader-uuid']),
    notifyUsersSafeMock: vi.fn().mockResolvedValue(undefined),
    warehouseMock: {
      isConfigured: vi.fn().mockReturnValue(false),
      getCachedClients: vi.fn().mockResolvedValue([]),
    },
  };
});

vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../../services/slack.js', () => ({
  notifyExclusionChange: notifyExclusionChangeMock,
  notifyExclusionBatchChange: notifyExclusionBatchChangeMock,
}));
vi.mock('../../services/notificationInserts.js', () => ({
  fetchActiveTraderUserIds: fetchActiveTraderUserIdsMock,
  notifyUsersSafe: notifyUsersSafeMock,
}));
// The firm-wide export enriches ids with names from the cached client list.
vi.mock('../../services/warehouse.js', () => warehouseMock);

import express from 'express';
import request from 'supertest';
import clientExclusionRoutes from '../exclusions.js';
import { errorHandler } from '../../middleware/errorHandler.js';

function createApp(user: AuthUser, isDemo = false) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: AuthUser; isDemo?: boolean }).user = user;
    (req as express.Request & { user?: AuthUser; isDemo?: boolean }).isDemo = isDemo;
    next();
  });
  app.use('/', clientExclusionRoutes);
  app.use(errorHandler);
  return app;
}

function exclusionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    client_id: 'C-1',
    ticker: 'TSLA',
    kind: 'advisor',
    reason: 'Concentration',
    no_buy: true,
    no_sell: true,
    created_by_name: 'Rachel',
    created_at: new Date('2026-05-21T10:00:00Z'),
    ...overrides,
  };
}

function accountExclusionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '660e8400-e29b-41d4-a716-446655440000',
    account_id: '01SYNTHQJHSGF8N5DPE53KFXYD',
    ticker: 'XOM',
    kind: 'client',
    reason: 'Legacy position',
    no_buy: true,
    no_sell: false,
    created_by_name: 'Rachel',
    created_at: new Date('2026-05-21T10:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchActiveTraderUserIdsMock.mockResolvedValue(['trader-uuid']);
  // Default db-client mock: any query a test forgets to script returns [].
  // Tests that exercise the transactional batch endpoint override this with
  // ordered .mockResolvedValueOnce calls.
  mockDbClient.query.mockReset();
  mockDbClient.query.mockResolvedValue({ rows: [] });
});

describe('GET /:clientId/exclusions', () => {
  it('returns the exclusion list for the client', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [exclusionRow()] });

    const res = await request(createApp(advisorUser)).get('/C-1/exclusions');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ ticker: 'TSLA', kind: 'advisor', reason: 'Concentration' });
  });

  it('returns [] in demo mode without hitting the pool', async () => {
    const res = await request(createApp(advisorUser, true)).get('/C-1/exclusions');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('POST /:clientId/exclusions', () => {
  it('creates a new exclusion and fires notifications', async () => {
    mockPool.query
      // INSERT … RETURNING
      .mockResolvedValueOnce({ rows: [exclusionRow({ ticker: 'XOM' })] })
      // resolveClientName SELECT
      .mockResolvedValueOnce({ rows: [{ name: 'Smith Family' }] });

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions')
      .send({ ticker: 'xom', kind: 'advisor', reason: 'Concentration' });

    expect(res.status).toBe(201);
    expect(res.body.data.ticker).toBe('XOM');
    expect(notifyExclusionChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'C-1',
        clientName: 'Smith Family',
        ticker: 'XOM',
        kind: 'advisor',
        action: 'added',
      }),
    );
  });

  it('returns 400 for invalid kind', async () => {
    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions')
      .send({ ticker: 'XOM', kind: 'bogus', reason: '' });

    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 409 on Postgres unique violation (duplicate)', async () => {
    const dbErr = Object.assign(new Error('dup'), { code: '23505' });
    mockPool.query.mockRejectedValueOnce(dbErr);

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions')
      .send({ ticker: 'XOM', kind: 'advisor', reason: '' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already on the advisor exclusion list/);
  });

  it('echoes back a demo payload without hitting the pool', async () => {
    const res = await request(createApp(advisorUser, true))
      .post('/C-1/exclusions')
      .send({ ticker: 'AAPL', kind: 'client', reason: 'employer' });

    expect(res.status).toBe(201);
    expect(res.body.data.ticker).toBe('AAPL');
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /:clientId/exclusions/:id', () => {
  it('removes and fires notifications with the original reason', async () => {
    mockPool.query
      // SELECT existing
      .mockResolvedValueOnce({ rows: [exclusionRow({ reason: 'old reason' })] })
      // DELETE
      .mockResolvedValueOnce({ rowCount: 1 })
      // resolveClientName SELECT
      .mockResolvedValueOnce({ rows: [{ name: 'Smith Family' }] });

    const res = await request(createApp(traderUser)).delete('/C-1/exclusions/550e8400-e29b-41d4-a716-446655440000');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true });
    expect(notifyExclusionChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'removed', reason: 'old reason' }),
    );
  });

  it('returns 404 when the exclusion does not exist for the client', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(traderUser)).delete('/C-1/exclusions/550e8400-e29b-41d4-a716-446655440009');

    expect(res.status).toBe(404);
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();
  });
});

describe('POST /exclusions/bulk', () => {
  it('returns a map keyed by clientId, with [] for empty IDs', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [exclusionRow({ client_id: 'C-1', ticker: 'TSLA' }), exclusionRow({ client_id: 'C-2', ticker: 'AAPL' })],
    });

    const res = await request(createApp(advisorUser))
      .post('/exclusions/bulk')
      .send({ clientIds: ['C-1', 'C-2', 'C-3'] });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['C-1', 'C-2', 'C-3']);
    expect(res.body.data['C-1']).toHaveLength(1);
    expect(res.body.data['C-2']).toHaveLength(1);
    expect(res.body.data['C-3']).toEqual([]);
  });

  it('returns 400 when clientIds is empty', async () => {
    const res = await request(createApp(advisorUser)).post('/exclusions/bulk').send({ clientIds: [] });

    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 400 when clientIds exceeds 1000', async () => {
    const clientIds = Array.from({ length: 1001 }, (_, i) => `C-${i}`);
    const res = await request(createApp(advisorUser)).post('/exclusions/bulk').send({ clientIds });

    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns empty arrays for every requested ID in demo mode without hitting the pool', async () => {
    const res = await request(createApp(advisorUser, true))
      .post('/exclusions/bulk')
      .send({ clientIds: ['C-1', 'C-2'] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ 'C-1': [], 'C-2': [] });
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('POST /account-exclusions/bulk', () => {
  it('returns a map keyed by accountId, with [] for empty IDs', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        accountExclusionRow({ account_id: 'ACC-ULID-1', ticker: 'XOM' }),
        accountExclusionRow({ account_id: 'ACC-ULID-2', ticker: 'AAPL' }),
      ],
    });

    const res = await request(createApp(advisorUser))
      .post('/account-exclusions/bulk')
      .send({ accountIds: ['ACC-ULID-1', 'ACC-ULID-2', 'ACC-ULID-3'] });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['ACC-ULID-1', 'ACC-ULID-2', 'ACC-ULID-3']);
    expect(res.body.data['ACC-ULID-1']).toHaveLength(1);
    expect(res.body.data['ACC-ULID-2']).toHaveLength(1);
    expect(res.body.data['ACC-ULID-3']).toEqual([]);
  });

  it('returns 400 when accountIds is empty', async () => {
    const res = await request(createApp(advisorUser)).post('/account-exclusions/bulk').send({ accountIds: [] });

    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns empty arrays for requested IDs in demo mode without hitting the pool', async () => {
    const res = await request(createApp(advisorUser, true))
      .post('/account-exclusions/bulk')
      .send({ accountIds: ['ACC-ULID-1', 'ACC-ULID-2'] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ 'ACC-ULID-1': [], 'ACC-ULID-2': [] });
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('POST /account-exclusions/:accountId/batch', () => {
  it('commits add + remove + edit in one transaction', async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [
          accountExclusionRow({ id: '11111111-1111-1111-1111-111111111111', account_id: 'ACC-ULID-1', ticker: 'OLD' }),
        ],
      }) // SELECT remove target
      .mockResolvedValueOnce({ rowCount: 1 }) // DELETE
      .mockResolvedValueOnce({
        rows: [
          accountExclusionRow({
            id: '22222222-2222-2222-2222-222222222222',
            account_id: 'ACC-ULID-1',
            ticker: 'KEEP',
            no_buy: true,
            no_sell: true,
          }),
        ],
      }) // SELECT edit target
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({
        rows: [
          accountExclusionRow({
            id: '22222222-2222-2222-2222-222222222222',
            account_id: 'ACC-ULID-1',
            ticker: 'KEEP',
            no_buy: true,
            no_sell: false,
          }),
          accountExclusionRow({
            id: '33333333-3333-3333-3333-333333333333',
            account_id: 'ACC-ULID-1',
            ticker: 'NEW',
            no_buy: false,
            no_sell: true,
          }),
        ],
      }) // final SELECT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(createApp(advisorUser))
      .post('/account-exclusions/ACC-ULID-1/batch')
      .send({
        add: [{ ticker: 'new', kind: 'advisor', reason: 'fresh', noBuy: false, noSell: true }],
        remove: ['11111111-1111-1111-1111-111111111111'],
        edit: [{ id: '22222222-2222-2222-2222-222222222222', noBuy: true, noSell: false }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ added: 1, removed: 1, edited: 1 });
    expect(res.body.data.exclusions).toHaveLength(2);
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();
    expect(notifyExclusionBatchChangeMock).not.toHaveBeenCalled();
  });

  it('rolls back and returns 404 when a remove id is not found for account', async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT remove target -> not found
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await request(createApp(advisorUser))
      .post('/account-exclusions/ACC-ULID-1/batch')
      .send({ remove: ['11111111-1111-1111-1111-111111111111'] });

    expect(res.status).toBe(404);
    expect(mockDbClient.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();
    expect(notifyExclusionBatchChangeMock).not.toHaveBeenCalled();
  });

  it('demo mode echoes back payload without touching the db', async () => {
    const res = await request(createApp(advisorUser, true))
      .post('/account-exclusions/ACC-ULID-1/batch')
      .send({
        add: [{ ticker: 'XOM', kind: 'client', reason: 'Employer', noBuy: true, noSell: false }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.added).toBe(1);
    expect(res.body.data.removed).toBe(0);
    expect(res.body.data.edited).toBe(0);
    expect(mockPool.connect).not.toHaveBeenCalled();
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();
    expect(notifyExclusionBatchChangeMock).not.toHaveBeenCalled();
  });
});

describe('POST /:clientId/exclusions/batch (v3.3)', () => {
  it('rejects an empty batch with 400', async () => {
    const res = await request(createApp(advisorUser)).post('/C-1/exclusions/batch').send({ add: [], remove: [] });

    expect(res.status).toBe(400);
    expect(mockPool.connect).not.toHaveBeenCalled();
    expect(notifyExclusionBatchChangeMock).not.toHaveBeenCalled();
  });

  it('rejects a batch with duplicate (ticker, kind) in adds with 400', async () => {
    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({
        add: [
          { ticker: 'TSLA', kind: 'advisor', reason: 'r1' },
          { ticker: 'tsla', kind: 'advisor', reason: 'r2' },
        ],
      });

    expect(res.status).toBe(400);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  // v3.3 regression guard: the user-facing reason this endpoint exists at all
  // is "one Slack per Apply, NOT one per ticker." If someone ever wires the
  // per-row `notifyExclusionChange` inside the batch route alongside the
  // batch helper, every test below should fail loudly.
  it('commits an adds-only batch and fires exactly one Slack message + one in-app fan-out', async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT 1
      .mockResolvedValueOnce({ rows: [] }) // INSERT 2
      .mockResolvedValueOnce({
        // Final SELECT (full standing list)
        rows: [
          exclusionRow({ ticker: 'AAPL', kind: 'advisor', reason: 'Employer' }),
          exclusionRow({ ticker: 'TSLA', kind: 'advisor', reason: 'Concentration' }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Smith Household' }] }); // resolveClientName

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({
        add: [
          { ticker: 'tsla', kind: 'advisor', reason: 'Concentration' },
          { ticker: 'aapl', kind: 'advisor', reason: 'Employer' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.added).toBe(2);
    expect(res.body.data.removed).toBe(0);
    expect(res.body.data.exclusions).toHaveLength(2);

    expect(notifyExclusionBatchChangeMock).toHaveBeenCalledTimes(1);
    expect(notifyExclusionBatchChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'C-1',
        clientName: 'Smith Household',
        added: [
          expect.objectContaining({ ticker: 'TSLA', kind: 'advisor', reason: 'Concentration' }),
          expect.objectContaining({ ticker: 'AAPL', kind: 'advisor', reason: 'Employer' }),
        ],
        removed: [],
        changedBy: advisorUser.name,
      }),
    );
    // Regression guard — per-row Slack helper must NEVER fire from the batch route.
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();

    // in-app: one summary message, not per-ticker
    await vi.waitFor(() => expect(notifyUsersSafeMock).toHaveBeenCalledTimes(1));
    expect(notifyUsersSafeMock).toHaveBeenCalledWith(['trader-uuid'], 'Smith Household: 2 exclusions added', null);
  });

  it('commits a removes-only batch and includes original reasons in the Slack payload', async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [exclusionRow({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ticker: 'XOM', reason: 'ESG concern' })],
      }) // SELECT existing
      .mockResolvedValueOnce({ rowCount: 1 }) // DELETE
      .mockResolvedValueOnce({ rows: [] }) // Final SELECT (now empty)
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Smith Household' }] });

    const res = await request(createApp(traderUser))
      .post('/C-1/exclusions/batch')
      .send({ remove: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'] });

    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(1);
    expect(res.body.data.added).toBe(0);

    expect(notifyExclusionBatchChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        added: [],
        removed: [expect.objectContaining({ ticker: 'XOM', reason: 'ESG concern' })],
      }),
    );
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(notifyUsersSafeMock).toHaveBeenCalledTimes(1));
    expect(notifyUsersSafeMock).toHaveBeenCalledWith(['trader-uuid'], 'Smith Household: 1 exclusion removed', null);
  });

  it('rolls back the entire batch and fires no notifications on a unique-violation on any add', async () => {
    const dbErr = Object.assign(new Error('dup'), { code: '23505' });
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT 1 success
      .mockRejectedValueOnce(dbErr) // INSERT 2 fails on uniqueness
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({
        add: [
          { ticker: 'NEW', kind: 'advisor', reason: '' },
          { ticker: 'DUP', kind: 'advisor', reason: '' },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/DUP is already on the advisor exclusion list/);
    expect(notifyExclusionBatchChangeMock).not.toHaveBeenCalled();
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();
    expect(notifyUsersSafeMock).not.toHaveBeenCalled();
    // Verify ROLLBACK was issued (the last query before release()).
    expect(mockDbClient.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockDbClient.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back the entire batch and returns 404 when a remove-id is not found', async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT existing → empty (not found)
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({ remove: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'] });

    expect(res.status).toBe(404);
    expect(notifyExclusionBatchChangeMock).not.toHaveBeenCalled();
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();
    expect(notifyUsersSafeMock).not.toHaveBeenCalled();
    expect(mockDbClient.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockDbClient.release).toHaveBeenCalledTimes(1);
  });

  it('processes mixed adds + removes inside one transaction and uses the updated-summary copy', async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [exclusionRow({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ticker: 'OLD', reason: 'stale' })],
      }) // SELECT (remove)
      .mockResolvedValueOnce({ rowCount: 1 }) // DELETE
      .mockResolvedValueOnce({ rows: [] }) // INSERT NEW
      .mockResolvedValueOnce({ rows: [exclusionRow({ ticker: 'NEW' })] }) // Final SELECT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Smith Household' }] });

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({
        add: [{ ticker: 'NEW', kind: 'advisor', reason: 'fresh' }],
        remove: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.added).toBe(1);
    expect(res.body.data.removed).toBe(1);

    expect(notifyExclusionBatchChangeMock).toHaveBeenCalledTimes(1);
    expect(notifyExclusionBatchChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        added: [expect.objectContaining({ ticker: 'NEW', reason: 'fresh' })],
        removed: [expect.objectContaining({ ticker: 'OLD', reason: 'stale' })],
      }),
    );
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(notifyUsersSafeMock).toHaveBeenCalledTimes(1));
    expect(notifyUsersSafeMock).toHaveBeenCalledWith(
      ['trader-uuid'],
      'Smith Household: 2 exclusions changed (+1, -1)',
      null,
    );
  });

  it('demo mode echoes back without touching the DB or firing notifications', async () => {
    const res = await request(createApp(advisorUser, true))
      .post('/C-1/exclusions/batch')
      .send({
        add: [{ ticker: 'AAPL', kind: 'client', reason: 'employer' }],
        remove: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.added).toBe(1);
    expect(res.body.data.removed).toBe(1);
    expect(mockPool.connect).not.toHaveBeenCalled();
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(notifyExclusionBatchChangeMock).not.toHaveBeenCalled();
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();
    expect(notifyUsersSafeMock).not.toHaveBeenCalled();
  });
});

// ─── v3.4 (DNB / DNS structure) ─────────────────────────────────────────────

describe('POST /:clientId/exclusions (v3.4 backward compat)', () => {
  it('accepts a v3.3 body shape (no noBuy/noSell) and inserts with both flags true', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [exclusionRow({ ticker: 'XOM', no_buy: true, no_sell: true })],
      })
      .mockResolvedValueOnce({ rows: [{ name: 'Smith Family' }] });

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions')
      .send({ ticker: 'xom', kind: 'advisor', reason: 'Concentration' });

    expect(res.status).toBe(201);
    expect(res.body.data.noBuy).toBe(true);
    expect(res.body.data.noSell).toBe(true);

    // Verify the INSERT statement received true/true for the two flag columns
    // (positions 5 and 6 of the parameter list).
    const insertCall = mockPool.query.mock.calls[0]!;
    const insertParams = insertCall[1] as unknown[];
    expect(insertParams[4]).toBe(true); // noBuy
    expect(insertParams[5]).toBe(true); // noSell

    expect(notifyExclusionChangeMock).toHaveBeenCalledWith(expect.objectContaining({ noBuy: true, noSell: true }));
  });

  it('accepts an explicit DNS-only body and inserts with no_buy=false, no_sell=true', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [exclusionRow({ ticker: 'AAPL', no_buy: false, no_sell: true })],
      })
      .mockResolvedValueOnce({ rows: [{ name: 'Smith Family' }] });

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions')
      .send({ ticker: 'AAPL', kind: 'advisor', reason: 'Low basis', noBuy: false, noSell: true });

    expect(res.status).toBe(201);
    expect(res.body.data.noBuy).toBe(false);
    expect(res.body.data.noSell).toBe(true);

    const insertParams = mockPool.query.mock.calls[0]![1] as unknown[];
    expect(insertParams[4]).toBe(false);
    expect(insertParams[5]).toBe(true);
  });

  it('returns 400 when both noBuy and noSell are explicitly false (Zod refine, before DB)', async () => {
    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions')
      .send({ ticker: 'XOM', kind: 'advisor', reason: '', noBuy: false, noSell: false });

    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();
  });
});

describe('POST /:clientId/exclusions/batch (v3.4 edit step)', () => {
  it('commits an edit-only batch and fires one batch Slack message with the Changed: payload', async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [
          exclusionRow({
            id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
            ticker: 'NVDA',
            kind: 'advisor',
            no_buy: true,
            no_sell: true,
          }),
        ],
      }) // SELECT existing for edit
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE
      .mockResolvedValueOnce({
        rows: [exclusionRow({ ticker: 'NVDA', no_buy: true, no_sell: false })],
      }) // Final SELECT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Smith Household' }] });

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({
        edit: [{ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', noBuy: true, noSell: false }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.edited).toBe(1);
    expect(res.body.data.added).toBe(0);
    expect(res.body.data.removed).toBe(0);

    expect(notifyExclusionBatchChangeMock).toHaveBeenCalledTimes(1);
    expect(notifyExclusionBatchChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        added: [],
        removed: [],
        changed: [
          expect.objectContaining({
            ticker: 'NVDA',
            kind: 'advisor',
            before: { noBuy: true, noSell: true },
            after: { noBuy: true, noSell: false },
          }),
        ],
      }),
    );
    // Per-row helper MUST NOT fire from the batch route (v3.3 regression guard).
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(notifyUsersSafeMock).toHaveBeenCalledTimes(1));
    expect(notifyUsersSafeMock).toHaveBeenCalledWith(['trader-uuid'], 'Smith Household: 1 exclusion updated', null);
  });

  it('commits a no-op edit (after == before) but excludes it from the notification payload', async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [
          exclusionRow({
            id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
            no_buy: true,
            no_sell: true,
          }),
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // Final SELECT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    // Note: resolveClientName is NOT mocked because a no-op batch short-circuits
    // before reaching the notification block. If we queued a clientName here it
    // would leak to the next test (mockPool.query isn't reset in beforeEach).

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({
        edit: [{ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', noBuy: true, noSell: true }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.edited).toBe(0);
    // No-op edit produces no notification because there's nothing to tell the
    // trader about. The route still COMMITted the (idempotent) UPDATE.
    expect(notifyExclusionBatchChangeMock).not.toHaveBeenCalled();
    expect(notifyUsersSafeMock).not.toHaveBeenCalled();
  });

  it('rolls back and returns 404 when an edit-id is from a DIFFERENT clientId (cross-tenant guard)', async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT id=X AND client_id=C-1 → empty (row belongs to C-2)
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({
        edit: [{ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', noBuy: false, noSell: true }],
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found for this client/);
    // CRITICAL: no UPDATE was issued — verifies the SELECT-then-UPDATE guard.
    expect(mockDbClient.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE client_exclusions'),
      expect.any(Array),
    );
    expect(notifyExclusionBatchChangeMock).not.toHaveBeenCalled();
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();
    expect(notifyUsersSafeMock).not.toHaveBeenCalled();
    expect(mockDbClient.query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('returns 400 (Zod) when an edit item has both flags false', async () => {
    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({
        edit: [{ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', noBuy: false, noSell: false }],
      });

    expect(res.status).toBe(400);
    // BEGIN should not have been called — Zod refused before the transaction.
    expect(mockDbClient.query).not.toHaveBeenCalled();
    expect(notifyExclusionBatchChangeMock).not.toHaveBeenCalled();
  });

  it('rolls back and returns 400 on a Postgres CHECK violation from the UPDATE (defense-in-depth)', async () => {
    // Simulates a scenario where Zod somehow let (false, false) through (it
    // doesn't, but the route catches CHECK violations defensively in case a
    // future schema refactor relaxes the Zod refine).
    const checkErr = Object.assign(new Error('check constraint'), { code: '23514' });
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [exclusionRow({ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' })],
      }) // SELECT
      .mockRejectedValueOnce(checkErr) // UPDATE rejects
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({
        edit: [{ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', noBuy: true, noSell: false }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one of noBuy or noSell must be true/);
    expect(notifyExclusionBatchChangeMock).not.toHaveBeenCalled();
    expect(mockDbClient.query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('rejects edit + remove of the same row at the Zod layer (clean error vs mid-transaction 404)', async () => {
    const sharedId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({
        edit: [{ id: sharedId, noBuy: true, noSell: false }],
        remove: [sharedId],
      });

    expect(res.status).toBe(400);
    expect(mockDbClient.query).not.toHaveBeenCalled();
    expect(notifyExclusionBatchChangeMock).not.toHaveBeenCalled();
  });

  it('processes remove + edit + add in one transaction (full v3.4 batch shape)', async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      // 1. Remove
      .mockResolvedValueOnce({
        rows: [exclusionRow({ id: '11111111-1111-1111-1111-111111111111', ticker: 'OLD', reason: 'stale' })],
      }) // SELECT
      .mockResolvedValueOnce({ rowCount: 1 }) // DELETE
      // 2. Edit
      .mockResolvedValueOnce({
        rows: [
          exclusionRow({ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', ticker: 'KEEP', no_buy: true, no_sell: true }),
        ],
      }) // SELECT
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE
      // 3. Add
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      // 4. Final SELECT
      .mockResolvedValueOnce({
        rows: [
          exclusionRow({ ticker: 'KEEP', no_buy: true, no_sell: false }),
          exclusionRow({ ticker: 'NEW', no_buy: false, no_sell: true }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Mixed' }] });

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({
        add: [{ ticker: 'new', kind: 'advisor', reason: 'fresh', noBuy: false, noSell: true }],
        remove: ['11111111-1111-1111-1111-111111111111'],
        edit: [{ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', noBuy: true, noSell: false }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ added: 1, removed: 1, edited: 1 });

    expect(notifyExclusionBatchChangeMock).toHaveBeenCalledTimes(1);
    expect(notifyExclusionBatchChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        added: [expect.objectContaining({ ticker: 'NEW', noBuy: false, noSell: true })],
        removed: [expect.objectContaining({ ticker: 'OLD' })],
        changed: [
          expect.objectContaining({
            ticker: 'KEEP',
            before: { noBuy: true, noSell: true },
            after: { noBuy: true, noSell: false },
          }),
        ],
      }),
    );
    // v3.3 regression guard.
    expect(notifyExclusionChangeMock).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(notifyUsersSafeMock).toHaveBeenCalledTimes(1));
    expect(notifyUsersSafeMock).toHaveBeenCalledWith(['trader-uuid'], 'Mixed: 3 exclusions changed (+1, -1, ~1)', null);
  });
});

describe('GET /exclusions/export (firm-wide)', () => {
  const clientRow = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    client_id: 'user-1',
    ticker: 'TSLA',
    kind: 'advisor',
    reason: 'Concentration',
    no_buy: true,
    no_sell: true,
    created_by_name: 'Dana Trader',
    created_at: new Date('2026-06-01T14:00:00.000Z'),
  };
  const accountRow = {
    id: '550e8400-e29b-41d4-a716-446655440001',
    account_id: '01SYNTHNQTDVG6RNQ8TPY28EEX',
    ticker: 'XOM',
    kind: 'client',
    reason: 'ESG preference',
    no_buy: true,
    no_sell: false,
    created_by_name: 'Dana Trader',
    created_at: new Date('2026-07-01T14:00:00.000Z'),
  };

  beforeEach(() => {
    warehouseMock.isConfigured.mockReturnValue(false);
    warehouseMock.getCachedClients.mockResolvedValue([]);
  });

  it('returns both client- and account-level exclusions in one flat list', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [clientRow] }).mockResolvedValueOnce({ rows: [accountRow] });

    const res = await request(createApp(traderUser)).get('/exclusions/export');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const client = res.body.data.find((r: { scope: string }) => r.scope === 'client');
    const account = res.body.data.find((r: { scope: string }) => r.scope === 'account');
    expect(client).toMatchObject({ clientId: 'user-1', ticker: 'TSLA', noBuy: true, noSell: true, accountId: '' });
    expect(account).toMatchObject({
      accountId: '01SYNTHNQTDVG6RNQ8TPY28EEX',
      ticker: 'XOM',
      noSell: false,
    });
    expect(client.createdAt).toBe('2026-06-01T14:00:00.000Z');
  });

  it('takes no id list — it is deliberately unscoped', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    await request(createApp(traderUser)).get('/exclusions/export');

    // Neither query carries a WHERE ... = ANY($1) id filter.
    for (const call of mockPool.query.mock.calls) {
      expect(call[0]).not.toContain('ANY(');
      expect(call[1]).toBeUndefined();
    }
  });

  it('enriches ids with client and account names when Warehouse is configured', async () => {
    warehouseMock.isConfigured.mockReturnValue(true);
    warehouseMock.getCachedClients.mockResolvedValue([
      {
        id: 'user-1',
        name: 'Bob Client',
        accounts: [{ id: '01SYNTHNQTDVG6RNQ8TPY28EEX', accountNumber: 'ACCT-1001' }],
      },
    ]);
    mockPool.query.mockResolvedValueOnce({ rows: [clientRow] }).mockResolvedValueOnce({ rows: [accountRow] });

    const res = await request(createApp(traderUser)).get('/exclusions/export');

    const client = res.body.data.find((r: { scope: string }) => r.scope === 'client');
    const account = res.body.data.find((r: { scope: string }) => r.scope === 'account');
    expect(client.clientName).toBe('Bob Client');
    // The account ULID resolves back to its client too.
    expect(account).toMatchObject({ clientId: 'user-1', clientName: 'Bob Client', accountNumber: 'ACCT-1001' });
    // One cached call covers both scopes — no per-client fan-out.
    expect(warehouseMock.getCachedClients).toHaveBeenCalledTimes(1);
  });

  it('still exports ids when name enrichment fails', async () => {
    warehouseMock.isConfigured.mockReturnValue(true);
    warehouseMock.getCachedClients.mockRejectedValue(new Error('warehouse down'));
    mockPool.query.mockResolvedValueOnce({ rows: [clientRow] }).mockResolvedValueOnce({ rows: [accountRow] });

    const res = await request(createApp(traderUser)).get('/exclusions/export');

    // A Warehouse outage must not fail the export — ids are the authoritative part.
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((r: { clientName: string }) => r.clientName === '')).toBe(true);
  });

  it('leaves names empty for a client that has left the Warehouse list', async () => {
    warehouseMock.isConfigured.mockReturnValue(true);
    warehouseMock.getCachedClients.mockResolvedValue([{ id: 'someone-else', name: 'Other', accounts: [] }]);
    mockPool.query.mockResolvedValueOnce({ rows: [clientRow] }).mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(traderUser)).get('/exclusions/export');

    expect(res.body.data[0]).toMatchObject({ clientId: 'user-1', clientName: '' });
  });

  it('returns an empty list in demo mode without touching the DB', async () => {
    const res = await request(createApp(advisorUser, true)).get('/exclusions/export');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('is reachable by advisors, not just traders', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [clientRow] }).mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(advisorUser)).get('/exclusions/export');

    expect(res.status).toBe(200);
  });
});

describe('public demo cap (PERSONA_SIGN_IN=on)', () => {
  // Answers the cap's own queries by their SQL; everything else returns [].
  function scriptCap(held: number) {
    mockDbClient.query.mockImplementation(async (sql: string) =>
      /count\(\*\)/.test(sql) ? { rows: [{ n: held }] } : { rows: [] },
    );
  }
  const sqlCalls = () => mockDbClient.query.mock.calls.map(([sql]) => String(sql));
  const add = (ticker: string) => ({ ticker, kind: 'advisor', reason: 'r', noBuy: true, noSell: false });

  beforeEach(() => {
    process.env.PERSONA_SIGN_IN = 'on';
  });
  afterEach(() => {
    delete process.env.PERSONA_SIGN_IN;
  });

  it('counts every add in a batch, so a batch cannot carry the demo past its cap', async () => {
    scriptCap(398);

    const res = await request(createApp(advisorUser))
      .post('/C-1/exclusions/batch')
      .send({ add: [add('AAA'), add('BBB'), add('CCC')] });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/would add 3 with room for 2/);
    const calls = sqlCalls();
    expect(calls.findIndex((s) => s.includes('pg_advisory_xact_lock'))).toBe(1); // right after BEGIN
    expect(calls.findIndex((s) => s.includes('pg_advisory_xact_lock'))).toBeLessThan(
      calls.findIndex((s) => /count\(\*\)/.test(s)),
    );
    expect(calls.some((s) => s.includes('INSERT'))).toBe(false);
    expect(mockDbClient.query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('does not consult the cap for a batch that adds nothing net of its removes', async () => {
    mockDbClient.query.mockImplementation(async (sql: string) => {
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: 400 }] };
      if (/SELECT id, account_id/.test(sql)) return { rows: [accountExclusionRow({ id: '11111111-1111-1111-1111-111111111111' })] };
      return { rows: [] };
    });

    const res = await request(createApp(advisorUser))
      .post('/account-exclusions/ACC-ULID-1/batch')
      .send({ add: [add('AAA'), add('BBB')], remove: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'] });

    expect(res.status).toBe(200);
    // Two adds and two removes add nothing, so the cap is not even consulted.
    expect(sqlCalls().some((s) => s.includes('pg_advisory_xact_lock'))).toBe(false);
  });

  it('refuses a single add once the demo holds its cap, inside a transaction', async () => {
    scriptCap(400);

    const res = await request(createApp(advisorUser)).post('/C-1/exclusions').send(add('AAA'));

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/try again tomorrow/);
    expect(sqlCalls()).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock($1::int, $2::int)',
      expect.stringMatching(/count\(\*\)/),
      'ROLLBACK',
    ]);
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(mockDbClient.release).toHaveBeenCalled();
  });

  it('writes a single add in the same transaction as its cap check', async () => {
    mockDbClient.query.mockImplementation(async (sql: string) => {
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: 12 }] };
      if (sql.includes('INSERT INTO client_exclusions')) return { rows: [exclusionRow()] };
      return { rows: [] };
    });

    const res = await request(createApp(advisorUser)).post('/C-1/exclusions').send(add('TSLA'));

    expect(res.status).toBe(201);
    const calls = sqlCalls();
    expect(calls[0]).toBe('BEGIN');
    expect(calls.findIndex((s) => s.includes('INSERT'))).toBeGreaterThan(calls.findIndex((s) => /count\(\*\)/.test(s)));
    expect(calls[calls.length - 1]).toBe('COMMIT');
    expect(mockPool.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT'), expect.anything());
  });
});
