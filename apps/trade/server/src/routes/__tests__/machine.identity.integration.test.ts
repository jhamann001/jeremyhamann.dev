import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TradeRequest } from '@trade-request/shared';
import express from 'express';
import request from 'supertest';

// Real route + real identity resolver; only the database and outbound network
// are replaced. Never connect these synthetic cases to a live service.
const { listRequests, logger } = vi.hoisted(() => ({
  listRequests: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/requestQueries.js', () => ({ listRequestsForClientIds: listRequests }));
vi.mock('../../lib/logger.js', () => ({ default: logger }));
vi.mock('../../lib/secrets.js', () => ({ readSecret: (key: string) => process.env[key] }));

const USER_ID = 'user-11111111-1111-1111-1111-111111111111';
const ACCOUNT = 'SYNTHETIC-1234';
const ACCOUNT_ID = '01SYNTHETICACCOUNT000000001';

function trade(persisted = false): TradeRequest {
  return {
    id: 'REQ-SYNTHETIC',
    clientId: USER_ID,
    clientIds: [USER_ID],
    clientName: 'Synthetic Fixture',
    clientNames: ['Synthetic Fixture'],
    advisor: 'Synthetic Advisor',
    submittedBy: 'Synthetic Submitter',
    tradeType: 'Rebalance',
    tradeAmount: '',
    depositAccount: '',
    rebalanceAll: false,
    status: 'Pending Review',
    date: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    selectedAccounts: [ACCOUNT],
    totalValue: 100,
    priority: 'Standard',
    advisorNotes: 'Synthetic private note',
    residence: 'Other',
    liquidationApproval: '',
    advisorExclusions: '',
    clientExclusions: '',
    esgFilters: {
      none: true,
      fossilFuels: false,
      tobacco: false,
      weapons: false,
      alcohol: false,
      gambling: false,
      other: false,
      otherDescription: '',
    },
    riskProfile: null,
    baseAllocation: { equity: 0, fixed: 0, cash: 0 },
    equityStrategies: [],
    raiseCashReason: '',
    liquidityDeadline: null,
    liquidateOption: '',
    liquidatePositions: '',
    executionPlan: [],
    auditLog: [],
    accountMetadata: [
      {
        accountNumber: ACCOUNT,
        accountType: 'Taxable',
        balance: 100,
        ...(persisted ? { accountId: ACCOUNT_ID } : {}),
      },
    ],
  };
}

function identityResponse(url: string): Response {
  if (url.includes('/card/contacts/')) {
    return Response.json([
      {
        cedar_ridge_user_id__c: USER_ID,
        name: 'Synthetic Fixture',
        crm__primary_entity_stage__c: 'Client',
      },
    ]);
  }
  if (url.includes('/card/investments/')) {
    return Response.json([
      {
        user_id: USER_ID,
        custodian_account_number: ACCOUNT,
        custodian_account_id: ACCOUNT_ID,
        account_type: 'BROKERAGE',
      },
    ]);
  }
  throw new Error('Unexpected dependency: identity reads must not load financial data');
}

async function app() {
  const { default: router } = await import('../machine.js');
  const server = express();
  // Production mounts requireMachineAuth before this router; its separate
  // middleware tests own OIDC verification. No auth bypass is added to runtime.
  server.use('/api/machine', router);
  return server;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({
    WAREHOUSE_URL: 'https://synthetic.invalid',
    WAREHOUSE_API_KEY: 'synthetic-test-key',
    WAREHOUSE_CONTACTS_QUESTION_ID: 'contacts',
    WAREHOUSE_INVESTMENTS_QUESTION_ID: 'investments',
    WAREHOUSE_BALANCES_QUESTION_ID: 'balances',
    WAREHOUSE_STOCK_RECORD_QUESTION_ID: 'stock',
  }))
    vi.stubEnv(key, value);
  listRequests.mockResolvedValue([trade()]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('machine route with the real independent identity resolver', () => {
  it('serves persisted account IDs without any Warehouse request', async () => {
    listRequests.mockResolvedValue([trade(true)]);
    const fetchMock = vi.fn(() => {
      throw new Error('No enrichment expected');
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(await app()).get(`/api/machine/trade-requests?cedar_ridge_user_id=${USER_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].accounts[0].accountId).toBe(ACCOUNT_ID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves legacy identities even when the unrelated balance and stock sources are unconfigured', async () => {
    vi.stubEnv('WAREHOUSE_BALANCES_QUESTION_ID', '');
    vi.stubEnv('WAREHOUSE_STOCK_RECORD_QUESTION_ID', '');
    const fetchMock = vi.fn(async (url: string | URL | Request) => identityResponse(String(url)));
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(await app()).get(`/api/machine/trade-requests?cedar_ridge_user_id=${USER_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].accounts[0].accountId).toBe(ACCOUNT_ID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares a cold identity refresh across concurrent batch and single-user reads, then refreshes after expiry', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    let calls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      calls += 1;
      if (calls === 2) bothStarted();
      await gate;
      return identityResponse(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const server = await app();
    const batch = Array.from(
      { length: 40 },
      (_, index) => `user-${String(index).padStart(8, '0')}-1111-1111-1111-111111111111`,
    );
    const first = request(server)
      .get(`/api/machine/trade-requests?cedar_ridge_user_ids=${batch.join(',')}`)
      .then((res) => res);
    const second = request(server)
      .get(`/api/machine/trade-requests?cedar_ridge_user_id=${USER_ID}`)
      .then((res) => res);
    await started;
    release();
    for (const res of await Promise.all([first, second])) {
      expect(res.status).toBe(200);
      expect(res.body.data[0].accounts[0].accountId).toBe(ACCOUNT_ID);
      expect(res.headers['cache-control']).toBe('no-store, private');
      expect(JSON.stringify(res.body)).not.toContain(ACCOUNT);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += 30 * 60 * 1000 + 1;
    const renewed = await request(server).get(`/api/machine/trade-requests?cedar_ridge_user_id=${USER_ID}`);
    expect(renewed.status).toBe(200);
    expect(renewed.body.data[0].accounts[0].accountId).toBe(ACCOUNT_ID);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retains the full response and persisted identities if legacy enrichment is unavailable', async () => {
    listRequests.mockResolvedValue([{ ...trade(true), id: 'REQ-PERSISTED' }, trade()]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'synthetic' }, { status: 503 })),
    );
    const res = await request(await app()).get(`/api/machine/trade-requests?cedar_ridge_user_id=${USER_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((row: { accounts: { accountId: string | null }[] }) => row.accounts[0].accountId)).toEqual(
      [ACCOUNT_ID, null],
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(ACCOUNT);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(USER_ID);
    expect(JSON.stringify(res.body)).not.toContain('Synthetic private note');
  });
});
