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
      connect: vi.fn(),
      end: vi.fn(),
    },
  };
});
vi.mock('../../db/pool.js', () => ({ default: mockPool }));

import express from 'express';
import request from 'supertest';
import notificationRoutes from '../notifications.js';
import { errorHandler } from '../../middleware/errorHandler.js';

function createApp(user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: AuthUser }).user = user;
    next();
  });
  app.use('/', notificationRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /', () => {
  it('returns notifications and unreadCount for the current user', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: '550e8400-e29b-41d4-a716-446655440000',
            body: 'Test message',
            request_id: 'REQ-1',
            read_at: null,
            created_at: new Date('2026-01-15T12:00:00Z'),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ c: '1' }] });

    const res = await request(createApp(traderUser)).get('/');

    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].message).toBe('Test message');
    expect(res.body.data[0].isRead).toBe(false);
  });
});

describe('PATCH /:id/read', () => {
  it('returns 204 when marking unread notification', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(createApp(advisorUser)).patch('/550e8400-e29b-41d4-a716-446655440001/read');

    expect(res.status).toBe(204);
  });

  it('returns 404 when notification not owned by user', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(advisorUser)).patch('/550e8400-e29b-41d4-a716-446655440002/read');

    expect(res.status).toBe(404);
  });
});

describe('POST /read-all', () => {
  it('returns 204', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 3 });

    const res = await request(createApp(traderUser)).post('/read-all');

    expect(res.status).toBe(204);
  });
});
