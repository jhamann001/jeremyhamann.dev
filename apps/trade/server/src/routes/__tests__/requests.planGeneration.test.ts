import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthUser } from '@trade-request/shared';
import { traderUser, advisorUser } from './testHelpers.js';

const { mockPool } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  const poolClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return {
    mockPool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue(poolClient),
      end: vi.fn(),
      _client: poolClient,
    },
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

vi.mock('../../services/notificationInserts.js', () => ({
  fetchActiveTraderUserIds: vi.fn().mockResolvedValue([]),
  insertNotificationsForUsers: vi.fn().mockResolvedValue(undefined),
  notifyUsersSafe: vi.fn(),
}));

vi.mock('../../services/requestQueries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/requestQueries.js')>();
  return { ...actual, findRecentDuplicate: vi.fn().mockResolvedValue(null) };
});

vi.mock('../../services/warehouse.js', () => ({
  isConfigured: () => false,
  getClientAccounts: vi.fn(),
  getAccountTypeMap: vi.fn(),
  isStockRecordConfigured: () => true,
  getClassifiedHoldings: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../services/assetLocationEngine.js', async (orig) => {
  const actual = await orig<typeof import('../../services/assetLocationEngine.js')>();
  return { ...actual, runAssetLocationEngine: vi.fn(actual.runAssetLocationEngine) };
});

import express from 'express';
import request from 'supertest';
import requestRoutes from '../requests.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { runAssetLocationEngine } from '../../services/assetLocationEngine.js';

const engineSpy = vi.mocked(runAssetLocationEngine);
const REFUSAL = 'Execution plans are no longer generated for trade requests.';

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

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

const sampleTradeRequestRow = {
  id: 'REQ-12345678',
  client_id: 'HH-001',
  client_name: 'The Richardson Family',
  client_ids: ['HH-001'],
  client_names: ['The Richardson Family'],
  advisor_id: 'advisor-uuid',
  advisor_name: 'Stale Joined Name',
  trade_type: 'Raise Cash',
  trade_amount: '$50,000',
  deposit_account: null,
  rebalance_all: false,
  status: 'Pending Review',
  total_value: '1000000',
  selected_accounts: ['ACCT-1001'],
  priority: 'Standard',
  advisor_notes: null,
  residence: 'Other',
  liquidation_approval: null,
  advisor_exclusions: null,
  client_exclusions: null,
  esg_filters: null,
  risk_profile: null,
  base_allocation: { equity: 0, fixed: 0, cash: 0 },
  equity_strategies: [],
  raise_cash_reason: 'Need liquidity',
  liquidity_deadline: null,
  liquidate_option: null,
  liquidate_positions: null,
  execution_plan: null,
  asset_location_mode: 'priority',
  household_id: null,
  household_name: null,
  created_at: new Date(),
  updated_at: new Date(),
};

const storedPlan = [
  {
    accountNumber: 'ACCT-1001',
    accountType: 'Taxable',
    accountValue: 850000,
    templateName: 'Stored',
    modelName: 'Stored',
    postTradeHoldings: { cash: 4250, fixed: 123250, equity: 722500 },
    trades: [],
  },
];

const mirrorPayloadBase = {
  clientId: 'HH-001',
  clientName: 'The Richardson Family',
  selectedAccounts: ['ACCT-TAX', 'ACCT-TRAD', 'ACCT-ROTH'],
  accountsData: [
    { accountNumber: 'ACCT-TAX', accountType: 'Taxable' as const, balance: 1_000_000 },
    { accountNumber: 'ACCT-TRAD', accountType: 'Traditional IRA' as const, balance: 200_000 },
    { accountNumber: 'ACCT-ROTH', accountType: 'Roth IRA' as const, balance: 200_000 },
  ],
  priority: 'Standard' as const,
  residence: 'Other' as const,
  liquidationApproval: 'Yes' as const,
  riskProfile: 18,
  equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: 'plan-generation switch test' }],
};

function findInsertTradeRequestCall() {
  return mockPool._client.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO trade_requests'))!;
}
function findUpdateTradeRequestCall() {
  return mockPool._client.query.mock.calls.find((call) => String(call[0]).startsWith('UPDATE trade_requests SET\n'))!;
}

