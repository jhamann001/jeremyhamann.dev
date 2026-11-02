import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@trade-request/shared';

const { localPool, opsPortalQuery, configured } = vi.hoisted(() => ({
  localPool: { query: vi.fn() },
  opsPortalQuery: vi.fn(),
  configured: { value: false },
}));
vi.mock('../../db/pool.js', () => ({ default: localPool }));
vi.mock('../../db/opsPortalRecords.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/opsPortalRecords.js')>();
  return { ...actual, opsPortalRecordsConfigured: () => configured.value, opsPortalRecordsDb: { query: opsPortalQuery } };
});
vi.mock('../../lib/logger.js', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { OpsPortalRecordsUnavailableError } from '../../db/opsPortalRecords.js';
import { MCP_ACCESS_REFUSED, McpAccessRefusedError, selectMcpRecordSource } from '../recordSource.js';

const user: AuthUser = {
  id: 'local-user-uuid',
  googleId: 'g-1',
  email: ' Pat.Trader@Example.TEST ',
  name: 'Pat Trader',
  picture: null,
  role: 'advisor',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: null,
  createdAt: new Date().toISOString(),
};

const row = (over: Record<string, unknown> = {}) => ({
  rows: [{ serving_source: 'opsPortal', has_access: true, ops_portal_trader: true, tr_user_id: 'ops-portal-identity-uuid', ...over }],
});

beforeEach(() => {
  configured.value = true;
  opsPortalQuery.mockReset();
  localPool.query.mockReset();
});

describe('selectMcpRecordSource', () => {
  it('reads locally without any query when the advisor platform is not configured', async () => {
    configured.value = false;
    const ctx = await selectMcpRecordSource(user);
    expect(ctx.source).toBe('local');
    expect(ctx.db).toBe(localPool);
    expect(ctx.user).toBe(user);
    expect(opsPortalQuery).not.toHaveBeenCalled();
  });

  it('reads locally while the advisor platform reports standalone-served', async () => {
    opsPortalQuery.mockResolvedValueOnce(row({ serving_source: 'standalone' }));
    const ctx = await selectMcpRecordSource(user);
    expect(ctx.source).toBe('local');
    expect(ctx.db).toBe(localPool);
    expect(ctx.user).toBe(user);
  });

  it("reads the advisor platform while OPS-PORTAL-served, as the caller's OPS_PORTAL Trade Request identity", async () => {
    opsPortalQuery.mockResolvedValueOnce(row());
    const ctx = await selectMcpRecordSource(user);
    expect(ctx.source).toBe('opsPortal');
    expect(ctx.db).not.toBe(localPool);
    expect(ctx.user).toMatchObject({ id: 'ops-portal-identity-uuid', role: 'trader', email: user.email });
    expect(opsPortalQuery.mock.calls[0][1]).toEqual(['pat.trader@example.test']);
    expect(String(opsPortalQuery.mock.calls[0][0])).toMatch(/FROM serving_state s/);
  });

  it('keeps the local id when the advisor platform holds no Trade Request identity for the caller', async () => {
    opsPortalQuery.mockResolvedValueOnce(row({ tr_user_id: null }));
    const ctx = await selectMcpRecordSource(user);
    expect(ctx.user).toMatchObject({ id: 'local-user-uuid', role: 'trader' });
  });

  it('treats a caller whose current advisor platform role is not ADMIN or OPERATIONS as an advisor, whatever the local role', async () => {
    opsPortalQuery.mockResolvedValueOnce(row({ ops_portal_trader: false }));
    const ctx = await selectMcpRecordSource({ ...user, role: 'trader' });
    expect(ctx.user).toMatchObject({ id: 'ops-portal-identity-uuid', role: 'advisor' });
  });

  it('refuses a caller whose advisor platform role grants no Trade Request access while OPS-PORTAL-served', async () => {
    opsPortalQuery.mockResolvedValueOnce(row({ has_access: false }));
    const err = await selectMcpRecordSource(user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpAccessRefusedError);
    expect((err as Error).message).toBe(MCP_ACCESS_REFUSED);
  });

  it('refuses as unavailable when the advisor platform cannot be read', async () => {
    opsPortalQuery.mockRejectedValueOnce(new OpsPortalRecordsUnavailableError());
    await expect(selectMcpRecordSource(user)).rejects.toBeInstanceOf(OpsPortalRecordsUnavailableError);
    expect(localPool.query).not.toHaveBeenCalled();
  });

  it('refuses as unavailable when the serving-state row is missing or unrecognised', async () => {
    opsPortalQuery.mockResolvedValueOnce({ rows: [] });
    await expect(selectMcpRecordSource(user)).rejects.toBeInstanceOf(OpsPortalRecordsUnavailableError);
    opsPortalQuery.mockResolvedValueOnce(row({ serving_source: 'both' }));
    await expect(selectMcpRecordSource(user)).rejects.toBeInstanceOf(OpsPortalRecordsUnavailableError);
  });
});
