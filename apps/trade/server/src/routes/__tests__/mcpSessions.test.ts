import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@trade-request/shared';
import { traderUser, advisorUser } from './testHelpers.js';

const { mockPool } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  return {
    mockPool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
      end: vi.fn(),
    },
  };
});
vi.mock('../../db/pool.js', () => ({ default: mockPool }));

import express from 'express';
import request from 'supertest';
import mcpSessionRoutes from '../mcpSessions.js';
import { errorHandler } from '../../middleware/errorHandler.js';

function createApp(user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { user?: AuthUser }).user = user;
    (req as { isAuthenticated?: () => boolean }).isAuthenticated = () => true;
    next();
  });
  app.use('/api/me/mcp-sessions', mcpSessionRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockPool.query.mockReset().mockResolvedValue({ rows: [] });
  mockPool.connect.mockReset().mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  });
});

describe('GET /api/me/mcp-sessions', () => {
  it('returns the current user sessions only (advisor)', async () => {
    const now = new Date();
    const refreshExpires = new Date(now.getTime() + 30 * 86400 * 1000);
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          family_id: '00000000-0000-0000-0000-000000000001',
          client_id: 'mcp_one',
          client_name: 'Claude Desktop',
          client_created_at: now,
          refresh_expires_at: refreshExpires,
          last_access_at: null,
        },
      ],
    });

    const res = await request(createApp(advisorUser)).get('/api/me/mcp-sessions');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].clientName).toBe('Claude Desktop');
    expect(res.body.data[0].familyId).toBe('00000000-0000-0000-0000-000000000001');

    // SQL must filter by user_id and exclude rotated/revoked/expired rows.
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/rt\.user_id = \$1/);
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(sql).toMatch(/rotated_to IS NULL/);
    expect(sql).toMatch(/expires_at > NOW\(\)/);
    expect(params).toEqual([advisorUser.id]);
  });
});

describe('DELETE /api/me/mcp-sessions/:familyId', () => {
  it('refuses to revoke a family that does not belong to the user', async () => {
    // Ownership check returns no rows -> 404.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(advisorUser)).delete(
      '/api/me/mcp-sessions/00000000-0000-0000-0000-000000000099',
    );
    expect(res.status).toBe(404);

    // Ownership check ran with the user id...
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/family_id = \$1 AND user_id = \$2/);
    expect(params).toEqual(['00000000-0000-0000-0000-000000000099', advisorUser.id]);
    // ...and revokeFamily (which would call connect()) was NOT invoked.
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('revokes when the family belongs to the user', async () => {
    // Ownership check passes.
    mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const txClient = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    mockPool.connect.mockResolvedValueOnce(txClient);

    const res = await request(createApp(traderUser)).delete(
      '/api/me/mcp-sessions/00000000-0000-0000-0000-000000000001',
    );
    expect(res.status).toBe(204);
    expect(mockPool.connect).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed familyId', async () => {
    const res = await request(createApp(traderUser)).delete('/api/me/mcp-sessions/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/me/mcp-sessions', () => {
  it('revokes every active family for the current user', async () => {
    // First query: list distinct families.
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { family_id: '00000000-0000-0000-0000-000000000001' },
        { family_id: '00000000-0000-0000-0000-000000000002' },
      ],
    });
    const txClient = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    mockPool.connect.mockResolvedValue(txClient);

    const res = await request(createApp(traderUser)).delete('/api/me/mcp-sessions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revokedFamilies: 2 });
    // revokeFamily uses pool.connect once per family.
    expect(mockPool.connect).toHaveBeenCalledTimes(2);
  });
});
