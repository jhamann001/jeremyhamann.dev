import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthUser } from '@trade-request/shared';

const { mockPool } = vi.hoisted(() => ({
  mockPool: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
    end: vi.fn(),
  },
}));
vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../../services/warehouse.js', () => ({
  isConfigured: () => false,
  getClientAccounts: vi.fn(),
}));
vi.mock('../../services/assetLocationEngine.js', async (orig) => {
  const actual = await orig<typeof import('../../services/assetLocationEngine.js')>();
  return {
    ...actual,
    runAssetLocationEngine: vi.fn(actual.runAssetLocationEngine),
    verifyExecutionPlans: vi.fn(actual.verifyExecutionPlans),
  };
});

import { registerTools } from '../tools.js';
import { runAssetLocationEngine, verifyExecutionPlans } from '../../services/assetLocationEngine.js';

interface RegisteredTool {
  name: string;
  cb: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

const engineSpy = vi.mocked(runAssetLocationEngine);
const verifierSpy = vi.mocked(verifyExecutionPlans);

const trader: AuthUser = {
  id: 'trader-uuid',
  googleId: 'g-trader',
  email: 'trader@example.com',
  name: 'Test Trader',
  picture: null,
  role: 'trader',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: null,
  createdAt: new Date().toISOString(),
};

function setup() {
  const tools = new Map<string, RegisteredTool>();
  const registerTool = vi.fn((name: string, _config: unknown, cb: RegisteredTool['cb']) => {
    tools.set(name, { name, cb });
  });
  registerTools({ registerTool } as unknown as Parameters<typeof registerTools>[0], async () => trader);
  return tools;
}

const fakeExtra = {} as never;

/** A row holding a stored plan, so a verifying caller runs the verifier. */
const planRow = {
  id: 'REQ-AB12CD34',
  client_id: 'HH-001',
  client_name: 'Synthetic Household',
  advisor_id: 'trader-uuid',
  trade_type: 'Rebalance',
  status: 'Approved',
  total_value: '100000',
  rebalance_all: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  base_allocation: { equity: 60, fixed: 30, cash: 10 },
  execution_plan: [
    {
      accountNumber: 'ACCT-1',
      accountType: 'Taxable',
      accountValue: 100000,
      templateName: 'T',
      modelName: 'M',
      postTradeHoldings: { cash: 10000, fixed: 30000, equity: 60000 },
      trades: [],
    },
  ],
};

function routeQueries(): void {
  mockPool.query.mockImplementation((sql: string) => {
    if (/GROUP BY status/.test(sql)) return Promise.resolve({ rows: [{ status: 'Approved', count: '1' }] });
    if (/FROM trade_requests/.test(sql)) return Promise.resolve({ rows: [planRow] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  process.env.EXECUTION_PLAN_GENERATION = 'off';
  mockPool.query.mockReset().mockResolvedValue({ rows: [] });
  engineSpy.mockClear();
  verifierSpy.mockClear();
});

afterEach(() => {
  delete process.env.EXECUTION_PLAN_GENERATION;
});

describe('MCP tools keep the engine while plan generation is off', () => {
  it('list_my_requests verifies stored plans', async () => {
    routeQueries();
    const result = await setup().get('list_my_requests')!.cb({ limit: 10 }, fakeExtra);
    expect(result.isError).toBeUndefined();
    expect(verifierSpy).toHaveBeenCalled();
  });

  it('get_request verifies the stored plan', async () => {
    routeQueries();
    const result = await setup().get('get_request')!.cb({ id: planRow.id }, fakeExtra);
    expect(result.isError).toBeUndefined();
    expect(verifierSpy).toHaveBeenCalled();
  });

  it('get_queue_digest verifies stored plans', async () => {
    routeQueries();
    const result = await setup().get('get_queue_digest')!.cb({ limit: 10 }, fakeExtra);
    expect(result.isError).toBeUndefined();
    expect(verifierSpy).toHaveBeenCalled();
  });

  it('get_request_pdf verifies the stored plan', async () => {
    routeQueries();
    const result = await setup().get('get_request_pdf')!.cb({ id: planRow.id }, fakeExtra);
    expect(result.isError).toBeUndefined();
    expect(verifierSpy).toHaveBeenCalled();
  });

  it('get_compliance_report_pdf verifies stored plans', async () => {
    routeQueries();
    const result = await setup().get('get_compliance_report_pdf')!.cb({}, fakeExtra);
    expect(result.isError).toBeUndefined();
    expect(verifierSpy).toHaveBeenCalled();
  });

  it('preview_engine runs the engine', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            client_id: 'HH-001',
            account_number: 'ACCT-1',
            account_type: 'Taxable',
            balance: '100000',
            holdings: { cash: 100000, fixed: 0, equity: 0 },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const result = await setup()
      .get('preview_engine')!
      .cb({ clientId: 'HH-001', tradeType: 'Rebalance', riskProfile: 12 }, fakeExtra);
    expect(result.isError).toBeUndefined();
    expect(engineSpy).toHaveBeenCalledTimes(1);
  });
});
