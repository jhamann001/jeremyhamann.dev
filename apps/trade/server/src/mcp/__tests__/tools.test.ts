import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { registerTools } from '../tools.js';

interface ToolContent {
  type?: string;
  text: string;
  resource?: { uri: string; mimeType: string; blob: string };
}
interface RegisteredTool {
  name: string;
  config: { inputSchema?: Record<string, unknown> };
  cb: (args: unknown, extra: unknown) => Promise<{ content: ToolContent[]; isError?: boolean }>;
}

/** Decode the first bytes of a base64 PDF resource so we can assert the magic header. */
function pdfHeader(blobBase64: string): string {
  return Buffer.from(blobBase64, 'base64').subarray(0, 5).toString('latin1');
}

function makeFakeServer(): { tools: Map<string, RegisteredTool>; registerTool: ReturnType<typeof vi.fn> } {
  const tools = new Map<string, RegisteredTool>();
  const registerTool = vi.fn((name: string, config: RegisteredTool['config'], cb: RegisteredTool['cb']) => {
    tools.set(name, { name, config, cb });
  });
  return { tools, registerTool };
}

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
const advisor: AuthUser = { ...trader, id: 'advisor-uuid', email: 'advisor@example.com', role: 'advisor' };

function setup(user: AuthUser) {
  const fakeServer = makeFakeServer();
  // The SDK's `McpServer.registerTool` is what we mock. Our registerTools fn just calls server.registerTool
  // — we cast the fake server through `unknown` to satisfy TS without pulling in the real SDK type.
  registerTools(
    { registerTool: fakeServer.registerTool } as unknown as Parameters<typeof registerTools>[0],
    async () => user,
  );
  return fakeServer;
}

const fakeExtra = {} as never;

beforeEach(() => {
  mockPool.query.mockReset().mockResolvedValue({ rows: [] });
});

describe('get_request_counts', () => {
  it('returns counts across the full queue for an advisor (no per-advisor scoping)', async () => {
    const fakeServer = setup(advisor);
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { status: 'Pending Review', count: '3' },
        { status: 'Approved', count: '7' },
      ],
    });

    const tool = fakeServer.tools.get('get_request_counts')!;
    const result = await tool.cb({}, fakeExtra);

    // Advisors now see every request — the query must NOT filter by advisor_id.
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).not.toMatch(/WHERE advisor_id/);

    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({ total: 10, pendingReview: 3, needsInfo: 0, approved: 7 });
  });

  it('does not filter when role=trader', async () => {
    const fakeServer = setup(trader);
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const tool = fakeServer.tools.get('get_request_counts')!;
    await tool.cb({}, fakeExtra);

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).not.toMatch(/WHERE advisor_id/);
  });
});

describe('list_my_requests', () => {
  it('does not filter by advisor_id for advisors (full queue visible)', async () => {
    const fakeServer = setup(advisor);
    // First call: list query. Empty result is fine — we only care about the SQL.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const tool = fakeServer.tools.get('list_my_requests')!;
    await tool.cb({ limit: 10 }, fakeExtra);

    const [sql] = mockPool.query.mock.calls[0];
    // The join still references tr.advisor_id; the filter predicate must be gone.
    expect(sql).not.toMatch(/tr\.advisor_id = \$/);
  });
});

/** Minimal trade_requests row good enough for mapRowToRequest. */
function tradeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'REQ-AB12CD34',
    client_id: 'HH-001',
    client_name: 'Client',
    advisor_id: 'trader-uuid',
    trade_type: 'Rebalance',
    status: 'Approved',
    total_value: '100000',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    execution_plan: null,
    ...overrides,
  };
}

describe('get_request', () => {
  it('returns a foreign request for an advisor (no ownership check)', async () => {
    const fakeServer = setup(advisor);
    mockPool.query
      .mockResolvedValueOnce({ rows: [tradeRow({ advisor_id: 'someone-else' })] }) // loadRequest: main row
      .mockResolvedValueOnce({ rows: [] }); // loadRequest: audit logs

    const tool = fakeServer.tools.get('get_request')!;
    const result = await tool.cb({ id: 'REQ-AB12CD34' }, fakeExtra);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).id).toBe('REQ-AB12CD34');
    // No `SELECT advisor_id` ownership probe — only loadRequest's two queries.
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  it('returns the request for a trader without an ownership check', async () => {
    const fakeServer = setup(trader);
    mockPool.query
      .mockResolvedValueOnce({ rows: [tradeRow({ id: 'REQ-XYZ' })] }) // loadRequest: main row
      .mockResolvedValueOnce({ rows: [] }); // loadRequest: audit logs

    const tool = fakeServer.tools.get('get_request')!;
    const result = await tool.cb({ id: 'REQ-XYZ' }, fakeExtra);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).id).toBe('REQ-XYZ');
    // Trader path runs only loadRequest's two queries — no `SELECT advisor_id` ownership probe.
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });
});

describe('get_last_allocation', () => {
  it('throws 403 when an advisor has no prior request for the client', async () => {
    const fakeServer = setup(advisor);
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // ownership probe finds nothing

    const tool = fakeServer.tools.get('get_last_allocation')!;
    const result = await tool.cb({ clientId: 'HH-999' }, fakeExtra);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/do not have access/);
    // Must short-circuit before the allocation lookup.
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/advisor_id = \$2/);
    expect(params).toEqual(['HH-999', advisor.id]);
  });

  it('returns the last allocation for an advisor who owns the client', async () => {
    const fakeServer = setup(advisor);
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ ok: 1 }] }) // ownership probe succeeds
      .mockResolvedValueOnce({
        rows: [{ risk_profile: 12, base_allocation: { equity: 60, fixed: 30, cash: 10 }, equity_strategies: [] }],
      });

    const tool = fakeServer.tools.get('get_last_allocation')!;
    const result = await tool.cb({ clientId: 'HH-001' }, fakeExtra);

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ riskProfile: 12, baseAllocation: { equity: 60, fixed: 30, cash: 10 } });
  });
});

