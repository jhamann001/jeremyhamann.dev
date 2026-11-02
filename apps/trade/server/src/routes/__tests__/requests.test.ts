import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@trade-request/shared';
import { traderUser, advisorUser } from './testHelpers.js';
import { getRiskAllocation } from '@trade-request/shared/allocations';

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

// The create/resubmit handlers fire `void fetchActiveTraderUserIds()...` AFTER
// responding. Unmocked, that floating promise runs a real `pool.query` once the
// test has already returned, where it can consume a `mockResolvedValueOnce`
// queued by a LATER test — `vi.clearAllMocks()` clears call history but not
// pending once-queues. That made the suite intermittently fail. Mock it so no
// post-response query touches the pool.
vi.mock('../../services/notificationInserts.js', () => ({
  fetchActiveTraderUserIds: vi.fn().mockResolvedValue([]),
  insertNotificationsForUsers: vi.fn().mockResolvedValue(undefined),
  notifyUsersSafe: vi.fn(),
}));

// The content-based duplicate guard runs on every create. Stub it at the
// service seam so these tests keep their positional `mockResolvedValueOnce`
// queues (its own SQL is covered in services/__tests__/findRecentDuplicate).
// Default: no duplicate found, i.e. the guard stays out of the way.
vi.mock('../../services/requestQueries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/requestQueries.js')>();
  return { ...actual, findRecentDuplicate: vi.fn().mockResolvedValue(null) };
});

vi.mock('../../services/warehouse.js', () => ({
  isConfigured: () => false,
  getClientAccounts: vi.fn(),
  getAccountTypeMap: vi.fn(),
  // Used by the run-engine fixed-context path; default stock-record available
  // and no sibling holdings unless a test sets them.
  isStockRecordConfigured: () => true,
  getClassifiedHoldings: vi.fn().mockResolvedValue({}),
}));

import express from 'express';
import request from 'supertest';
import requestRoutes from '../requests.js';
import * as warehouse from '../../services/warehouse.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { notifyNewRequest } from '../../services/slack.js';
import { findRecentDuplicate } from '../../services/requestQueries.js';

function createApp(user: AuthUser, options?: { isDemo?: boolean; authChannel?: 'standalone' | 'opsPortal' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    (req as any).isAuthenticated = () => true;
    if (options?.isDemo) (req as any).isDemo = true;
    if (options?.authChannel) (req as any).authChannel = options.authChannel;
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
  // Intentionally NOT equal to advisorUser.name so tests that exercise the
  // POST handler's `insertedRow.advisor_name = user.name` override can prove
  // the override actually fired (rather than passing by coincidence because
  // the fixture and the test user share a name).
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

const sampleAccountRow = {
  id: 'acc-uuid',
  client_id: 'HH-001',
  account_number: 'ACCT-1001',
  account_type: 'Taxable',
  balance: '850000',
  cash_holding: '42500',
  fixed_holding: '127500',
  equity_holding: '680000',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPool._client.query.mockResolvedValue({ rows: [] });
  // `clearAllMocks` clears call history but NOT implementations, so a test that
  // stubs a duplicate hit would otherwise leak it into every test after it.
  vi.mocked(findRecentDuplicate).mockResolvedValue(null);
});

describe('GET /requests', () => {
  it('returns all requests for traders', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [sampleTradeRequestRow] }).mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(traderUser)).get('/requests');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('REQ-12345678');
    expect(res.body.data[0].advisor).toBe('Rachel Moss');
    // The DB column `advisor_name` (joined from users.name on advisor_id) is
    // the real submitter and is exposed as `submittedBy` — surfacing the
    // joined value verbatim, not the forced advisor.
    expect(res.body.data[0].submittedBy).toBe('Stale Joined Name');
  });

  it('returns all requests for advisors too (no per-advisor scoping)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [sampleTradeRequestRow] }).mockResolvedValueOnce({ rows: [] });

    await request(createApp(advisorUser)).get('/requests');

    const queryCall = mockPool.query.mock.calls[0];
    // The join still references tr.advisor_id; what must be gone is the filter predicate.
    expect(queryCall[0]).not.toContain('tr.advisor_id = $');
    // Only the LIMIT param (50 + 1) — no advisor id prepended.
    expect(queryCall[1]).toEqual([51]);
  });

  it('returns empty array when no requests', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(traderUser)).get('/requests');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], nextCursor: null });
  });

  it('applies server-side search (q) with ILIKE across key fields', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [sampleTradeRequestRow] }).mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(traderUser)).get('/requests').query({ q: 'Richardson' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);

    const queryCall = mockPool.query.mock.calls[0];
    expect(queryCall[0]).toContain('ILIKE');
    expect(queryCall[0]).toContain('tr.client_name');
    expect(queryCall[1][0]).toBe('%Richardson%');
    expect(queryCall[1][queryCall[1].length - 1]).toBe(51);
  });

  it('does not scope search by advisor (advisors search the full queue)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await request(createApp(advisorUser)).get('/requests').query({ q: 'REQ' });

    const queryCall = mockPool.query.mock.calls[0];
    expect(queryCall[0]).not.toContain('tr.advisor_id = $');
    expect(queryCall[0]).toContain('ILIKE');
    expect(queryCall[1][0]).toBe('%REQ%');
  });

  it('rejects combining q with all=true', async () => {
    const res = await request(createApp(traderUser)).get('/requests').query({ all: 'true', q: 'test' });
    expect(res.status).toBe(400);
  });
});

