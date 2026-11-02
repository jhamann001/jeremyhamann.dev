// MCP tools against a local OPS-PORTAL-shaped stand-in: schema trade_request (record tables, serving_state, mcp_access)
// read through a SELECT-only login, and schema trb12_local standing in for the service's own tables. Creates the
// two schemas and the cluster role trb12_mcp_ro_it, and drops them afterwards. Skips without DATABASE_URL.
// The view and grants mirror OPS_PORTAL's merged migration 20261101120000_trade_request_schema (ticket).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import type { AuthUser } from '@trade-request/shared';

vi.mock('../../db/pool.js', async () => {
  const { default: pgModule } = await import('pg');
  return {
    default: new pgModule.Pool({
      connectionString: process.env.DATABASE_URL ?? 'postgres://127.0.0.1:1/unused',
      options: '-c search_path=trb12_local',
      max: 2,
    }),
  };
});
vi.mock('../../services/warehouse.js', () => ({ isConfigured: () => false, getClientAccounts: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import localPool from '../../db/pool.js';
import {
  OPS_PORTAL_RECORDS_UNAVAILABLE,
  OpsPortalRecordsUnavailableError,
  opsPortalRecordsDb,
  buildOpsPortalRecordsPoolConfig,
  closeOpsPortalRecordsDb,
} from '../../db/opsPortalRecords.js';
import { MCP_ACCESS_REFUSED } from '../recordSource.js';
import { registerTools } from '../tools.js';

const DATABASE_URL = process.env.DATABASE_URL;
const ROLE = 'trb12_mcp_ro_it';
const ROLE_PASSWORD = 'integration-only-mcp';
const TABLES = [
  'users',
  'clients',
  'accounts',
  'trade_requests',
  'audit_logs',
  'client_exclusions',
  'account_exclusions',
];

interface ToolResult {
  content: Array<{ text: string }>;
  isError?: boolean;
}
type ToolCb = (args: unknown, extra: unknown) => Promise<ToolResult>;

const caller = (email: string): AuthUser => ({
  id: '00000000-0000-4000-8000-000000000001',
  googleId: null,
  email,
  name: 'Integration Caller',
  picture: null,
  role: 'advisor',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: null,
  createdAt: new Date().toISOString(),
});

function tool(name: string, email = 'pat.ops@example.test'): ToolCb {
  const map = new Map<string, ToolCb>();
  const server = { registerTool: (n: string, _c: unknown, cb: ToolCb) => map.set(n, cb) };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], async () => caller(email));
  return map.get(name)!;
}

function setOpsPortalEnv(): void {
  const url = new URL(DATABASE_URL!);
  process.env.OPS_PORTAL_RECORDS_DB_HOST = url.hostname;
  process.env.OPS_PORTAL_RECORDS_DB_PORT = url.port || '5432';
  process.env.OPS_PORTAL_RECORDS_DB_NAME = url.pathname.slice(1);
  process.env.OPS_PORTAL_RECORDS_DB_USER = ROLE;
  process.env.OPS_PORTAL_RECORDS_DB_PASSWORD = ROLE_PASSWORD;
  process.env.OPS_PORTAL_RECORDS_DB_SSL = 'off';
}

describe.skipIf(!DATABASE_URL)('MCP reads from an OPS-PORTAL-shaped database (Postgres integration)', () => {
  let admin: pg.Client;

  const setServing = (source: 'standalone' | 'opsPortal') =>
    admin.query('UPDATE trade_request.serving_state SET serving_source = $1 WHERE id', [source]);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS trade_request CASCADE; DROP SCHEMA IF EXISTS trb12_local CASCADE;`);
    await admin.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN DROP OWNED BY ${ROLE}; DROP ROLE ${ROLE}; END IF;
    END $$`);
    await admin.query('CREATE SCHEMA trade_request; CREATE SCHEMA trb12_local;');
    for (const t of TABLES) {
      await admin.query(`CREATE TABLE trade_request.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
      await admin.query(`CREATE TABLE trb12_local.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
    }
    await admin.query(`
      CREATE TABLE trade_request.serving_state (
        id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
        serving_source TEXT NOT NULL DEFAULT 'standalone' CHECK (serving_source IN ('standalone', 'opsPortal'))
      );
      INSERT INTO trade_request.serving_state (id) VALUES (TRUE);
      CREATE TABLE trade_request.ops_portal_user_standin (email TEXT, role TEXT);
      CREATE VIEW trade_request.mcp_access AS
        SELECT lower(btrim(email)) AS email, bool_or(role IN ('ADMIN', 'OPERATIONS', 'ADVISOR')) AS has_access,
               bool_or(role IN ('ADMIN', 'OPERATIONS')) AS trader_role
          FROM trade_request.ops_portal_user_standin GROUP BY lower(btrim(email));
      INSERT INTO trade_request.ops_portal_user_standin VALUES (' Pat.Ops@Example.TEST ', 'OPERATIONS'), ('vic.viewer@example.test', 'CLIENT');
      INSERT INTO trade_request.trade_requests (id, client_id, client_name, trade_type, status, total_value, risk_profile, base_allocation)
        VALUES ('REQ-OPS00002', 'HH-002', 'Synthetic Household', 'Rebalance', 'Approved', 1000, 12, '{"equity":60,"fixed":30,"cash":10}');
      INSERT INTO trade_request.trade_requests (id, client_id, client_name, trade_type, status, total_value)
        VALUES ('REQ-OPS00001', 'HH-001', 'Synthetic Household', 'Rebalance', 'Approved', 1000);
      INSERT INTO trade_request.audit_logs (request_id, user_name, action, channel)
        VALUES ('REQ-OPS00001', 'Synthetic Person', 'Submitted', 'opsPortal');
      INSERT INTO trb12_local.trade_requests (id, client_id, client_name, trade_type, status, total_value)
        VALUES ('REQ-LOCAL0001', 'HH-001', 'Synthetic Household', 'Rebalance', 'Pending Review', 1000);
      CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}';
      GRANT USAGE ON SCHEMA trade_request TO ${ROLE};
      GRANT SELECT ON trade_request.trade_requests, trade_request.audit_logs, trade_request.users,
        trade_request.accounts, trade_request.clients, trade_request.serving_state, trade_request.mcp_access,
        trade_request.client_exclusions, trade_request.account_exclusions TO ${ROLE};
    `);
  });

  beforeEach(async () => {
    await closeOpsPortalRecordsDb();
    setOpsPortalEnv();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeOpsPortalRecordsDb();
    await (localPool as unknown as pg.Pool).end();
    await admin.query('DROP SCHEMA IF EXISTS trade_request CASCADE; DROP SCHEMA IF EXISTS trb12_local CASCADE;');
    await admin.query(`DROP OWNED BY ${ROLE}; DROP ROLE IF EXISTS ${ROLE};`);
    await admin.end();
    for (const k of Object.keys(process.env)) if (k.startsWith('OPS_PORTAL_RECORDS_DB_')) delete process.env[k];
  });

  it("answers from OPS_PORTAL's records while OPS-PORTAL-served", async () => {
    await setServing('opsPortal');
    const found = await tool('get_request')({ id: 'REQ-OPS00001' }, {});
    expect(found.isError).toBeUndefined();
    const body = JSON.parse(found.content[0].text);
    expect(body.id).toBe('REQ-OPS00001');
    expect(body.auditLog.map((a: { action: string; channel: string }) => [a.action, a.channel])).toEqual([
      ['Submitted', 'opsPortal'],
    ]);
    const local = await tool('get_request')({ id: 'REQ-LOCAL0001' }, {});
    expect(local).toEqual({ content: [{ type: 'text', text: 'Request REQ-LOCAL0001 not found' }], isError: true });
  });

  it('answers from the local records while standalone-served', async () => {
    await setServing('standalone');
    const found = await tool('get_request')({ id: 'REQ-LOCAL0001' }, {});
    expect(JSON.parse(found.content[0].text).id).toBe('REQ-LOCAL0001');
    const opsPortal = await tool('get_request')({ id: 'REQ-OPS00001' }, {});
    expect(opsPortal.isError).toBe(true);
  });

  it('refuses callers whose advisor platform role grants no Trade Request access while OPS-PORTAL-served', async () => {
    await setServing('opsPortal');
    for (const email of ['vic.viewer@example.test', 'nobody@example.test']) {
      const result = await tool('get_request_counts', email)({}, {});
      expect(result).toEqual({ content: [{ type: 'text', text: MCP_ACCESS_REFUSED }], isError: true });
    }
  });

  it('cannot write through the read-only login', async () => {
    const insert = `INSERT INTO trade_requests (id, client_id, trade_type) VALUES ('REQ-WRITE001', 'HH-1', 'Rebalance')`;
    await expect(opsPortalRecordsDb.query(insert)).rejects.toBeInstanceOf(OpsPortalRecordsUnavailableError);
    const readOnly = new pg.Client(buildOpsPortalRecordsPoolConfig());
    await readOnly.connect();
    const sessionCode = await readOnly.query(insert).then(
      () => 'ok',
      (e: { code?: string }) => e.code,
    );
    await readOnly.query('SET default_transaction_read_only = off');
    const grantCode = await readOnly.query(insert).then(
      () => 'ok',
      (e: { code?: string }) => e.code,
    );
    await readOnly.end();
    expect([sessionCode, grantCode]).toEqual(['25006', '42501']);
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM trade_request.trade_requests WHERE id = 'REQ-WRITE001'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses with the unavailable message, never local records, when the advisor platform is unreachable', async () => {
    await setServing('standalone');
    process.env.OPS_PORTAL_RECORDS_DB_PORT = '1';
    const spy = vi.spyOn(localPool as unknown as pg.Pool, 'query');
    const result = await tool('get_request')({ id: 'REQ-LOCAL0001' }, {});
    expect(result).toEqual({ content: [{ type: 'text', text: OPS_PORTAL_RECORDS_UNAVAILABLE }], isError: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a PDF tool as unavailable when the login cannot read standing exclusions', async () => {
    await setServing('opsPortal');
    await admin.query(`REVOKE SELECT ON trade_request.client_exclusions FROM ${ROLE}`);
    try {
      const result = await tool('get_compliance_report_pdf')({}, {});
      expect(result).toEqual({ content: [{ type: 'text', text: OPS_PORTAL_RECORDS_UNAVAILABLE }], isError: true });
    } finally {
      await admin.query(`GRANT SELECT ON trade_request.client_exclusions TO ${ROLE}`);
    }
  });

  it("follows the caller's current OPS_PORTAL role for ownership checks, and refuses as unavailable without trader_role", async () => {
    await setServing('opsPortal');
    const asOps = await tool('get_last_allocation')({ clientId: 'HH-002' }, {});
    expect(JSON.parse(asOps.content[0].text)).toMatchObject({ riskProfile: 12 });
    await admin.query(`UPDATE trade_request.ops_portal_user_standin SET role = 'ADVISOR' WHERE role = 'OPERATIONS'`);
    try {
      const asAdvisor = await tool('get_last_allocation')({ clientId: 'HH-002' }, {});
      expect(asAdvisor).toEqual({
        content: [{ type: 'text', text: 'You do not have access to this client' }],
        isError: true,
      });
    } finally {
      await admin.query(`UPDATE trade_request.ops_portal_user_standin SET role = 'OPERATIONS' WHERE role = 'ADVISOR'`);
    }
    await admin.query(`
      CREATE OR REPLACE VIEW trade_request.mcp_access_without_role AS SELECT email, has_access FROM trade_request.mcp_access;
      ALTER VIEW trade_request.mcp_access RENAME TO mcp_access_full;
      ALTER VIEW trade_request.mcp_access_without_role RENAME TO mcp_access;
      GRANT SELECT ON trade_request.mcp_access TO ${ROLE};
    `);
    try {
      const result = await tool('get_last_allocation')({ clientId: 'HH-002' }, {});
      expect(result).toEqual({ content: [{ type: 'text', text: OPS_PORTAL_RECORDS_UNAVAILABLE }], isError: true });
    } finally {
      await admin.query(`
        DROP VIEW trade_request.mcp_access;
        ALTER VIEW trade_request.mcp_access_full RENAME TO mcp_access;
      `);
    }
  });

  it('reads the local records when the advisor platform settings are absent, whatever the advisor platform reports', async () => {
    await setServing('opsPortal');
    delete process.env.OPS_PORTAL_RECORDS_DB_HOST;
    const result = await tool('get_request')({ id: 'REQ-LOCAL0001' }, {});
    expect(JSON.parse(result.content[0].text).id).toBe('REQ-LOCAL0001');
  });
});