function mockPostTransaction(insertedRow: Record<string, unknown>): void {
  mockPool._client.query
    .mockResolvedValueOnce({ rows: [] }) // BEGIN
    .mockResolvedValueOnce({ rows: [insertedRow] }) // INSERT trade_requests RETURNING *
    .mockResolvedValueOnce({
      rows: [
        {
          id: 'audit-1',
          request_id: insertedRow.id,
          user_name: advisorUser.name,
          action: 'Created Request',
          notes: '',
          created_at: new Date(),
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] }); // COMMIT
}

async function createRequest(tradeType: 'Initial Funding' | 'Rebalance') {
  mockPool.query.mockResolvedValueOnce({ rows: [] }); // last-allocation lookup
  mockPostTransaction({ ...sampleTradeRequestRow, trade_type: tradeType });
  return request(createApp(advisorUser))
    .post('/requests')
    .send({ ...mirrorPayloadBase, tradeType, tradeAmount: '', depositAccount: '' });
}

function expectSingleRefusalWrite(): void {
  expect(mockPool.query).toHaveBeenCalledTimes(1);
  const [sql, params] = mockPool.query.mock.calls[0];
  expect(String(sql)).toContain('engine_use_daily');
  expect(params).toEqual([today(), 'service', 'refused', 1]);
  expect(mockPool.connect).not.toHaveBeenCalled();
}

beforeEach(() => {
  mockPool.query.mockReset().mockResolvedValue({ rows: [] });
  mockPool._client.query.mockReset().mockResolvedValue({ rows: [] });
  mockPool.connect.mockReset().mockResolvedValue(mockPool._client);
  engineSpy.mockClear();
});

afterEach(() => {
  delete process.env.EXECUTION_PLAN_GENERATION;
});

describe('plan generation off', () => {
  beforeEach(() => {
    process.env.EXECUTION_PLAN_GENERATION = 'off';
  });

  it('saves a new Initial Funding request with no plan', async () => {
    const res = await createRequest('Initial Funding');
    expect(res.status).toBe(201);
    expect(engineSpy).not.toHaveBeenCalled();
    expect(findInsertTradeRequestCall()[1][28]).toBeNull();
  });

  it('saves a new Rebalance request with no plan', async () => {
    const res = await createRequest('Rebalance');
    expect(res.status).toBe(201);
    expect(engineSpy).not.toHaveBeenCalled();
    expect(findInsertTradeRequestCall()[1][28]).toBeNull();
  });

  it('keeps the stored plan when a request is edited', async () => {
    const needsInfoRow = {
      ...sampleTradeRequestRow,
      status: 'Needs Info',
      advisor_id: advisorUser.id,
      execution_plan: storedPlan,
    };
    mockPool.query
      .mockResolvedValueOnce({ rows: [needsInfoRow] })
      .mockResolvedValueOnce({
        rows: [
          {
            risk_profile: 20,
            base_allocation: { equity: 79, fixed: 20, cash: 1 },
            equity_strategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: 'Existing rationale' }],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ ...needsInfoRow, trade_type: 'Rebalance', risk_profile: 20 }] })
      .mockResolvedValueOnce({ rows: [] });
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(advisorUser))
      .put('/requests/REQ-12345678')
      .send({
        clientId: 'HH-001',
        clientName: 'The Richardson Family',
        tradeType: 'Rebalance',
        tradeAmount: '',
        depositAccount: '',
        selectedAccounts: ['ACCT-1001'],
        accountsData: [{ accountNumber: 'ACCT-1001', accountType: 'Taxable', balance: 850000 }],
        priority: 'Standard',
        residence: 'Other',
        liquidationApproval: 'Yes',
        riskProfile: 20,
        equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
      });

    expect(res.status).toBe(200);
    expect(engineSpy).not.toHaveBeenCalled();
    const [sql, params] = findUpdateTradeRequestCall();
    expect(String(sql)).toContain('COALESCE($26::jsonb, execution_plan)');
    expect(params[25]).toBeNull();
  });

  it('refuses run-engine and leaves the request untouched', async () => {
    const res = await request(createApp(traderUser))
      .post('/requests/REQ-12345678/run-engine')
      .send({ holdings: {}, expectedUpdatedAt: new Date().toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(REFUSAL);
    expectSingleRefusalWrite();
  });

  it('refuses the classified-holdings pre-fill', async () => {
    const res = await request(createApp(traderUser)).get('/requests/REQ-12345678/classified-holdings');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(REFUSAL);
    expectSingleRefusalWrite();
  });

  it('refuses the household-holdings pre-fill', async () => {
    const res = await request(createApp(traderUser)).get('/requests/REQ-12345678/household-holdings');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(REFUSAL);
    expectSingleRefusalWrite();
  });

  it('refuses run-engine in demo mode', async () => {
    const res = await request(createApp(traderUser, { isDemo: true }))
      .post('/requests/REQ-DEMO0001/run-engine')
      .send({});
    expect(res.status).toBe(409);
  });
});

describe('plan generation on (switch unset)', () => {
  it('generates a plan and writes no count during the request', async () => {
    const res = await createRequest('Initial Funding');
    expect(res.status).toBe(201);
    expect(engineSpy).toHaveBeenCalledTimes(1);
    for (const call of mockPool.query.mock.calls) {
      expect(String(call[0])).not.toContain('engine_use_daily');
    }
  });
});