describe('GET /requests/counts', () => {
  it('returns aggregated counts for traders', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { status: 'Pending Review', count: '3' },
        { status: 'Approved', count: '10' },
        { status: 'Completed', count: '5' },
        { status: 'Needs Info', count: '2' },
        { status: 'Rejected', count: '1' },
      ],
    });

    const res = await request(createApp(traderUser)).get('/requests/counts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 21, pendingReview: 3, needsInfo: 2, approved: 15 });
  });

  it('returns counts across all requests for advisors too', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ status: 'Pending Review', count: '1' }],
    });

    const res = await request(createApp(advisorUser)).get('/requests/counts');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);

    const queryCall = mockPool.query.mock.calls[0];
    expect(queryCall[0]).not.toContain('WHERE advisor_id');
  });

  it('returns zeros when no requests exist', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(traderUser)).get('/requests/counts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, pendingReview: 0, needsInfo: 0, approved: 0 });
  });
});

describe('POST /requests', () => {
  const validRaiseCashPayload = {
    clientId: 'HH-001',
    clientName: 'The Richardson Family',
    tradeType: 'Raise Cash',
    tradeAmount: '$50,000',
    selectedAccounts: ['ACCT-1001'],
    priority: 'Standard',
    raiseCashReason: 'Need liquidity',
  };
  const priorAllocationRow = {
    risk_profile: 20,
    base_allocation: { equity: 79, fixed: 20, cash: 1 },
    equity_strategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: 'Existing rationale' }],
  };
  const validAllocationPayload = {
    clientId: 'HH-001',
    clientName: 'The Richardson Family',
    tradeType: 'Cash Deposit',
    tradeAmount: '$50,000',
    depositAccount: 'ACCT-1001',
    selectedAccounts: ['ACCT-1001'],
    accountsData: [{ accountNumber: 'ACCT-1001', accountType: 'Taxable', balance: 850000 }],
    priority: 'Standard',
    residence: 'Other',
    liquidationApproval: 'Yes',
    riskProfile: 20,
    equityStrategies: [{ id: 1, benchmark: 'spy', allocation: 100, rationale: '' }],
  };

  it('creates a Raise Cash request successfully', async () => {
    // account lookup
    mockPool.query.mockResolvedValueOnce({ rows: [sampleAccountRow] });
    // transaction: connect returns poolClient
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [sampleTradeRequestRow] }) // INSERT trade_requests RETURNING *
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'audit-1',
            request_id: 'REQ-12345678',
            user_name: advisorUser.name,
            action: 'Created Request',
            notes: '',
            created_at: new Date(),
          },
        ],
      }) // INSERT audit_logs RETURNING *
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(createApp(advisorUser)).post('/requests').send(validRaiseCashPayload);

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('REQ-12345678');
    expect(res.body.data.advisor).toBe('Rachel Moss');
    // The actual submitter is the authenticated user, not the forced advisor.
    expect(res.body.data.submittedBy).toBe(advisorUser.name);
    expect(notifyNewRequest).toHaveBeenCalledWith(expect.objectContaining({ submittedBy: advisorUser.name }));
  });

  it('returns 400 for invalid payload', async () => {
    const res = await request(createApp(advisorUser)).post('/requests').send({ tradeType: 'InvalidType' });

    expect(res.status).toBe(400);
  });

  // Duplicate-submission guards. A create can commit and still miss the
  // browser's deadline, so the advisor retries a request that already landed.
  // Guard 1 matches the client-supplied idempotency key; guard 2 matches on
  // content and needs nothing from the client. Both must return the ORIGINAL
  // request rather than inserting a second row.
  //
  // Both guards run before account resolution, so no account lookup is queued
  // on the paths that short-circuit.
  describe('duplicate submission guards', () => {
    const idempotentPayload = {
      ...validRaiseCashPayload,
      idempotencyKey: '11111111-2222-3333-4444-555555555555',
    };

    describe('idempotency key', () => {
      it('returns 200 with the existing request instead of inserting a duplicate', async () => {
        mockPool.query
          .mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] }) // idempotency hit
          .mockResolvedValueOnce({ rows: [sampleTradeRequestRow] }) // loadRequest: trade_requests
          .mockResolvedValueOnce({ rows: [] }); // loadRequest: audit_logs

        const res = await request(createApp(advisorUser)).post('/requests').send(idempotentPayload);

        // 200, not 201 — nothing was created on this call.
        expect(res.status).toBe(200);
        expect(res.body.data.id).toBe('REQ-12345678');
        // The decisive assertion: no transaction was ever opened, so no second
        // row could have been written.
        expect(mockPool.connect).not.toHaveBeenCalled();
        expect(notifyNewRequest).not.toHaveBeenCalled();
      });

      it('scopes the lookup to the submitting advisor', async () => {
        mockPool.query
          .mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] })
          .mockResolvedValueOnce({ rows: [sampleTradeRequestRow] })
          .mockResolvedValueOnce({ rows: [] });

        await request(createApp(advisorUser)).post('/requests').send(idempotentPayload);

        expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('idempotency_key'), [
          idempotentPayload.idempotencyKey,
          advisorUser.id,
        ]);
      });

      it('inserts normally when the key has not been seen before', async () => {
        mockPool.query
          .mockResolvedValueOnce({ rows: [] }) // idempotency miss
          .mockResolvedValueOnce({ rows: [sampleAccountRow] }); // account lookup
        mockPool._client.query
          .mockResolvedValueOnce({ rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rows: [sampleTradeRequestRow] }) // INSERT trade_requests
          .mockResolvedValueOnce({ rows: [{ id: 'audit-1', request_id: 'REQ-12345678', created_at: new Date() }] })
          .mockResolvedValueOnce({ rows: [] }); // COMMIT

        const res = await request(createApp(advisorUser)).post('/requests').send(idempotentPayload);

        expect(res.status).toBe(201);
        expect(mockPool.connect).toHaveBeenCalled();
      });

      it('recovers to the original request when the unique index rejects a racing insert', async () => {
        const uniqueViolation = Object.assign(new Error('duplicate key value'), { code: '23505' });

        mockPool.query
          .mockResolvedValueOnce({ rows: [] }) // idempotency miss — racing request wins below
          .mockResolvedValueOnce({ rows: [sampleAccountRow] }) // account lookup
          .mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] }) // post-23505 re-lookup
          .mockResolvedValueOnce({ rows: [sampleTradeRequestRow] }) // loadRequest: trade_requests
          .mockResolvedValueOnce({ rows: [] }); // loadRequest: audit_logs
        mockPool._client.query
          .mockResolvedValueOnce({ rows: [] }) // BEGIN
          .mockRejectedValueOnce(uniqueViolation) // INSERT trips idx_trade_requests_idempotency
          .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

        const res = await request(createApp(advisorUser)).post('/requests').send(idempotentPayload);

        expect(res.status).toBe(200);
        expect(res.body.data.id).toBe('REQ-12345678');
      });
    });

    describe('content match', () => {
      it('suppresses a duplicate even when no idempotency key is sent', async () => {
        vi.mocked(findRecentDuplicate).mockResolvedValue('REQ-12345678');
        mockPool.query
          .mockResolvedValueOnce({ rows: [] }) // audit_logs INSERT (suppression note)
          .mockResolvedValueOnce({ rows: [sampleTradeRequestRow] }) // loadRequest: trade_requests
          .mockResolvedValueOnce({ rows: [] }); // loadRequest: audit_logs

        // No idempotencyKey at all — this is the case a client-side regression
        // reintroduces, and the guard has to hold without client cooperation.
        const res = await request(createApp(advisorUser)).post('/requests').send(validRaiseCashPayload);

        expect(res.status).toBe(200);
        expect(res.body.data.id).toBe('REQ-12345678');
        expect(mockPool.connect).not.toHaveBeenCalled();
        expect(notifyNewRequest).not.toHaveBeenCalled();
      });

      it('suppresses a duplicate when the client rotated to a fresh key', async () => {
        vi.mocked(findRecentDuplicate).mockResolvedValue('REQ-12345678');
        mockPool.query
          .mockResolvedValueOnce({ rows: [] }) // idempotency miss — key is brand new
          .mockResolvedValueOnce({ rows: [] }) // audit_logs INSERT (suppression note)
          .mockResolvedValueOnce({ rows: [sampleTradeRequestRow] })
          .mockResolvedValueOnce({ rows: [] });

        const res = await request(createApp(advisorUser))
          .post('/requests')
          .send({ ...validRaiseCashPayload, idempotencyKey: '99999999-8888-7777-6666-555555555555' });

        expect(res.status).toBe(200);
        expect(res.body.data.id).toBe('REQ-12345678');
        expect(mockPool.connect).not.toHaveBeenCalled();
      });

      it('probes on advisor, client, trade type, amount and accounts', async () => {
        vi.mocked(findRecentDuplicate).mockResolvedValue(null);
        mockPool.query.mockResolvedValueOnce({ rows: [sampleAccountRow] });
        mockPool._client.query
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [sampleTradeRequestRow] })
          .mockResolvedValueOnce({ rows: [{ id: 'audit-1', request_id: 'REQ-12345678', created_at: new Date() }] })
          .mockResolvedValueOnce({ rows: [] });

        await request(createApp(advisorUser)).post('/requests').send(validRaiseCashPayload);

        expect(findRecentDuplicate).toHaveBeenCalledWith({
          advisorId: advisorUser.id,
          clientId: validRaiseCashPayload.clientId,
          tradeType: validRaiseCashPayload.tradeType,
          tradeAmount: validRaiseCashPayload.tradeAmount,
          selectedAccounts: validRaiseCashPayload.selectedAccounts,
        });
      });

      it('records the suppressed attempt on the surviving request', async () => {
        vi.mocked(findRecentDuplicate).mockResolvedValue('REQ-12345678');
        mockPool.query
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [sampleTradeRequestRow] })
          .mockResolvedValueOnce({ rows: [] });

        await request(createApp(advisorUser)).post('/requests').send(validRaiseCashPayload);

        expect(mockPool.query).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO audit_logs'),
          expect.arrayContaining(['REQ-12345678', 'Duplicate Submission Suppressed']),
        );
      });

      it('still returns the existing request when the audit note fails to write', async () => {
        vi.mocked(findRecentDuplicate).mockResolvedValue('REQ-12345678');
        mockPool.query
          .mockRejectedValueOnce(new Error('audit_logs unavailable')) // best-effort insert
          .mockResolvedValueOnce({ rows: [sampleTradeRequestRow] })
          .mockResolvedValueOnce({ rows: [] });

        const res = await request(createApp(advisorUser)).post('/requests').send(validRaiseCashPayload);

        expect(res.status).toBe(200);
        expect(res.body.data.id).toBe('REQ-12345678');
      });
    });
  });

  it('returns 400 when accounts do not belong to client', async () => {
    // account lookup returns empty (no matching accounts for client)
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(advisorUser)).post('/requests').send(validRaiseCashPayload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/do not belong/i);
  });

  it('returns 400 when selectedAccounts is empty', async () => {
    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({ ...validRaiseCashPayload, selectedAccounts: [] });

    expect(res.status).toBe(400);
  });

  it('returns 400 for Raise Cash without tradeAmount', async () => {
    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({ ...validRaiseCashPayload, tradeAmount: '' });

    expect(res.status).toBe(400);
    expect(res.body.details).toBeDefined();
  });

  it('returns 400 for Initial Funding without riskProfile', async () => {
    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({
        clientId: 'HH-001',
        clientName: 'Test',
        tradeType: 'Initial Funding',
        selectedAccounts: ['ACCT-1001'],
        priority: 'Standard',
        residence: 'Other',
        liquidationApproval: 'Yes',
        riskProfile: null,
        equityStrategies: [{ id: 1, benchmark: 'S&P 500', allocation: 100, rationale: 'test' }],
      });

    expect(res.status).toBe(400);
  });

  it('returns 400 for Initial Funding without strategy rationale', async () => {
    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({
        ...validAllocationPayload,
        tradeType: 'Initial Funding',
        tradeAmount: '',
        depositAccount: '',
      });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['equityStrategies', 0, 'rationale'] })]),
    );
  });

  it('allows blank rationale for unchanged Cash Deposit allocation', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [priorAllocationRow] });
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ ...sampleTradeRequestRow, trade_type: 'Cash Deposit', risk_profile: 20, equity_strategies: [] }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'audit-1',
            request_id: 'REQ-12345678',
            user_name: advisorUser.name,
            action: 'Created Request',
            notes: 'Risk Profile 20 applied.',
            created_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(advisorUser)).post('/requests').send(validAllocationPayload);

    expect(res.status).toBe(201);
  });

  it('returns 400 for Cash Deposit blank rationale when risk profile changes', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [priorAllocationRow] });

    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({ ...validAllocationPayload, riskProfile: 21 });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['equityStrategies', 0, 'rationale'] })]),
    );
  });

  it('returns 400 for Rebalance blank rationale when strategy allocation changes', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [priorAllocationRow] });

    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({
        ...validAllocationPayload,
        tradeType: 'Rebalance',
        tradeAmount: '',
        depositAccount: '',
        equityStrategies: [
          { id: 1, benchmark: 'SPY', allocation: 60, rationale: '' },
          { id: 2, benchmark: 'IWD', allocation: 40, rationale: '' },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['equityStrategies', 0, 'rationale'] })]),
    );
  });

  it('returns 400 for first-time Cash Deposit with blank rationale', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(advisorUser)).post('/requests').send(validAllocationPayload);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['equityStrategies', 0, 'rationale'] })]),
    );
  });

  it('returns 400 when equity strategies do not sum to 100', async () => {
    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({
        clientId: 'HH-001',
        clientName: 'Test',
        tradeType: 'Initial Funding',
        selectedAccounts: ['ACCT-1001'],
        priority: 'Standard',
        residence: 'Other',
        liquidationApproval: 'Yes',
        riskProfile: 15,
        equityStrategies: [
          { id: 1, benchmark: 'S&P 500', allocation: 60, rationale: 'test' },
          { id: 2, benchmark: 'Russell 2000', allocation: 30, rationale: 'test' },
        ],
      });

    expect(res.status).toBe(400);
  });

  it('returns 400 for Liquidate without liquidateOption', async () => {
    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({
        clientId: 'HH-001',
        clientName: 'Test',
        tradeType: 'Liquidate',
        selectedAccounts: ['ACCT-1001'],
        priority: 'Standard',
        liquidateOption: '',
      });

    expect(res.status).toBe(400);
  });

  it('returns 400 for negative balance in accountsData', async () => {
    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({
        ...validRaiseCashPayload,
        accountsData: [{ accountNumber: 'ACCT-1001', accountType: 'Taxable', balance: -1000 }],
      });

    expect(res.status).toBe(400);
  });

  // ─── Household tag (Decision log #5 + DB CHECK constraint) ────────────────

  function getInsertParams(): readonly unknown[] {
    // Call order inside the transaction:
    //   0: BEGIN
    //   1: INSERT trade_requests  ← this one
    //   2: INSERT audit_logs
    //   3: COMMIT
    const call = (mockPool._client.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(call).toBeDefined();
    return call![1] as readonly unknown[];
  }

  function mockInsertHappyPath(rowOverrides: Record<string, unknown> = {}): void {
    mockPool.query.mockResolvedValueOnce({ rows: [sampleAccountRow] });
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ ...sampleTradeRequestRow, ...rowOverrides }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'audit-1',
            request_id: 'REQ-12345678',
            user_name: advisorUser.name,
            action: 'Created Request',
            notes: '',
            created_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
  }

  it('persists household_id and household_name when both are provided', async () => {
    mockInsertHappyPath({ household_id: '3027', household_name: 'Marsh Family' });

    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({ ...validRaiseCashPayload, householdId: 3027, householdName: 'Marsh Family' });

    expect(res.status).toBe(201);
    const params = getInsertParams();
    // The two household params are appended after asset_location_mode ($31 → params[30]).
    expect(params[31]).toBe(3027);
    expect(params[32]).toBe('Marsh Family');
    expect(res.body.data.householdId).toBe(3027);
    expect(res.body.data.householdName).toBe('Marsh Family');
  });

  it('writes both household columns as NULL when only householdId is provided (paired contract)', async () => {
    mockInsertHappyPath();

    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({ ...validRaiseCashPayload, householdId: 3027 });

    expect(res.status).toBe(201);
    const params = getInsertParams();
    expect(params[31]).toBeNull();
    expect(params[32]).toBeNull();
  });

  it('writes both household columns as NULL when only householdName is provided (paired contract)', async () => {
    mockInsertHappyPath();

    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({ ...validRaiseCashPayload, householdName: 'Marsh Family' });

    expect(res.status).toBe(201);
    const params = getInsertParams();
    expect(params[31]).toBeNull();
    expect(params[32]).toBeNull();
  });

  it('defaults household columns to NULL when neither is provided', async () => {
    mockInsertHappyPath();

    const res = await request(createApp(advisorUser)).post('/requests').send(validRaiseCashPayload);
    expect(res.status).toBe(201);
    const params = getInsertParams();
    expect(params[31]).toBeNull();
    expect(params[32]).toBeNull();
  });

  it('returns 400 when householdId is not a positive integer', async () => {
    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({ ...validRaiseCashPayload, householdId: -1, householdName: 'Bad' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /requests/:id', () => {
  const priorAllocationRow = {
    risk_profile: 20,
    base_allocation: { equity: 79, fixed: 20, cash: 1 },
    equity_strategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: 'Existing rationale' }],
  };
  const resubmitPayload = {
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
  };
  const needsInfoRow = { ...sampleTradeRequestRow, status: 'Needs Info', advisor_id: advisorUser.id };

  it('allows blank rationale on unchanged Rebalance resubmission', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [needsInfoRow] })
      .mockResolvedValueOnce({ rows: [priorAllocationRow] })
      .mockResolvedValueOnce({ rows: [{ ...needsInfoRow, trade_type: 'Rebalance', risk_profile: 20 }] })
      .mockResolvedValueOnce({ rows: [] });
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(advisorUser)).put('/requests/REQ-12345678').send(resubmitPayload);

    expect(res.status).toBe(200);
  });

  it('returns 400 when Rebalance resubmission changes allocation without rationale', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [needsInfoRow] })
      .mockResolvedValueOnce({ rows: [priorAllocationRow] });

    const res = await request(createApp(advisorUser))
      .put('/requests/REQ-12345678')
      .send({ ...resubmitPayload, riskProfile: 21 });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['equityStrategies', 0, 'rationale'] })]),
    );
  });

  it('does not mutate the persisted household tag (Decision log #5)', async () => {
    // Submit-time tag on the existing row.
    const taggedNeedsInfoRow = {
      ...needsInfoRow,
      household_id: '3027',
      household_name: 'Marsh Family',
    };
    mockPool.query
      .mockResolvedValueOnce({ rows: [taggedNeedsInfoRow] })
      .mockResolvedValueOnce({ rows: [priorAllocationRow] })
      .mockResolvedValueOnce({
        rows: [{ ...taggedNeedsInfoRow, trade_type: 'Rebalance', risk_profile: 20 }],
      })
      .mockResolvedValueOnce({ rows: [] });
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] }) // UPDATE RETURNING id
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    // PUT payload tries to clear the tag — server MUST ignore it.
    const res = await request(createApp(advisorUser))
      .put('/requests/REQ-12345678')
      .send({ ...resubmitPayload, householdId: null, householdName: null });

    expect(res.status).toBe(200);

    // Inspect the UPDATE statement: SQL text must not mention `household_id`
    // or `household_name`, and its param tuple must not carry them either.
    const updateCall = (mockPool._client.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(updateCall).toBeDefined();
    const [sql, params] = updateCall! as [string, readonly unknown[]];
    expect(sql).not.toMatch(/household_id/);
    expect(sql).not.toMatch(/household_name/);
    // The mapped response surfaces the EXISTING DB row's tag, not the payload's.
    expect(res.body.data.householdId).toBe(3027);
    expect(res.body.data.householdName).toBe('Marsh Family');
    // Sanity: params still has the existing fields count (no extras for household).
    expect(params).toHaveLength(28);
  });

  const staleRow = { ...needsInfoRow, updated_at: new Date('2026-01-01T00:00:00.000Z') };

  it('TRW-02: rejects a stale expectedUpdatedAt with the modified-by-another-user 409 before any write', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [staleRow] });

    const res = await request(createApp(advisorUser))
      .put('/requests/REQ-12345678')
      .send({ ...resubmitPayload, expectedUpdatedAt: '2025-12-31T23:59:59.000Z' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Request was modified by another user. Please refresh and try again.');
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('TRW-02: returns the modified-by-another-user 409 when a change lands between the check and the UPDATE', async () => {
    const token = '2026-01-01T00:00:00.000Z';
    mockPool.query.mockResolvedValueOnce({ rows: [staleRow] }).mockResolvedValueOnce({ rows: [priorAllocationRow] });
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // conditional UPDATE matches no row

    const res = await request(createApp(advisorUser))
      .put('/requests/REQ-12345678')
      .send({ ...resubmitPayload, expectedUpdatedAt: token });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Request was modified by another user. Please refresh and try again.');
    const calls = mockPool._client.query.mock.calls;
    const [sql, params] = calls.find((c) => String(c[0]).startsWith('UPDATE trade_requests SET\n'))! as [
      string,
      unknown[],
    ];
    expect(sql).toContain("WHERE id = $28 AND status = 'Needs Info' AND updated_at = $29");
    expect(params).toHaveLength(29);
    expect(params[28]).toBe(token);
    expect(calls.some((c) => String(c[0]).startsWith('INSERT INTO audit_logs'))).toBe(false);
  });

  it('TRW-02: requires expectedUpdatedAt on an advisor platform resubmission before reading the request', async () => {
    const res = await request(createApp(advisorUser, { authChannel: 'opsPortal' }))
      .put('/requests/REQ-12345678')
      .send(resubmitPayload);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("TRW-02: refuses another advisor's request with 403 before comparing the token", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ...staleRow, status: 'Pending Review', advisor_id: 'someone-else' }],
    });

    const res = await request(createApp(advisorUser))
      .put('/requests/REQ-12345678')
      .send({ ...resubmitPayload, expectedUpdatedAt: '2025-12-31T23:59:59.000Z' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('You do not have access to this request');
  });
});

