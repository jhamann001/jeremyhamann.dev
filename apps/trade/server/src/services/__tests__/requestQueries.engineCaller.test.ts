import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthUser } from '@trade-request/shared';

const { mockPool } = vi.hoisted(() => ({
  mockPool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), end: vi.fn() },
}));
vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../assetLocationEngine.js', async (orig) => {
  const actual = await orig<typeof import('../assetLocationEngine.js')>();
  return { ...actual, verifyExecutionPlans: vi.fn(actual.verifyExecutionPlans) };
});

import { verifyExecutionPlans } from '../assetLocationEngine.js';
import { mapRowToRequest, listRequests, getRequestForUser, type DbTradeRequestRow } from '../requestQueries.js';

const user: AuthUser = {
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

const row = {
  id: 'REQ-PLAN0001',
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
} as unknown as DbTradeRequestRow;

const verifier = vi.mocked(verifyExecutionPlans);

beforeEach(() => {
  process.env.EXECUTION_PLAN_GENERATION = 'off';
  mockPool.query.mockReset().mockResolvedValue({ rows: [] });
  verifier.mockClear();
});

afterEach(() => {
  delete process.env.EXECUTION_PLAN_GENERATION;
});

function queueRequestRows(): void {
  mockPool.query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
}

describe('stored-plan verification by caller class (plan generation off)', () => {
  it('mapRowToRequest skips the verifier for the default service caller', () => {
    expect(mapRowToRequest(row, []).validation).toBeUndefined();
    expect(verifier).not.toHaveBeenCalled();
  });

  it('mapRowToRequest verifies for an MCP caller', () => {
    expect(mapRowToRequest(row, [], 'mcp').validation).toBeDefined();
  });

  it('listRequests verifies for an MCP caller', async () => {
    queueRequestRows();
    const { data } = await listRequests(user, { limit: 5 }, 'mcp');
    expect(data).toHaveLength(1);
    expect(data[0].validation).toBeDefined();
  });

  it('listRequests skips the verifier for the default caller', async () => {
    queueRequestRows();
    const { data } = await listRequests(user, { limit: 5 });
    expect(data).toHaveLength(1);
    expect(data[0].validation).toBeUndefined();
  });

  it('getRequestForUser verifies for an MCP caller', async () => {
    queueRequestRows();
    expect((await getRequestForUser(user, row.id, 'mcp')).validation).toBeDefined();
  });

  it('getRequestForUser skips the verifier for the default caller', async () => {
    queueRequestRows();
    expect((await getRequestForUser(user, row.id)).validation).toBeUndefined();
  });
});
