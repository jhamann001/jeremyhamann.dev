import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser, Client } from '@trade-request/shared';
import { traderUser, advisorUser } from './testHelpers.js';

const { mockPool, warehouseMocks, householdCacheMocks, driftMocks, mockLogger } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  return {
    mockPool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() },
    warehouseMocks: {
      isConfigured: vi.fn(),
      getCachedClients: vi.fn(),
    },
    householdCacheMocks: {
      loadHouseholdConfigCached: vi.fn(),
    },
    driftMocks: {
      fetchLatestDriftAllocationsByAccountId: vi.fn(),
    },
    mockLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('../../db/pool.js', () => ({ default: mockPool }));

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

vi.mock('../../services/slack.js', () => ({
  notifyNewRequest: vi.fn(),
  notifyStatusChange: vi.fn(),
}));

vi.mock('../../services/warehouse.js', () => ({
  isConfigured: () => warehouseMocks.isConfigured(),
  getCachedClients: (...args: unknown[]) => warehouseMocks.getCachedClients(...args),
  // Touched by other request routes at import/handler time; harmless stubs.
  getClientAccounts: vi.fn(),
  getAccountTypeMap: vi.fn(),
  isStockRecordConfigured: () => false,
  getClassifiedHoldings: vi.fn(),
}));

vi.mock('../../services/householdConfigCache.js', () => ({
  loadHouseholdConfigCached: (...args: unknown[]) => householdCacheMocks.loadHouseholdConfigCached(...args),
}));

vi.mock('../../services/positionDriftAccountsPersistence.js', () => ({
  fetchLatestDriftAllocationsByAccountId: (...args: unknown[]) =>
    driftMocks.fetchLatestDriftAllocationsByAccountId(...args),
}));

vi.mock('../../lib/logger.js', () => ({ default: mockLogger }));

import express from 'express';
import request from 'supertest';
import requestRoutes from '../requests.js';
import { ActiveAccountsLoadError } from '../../services/meridianActiveAccounts.js';
import type { HouseholdConfig, HouseholdEntry } from '../../services/householdConfig.js';
import { DEMO_REQUESTS } from '../../fixtures/demo-data.js';
import { errorHandler } from '../../middleware/errorHandler.js';

function createApp(user: AuthUser, options?: { isDemo?: boolean }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    (req as any).isAuthenticated = () => true;
    if (options?.isDemo) (req as any).isDemo = true;
    next();
  });
  app.use('/requests', requestRoutes);
  app.use(errorHandler);
  return app;
}

const ULID_SEL = '01SYNTHQJHSGF8N5DPE53KFXYD';
const ULID_SIB = '01SYNTH3ZDVSZCA9ZAK4Q2RS5B';

function makeClient(id: string, accounts: { ulid: string; accountNumber: string }[]): Client {
  return {
    id,
    name: `Client ${id}`,
    accounts: accounts.map((a) => ({
      id: a.ulid,
      clientId: id,
      accountNumber: a.accountNumber,
      accountType: 'Taxable',
      balance: 100_000,
      holdings: { cash: 0, fixed: 0, equity: 100_000 },
    })),
  };
}

function makeConfig(entries: HouseholdEntry[]): HouseholdConfig {
  return {
    byAccountNumber: new Map(entries.map((e) => [e.accountNumber, e] as const)),
    householdNames: new Set(entries.map((e) => e.householdName)),
    entries,
  };
}

// Two accounts in one household; ACCT-SEL is the selected account, ACCT-SIB the sibling.
function happyHousehold() {
  warehouseMocks.isConfigured.mockReturnValue(true);
  warehouseMocks.getCachedClients.mockResolvedValue([
    makeClient('CLI-1', [
      { ulid: ULID_SEL, accountNumber: 'ACCT-SEL' },
      { ulid: ULID_SIB, accountNumber: 'ACCT-SIB' },
    ]),
  ]);
  householdCacheMocks.loadHouseholdConfigCached.mockResolvedValue(
    makeConfig([
      { accountNumber: ULID_SEL, householdName: 'Alpha Household', accountTitle: 'Joint', householdId: 100 },
      { accountNumber: ULID_SIB, householdName: 'Alpha Household', accountTitle: 'Roth IRA', householdId: 100 },
    ]),
  );
}