describe('PUT /requests/:id/status', () => {
  it('updates status for traders', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ status: 'Pending Review', client_id: 'HH-001', client_name: 'Richardson', advisor_slack_id: null }],
    });
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] }) // UPDATE RETURNING id
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    // loadRequest
    mockPool.query.mockResolvedValueOnce({ rows: [{ ...sampleTradeRequestRow, status: 'Approved' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(traderUser))
      .put('/requests/REQ-12345678/status')
      .send({ status: 'Approved', note: 'Looks good', expectedUpdatedAt: '2025-01-01T00:00:00.000Z' });

    expect(res.status).toBe(200);
  });

  function auditInsertParams() {
    const call = mockPool._client.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO audit_logs'));
    return { sql: String(call?.[0]), params: call?.[1] as unknown[] };
  }

  function mockStatusChange() {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ status: 'Pending Review', client_id: 'HH-001', client_name: 'Richardson', advisor_slack_id: null }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [{ ...sampleTradeRequestRow, status: 'Approved' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] }); // UPDATE RETURNING id
  }

  it('TRW-02: marks a session status change as standalone in the audit trail', async () => {
    mockStatusChange();

    const res = await request(createApp(traderUser))
      .put('/requests/REQ-12345678/status')
      .send({ status: 'Approved', expectedUpdatedAt: '2025-01-01T00:00:00.000Z' });

    expect(res.status).toBe(200);
    const { sql, params } = auditInsertParams();
    expect(sql).toContain('channel');
    expect(params).toEqual([
      'REQ-12345678',
      traderUser.name,
      traderUser.id,
      'Status changed to Approved',
      'No additional notes.',
      'standalone',
    ]);
  });

  it('TRW-02: marks a delegated status change as opsPortal in the audit trail', async () => {
    mockStatusChange();

    const res = await request(createApp(traderUser, { authChannel: 'opsPortal' }))
      .put('/requests/REQ-12345678/status')
      .send({ status: 'Approved', expectedUpdatedAt: '2025-01-01T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(auditInsertParams().params.at(-1)).toBe('opsPortal');
  });

  it('returns 409 for terminal status', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ status: 'Completed', client_id: 'HH-001', client_name: 'Richardson', advisor_slack_id: null }],
    });

    const res = await request(createApp(traderUser))
      .put('/requests/REQ-12345678/status')
      .send({ status: 'Approved', expectedUpdatedAt: '2025-01-01T00:00:00.000Z' });

    expect(res.status).toBe(409);
  });

  it('returns 404 for non-existent request', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(traderUser))
      .put('/requests/REQ-NONEXIST/status')
      .send({ status: 'Approved', expectedUpdatedAt: '2025-01-01T00:00:00.000Z' });

    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid status', async () => {
    const res = await request(createApp(traderUser))
      .put('/requests/REQ-12345678/status')
      .send({ status: 'InvalidStatus' });

    expect(res.status).toBe(400);
  });

  it('returns 403 for advisors', async () => {
    const res = await request(createApp(advisorUser)).put('/requests/REQ-12345678/status').send({ status: 'Approved' });

    expect(res.status).toBe(403);
  });
});

