import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@trade-request/shared';
import { traderUser, advisorUser } from './testHelpers.js';

const { mockPool, mockSendInviteEmail } = vi.hoisted(() => {
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
    mockSendInviteEmail: vi.fn(),
  };
});
vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../../services/email.js', () => ({ sendInviteEmail: mockSendInviteEmail }));
vi.mock('../../services/slack.js', () => ({
  sendChannelMessage: vi.fn().mockResolvedValue(undefined),
  escapeSlack: (s: string) => s,
}));

vi.mock('../../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth.js')>();
  return {
    ...actual,
    ALLOWED_DOMAINS: ['example.com', 'example.org'],
    requireRole:
      (...roles: string[]) =>
      (req: any, res: any, next: any) => {
        if (!req.user) return res.status(401).json({ error: 'Authentication required' });
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
        next();
      },
    mapRow: (row: any) => ({
      id: row.id,
      googleId: row.google_id ?? null,
      email: row.email,
      name: row.name,
      picture: row.picture ?? null,
      role: row.role,
      slackUserId: row.slack_user_id ?? null,
      isActive: row.is_active,
      lastLogin: row.last_login ? String(row.last_login) : null,
      createdAt: String(row.created_at ?? new Date().toISOString()),
    }),
  };
});

import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import userRoutes from '../users.js';

function createApp(user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    (req as any).isAuthenticated = () => true;
    next();
  });
  app.use('/users', userRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.issues });
      return;
    }
    const status = err.statusCode ?? 500;
    res.status(status).json({ error: err.message ?? 'Internal server error' });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /users', () => {
  it('returns user list for traders', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'u1',
          email: 'a@example.com',
          name: 'A',
          role: 'advisor',
          is_active: true,
          created_at: new Date(),
        },
      ],
    });
    const res = await request(createApp(traderUser)).get('/users');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].email).toBe('a@example.com');
  });

  it('returns 403 for advisors', async () => {
    const res = await request(createApp(advisorUser)).get('/users');
    expect(res.status).toBe(403);
  });
});

describe('POST /users/invite', () => {
  it('creates a new invited user and sends invite email', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'new-id',
          email: 'new@example.com',
          name: 'New User',
          role: 'advisor',
          is_active: true,
          created_at: new Date(),
        },
      ],
    });

    const res = await request(createApp(traderUser))
      .post('/users/invite')
      .send({ email: 'new@example.com', name: 'New User', role: 'advisor' });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe('new@example.com');
    expect(mockSendInviteEmail).toHaveBeenCalledWith({
      to: 'new@example.com',
      inviteeName: 'New User',
      role: 'advisor',
      invitedBy: traderUser.name,
    });
  });

  it('returns 409 for duplicate email and does not send email', async () => {
    const pgError = new Error('duplicate key value violates unique constraint') as Error & { code: string };
    pgError.code = '23505';
    mockPool.query.mockRejectedValueOnce(pgError);

    const res = await request(createApp(traderUser))
      .post('/users/invite')
      .send({ email: 'existing@example.com', name: 'Existing', role: 'advisor' });

    expect(res.status).toBe(409);
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid domain and does not send email', async () => {
    const res = await request(createApp(traderUser))
      .post('/users/invite')
      .send({ email: 'bad@gmail.com', name: 'Bad', role: 'advisor' });

    expect(res.status).toBe(400);
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it('returns 400 for missing fields and does not send email', async () => {
    const res = await request(createApp(traderUser)).post('/users/invite').send({ email: 'a@example.com' });

    expect(res.status).toBe(400);
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });
});

describe('PATCH /users/:id/role', () => {
  it('prevents changing own role', async () => {
    const res = await request(createApp(traderUser)).patch(`/users/${traderUser.id}/role`).send({ role: 'advisor' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own role/i);
  });

  it('prevents demoting last active trader', async () => {
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'other-trader-id' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // SELECT COUNT

    const res = await request(createApp(traderUser)).patch('/users/other-trader-id/role').send({ role: 'advisor' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last active trader/i);
  });

  it('allows demoting when other traders exist', async () => {
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'other-id' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // SELECT COUNT
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'other-id',
            email: 'other@example.com',
            name: 'Other',
            role: 'advisor',
            is_active: true,
            created_at: new Date(),
          },
        ],
      }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(createApp(traderUser)).patch('/users/other-id/role').send({ role: 'advisor' });

    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid role', async () => {
    const res = await request(createApp(traderUser)).patch('/users/other-id/role').send({ role: 'admin' });

    expect(res.status).toBe(400);
  });
});

