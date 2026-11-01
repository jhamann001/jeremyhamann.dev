import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPool } = vi.hoisted(() => {
  process.env.SESSION_SECRET = 'test-session';
  // Read at import: with persona sign-in on, Google may be left unconfigured.
  process.env.PERSONA_SIGN_IN = 'on';
  return { mockPool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() } };
});
vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('passport', () => ({
  default: {
    use: vi.fn(),
    authenticate: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
    initialize: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
    session: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
    serializeUser: vi.fn(),
    deserializeUser: vi.fn(),
  },
}));
vi.mock('connect-pg-simple', () => ({ default: () => class MockPgStore {} }));
vi.mock('../../services/email.js', () => ({ sendInviteEmail: vi.fn() }));
const store = vi.hoisted(() => ({ consumePendingAuth: vi.fn(), issueAuthorizationCode: vi.fn(), insertPendingAuth: vi.fn() }));
vi.mock('../../mcp/oauth/store.js', async (orig) => ({ ...(await orig<object>()), ...store }));

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import type { AuthUser } from '@trade-request/shared';
import authRoutes from '../../routes/auth.js';
import userRoutes from '../../routes/users.js';
import { TradeRequestOAuthProvider } from '../../mcp/oauth/provider.js';

const RACHEL = {
  id: '11111111-1111-4111-8111-111111111111', google_id: null, email: 'rachel.moss@example.com', name: 'Rachel Moss',
  picture: null, role: 'advisor', slack_user_id: null, theme_preference: 'system', is_active: true, last_login: null,
  created_at: '2026-01-01T00:00:00Z',
};
const trader = { id: '22222222-2222-4222-8222-222222222222', email: 'ethan.cole@example.com', role: 'trader' } as AuthUser;

function app(user?: AuthUser) {
  const login = vi.fn((_u: unknown, cb: (err: unknown) => void) => cb(null));
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, {
      session: { regenerate: (cb: (err: unknown) => void) => cb(null) },
      login,
      user,
      isAuthenticated: () => !!user,
    });
    next();
  });
  a.use('/auth', authRoutes);
  a.use('/api/users', userRoutes);
  a.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as Error & { statusCode?: number }).statusCode ?? (err.name === 'ZodError' ? 400 : 500);
    res.status(status).json({ error: err.message });
  });
  return { app: a, login };
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  process.env.PERSONA_SIGN_IN = 'on';
});
afterEach(() => {
  delete process.env.PERSONA_SIGN_IN;
});

