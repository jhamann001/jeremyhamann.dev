import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPool } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  process.env.SESSION_MAX_AGE_MS = '3600000';
  return {
    mockPool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn(),
      end: vi.fn(),
    },
  };
});
vi.mock('../../db/pool.js', () => ({ default: mockPool }));

vi.mock('passport', () => ({
  default: {
    use: vi.fn(),
    authenticate: vi.fn(() => (_req: any, _res: any, next: any) => next()),
    initialize: vi.fn(() => (_req: any, _res: any, next: any) => next()),
    session: vi.fn(() => (_req: any, _res: any, next: any) => next()),
    serializeUser: vi.fn(),
    deserializeUser: vi.fn(),
  },
}));

vi.mock('connect-pg-simple', () => ({
  default: () => class MockPgStore {},
}));

import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import authRoutes from '../auth.js';
import type { AuthUser } from '@trade-request/shared';

function createApp(user?: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).session = {
      touch: vi.fn(),
      destroy: vi.fn((cb: (...args: any[]) => void) => cb()),
      regenerate: vi.fn((cb: (...args: any[]) => void) => cb(null)),
    };
    if (user) {
      (req as any).user = user;
      (req as any).isAuthenticated = () => true;
    } else {
      (req as any).isAuthenticated = () => false;
    }
    (req as any).logout = vi.fn((cb: (...args: any[]) => void) => cb(null));
    (req as any).login = vi.fn((u: any, cb: (...args: any[]) => void) => cb(null));
    next();
  });
  app.use('/auth', authRoutes);
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

const testUser: AuthUser = {
  id: 'user-1',
  googleId: 'g-1',
  email: 'test@example.com',
  name: 'Test User',
  picture: null,
  role: 'trader',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /auth/config', () => {
  it('returns 401 for unauthenticated requests', async () => {
    const res = await request(createApp()).get('/auth/config');
    expect(res.status).toBe(401);
  });

  it('returns allowed domain and session TTL when authenticated', async () => {
    const res = await request(createApp(testUser)).get('/auth/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('allowedDomains');
    expect(res.body).toHaveProperty('sessionTtlMs');
    expect(res.body.sessionTtlMs).toBe(3600000);
  });
});

describe('GET /auth/me', () => {
  it('returns current user when authenticated', async () => {
    const res = await request(createApp(testUser)).get('/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('user-1');
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(createApp()).get('/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/extend-session', () => {
  it('touches session when authenticated', async () => {
    const res = await request(createApp(testUser)).post('/auth/extend-session');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(createApp()).post('/auth/extend-session');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /auth/preferences', () => {
  it('updates theme preference', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'user-1',
          google_id: 'g-1',
          email: 'test@example.com',
          name: 'Test User',
          picture: null,
          role: 'trader',
          slack_user_id: null,
          theme_preference: 'dark',
          is_active: true,
          last_login: new Date(),
          created_at: new Date(),
        },
      ],
    });

    const res = await request(createApp(testUser)).patch('/auth/preferences').send({ themePreference: 'dark' });

    expect(res.status).toBe(200);
    expect(res.body.themePreference).toBe('dark');
  });

  it('rejects invalid theme preference', async () => {
    const res = await request(createApp(testUser)).patch('/auth/preferences').send({ themePreference: 'neon' });

    expect(res.status).toBe(400);
  });

  it('rejects missing theme preference', async () => {
    const res = await request(createApp(testUser)).patch('/auth/preferences').send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /auth/logout', () => {
  it('clears session', async () => {
    const res = await request(createApp(testUser)).post('/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /auth/dev-login', () => {
  // The handler reads NODE_ENV + DEV_LOGIN_EMAIL + CLIENT_ORIGIN at request
  // time, so each test can mutate them locally and restore in afterEach.
  // Saving the original values defends against bleed if a future test runs
  // in the same process. CLIENT_ORIGIN is also saved/cleared because dev
  // operators commonly set it in their local `.env` (e.g. http://localhost:5173
  // for Vite), and the dev-login post-login redirect picks it up — without
  // clearing it the "redirect to /" assertion below sees the Vite URL and
  // fails locally while still passing in CI's clean environment.
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_DEV_LOGIN_EMAIL = process.env.DEV_LOGIN_EMAIL;
  const ORIGINAL_CLIENT_ORIGIN = process.env.CLIENT_ORIGIN;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    delete process.env.DEV_LOGIN_EMAIL;
    delete process.env.CLIENT_ORIGIN;
  });

  // Tighter than the file-level beforeEach: also restore env after each test.
  // Vitest runs afterEach after the test body, so restoration is guaranteed.
  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_DEV_LOGIN_EMAIL === undefined) delete process.env.DEV_LOGIN_EMAIL;
    else process.env.DEV_LOGIN_EMAIL = ORIGINAL_DEV_LOGIN_EMAIL;
    if (ORIGINAL_CLIENT_ORIGIN === undefined) delete process.env.CLIENT_ORIGIN;
    else process.env.CLIENT_ORIGIN = ORIGINAL_CLIENT_ORIGIN;
  });

  it('returns 404 when NODE_ENV=production (even with DEV_LOGIN_EMAIL set)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_LOGIN_EMAIL = 'jeremy@example.com';
    const res = await request(createApp()).get('/auth/dev-login');
    expect(res.status).toBe(404);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 404 when DEV_LOGIN_EMAIL is unset', async () => {
    const res = await request(createApp()).get('/auth/dev-login');
    expect(res.status).toBe(404);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 404 when DEV_LOGIN_EMAIL matches no active user', async () => {
    process.env.DEV_LOGIN_EMAIL = 'ghost@example.com';
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp()).get('/auth/dev-login');
    expect(res.status).toBe(404);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('redirects to / and calls req.login when the email matches an active user', async () => {
    process.env.DEV_LOGIN_EMAIL = 'test@example.com';
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'user-1',
          google_id: 'g-1',
          email: 'test@example.com',
          name: 'Test User',
          picture: null,
          role: 'trader',
          slack_user_id: null,
          theme_preference: 'system',
          is_active: true,
          last_login: new Date(),
          created_at: new Date(),
        },
      ],
    });
    const res = await request(createApp()).get('/auth/dev-login');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});