const requestRow = {
  rows: [{ client_id: 'CLI-1', client_ids: ['CLI-1'], selected_accounts: ['ACCT-SEL'] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockReset();
  warehouseMocks.isConfigured.mockReset();
  warehouseMocks.getCachedClients.mockReset();
  householdCacheMocks.loadHouseholdConfigCached.mockReset();
  driftMocks.fetchLatestDriftAllocationsByAccountId.mockReset();
});

describe('GET /requests/:id/household-holdings', () => {
  it('returns non-selected siblings enriched with current allocation + drift', async () => {
    mockPool.query.mockResolvedValueOnce(requestRow);
    happyHousehold();
    driftMocks.fetchLatestDriftAllocationsByAccountId.mockResolvedValue(
      new Map([
        [
          ULID_SIB,
          {
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
          },
        ],
      ]),
    );

    const res = await request(createApp(traderUser)).get('/requests/REQ-1/household-holdings').expect(200);
    expect(res.body.source).toBe('drift');
    expect(res.body.data.driftRunDate).toBe('2026-05-13');
    expect(res.body.data.siblings).toHaveLength(1);
    expect(res.body.data.siblings[0]).toMatchObject({
      accountId: ULID_SIB,
      accountNumber: 'ACCT-SIB',
      hasDrift: true,
      positionEquityPct: 68,
      templateEquityPct: 60,
      maxBucketDeltaPct: 8,
      worstBucket: 'equity',
    });
    // The selected account must NOT appear among siblings.
    expect(res.body.data.siblings.map((s: { accountId: string }) => s.accountId)).not.toContain(ULID_SEL);
    // Drift was queried only for the sibling ULID.
    expect(driftMocks.fetchLatestDriftAllocationsByAccountId).toHaveBeenCalledWith(mockPool, [ULID_SIB]);
  });

  it('nulls the target for a no_template sibling (no model to compare against)', async () => {
    mockPool.query.mockResolvedValueOnce(requestRow);
    happyHousehold();
    driftMocks.fetchLatestDriftAllocationsByAccountId.mockResolvedValue(
      new Map([
        [
          ULID_SIB,
          {
            runDateLocal: '2026-05-13',
            status: 'no_template',
            totalValueUsd: 100_000,
            positionCashPct: 3,
            positionFixedPct: 0,
            positionEquityPct: 97,
            templateCashPct: 0,
            templateFixedPct: 0,
            templateEquityPct: 0,
            maxBucketDeltaPct: null,
            worstBucket: null,
          },
        ],
      ]),
    );

    const res = await request(createApp(traderUser)).get('/requests/REQ-1/household-holdings').expect(200);
    const sib = res.body.data.siblings[0];
    expect(sib).toMatchObject({
      status: 'no_template',
      positionEquityPct: 97,
      templateCashPct: null,
      templateFixedPct: null,
      templateEquityPct: null,
      maxBucketDeltaPct: null,
    });
  });

  it('still returns siblings (balance-only) when the drift query fails', async () => {
    mockPool.query.mockResolvedValueOnce(requestRow);
    happyHousehold();
    driftMocks.fetchLatestDriftAllocationsByAccountId.mockRejectedValue(new Error('db down'));

    const res = await request(createApp(traderUser)).get('/requests/REQ-1/household-holdings').expect(200);
    expect(res.body.source).toBe('drift');
    expect(res.body.data.driftRunDate).toBeNull();
    expect(res.body.data.siblings[0]).toMatchObject({ accountId: ULID_SIB, hasDrift: false, positionEquityPct: null });
  });

  it('falls back to empty/unavailable when Warehouse is not configured', async () => {
    mockPool.query.mockResolvedValueOnce(requestRow);
    warehouseMocks.isConfigured.mockReturnValue(false);

    const res = await request(createApp(traderUser)).get('/requests/REQ-1/household-holdings').expect(200);
    expect(res.body).toEqual({ data: { siblings: [], driftRunDate: null }, source: 'unavailable' });
    expect(householdCacheMocks.loadHouseholdConfigCached).not.toHaveBeenCalled();
  });

  it('falls back to unavailable when the household feed is unavailable', async () => {
    mockPool.query.mockResolvedValueOnce(requestRow);
    warehouseMocks.isConfigured.mockReturnValue(true);
    householdCacheMocks.loadHouseholdConfigCached.mockRejectedValue(new ActiveAccountsLoadError('boom', 'gcs'));

    const res = await request(createApp(traderUser)).get('/requests/REQ-1/household-holdings').expect(200);
    expect(res.body.source).toBe('unavailable');
    expect(res.body.data.siblings).toEqual([]);
  });

  it('returns 404 when the request does not exist', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(createApp(traderUser)).get('/requests/REQ-MISSING/household-holdings').expect(404);
  });

  it('returns 403 for non-trader roles', async () => {
    await request(createApp(advisorUser)).get('/requests/REQ-1/household-holdings').expect(403);
  });

  it('serves demo sessions without touching Warehouse or the drift feed', async () => {
    const demoId = DEMO_REQUESTS[0].id;
    const res = await request(createApp(traderUser, { isDemo: true }))
      .get(`/requests/${demoId}/household-holdings`)
      .expect(200);
    expect(res.body.source).toBe('demo');
    expect(Array.isArray(res.body.data.siblings)).toBe(true);
    expect(warehouseMocks.getCachedClients).not.toHaveBeenCalled();
    expect(driftMocks.fetchLatestDriftAllocationsByAccountId).not.toHaveBeenCalled();
  });
});
