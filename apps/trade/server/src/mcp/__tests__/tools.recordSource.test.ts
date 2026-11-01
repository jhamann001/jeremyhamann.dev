import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AuthUser } from '@trade-request/shared';

const { localPool, opsPortalDb, select } = vi.hoisted(() => ({
  localPool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() },
  opsPortalDb: { query: vi.fn() },
  select: vi.fn(),
}));
vi.mock('../../db/pool.js', () => ({ default: localPool }));
vi.mock('../../services/warehouse.js', () => ({ isConfigured: () => false, getClientAccounts: vi.fn() }));
vi.mock('../recordSource.js', () => ({ selectMcpRecordSource: select }));

import { registerTools } from '../tools.js';
import { OPS_PORTAL_RECORDS_UNAVAILABLE, OpsPortalRecordsUnavailableError } from '../../db/opsPortalRecords.js';

interface ToolResult {
  content: Array<{ type?: string; text: string }>;
  isError?: boolean;
}
type ToolCb = (args: unknown, extra: unknown) => Promise<ToolResult>;

const advisor: AuthUser = {
  id: 'local-advisor-uuid',
  googleId: 'g-advisor',
  email: 'advisor@example.test',
  name: 'Test Advisor',
  picture: null,
  role: 'advisor',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: null,
  createdAt: new Date().toISOString(),
};

function tools(): Map<string, ToolCb> {
  const map = new Map<string, ToolCb>();
  const server = { registerTool: (name: string, _config: unknown, cb: ToolCb) => map.set(name, cb) };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], async () => advisor);
  return map;
}

const tradeRow = (id: string) => ({
  id,
  client_id: 'HH-001',
  client_name: 'Client',
  advisor_id: 'someone',
  trade_type: 'Rebalance',
  status: 'Approved',
  total_value: '100000',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  execution_plan: null,
});

const opsPortalContext = (user: AuthUser = advisor) => ({ source: 'opsPortal', db: opsPortalDb, user });

beforeEach(() => {
  localPool.query.mockReset().mockResolvedValue({ rows: [] });
  opsPortalDb.query.mockReset().mockResolvedValue({ rows: [] });
  select.mockReset();
});

describe('MCP tools follow the selected record source', () => {
  it("answers get_request from OPS_PORTAL's records while OPS-PORTAL-served", async () => {
    select.mockResolvedValueOnce(opsPortalContext());
    opsPortalDb.query.mockResolvedValueOnce({ rows: [tradeRow('REQ-OPS00001')] }).mockResolvedValueOnce({ rows: [] });
    const result = await tools().get('get_request')!({ id: 'REQ-OPS00001' }, {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).id).toBe('REQ-OPS00001');
    expect(opsPortalDb.query).toHaveBeenCalledTimes(2);
    expect(localPool.query).not.toHaveBeenCalled();
  });

  it('answers get_request from the local database while standalone-served', async () => {
    select.mockResolvedValueOnce({ source: 'local', db: localPool, user: advisor });
    localPool.query.mockResolvedValueOnce({ rows: [tradeRow('REQ-LOCAL001')] }).mockResolvedValueOnce({ rows: [] });
    const result = await tools().get('get_request')!({ id: 'REQ-LOCAL001' }, {});
    expect(JSON.parse(result.content[0].text).id).toBe('REQ-LOCAL001');
    expect(opsPortalDb.query).not.toHaveBeenCalled();
  });

  it('returns the refusal and reads nothing when the Ops Portal role grants no access', async () => {
    const { McpAccessRefusedError, MCP_ACCESS_REFUSED } =
      await vi.importActual<typeof import('../recordSource.js')>('../recordSource.js');
    select.mockRejectedValueOnce(new McpAccessRefusedError());
    const result = await tools().get('get_request_counts')!({}, {});
    expect(result).toEqual({ content: [{ type: 'text', text: MCP_ACCESS_REFUSED }], isError: true });
    expect(opsPortalDb.query).not.toHaveBeenCalled();
    expect(localPool.query).not.toHaveBeenCalled();
  });

  it('returns the unavailable message, never local records, when Ops Portal cannot be read', async () => {
    select.mockRejectedValueOnce(new OpsPortalRecordsUnavailableError());
    const result = await tools().get('list_my_requests')!({ limit: 5 }, {});
    expect(result).toEqual({ content: [{ type: 'text', text: OPS_PORTAL_RECORDS_UNAVAILABLE }], isError: true });
    expect(localPool.query).not.toHaveBeenCalled();
  });

  it('returns the unavailable message when an Ops Portal read fails mid-tool', async () => {
    select.mockResolvedValueOnce(opsPortalContext());
    opsPortalDb.query.mockRejectedValueOnce(new OpsPortalRecordsUnavailableError());
    const result = await tools().get('get_request')!({ id: 'REQ-OPS00001' }, {});
    expect(result).toEqual({ content: [{ type: 'text', text: OPS_PORTAL_RECORDS_UNAVAILABLE }], isError: true });
    expect(localPool.query).not.toHaveBeenCalled();
  });

  it("checks last-allocation ownership against OPS_PORTAL's records with the OPS_PORTAL identity", async () => {
    select.mockResolvedValueOnce(opsPortalContext({ ...advisor, id: 'ops-portal-identity-uuid' }));
    opsPortalDb.query.mockResolvedValueOnce({ rows: [] });
    const result = await tools().get('get_last_allocation')!({ clientId: 'HH-001' }, {});
    expect(result.isError).toBe(true);
    expect(opsPortalDb.query.mock.calls[0][1]).toEqual(['HH-001', 'ops-portal-identity-uuid']);
    expect(localPool.query).not.toHaveBeenCalled();
  });

  it("reads standing exclusions for the compliance PDF from OPS_PORTAL's records", async () => {
    select.mockResolvedValueOnce(opsPortalContext());
    opsPortalDb.query
      .mockResolvedValueOnce({ rows: [tradeRow('REQ-OPS00001')] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await tools().get('get_compliance_report_pdf')!({}, {});
    expect(result.isError).toBeUndefined();
    expect(opsPortalDb.query.mock.calls.map((c) => String(c[0])).some((s) => /FROM client_exclusions/.test(s))).toBe(true);
    expect(localPool.query).not.toHaveBeenCalled();
  });

  it('leaves no direct local-pool import in the MCP tools module', () => {
    const source = readFileSync(fileURLToPath(new URL('../tools.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/db\/pool\.js/);
  });
});