describe('POST /requests/:id/run-engine', () => {
  const engineRequestRow = {
    ...sampleTradeRequestRow,
    trade_type: 'Rebalance',
    risk_profile: 15,
    base_allocation: { equity: 80, fixed: 19.5, cash: 0.5 },
    equity_strategies: [],
    selected_accounts: ['ACCT-1001'],
  };

  it('runs engine for traders', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [engineRequestRow] });
    // lookupAccountTypes + lookupAccountClientIds (parallel)
    mockPool.query.mockResolvedValueOnce({
      rows: [{ account_number: 'ACCT-1001', account_type: 'Taxable' }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ account_number: 'ACCT-1001', client_id: 'client-1' }],
    });
    // transaction
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] }) // UPDATE RETURNING id
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    // loadRequest
    mockPool.query.mockResolvedValueOnce({ rows: [{ ...engineRequestRow, execution_plan: [] }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(traderUser))
      .post('/requests/REQ-12345678/run-engine')
      .send({
        holdings: {
          'ACCT-1001': { cash: 42500, fixed: 127500, equity: 680000 },
        },
        expectedUpdatedAt: '2025-01-01T00:00:00.000Z',
      });

    expect(res.status).toBe(200);
  });

  it('includes fixed-context siblings as recommend-only plans when fixedContextAccountNumbers is sent', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [engineRequestRow] }); // request row
    mockPool.query.mockResolvedValueOnce({ rows: [{ account_number: 'ACCT-1001', account_type: 'Taxable' }] }); // selected types
    mockPool.query.mockResolvedValueOnce({ rows: [{ account_number: 'ACCT-1001', client_id: 'client-1' }] }); // selected clientIds
    mockPool.query.mockResolvedValueOnce({ rows: [{ account_number: 'CTX-1', account_type: 'Traditional IRA' }] }); // context types
    mockPool.query.mockResolvedValueOnce({ rows: [{ account_number: 'CTX-1', client_id: 'client-1' }] }); // context clientIds
    vi.mocked(warehouse.getClassifiedHoldings).mockResolvedValueOnce({
      'CTX-1': { cash: 0, fixed: 0, equity: 200_000 },
    });
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] }) // UPDATE RETURNING id
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    mockPool.query.mockResolvedValueOnce({ rows: [{ ...engineRequestRow, execution_plan: [] }] }); // loadRequest
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(traderUser))
      .post('/requests/REQ-12345678/run-engine')
      .send({
        holdings: { 'ACCT-1001': { cash: 42500, fixed: 127500, equity: 680000 } },
        fixedContextAccountNumbers: ['CTX-1'],
        expectedUpdatedAt: '2025-01-01T00:00:00.000Z',
      });

    expect(res.status).toBe(200);
    const updateCall = mockPool._client.query.mock.calls.find((call) =>
      String(call[0]).includes('UPDATE trade_requests SET execution_plan'),
    )!;
    const persistedPlan = JSON.parse(updateCall[1][0]);
    const byNum = Object.fromEntries(persistedPlan.map((p: { accountNumber: string }) => [p.accountNumber, p]));
    expect(byNum['ACCT-1001'].action).toBe('execute');
    expect(byNum['CTX-1'].action).toBe('recommend');
    // The Traditional IRA sibling holds the household's fixed income in the ideal.
    expect(byNum['CTX-1'].postTradeHoldings.fixed).toBeGreaterThan(0);
    expect(warehouse.getClassifiedHoldings).toHaveBeenCalledWith(['CTX-1']);
  });

  it('persists cash deposit context and sleeve instructions when running engine', async () => {
    const cashDepositRequestRow = {
      ...engineRequestRow,
      trade_type: 'Cash Deposit',
      trade_amount: '$150,000',
      deposit_account: 'ACCT-1001',
      base_allocation: { equity: 79, fixed: 20, cash: 1 },
      residence: 'NY',
      selected_accounts: ['ACCT-1001'],
    };
    mockPool.query.mockResolvedValueOnce({ rows: [cashDepositRequestRow] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ account_number: 'ACCT-1001', account_type: 'Joint' }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ account_number: 'ACCT-1001', client_id: 'client-1' }],
    });
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] }) // UPDATE RETURNING id
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    mockPool.query.mockResolvedValueOnce({ rows: [{ ...cashDepositRequestRow, execution_plan: [] }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(traderUser))
      .post('/requests/REQ-12345678/run-engine')
      .send({
        holdings: {
          'ACCT-1001': { cash: 2260, fixed: 58883.28, equity: 386409.65 },
        },
        expectedUpdatedAt: '2025-01-01T00:00:00.000Z',
      });

    expect(res.status).toBe(200);
    const updateCall = mockPool._client.query.mock.calls.find((call) =>
      String(call[0]).includes('UPDATE trade_requests SET execution_plan'),
    )!;
    const persistedPlan = JSON.parse(updateCall[1][0]);
    expect(persistedPlan[0].cashDepositContext).toMatchObject({
      depositAmount: 150_000,
      depositAccountNumber: 'ACCT-1001',
      existingCash: 2_260,
    });
    expect(persistedPlan[0].sleeveInstructions).toEqual(
      expect.arrayContaining([expect.objectContaining({ sleeve: 'cash' })]),
    );
  });

  it('rejects negative holdings', async () => {
    const res = await request(createApp(traderUser))
      .post('/requests/REQ-12345678/run-engine')
      .send({
        holdings: {
          'ACCT-1001': { cash: -100, fixed: 127500, equity: 680000 },
        },
        expectedUpdatedAt: '2025-01-01T00:00:00.000Z',
      });

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing account in DB', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [engineRequestRow] });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // lookupAccountTypes: no accounts found
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // lookupAccountClientIds

    const res = await request(createApp(traderUser))
      .post('/requests/REQ-12345678/run-engine')
      .send({
        holdings: {
          'ACCT-1001': { cash: 42500, fixed: 127500, equity: 680000 },
        },
        expectedUpdatedAt: '2025-01-01T00:00:00.000Z',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found in database/i);
  });

  it('returns 403 for advisors', async () => {
    const res = await request(createApp(advisorUser)).post('/requests/REQ-12345678/run-engine').send({ holdings: {} });

    expect(res.status).toBe(403);
  });
});