describe('PATCH /users/:id/deactivate', () => {
  it('prevents deactivating yourself', async () => {
    const res = await request(createApp(traderUser)).patch(`/users/${traderUser.id}/deactivate`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own account/i);
  });

  it('prevents deactivating last active trader', async () => {
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ role: 'trader' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // SELECT COUNT

    const res = await request(createApp(traderUser)).patch('/users/other-trader-id/deactivate');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last active trader/i);
  });

  it('allows deactivating non-trader users', async () => {
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ role: 'advisor' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'adv-id',
            email: 'adv@example.com',
            name: 'Adv',
            role: 'advisor',
            is_active: false,
            created_at: new Date(),
          },
        ],
      }) // UPDATE users
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // UPDATE mcp_pats (cascade)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // UPDATE oauth_refresh_tokens (cascade)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // UPDATE oauth_access_tokens (cascade)
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(createApp(traderUser)).patch('/users/adv-id/deactivate');

    expect(res.status).toBe(200);
  });

  it('cascades revocation to mcp_pats, oauth_refresh_tokens, and oauth_access_tokens', async () => {
    mockPool._client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ role: 'advisor' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'adv-id',
            email: 'adv@example.com',
            name: 'Adv',
            role: 'advisor',
            is_active: false,
            created_at: new Date(),
          },
        ],
      }) // UPDATE users
      .mockResolvedValueOnce({ rowCount: 2, rows: [] }) // UPDATE mcp_pats — 2 PATs revoked
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE oauth_refresh_tokens — 1 family
      .mockResolvedValueOnce({ rowCount: 3, rows: [] }) // UPDATE oauth_access_tokens — 3 access tokens
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(createApp(traderUser)).patch('/users/adv-id/deactivate');
    expect(res.status).toBe(200);

    // The three cascade queries must each scope by user_id and exclude already-revoked rows.
    const calls = mockPool._client.query.mock.calls.map((c: unknown[]) => c[0] as string);
    const patUpdate = calls.find((sql) => /UPDATE mcp_pats SET revoked_at/.test(sql));
    const refreshUpdate = calls.find((sql) => /UPDATE oauth_refresh_tokens SET revoked_at/.test(sql));
    const accessUpdate = calls.find((sql) => /UPDATE oauth_access_tokens SET revoked_at/.test(sql));
    expect(patUpdate).toMatch(/WHERE user_id = \$1 AND revoked_at IS NULL/);
    expect(refreshUpdate).toMatch(/WHERE user_id = \$1 AND revoked_at IS NULL/);
    expect(accessUpdate).toMatch(/WHERE user_id = \$1 AND revoked_at IS NULL/);
  });
});

describe('PATCH /users/:id/slack', () => {
  it('updates own slack user ID', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: traderUser.id,
          email: traderUser.email,
          name: traderUser.name,
          role: 'trader',
          slack_user_id: 'U123',
          is_active: true,
          created_at: new Date(),
        },
      ],
    });

    const res = await request(createApp(traderUser))
      .patch(`/users/${traderUser.id}/slack`)
      .send({ slackUserId: 'U123' });

    expect(res.status).toBe(200);
  });

  it('allows trader to update another user slack ID', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'other-user-id',
          email: 'other@example.com',
          name: 'Other User',
          role: 'advisor',
          slack_user_id: 'U456',
          is_active: true,
          created_at: new Date(),
        },
      ],
    });

    const res = await request(createApp(traderUser)).patch('/users/other-user-id/slack').send({ slackUserId: 'U456' });

    expect(res.status).toBe(200);
    expect(res.body.slackUserId).toBe('U456');
  });
});

describe('PATCH /users/:id/reactivate', () => {
  it('reactivates a deactivated user', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'u1',
          email: 'a@example.com',
          name: 'A',
          role: 'advisor',
          is_active: true,
          created_at: new Date(),
        },
      ],
    });

    const res = await request(createApp(traderUser)).patch('/users/u1/reactivate');

    expect(res.status).toBe(200);
  });

  it('returns 404 for non-existent user', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(traderUser)).patch('/users/nonexistent/reactivate');

    expect(res.status).toBe(404);
  });
});