describe('persona sign-in', () => {
  it('lists the personas and says Google is not configured', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ email: RACHEL.email, name: RACHEL.name, role: 'advisor' }] });
    const res = await request(app().app).get('/auth/sign-in-options').expect(200);
    expect(res.body).toEqual({ google: false, personas: [{ email: RACHEL.email, name: 'Rachel Moss', role: 'advisor', title: 'Advisor' }] });
    // Only the universe's staff emails are ever asked for.
    expect(mockPool.query.mock.calls[0][1][0]).toEqual(
      expect.arrayContaining(['rachel.moss@example.com', 'ethan.cole@example.com', 'sam.ortiz@example.com', 'dana.pruitt@example.com']),
    );
  });

  it('signs in as a persona', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [RACHEL] }).mockResolvedValueOnce({ rows: [] });
    const { app: a, login } = app();
    const res = await request(a).post('/auth/persona').send({ email: 'Rachel.Moss@example.com' }).expect(200);
    expect(res.body.email).toBe(RACHEL.email);
    expect(login).toHaveBeenCalledWith(expect.objectContaining({ id: RACHEL.id, role: 'advisor' }), expect.any(Function));
  });

  it('looks a persona up by its exact canonical email, whatever case was sent', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [RACHEL] }).mockResolvedValueOnce({ rows: [] });
    await request(app().app).post('/auth/persona').send({ email: 'RACHEL.MOSS@example.com' }).expect(200);
    expect(mockPool.query.mock.calls[0][0]).toMatch(/WHERE email = \$1/);
    expect(mockPool.query.mock.calls[0][1]).toEqual(['rachel.moss@example.com']);
  });

  it('does not treat a case-variant account as a persona', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ email: 'Rachel.Moss@example.com' }] });
    const res = await request(app(trader).app).patch(`/api/users/${RACHEL.id}/role`).send({ role: 'nope' });
    expect(res.status).toBe(400); // past the fence, into the route's own validation
  });

  it('refuses to invite a persona email in any letter case', async () => {
    const res = await request(app(trader).app)
      .post('/api/users/invite')
      .send({ email: 'Rachel.Moss@example.com', name: 'Not Rachel', role: 'trader' });
    expect(res.status).toBe(409);
    expect(mockPool.query).not.toHaveBeenCalled(); // nothing inserted
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('refuses an invite once the demo holds its cap of users, without inserting', async () => {
    const db = { query: vi.fn(async (sql: string) => (/count\(\*\)/.test(sql) ? { rows: [{ n: 30 }] } : { rows: [] })), release: vi.fn() };
    mockPool.connect.mockResolvedValueOnce(db);
    const res = await request(app(trader).app)
      .post('/api/users/invite')
      .send({ email: 'new.person@example.com', name: 'New Person', role: 'advisor' });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/nightly reset/);
    expect(db.query.mock.calls.map(([sql]) => sql)).not.toContainEqual(expect.stringContaining('INSERT'));
    expect(db.release).toHaveBeenCalled();
  });

  it('refuses anyone who is not a persona, such as a user a visitor invited', async () => {
    const res = await request(app().app).post('/auth/persona').send({ email: 'visitor@example.com' }).expect(403);
    expect(res.body.error).toMatch(/not one of the demo personas/);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('is not there when persona sign-in is off', async () => {
    delete process.env.PERSONA_SIGN_IN;
    await request(app().app).post('/auth/persona').send({ email: RACHEL.email }).expect(404);
    const res = await request(app().app).get('/auth/sign-in-options').expect(200);
    expect(res.body.personas).toEqual([]);
  });

  it('keeps persona accounts from being changed', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ email: RACHEL.email }] });
    const res = await request(app(trader).app).patch(`/api/users/${RACHEL.id}/deactivate`).send({}).expect(403);
    expect(res.body.error).toMatch(/Demo personas/);
  });

  it('keeps a persona fenced whatever the spelling of its id', async () => {
    for (const spelling of [RACHEL.id.toUpperCase(), RACHEL.id.replace('11111111', '11111111').toUpperCase()]) {
      mockPool.query.mockReset();
      mockPool.query.mockResolvedValueOnce({ rows: [{ email: RACHEL.email }] });
      await request(app(trader).app).patch(`/api/users/${spelling}/deactivate`).send({}).expect(403);
      // The fence compares as UUIDs, as the route's own UPDATE does.
      expect(mockPool.query.mock.calls[0][0]).toMatch(/id = \$1::uuid/);
    }
  });

  it('refuses an id that is not a UUID before touching the database', async () => {
    for (const bad of ['{11111111-1111-4111-8111-111111111111}', '11111111111141118111111111111111', 'abc']) {
      await request(app(trader).app).patch(`/api/users/${encodeURIComponent(bad)}/deactivate`).send({}).expect(400);
    }
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('still lets a trader change a user who is not a persona', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ email: 'invited@example.com' }] });
    const res = await request(app(trader).app).patch('/api/users/33333333-3333-4333-8333-333333333333/role').send({ role: 'nope' });
    // Past the persona fence: the route's own validation answers.
    expect(res.status).toBe(400);
  });

  it('finishes an MCP connection: issues the code for the chosen persona and returns the client redirect', async () => {
    store.consumePendingAuth.mockResolvedValueOnce({
      clientId: 'client-1', redirectUri: 'http://127.0.0.1:5555/callback', codeChallenge: 'ch', resource: 'https://trade.test/mcp',
      scope: 'mcp', mcpState: 'client-state',
    });
    store.issueAuthorizationCode.mockResolvedValueOnce('auth-code');
    mockPool.query.mockResolvedValueOnce({ rows: [RACHEL] }).mockResolvedValueOnce({ rows: [] });
    const res = await request(app().app).post('/auth/persona').send({ email: RACHEL.email, mcpState: 'pending-1' }).expect(200);
    expect(store.consumePendingAuth).toHaveBeenCalledWith('pending-1');
    expect(store.issueAuthorizationCode).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'client-1', userId: RACHEL.id }));
    expect(res.body.redirect).toBe('http://127.0.0.1:5555/callback?code=auth-code&state=client-state');
  });

  it('refuses an expired MCP connection request, after confirming the persona exists', async () => {
    store.consumePendingAuth.mockResolvedValueOnce(null);
    mockPool.query.mockResolvedValueOnce({ rows: [RACHEL] });
    const res = await request(app().app).post('/auth/persona').send({ email: RACHEL.email, mcpState: 'old' }).expect(400);
    expect(res.body.error).toMatch(/expired/);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // the lookup; no sign-in recorded
  });

  it('keeps an MCP connection request when the persona is unavailable', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(app().app).post('/auth/persona').send({ email: RACHEL.email, mcpState: 'still-good' }).expect(404);
    expect(store.consumePendingAuth).not.toHaveBeenCalledWith('still-good');
  });

  it("sends an MCP client's authorization request to the persona picker instead of Google", async () => {
    process.env.CLIENT_ORIGIN = 'https://trade.test';
    const provider = new TradeRequestOAuthProvider({ resourceUrl: 'https://trade.test/mcp', googleCallbackUrl: 'https://trade.test/oauth/google/callback' } as never);
    const redirect = vi.fn();
    await provider.authorize(
      { client_id: 'client-1', redirect_uris: ['http://127.0.0.1:5555/callback'] } as never,
      { resource: new URL('https://trade.test/mcp'), redirectUri: 'http://127.0.0.1:5555/callback', codeChallenge: 'ch', state: 's', scopes: [] } as never,
      { redirect } as never,
    );
    expect(store.insertPendingAuth).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'client-1', mcpState: 's' }));
    const state = store.insertPendingAuth.mock.calls[0][0].state as string;
    expect(redirect).toHaveBeenCalledWith(302, `https://trade.test/login?mcp=${encodeURIComponent(state)}`);
    delete process.env.CLIENT_ORIGIN;
  });
});
