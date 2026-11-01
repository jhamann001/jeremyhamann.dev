import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbTradeRequestRow } from '../../services/requestQueries.js';

const { mockPool, loggerMock, warehouseMock } = vi.hoisted(() => ({
  mockPool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), end: vi.fn() },
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  warehouseMock: { isMachineAccountIdentityConfigured: vi.fn(() => false), getMachineAccountIdMap: vi.fn() },
}));

vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../../lib/logger.js', () => ({ default: loggerMock }));
vi.mock('../../services/warehouse.js', () => warehouseMock);

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';

async function createApp() {
  vi.resetModules();
  const { default: machineRoutes } = await import('../machine.js');
  const app = express();
  app.use(express.json());
  // Auth is applied at mount time in index.ts (requireMachineAuth); the router
  // itself is auth-agnostic, so we mount it bare here.
  app.use('/api/machine', machineRoutes);
  app.use(errorHandler);
  return app;
}

// Real cedar_ridge_user_id format: `user-` prefix + uuid (what Ops Portal actually sends).
const ID_A = 'user-11111111-1111-1111-1111-111111111111';
const ID_B = 'user-22222222-2222-2222-2222-222222222222';
const FULL_ACCOUNT = 'APEX-87654321';
const ACCOUNT_ID = '01JTESTACCOUNTULID00000001';

function makeRow(overrides: Partial<DbTradeRequestRow> = {}): DbTradeRequestRow {
  return {
    id: 'REQ-000001',
    client_id: ID_A,
    client_name: 'Jane Doe',
    client_ids: [ID_A],
    client_names: ['Jane Doe'],
    advisor_id: 'advisor-1',
    advisor_name: 'Ops Submitter',
    trade_type: 'Rebalance',
    trade_amount: null,
    deposit_account: null,
    rebalance_all: false,
    status: 'Approved',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    selected_accounts: [FULL_ACCOUNT],
    total_value: '1000',
    priority: 'Standard',
    advisor_notes: 'secret advisor note',
    residence: 'CA',
    liquidation_approval: null,
    advisor_exclusions: null,
    client_exclusions: null,
    esg_filters: null,
    risk_profile: null,
    base_allocation: null,
    equity_strategies: null,
    raise_cash_reason: null,
    liquidity_deadline: null,
    liquidate_option: null,
    liquidate_positions: null,
    execution_plan: null,
    account_metadata: [{ accountId: ACCOUNT_ID, accountNumber: FULL_ACCOUNT, accountType: 'Taxable', balance: 1000 }],
    asset_location_mode: null,
    household_id: null,
    household_name: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
  warehouseMock.isMachineAccountIdentityConfigured.mockReturnValue(false);
  warehouseMock.getMachineAccountIdMap.mockReset();
});

