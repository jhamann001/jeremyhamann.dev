import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TradeRequest } from '@trade-request/shared';

const { mockPool } = vi.hoisted(() => ({
  mockPool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock('../../db/pool.js', () => ({ default: mockPool }));

const { mockMeta } = vi.hoisted(() => ({
  mockMeta: { isConfigured: vi.fn().mockReturnValue(false), getClientAccounts: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../warehouse.js', () => mockMeta);

vi.mock('../../lib/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  loadStandingClientExclusions,
  loadAccountExclusionsForRequests,
  renderRequestPdf,
  renderCompliancePdf,
} from '../pdfExports.js';

function makeRequest(overrides: Partial<TradeRequest> = {}): TradeRequest {
  return {
    id: 'REQ-TEST01',
    clientId: 'HH-1',
    clientName: 'Test Household',
    clientIds: ['HH-1'],
    clientNames: ['Test Household'],
    advisor: 'Rachel Moss',
    submittedBy: 'Jane Advisor',
    tradeType: 'Rebalance',
    tradeAmount: '',
    depositAccount: '',
    rebalanceAll: true,
    status: 'Approved',
    date: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
    selectedAccounts: ['ACC-1'],
    totalValue: 100000,
    priority: '',
    advisorNotes: '',
    residence: 'NY',
    liquidationApproval: '',
    advisorExclusions: '',
    clientExclusions: '',
    esgFilters: {
      fossilFuels: false,
      tobacco: false,
      weapons: false,
      alcohol: false,
      gambling: false,
      other: false,
      otherDescription: '',
      none: true,
    },
    riskProfile: 12,
    baseAllocation: { equity: 60, fixed: 30, cash: 10 },
    equityStrategies: [],
    raiseCashReason: '',
    liquidityDeadline: null,
    liquidateOption: '',
    liquidatePositions: '',
    executionPlan: [],
    assetLocationMode: 'priority',
    householdId: null,
    householdName: null,
    auditLog: [],
    ...overrides,
  };
}

const exporter = { name: 'Jeremy Hamann', email: 'jeremy@example.com' };

beforeEach(() => {
  mockPool.query.mockReset().mockResolvedValue({ rows: [] });
  mockMeta.isConfigured.mockReset().mockReturnValue(false);
  mockMeta.getClientAccounts.mockReset().mockResolvedValue([]);
});

describe('loadStandingClientExclusions', () => {
  it('returns an empty entry for every requested id and groups rows by client', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'e1',
          client_id: 'HH-1',
          ticker: 'TSLA',
          kind: 'advisor',
          reason: 'concentration',
          no_buy: true,
          no_sell: false,
          created_by_name: 'Jane',
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    });

    const result = await loadStandingClientExclusions(['HH-1', 'HH-2']);

    expect(Object.keys(result).sort()).toEqual(['HH-1', 'HH-2']);
    expect(result['HH-2']).toEqual([]); // id with no rows still present
    expect(result['HH-1']).toHaveLength(1);
    expect(result['HH-1'][0]).toMatchObject({ ticker: 'TSLA', kind: 'advisor', noBuy: true, noSell: false });
  });

  it('short-circuits without a query when given no ids', async () => {
    const result = await loadStandingClientExclusions([]);
    expect(result).toEqual({});
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('loadAccountExclusionsForRequests', () => {
  it('returns {} without touching the DB when warehouse is not configured', async () => {
    mockMeta.isConfigured.mockReturnValue(false);
    const result = await loadAccountExclusionsForRequests([makeRequest()]);
    expect(result).toEqual({});
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('resolves account numbers to ULIDs and reshapes exclusions by request', async () => {
    mockMeta.isConfigured.mockReturnValue(true);
    mockMeta.getClientAccounts.mockResolvedValue([
      { id: 'acct-ulid-1', clientId: 'HH-1', accountNumber: 'ACC-1', accountType: 'Taxable', balance: 0, holdings: {} },
    ]);
    // account_exclusions bulk query keyed by ULID
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'ax1',
          account_id: 'acct-ulid-1',
          ticker: 'NVDA',
          kind: 'client',
          reason: 'client request',
          no_buy: true,
          no_sell: true,
        },
      ],
    });

    const result = await loadAccountExclusionsForRequests([makeRequest({ id: 'REQ-X', selectedAccounts: ['ACC-1'] })]);

    expect(result['REQ-X']).toEqual([
      { accountNumber: 'ACC-1', kind: 'client', ticker: 'NVDA', reason: 'client request', noBuy: true, noSell: true },
    ]);
  });

  it('degrades to {} if a lookup throws', async () => {
    mockMeta.isConfigured.mockReturnValue(true);
    mockMeta.getClientAccounts.mockRejectedValue(new Error('warehouse down'));
    const result = await loadAccountExclusionsForRequests([makeRequest()]);
    expect(result).toEqual({});
  });
});

describe('render*Pdf', () => {
  it('renderRequestPdf produces valid PDF bytes and a keyed filename', async () => {
    mockMeta.isConfigured.mockReturnValue(false); // skip account enrichment
    const rendered = await renderRequestPdf(makeRequest({ id: 'REQ-ABC', clientName: 'Smith Household' }), exporter);

    expect(rendered.filename).toMatch(/^Trade_Request_Smith_Household_REQ-ABC_\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(rendered.bytes).toBeGreaterThan(0);
    expect(Buffer.from(rendered.base64, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('renderCompliancePdf gathers standing exclusions and produces a valid PDF', async () => {
    mockMeta.isConfigured.mockReturnValue(false);
    // loadStandingClientExclusions is the only DB call (account enrichment skipped).
    mockPool.query.mockResolvedValue({ rows: [] });

    const rendered = await renderCompliancePdf([makeRequest(), makeRequest({ id: 'REQ-2' })], exporter);

    expect(rendered.filename).toMatch(/^Compliance_Report_\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(Buffer.from(rendered.base64, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // Standing-exclusion query ran against client_exclusions.
    const sqls = mockPool.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /FROM client_exclusions/.test(s))).toBe(true);
  });
});