describe('get_queue_digest', () => {
  it('returns counts and the list across the full queue for an advisor', async () => {
    const fakeServer = setup(advisor);
    mockPool.query.mockImplementation((sql: string) => {
      if (/GROUP BY status/.test(sql)) {
        expect(sql).not.toMatch(/WHERE advisor_id/);
        return Promise.resolve({
          rows: [
            { status: 'Pending Review', count: '2' },
            { status: 'Approved', count: '1' },
          ],
        });
      }
      // The list query — assert it is NOT advisor-scoped, return an empty page.
      expect(sql).not.toMatch(/tr\.advisor_id = \$/);
      return Promise.resolve({ rows: [] });
    });

    const tool = fakeServer.tools.get('get_queue_digest')!;
    const result = await tool.cb({ limit: 10 }, fakeExtra);

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.counts).toEqual({ total: 3, pendingReview: 2, needsInfo: 0, approved: 1 });
    expect(payload.requests).toEqual([]);
    expect(payload.nextCursor).toBeNull();
  });
});

describe('preview_engine', () => {
  it('rejects when an advisor has never had access to the client', async () => {
    const fakeServer = setup(advisor);
    // Access check returns no rows -> 403.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const tool = fakeServer.tools.get('preview_engine')!;
    const result = await tool.cb({ clientId: 'HH-001', tradeType: 'Rebalance' }, fakeExtra);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/do not have access/);
    // Critically: no further DB queries should have run.
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('runs the engine without writing to the DB', async () => {
    const fakeServer = setup(trader);
    // 1) Account lookup (warehouse is unconfigured, so we hit the DB fallback).
    mockPool.query.mockResolvedValueOnce({
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
    });
    // 2) getLastAllocation: the last-approved query returns nothing.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const tool = fakeServer.tools.get('preview_engine')!;
    const result = await tool.cb(
      {
        clientId: 'HH-001',
        tradeType: 'Rebalance',
        riskProfile: 12,
      },
      fakeExtra,
    );

    // No INSERT/UPDATE on trade_requests should have happened.
    for (const call of mockPool.query.mock.calls) {
      const sql = String(call[0]);
      expect(sql).not.toMatch(/INSERT INTO trade_requests/i);
      expect(sql).not.toMatch(/UPDATE trade_requests/i);
    }

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.inputs.riskProfile).toBe(12);
    expect(Array.isArray(payload.plan)).toBe(true);
  });
});

describe('get_request_pdf', () => {
  it('returns a valid application/pdf resource for one request', async () => {
    const fakeServer = setup(trader);
    // loadRequest: main row + audit logs. warehouse is unconfigured (top-level
    // mock), so account-exclusion enrichment adds no further queries.
    mockPool.query
      .mockResolvedValueOnce({ rows: [tradeRow({ id: 'REQ-PDF001', client_name: 'Test Household' })] })
      .mockResolvedValueOnce({ rows: [] });

    const tool = fakeServer.tools.get('get_request_pdf')!;
    const result = await tool.cb({ id: 'REQ-PDF001' }, fakeExtra);

    expect(result.isError).toBeUndefined();
    const resource = result.content[1].resource!;
    expect(result.content[0].text).toMatch(/^Generated Trade_Request_.*REQ-PDF001.*\.pdf/);
    expect(result.content[1].type).toBe('resource');
    expect(resource.mimeType).toBe('application/pdf');
    expect(resource.uri).toMatch(/^pdf:\/\/Trade_Request_/);
    // The blob must be real PDF bytes, not JSON or an error string.
    expect(pdfHeader(resource.blob)).toBe('%PDF-');
    // Only loadRequest's two queries ran (no enrichment queries when warehouse is off).
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  it('surfaces a 404 as a tool error when the request does not exist', async () => {
    const fakeServer = setup(trader);
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // loadRequest finds nothing

    const tool = fakeServer.tools.get('get_request_pdf')!;
    const result = await tool.cb({ id: 'REQ-NOPE' }, fakeExtra);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});

describe('get_compliance_report_pdf', () => {
  it('returns a valid application/pdf resource covering the matched requests', async () => {
    const fakeServer = setup(trader);
    mockPool.query.mockImplementation((sql: string) => {
      if (/FROM trade_requests/.test(sql)) {
        return Promise.resolve({ rows: [tradeRow({ id: 'REQ-C1', client_id: 'HH-1' })] });
      }
      if (/FROM audit_logs/.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM client_exclusions/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const tool = fakeServer.tools.get('get_compliance_report_pdf')!;
    const result = await tool.cb({}, fakeExtra);

    expect(result.isError).toBeUndefined();
    const resource = result.content[1].resource!;
    expect(result.content[0].text).toMatch(/covering 1 request\b/);
    expect(resource.mimeType).toBe('application/pdf');
    expect(pdfHeader(resource.blob)).toBe('%PDF-');
  });

  it('returns a tool error (not an empty PDF) when nothing matches', async () => {
    const fakeServer = setup(trader);
    mockPool.query.mockResolvedValue({ rows: [] }); // list query returns no rows

    const tool = fakeServer.tools.get('get_compliance_report_pdf')!;
    const result = await tool.cb({ q: 'zzz-no-match' }, fakeExtra);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nothing to export/i);
  });
});