describe('GET /api/machine/trade-requests', () => {
  it('returns 200 with a redacted, account-masked row for one user', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          makeRow({
            trade_type: 'Initial Funding',
            risk_profile: 25,
            base_allocation: { equity: 100, fixed: 0, cash: 0 },
            equity_strategies: [{ id: 1, benchmark: 'URTH', allocation: 100, rationale: 'private rationale' }],
            residence: 'CA',
          }),
        ],
      }) // main query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'audit-1',
            request_id: 'REQ-000001',
            created_at: '2026-07-02T12:00:00.000Z',
            user_name: 'Reviewer',
            action: 'Status changed to Approved',
            notes: 'private approval note',
          },
        ],
      }); // audit batch

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const row = res.body.data[0];
    // Account numbers masked everywhere.
    expect(row.accounts[0].accountNumber).toMatch(/^\*{4}/);
    expect(row.accounts[0].accountNumber).toBe('****4321');
    expect(row.accounts[0].accountId).toBe(ACCOUNT_ID);
    expect(row.selectedAccounts[0]).toBe('****4321');
    // Client-name PII and heavy fields dropped from the projection.
    expect(row).not.toHaveProperty('clientName');
    expect(row).not.toHaveProperty('clientNames');
    expect(row).not.toHaveProperty('advisorNotes');
    expect(row).not.toHaveProperty('submittedBy');
    expect(row).not.toHaveProperty('auditLog');
    // Kept fields for batch grouping.
    expect(row.clientId).toBe(ID_A);
    expect(row.clientIds).toEqual([ID_A]);
    expect(row.profile).toEqual({
      decidedAt: '2026-07-02T12:00:00.000Z',
      riskScore: 25,
      instructions: [
        { key: 'target_allocation', label: 'Target allocation', value: '100% equity · 0% fixed income · 0% cash' },
        { key: 'equity_strategy', label: 'Equity strategy', value: 'URTH 100%' },
        { key: 'tax_preference', label: 'Tax preference', value: 'California municipal preference' },
        { key: 'restrictions', label: 'Restrictions', value: 'None' },
      ],
    });
    // The full account number never appears anywhere in the response.
    expect(JSON.stringify(res.body)).not.toContain(FULL_ACCOUNT);
    expect(JSON.stringify(res.body)).not.toContain('Jane Doe');
    expect(JSON.stringify(res.body)).not.toContain('private rationale');
    expect(JSON.stringify(res.body)).not.toContain('private approval note');
    // no-store cache header on the sensitive payload.
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('does not project profile facts from an unapproved request', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [makeRow({ status: 'Pending Review', risk_profile: 25 })] })
      .mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`);

    expect(res.status).toBe(200);
    expect(res.body.data[0].profile).toBeNull();
  });

  it('resolves a stable account id for legacy account metadata', async () => {
    warehouseMock.isMachineAccountIdentityConfigured.mockReturnValue(true);
    warehouseMock.getMachineAccountIdMap.mockResolvedValue({ [FULL_ACCOUNT]: ACCOUNT_ID });
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          makeRow({
            account_metadata: [{ accountNumber: FULL_ACCOUNT, accountType: 'Taxable', balance: 1000 }],
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`);

    expect(res.status).toBe(200);
    expect(warehouseMock.getMachineAccountIdMap).toHaveBeenCalledWith([FULL_ACCOUNT]);
    expect(res.body.data[0].accounts[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      accountNumber: '****4321',
    });
  });

  it('recovers and resolves a stable account id from a legacy deposit label', async () => {
    warehouseMock.isMachineAccountIdentityConfigured.mockReturnValue(true);
    warehouseMock.getMachineAccountIdMap.mockResolvedValue({ [FULL_ACCOUNT]: ACCOUNT_ID });
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          makeRow({
            selected_accounts: [`${FULL_ACCOUNT} ($1,000.00)`],
            account_metadata: null,
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`);

    expect(res.status).toBe(200);
    expect(warehouseMock.getMachineAccountIdMap).toHaveBeenCalledWith([FULL_ACCOUNT]);
    expect(res.body.data[0].selectedAccounts).toEqual(['****4321']);
    expect(res.body.data[0].accounts).toEqual([
      {
        accountId: ACCOUNT_ID,
        accountNumber: '****4321',
        accountType: null,
        balance: 0,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('$1,000.00');
  });

  it('does not fabricate account scope from an ambiguous legacy label', async () => {
    warehouseMock.isMachineAccountIdentityConfigured.mockReturnValue(true);
    mockPool.query
      .mockResolvedValueOnce({
        rows: [makeRow({ selected_accounts: ['Account ending 4321'], account_metadata: null })],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`);

    expect(res.status).toBe(200);
    expect(warehouseMock.getMachineAccountIdMap).not.toHaveBeenCalled();
    expect(res.body.data[0].accounts).toEqual([]);
  });

  it('returns persisted identities without waiting for an unavailable resolver', async () => {
    warehouseMock.isMachineAccountIdentityConfigured.mockReturnValue(true);
    warehouseMock.getMachineAccountIdMap.mockImplementation(() => new Promise(() => {}));
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          makeRow({
            selected_accounts: ['APEX-99990000'],
            account_metadata: [
              { accountId: ACCOUNT_ID, accountNumber: FULL_ACCOUNT, accountType: 'Taxable', balance: 1000 },
              // Preserve the existing ?? contract: an empty ID is not nullish.
              { accountId: '', accountNumber: 'APEX-11110000', accountType: 'Taxable', balance: 2000 },
            ],
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    const res = await request(app)
      .get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(warehouseMock.isMachineAccountIdentityConfigured).not.toHaveBeenCalled();
    expect(warehouseMock.getMachineAccountIdMap).not.toHaveBeenCalled();
    expect(res.body.data[0].accounts.map((account: { accountId: string }) => account.accountId)).toEqual([
      ACCOUNT_ID,
      '',
    ]);
  });

  it('resolves only deduplicated missing identities and preserves exact account matching', async () => {
    const unresolvedNumber = 'APEX-11114321';
    const unmappedNumber = 'APEX-22224321';
    const unresolvedId = '01JTESTACCOUNTULID00000002';
    warehouseMock.isMachineAccountIdentityConfigured.mockReturnValue(true);
    warehouseMock.getMachineAccountIdMap.mockResolvedValue({ [unresolvedNumber]: unresolvedId });
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          makeRow({
            selected_accounts: ['APEX-99990000'],
            account_metadata: [
              { accountId: ACCOUNT_ID, accountNumber: FULL_ACCOUNT, accountType: 'Taxable', balance: 1000 },
              {
                accountId: null,
                accountNumber: ` ${unresolvedNumber} ($2,000.00) `,
                accountType: 'Taxable',
                balance: 2000,
              },
              { accountNumber: unmappedNumber, accountType: 'Taxable', balance: 3000 },
            ],
          }),
          makeRow({ id: 'REQ-000002', selected_accounts: [unresolvedNumber], account_metadata: null }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`);

    expect(res.status).toBe(200);
    expect(warehouseMock.getMachineAccountIdMap).toHaveBeenCalledExactlyOnceWith([unresolvedNumber, unmappedNumber]);
    expect(
      res.body.data.map((row: { accounts: { accountId: string | null }[] }) =>
        row.accounts.map((account) => account.accountId),
      ),
    ).toEqual([[ACCOUNT_ID, unresolvedId, null], [unresolvedId]]);
    expect(res.body.data[0].accounts.map((account: { accountNumber: string }) => account.accountNumber)).toEqual([
      '****4321',
      '****4321',
      '****4321',
    ]);
    expect(res.body.data[0].selectedAccounts).toEqual(['****0000']);
  });

  it('does not infer a missing identity from another request with the same persisted account number', async () => {
    warehouseMock.isMachineAccountIdentityConfigured.mockReturnValue(true);
    warehouseMock.getMachineAccountIdMap.mockResolvedValue({});
    mockPool.query
      .mockResolvedValueOnce({
        rows: [makeRow(), makeRow({ id: 'REQ-000002', account_metadata: null })],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`);

    expect(res.status).toBe(200);
    expect(warehouseMock.getMachineAccountIdMap).toHaveBeenCalledExactlyOnceWith([FULL_ACCOUNT]);
    expect(res.body.data.map((row: { accounts: { accountId: string | null }[] }) => row.accounts[0].accountId)).toEqual(
      [ACCOUNT_ID, null],
    );
  });

  it('ignores selected accounts when persisted metadata contains only malformed or empty numbers', async () => {
    warehouseMock.isMachineAccountIdentityConfigured.mockReturnValue(true);
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          makeRow({
            account_metadata: [
              { accountNumber: 'Account ending 4321', accountType: 'Taxable', balance: 1000 },
              { accountNumber: ' ', accountType: 'Taxable', balance: 2000 },
            ],
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`);

    expect(res.status).toBe(200);
    expect(warehouseMock.getMachineAccountIdMap).not.toHaveBeenCalled();
    expect(res.body.data[0].accounts).toEqual([
      { accountId: null, accountNumber: '****4321', accountType: 'Taxable', balance: 1000 },
    ]);
    expect(res.body.data[0].selectedAccounts).toEqual(['****4321']);
  });

  it('retains every request and persisted identity when resolution fails, logging only counts', async () => {
    const unresolvedNumber = 'APEX-11114321';
    warehouseMock.isMachineAccountIdentityConfigured.mockReturnValue(true);
    warehouseMock.getMachineAccountIdMap.mockRejectedValue(
      new Error(`private failure for Jane Doe ${unresolvedNumber}`),
    );
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          makeRow({
            account_metadata: [
              { accountId: ACCOUNT_ID, accountNumber: FULL_ACCOUNT, accountType: 'Taxable', balance: 1000 },
              { accountId: null, accountNumber: unresolvedNumber, accountType: 'Taxable', balance: 2000 },
            ],
          }),
          makeRow({ id: 'REQ-000002', selected_accounts: [unresolvedNumber], account_metadata: null }),
          makeRow({ id: 'REQ-000003', selected_accounts: ['Account ending 4321'], account_metadata: null }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(res.body.data.map((row: { id: string }) => row.id)).toEqual(['REQ-000001', 'REQ-000002', 'REQ-000003']);
    expect(
      res.body.data.map((row: { accounts: { accountId: string | null }[] }) =>
        row.accounts.map((account) => account.accountId),
      ),
    ).toEqual([[ACCOUNT_ID, null], [null], []]);
    expect(loggerMock.warn).toHaveBeenCalledExactlyOnceWith(
      { event: 'machine_trade_requests_account_resolution_failed', accountCount: 1 },
      'Machine trade-request account resolution failed',
    );
    const logged = JSON.stringify(Object.values(loggerMock).flatMap((mock) => mock.mock.calls));
    for (const privateValue of [
      ID_A,
      FULL_ACCOUNT,
      unresolvedNumber,
      ACCOUNT_ID,
      'Jane Doe',
      'private failure',
      'secret advisor note',
    ]) {
      expect(logged).not.toContain(privateValue);
    }
  });

  it.each(['empty result', 'failure'])('keeps inherited object keys unresolved after resolver %s', async (outcome) => {
    warehouseMock.isMachineAccountIdentityConfigured.mockReturnValue(true);
    if (outcome === 'failure') {
      warehouseMock.getMachineAccountIdMap.mockRejectedValue(new Error('unavailable'));
    } else {
      warehouseMock.getMachineAccountIdMap.mockResolvedValue({});
    }
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          makeRow({
            account_metadata: [
              { accountNumber: 'constructor', accountType: 'Taxable', balance: 1000 },
              { accountId: null, accountNumber: 'toString', accountType: 'Taxable', balance: 2000 },
              { accountId: ACCOUNT_ID, accountNumber: 'constructor', accountType: 'Taxable', balance: 3000 },
            ],
          }),
          makeRow({ id: 'REQ-000002', selected_accounts: ['constructor', 'toString'], account_metadata: null }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`);

    expect(res.status).toBe(200);
    expect(warehouseMock.getMachineAccountIdMap).toHaveBeenCalledExactlyOnceWith(['constructor', 'toString']);
    expect(
      res.body.data.map((row: { accounts: { accountId: string | null }[] }) =>
        row.accounts.map((account) => account.accountId),
      ),
    ).toEqual([
      [null, null, ACCOUNT_ID],
      [null, null],
    ]);
  });

  it('logs counts only — never ids or content', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [makeRow()] }).mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`);

    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    const [logPayload] = loggerMock.info.mock.calls[0];
    expect(logPayload).toMatchObject({ event: 'machine_trade_requests_read', idCount: 1, rowCount: 1 });
    const serialized = JSON.stringify(logPayload);
    expect(serialized).not.toContain(ID_A);
    expect(serialized).not.toContain('Jane Doe');
  });

  it('returns the deduped union for a batch of ids', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          makeRow({ id: 'REQ-000001', client_id: ID_A, client_ids: [ID_A] }),
          makeRow({ id: 'REQ-000002', client_id: ID_B, client_ids: [ID_B] }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_ids=${ID_A},${ID_B},${ID_A}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // Duplicate ID_A collapsed → the main query receives a deduped id array.
    const [, params] = mockPool.query.mock.calls[0];
    expect(params[0]).toEqual([ID_A, ID_B]);
  });

  it('returns 200 with an empty array for an unknown user (no 404)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_id=${ID_A}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  it('returns 400 when neither query param is supplied', async () => {
    const app = await createApp();
    const res = await request(app).get('/api/machine/trade-requests');

    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 400 when more than 50 ids are supplied', async () => {
    // Each id must be a VALID user-<uuid> so the ONLY reason for the 400 is the
    // >50 count (not a format failure) — otherwise this wouldn't guard .max(50).
    const ids = Array.from(
      { length: 51 },
      (_, i) => `user-${String(i + 1).padStart(8, '0')}-1111-1111-1111-111111111111`,
    ).join(',');

    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_ids=${ids}`);

    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed id', async () => {
    const app = await createApp();
    const res = await request(app).get('/api/machine/trade-requests?cedar_ridge_user_id=not-a-uuid');

    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 400 for a BARE uuid (missing the user- prefix)', async () => {
    // Regression guard for the original bug: the id must be `user-<uuid>`, not a
    // bare UUID. A bare uuid is exactly what Ops Portal never sends and must be rejected.
    const app = await createApp();
    const res = await request(app).get(
      '/api/machine/trade-requests?cedar_ridge_user_id=11111111-1111-1111-1111-111111111111',
    );

    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('accepts a real user-<uuid> cedar_ridge_user_id (200)', async () => {
    // The format Ops Portal actually sends (e.g. user-ae66b3c8-...). Regression guard:
    // this used to 400 under the bare-uuid validator.
    mockPool.query.mockResolvedValueOnce({ rows: [makeRow()] });
    const app = await createApp();
    const res = await request(app).get(
      '/api/machine/trade-requests?cedar_ridge_user_id=user-ae66b3c8-d257-4a6a-a8fd-d1c3641db27b',
    );

    expect(res.status).toBe(200);
    expect(mockPool.query).toHaveBeenCalled();
  });

  it('returns 400 for a malformed id inside a batch', async () => {
    const app = await createApp();
    const res = await request(app).get(`/api/machine/trade-requests?cedar_ridge_user_ids=${ID_A},nope`);

    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});
