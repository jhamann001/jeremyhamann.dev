import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser, Client } from '@trade-request/shared';
import { advisorUser } from './testHelpers.js';

const { warehouseMocks, householdCacheMocks, mockLogger } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  return {
    warehouseMocks: {
      isConfigured: vi.fn(),
      getCachedClients: vi.fn(),
    },
    householdCacheMocks: {
      loadHouseholdConfigCached: vi.fn(),
    },
    mockLogger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock('../../services/warehouse.js', () => ({
  isConfigured: () => warehouseMocks.isConfigured(),
  getCachedClients: (...args: unknown[]) => warehouseMocks.getCachedClients(...args),
}));

vi.mock('../../services/householdConfigCache.js', () => ({
  loadHouseholdConfigCached: (...args: unknown[]) => householdCacheMocks.loadHouseholdConfigCached(...args),
}));

vi.mock('../../lib/logger.js', () => ({ default: mockLogger }));

import express from 'express';
import request from 'supertest';
import householdRoutes from '../households.js';
import { ActiveAccountsLoadError } from '../../services/meridianActiveAccounts.js';
import type { HouseholdConfig, HouseholdEntry } from '../../services/householdConfig.js';
import { errorHandler } from '../../middleware/errorHandler.js';

function createApp(user: AuthUser, options?: { isDemo?: boolean }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: AuthUser }).user = user;
    (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => true;
    if (options?.isDemo) (req as unknown as { isDemo: boolean }).isDemo = true;
    next();
  });
  app.use('/api/households', householdRoutes);
  app.use(errorHandler);
  return app;
}

const VALID_ULID = '01SYNTHJ7G094TRY2A6R126CB3';
const VALID_ULID_2 = '01SYNTH9K585RAMMAY4BF7AZ29';

function makeClient(id: string, accounts: { ulid: string; accountNumber: string }[] = []): Client {
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
  const byAccountNumber = new Map(entries.map((e) => [e.accountNumber, e] as const));
  return {
    byAccountNumber,
    householdNames: new Set(entries.map((e) => e.householdName)),
    entries,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  warehouseMocks.isConfigured.mockReset();
  warehouseMocks.getCachedClients.mockReset();
  householdCacheMocks.loadHouseholdConfigCached.mockReset();
});

describe('GET /api/households/resolve', () => {
  it('returns 200 with resolved households on the happy path', async () => {
    warehouseMocks.isConfigured.mockReturnValue(true);
    warehouseMocks.getCachedClients.mockResolvedValue([
      makeClient('CLI-1', [{ ulid: VALID_ULID, accountNumber: 'ACCT-1' }]),
    ]);
    householdCacheMocks.loadHouseholdConfigCached.mockResolvedValue(
      makeConfig([
        {
          accountNumber: VALID_ULID,
          householdName: 'Alpha Household',
          accountTitle: 'Alpha',
          householdId: 100,
        },
      ]),
    );

    const res = await request(createApp(advisorUser)).get('/api/households/resolve?clientIds=CLI-1').expect(200);
    expect(res.body.data.households).toHaveLength(1);
    expect(res.body.data.households[0]).toMatchObject({
      householdId: 100,
      householdName: 'Alpha Household',
      selectedAccountIds: [VALID_ULID],
    });
  });

  it('returns empty households in demo mode without calling the loader', async () => {
    const res = await request(createApp(advisorUser, { isDemo: true }))
      .get('/api/households/resolve?clientIds=CLI-1')
      .expect(200);
    expect(res.body.data).toEqual({
      households: [],
      unresolvedClientIds: ['CLI-1'],
      unresolvedAccountIds: [],
    });
    expect(householdCacheMocks.loadHouseholdConfigCached).not.toHaveBeenCalled();
    expect(warehouseMocks.getCachedClients).not.toHaveBeenCalled();
  });

  it('returns empty households when Warehouse is not configured (local-dev silent fallback)', async () => {
    warehouseMocks.isConfigured.mockReturnValue(false);
    const res = await request(createApp(advisorUser))
      .get(`/api/households/resolve?accountIds=${VALID_ULID}`)
      .expect(200);
    expect(res.body.data).toEqual({
      households: [],
      unresolvedClientIds: [],
      unresolvedAccountIds: [VALID_ULID],
    });
    expect(householdCacheMocks.loadHouseholdConfigCached).not.toHaveBeenCalled();
  });

  it('returns 400 when accountIds contains a non-ULID entry', async () => {
    warehouseMocks.isConfigured.mockReturnValue(true);
    await request(createApp(advisorUser)).get('/api/households/resolve?accountIds=not-a-ulid').expect(400);
  });

  it('returns 400 when clientIds list exceeds 50 entries', async () => {
    warehouseMocks.isConfigured.mockReturnValue(true);
    const over = Array.from({ length: 51 }, (_, i) => `CLI-${i}`).join(',');
    await request(createApp(advisorUser)).get(`/api/households/resolve?clientIds=${over}`).expect(400);
  });

  it('returns 503 with household_data_unavailable on loader failure', async () => {
    warehouseMocks.isConfigured.mockReturnValue(true);
    householdCacheMocks.loadHouseholdConfigCached.mockRejectedValue(new ActiveAccountsLoadError('GCS exploded', 'gcs'));
    const res = await request(createApp(advisorUser)).get('/api/households/resolve?clientIds=CLI-1').expect(503);
    expect(res.body.error).toBe('household_data_unavailable');
  });

  it('rejects unrelated loader errors as 500 (do not silently swallow)', async () => {
    warehouseMocks.isConfigured.mockReturnValue(true);
    householdCacheMocks.loadHouseholdConfigCached.mockRejectedValue(new Error('unexpected'));
    await request(createApp(advisorUser)).get('/api/households/resolve?clientIds=CLI-1').expect(500);
  });

  it('accepts the empty query (no clientIds, no accountIds) and returns an empty resolution', async () => {
    warehouseMocks.isConfigured.mockReturnValue(true);
    warehouseMocks.getCachedClients.mockResolvedValue([]);
    householdCacheMocks.loadHouseholdConfigCached.mockResolvedValue(makeConfig([]));

    const res = await request(createApp(advisorUser)).get('/api/households/resolve').expect(200);
    expect(res.body.data).toEqual({ households: [], unresolvedClientIds: [], unresolvedAccountIds: [] });
  });

  it('parses comma-separated lists with multiple entries', async () => {
    warehouseMocks.isConfigured.mockReturnValue(true);
    warehouseMocks.getCachedClients.mockResolvedValue([
      makeClient('CLI-1', [{ ulid: VALID_ULID, accountNumber: 'ACCT-1' }]),
      makeClient('CLI-2', [{ ulid: VALID_ULID_2, accountNumber: 'ACCT-2' }]),
    ]);
    householdCacheMocks.loadHouseholdConfigCached.mockResolvedValue(
      makeConfig([
        { accountNumber: VALID_ULID, householdName: 'H1', accountTitle: 'a', householdId: 1 },
        { accountNumber: VALID_ULID_2, householdName: 'H2', accountTitle: 'b', householdId: 2 },
      ]),
    );

    const res = await request(createApp(advisorUser)).get('/api/households/resolve?clientIds=CLI-1,CLI-2').expect(200);
    expect(res.body.data.households.map((h: { householdId: number }) => h.householdId)).toEqual([1, 2]);
  });
});