describe('demo mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockReset();
  });

  it('GET /counts returns demo counts without DB call', async () => {
    const res = await request(createApp(traderUser, { isDemo: true }))
      .get('/requests/counts')
      .expect(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body).toHaveProperty('pendingReview');
    expect(res.body).toHaveProperty('needsInfo');
    expect(res.body).toHaveProperty('approved');
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('GET / returns demo requests without DB call', async () => {
    const res = await request(createApp(traderUser, { isDemo: true }))
      .get('/requests')
      .expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].id).toMatch(/^REQ-DEMO/);
    expect(res.body.nextCursor).toBeNull();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('GET / supports search filtering in demo mode', async () => {
    const res = await request(createApp(traderUser, { isDemo: true }))
      .get('/requests?q=Martinez')
      .expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const r of res.body.data) {
      expect(r.clientName.toLowerCase()).toContain('martinez');
    }
  });

  it('GET /:id returns a demo request', async () => {
    const res = await request(createApp(traderUser, { isDemo: true }))
      .get('/requests/REQ-DEMO0001')
      .expect(200);
    expect(res.body.data.id).toBe('REQ-DEMO0001');
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('GET /:id returns 404 for unknown demo id', async () => {
    const res = await request(createApp(traderUser, { isDemo: true }))
      .get('/requests/REQ-NOTEXIST')
      .expect(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('POST / returns a fake created request without DB call', async () => {
    const res = await request(createApp(traderUser, { isDemo: true }))
      .post('/requests')
      .send({
        clientId: 'demo-client-1',
        clientName: 'Demo',
        tradeType: 'Rebalance',
        selectedAccounts: ['ACCT-1'],
        priority: 'Standard',
        riskProfile: 10,
        residence: 'Other',
        liquidationApproval: 'Yes',
      })
      .expect(201);
    expect(res.body.data.id).toMatch(/^REQ-DEMO/);
    expect(res.body.data.status).toBe('Pending Review');
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('PUT /:id/status returns updated demo request without DB call', async () => {
    const res = await request(createApp(traderUser, { isDemo: true }))
      .put('/requests/REQ-DEMO0001/status')
      .send({ status: 'Approved', note: 'test' })
      .expect(200);
    expect(res.body.data.status).toBe('Approved');
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('asset location mode round-trip', () => {
  // Risk 18 → equity 71%, fixed 25%, cash 4%. Household = 1.4M; Trad = 200k ≤
  // (fixed+cash) capacity of 406k, so under priority mode the Traditional IRA gets
  // filled entirely with fixed + cash → 0 equity. Under mirror mode, every account
  // gets the household ratios applied to its own balance, so Trad equity = 200k * 0.71.
  const mirrorAccountsData = [
    { accountNumber: 'ACCT-TAX', accountType: 'Taxable' as const, balance: 1_000_000 },
    { accountNumber: 'ACCT-TRAD', accountType: 'Traditional IRA' as const, balance: 200_000 },
    { accountNumber: 'ACCT-ROTH', accountType: 'Roth IRA' as const, balance: 200_000 },
  ];
  const mirrorPayloadBase = {
    clientId: 'HH-001',
    clientName: 'The Richardson Family',
    selectedAccounts: ['ACCT-TAX', 'ACCT-TRAD', 'ACCT-ROTH'],
    accountsData: mirrorAccountsData,
    priority: 'Standard' as const,
    residence: 'Other' as const,
    liquidationApproval: 'Yes' as const,
    riskProfile: 18,
    equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: 'mirror-mode round-trip test' }],
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

  it("POST persists 'mirror' and produces a mirror-shaped execution plan", async () => {
    // findLastAllocationForClient returns null → fresh allocation; rationale is supplied above.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPostTransaction({ ...sampleTradeRequestRow, asset_location_mode: 'mirror', trade_type: 'Rebalance' });

    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({
        ...mirrorPayloadBase,
        tradeType: 'Rebalance',
        tradeAmount: '',
        depositAccount: '',
        assetLocationMode: 'mirror',
      });

    expect(res.status).toBe(201);

    const insertParams = findInsertTradeRequestCall()[1];
    // $31 column = asset_location_mode (zero-indexed: 30)
    expect(insertParams[30]).toBe('mirror');

    // $29 column = execution_plan JSON (zero-indexed: 28)
    const persistedPlan = JSON.parse(insertParams[28]);
    const trad = persistedPlan.find((p: { accountType: string }) => p.accountType === 'Traditional IRA')!;
    expect(trad).toBeDefined();
    // Mirror: Trad equity = trad balance × household equity %.
    expect(trad.postTradeHoldings.equity).toBeCloseTo((200_000 * getRiskAllocation(18).equity) / 100, 0);
    // And it must be > 0, which is the priority-mode contrast (Trad capacity ≤ fixed+cash → 0 equity).
    expect(trad.postTradeHoldings.equity).toBeGreaterThan(1_000);
  });

  it("default submit (no assetLocationMode in body) persists 'priority'", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPostTransaction({ ...sampleTradeRequestRow, trade_type: 'Rebalance' });

    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({
        ...mirrorPayloadBase,
        tradeType: 'Rebalance',
        tradeAmount: '',
        depositAccount: '',
      });

    expect(res.status).toBe(201);
    expect(findInsertTradeRequestCall()[1][30]).toBe('priority');
  });

  it("'mirror' + Cash Deposit + rebalanceAll: false still persists 'mirror' on the row", async () => {
    // Cash Deposit doesn't run the engine at submit (engine only fires for Initial Funding /
    // Rebalance), so the deposit-only short-circuit applies at engine-run time. The row must
    // still record asset_location_mode='mirror' so the trader-side run-engine call can read it.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPostTransaction({
      ...sampleTradeRequestRow,
      asset_location_mode: 'mirror',
      trade_type: 'Cash Deposit',
      trade_amount: '$50,000',
      deposit_account: 'ACCT-TAX',
    });

    const res = await request(createApp(advisorUser))
      .post('/requests')
      .send({
        ...mirrorPayloadBase,
        tradeType: 'Cash Deposit',
        tradeAmount: '$50,000',
        depositAccount: 'ACCT-TAX',
        rebalanceAll: false,
        assetLocationMode: 'mirror',
      });

    expect(res.status).toBe(201);
    // INSERT was bound with 'mirror' regardless of which engine branch would have fired.
    expect(findInsertTradeRequestCall()[1][30]).toBe('mirror');
    // Round-trip through mapRowToRequest preserves the mode.
    expect(res.body.data.assetLocationMode).toBe('mirror');
  });

  it("PUT resubmit on a 'mirror' row, body omits assetLocationMode, persists 'priority' (intentional)", async () => {
    // INTENTIONAL BEHAVIOR — DO NOT "FIX" THIS TEST.
    //
    // The Zod schema declares `assetLocationMode: z.enum([...]).default('priority')`, so when
    // the AdvisorForm PUT body omits the field, it is bound to the UPDATE as 'priority' even if
    // the existing row was 'mirror'. This locks in the documented design: the AdvisorForm's
    // pre-fill from `editRequest.assetLocationMode` is the ONLY mechanism protecting the prior
    // mode on resubmit. See `docs/plans/2026-q3-engine-mirror-mode.md` § Risks ("PUT /:id
    // resubmit changes the mode silently"). If a future contributor moves the default
    // server-side (e.g. reading from the existing row), the AdvisorForm pre-fill contract should
    // be revisited at the same time.
    const needsInfoMirrorRow = {
      ...sampleTradeRequestRow,
      status: 'Needs Info',
      advisor_id: advisorUser.id,
      asset_location_mode: 'mirror',
      trade_type: 'Rebalance',
      risk_profile: 18,
    };
    const priorAllocationRow = {
      risk_profile: 18,
      base_allocation: { equity: 71, fixed: 25, cash: 4 },
      equity_strategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: 'Existing rationale' }],
    };

    mockPool.query
      .mockResolvedValueOnce({ rows: [needsInfoMirrorRow] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [priorAllocationRow] }) // findLastAllocationForClient
      .mockResolvedValueOnce({
        rows: [{ ...needsInfoMirrorRow, asset_location_mode: 'priority', status: 'Pending Review' }],
      }) // loadRequest after UPDATE
      .mockResolvedValueOnce({ rows: [] }); // audit logs for loadRequest

    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'REQ-12345678' }] }) // UPDATE RETURNING id
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(createApp(advisorUser))
      .put('/requests/REQ-12345678')
      .send({
        ...mirrorPayloadBase,
        tradeType: 'Rebalance',
        tradeAmount: '',
        depositAccount: '',
        equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
        // `assetLocationMode` intentionally omitted — Zod default 'priority' overwrites prior 'mirror'.
      });

    expect(res.status).toBe(200);

    const updateParams = findUpdateTradeRequestCall()[1];
    // $27 column = asset_location_mode (zero-indexed: 26)
    expect(updateParams[26]).toBe('priority');
    expect(res.body.data.assetLocationMode).toBe('priority');
  });
});
