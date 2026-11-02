import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '@trade-request/shared';

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.SESSION_SECRET = 'test-session-secret';
});

vi.mock('../../db/pool.js', () => ({
  default: { query: vi.fn(), connect: vi.fn(), end: vi.fn(), on: vi.fn() },
}));

const { requireAuth, requireRole } = await import('../auth.js');

function makeMocks(user?: AuthUser, authenticated = !!user) {
  const req = {
    isAuthenticated: vi.fn().mockReturnValue(authenticated),
    user: user ?? undefined,
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

const traderUser: AuthUser = {
  id: 'u1',
  googleId: 'g1',
  email: 'trader@example.com',
  name: 'Trader',
  picture: null,
  role: 'trader',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: null,
  createdAt: new Date().toISOString(),
};

const advisorUser: AuthUser = {
  ...traderUser,
  id: 'u2',
  role: 'advisor',
  email: 'advisor@example.com',
  name: 'Advisor',
};

describe('requireAuth', () => {
  it('calls next for authenticated users', () => {
    const { req, res, next } = makeMocks(traderUser);
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 for unauthenticated requests', () => {
    const { req, res, next } = makeMocks();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireRole', () => {
  it('calls next when user has required role', () => {
    const { req, res, next } = makeMocks(traderUser);
    requireRole('trader')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when user lacks required role', () => {
    const { req, res, next } = makeMocks(advisorUser);
    requireRole('trader')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Insufficient permissions' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when not authenticated', () => {
    const { req, res, next } = makeMocks();
    requireRole('trader')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('allows multiple roles', () => {
    const { req, res, next } = makeMocks(advisorUser);
    requireRole('trader', 'advisor')(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

// The advisor platform delegated branch (TRW-01): only requireDelegatedCaller sets
// authChannel = 'opsPortal', and only together with req.user.
describe('requireAuth / requireRole — the advisor platform delegated channel', () => {
  function delegated(user: AuthUser | undefined) {
    const mocks = makeMocks(user, false);
    (mocks.req as Request & { authChannel?: string }).authChannel = 'opsPortal';
    return mocks;
  }

  it('admits a delegated caller without a passport session', () => {
    const { req, res, next } = delegated(advisorUser);
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('refuses the delegated channel marker without a user', () => {
    const { req, res, next } = delegated(undefined);
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();

    const role = delegated(undefined);
    requireRole('trader')(role.req, role.res, role.next);
    expect(role.res.status).toHaveBeenCalledWith(401);
    expect(role.next).not.toHaveBeenCalled();
  });

  it('applies the mapped role: a delegated advisor is refused a trader-only action', () => {
    const { req, res, next } = delegated(advisorUser);
    requireRole('trader')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('admits a delegated trader to a trader-only action', () => {
    const { req, res, next } = delegated(traderUser);
    requireRole('trader')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('leaves session behavior unchanged: a user object without a session or channel is refused', () => {
    const { req, res, next } = makeMocks(traderUser, false);
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    const role = makeMocks(traderUser, false);
    requireRole('trader')(role.req, role.res, role.next);
    expect(role.res.status).toHaveBeenCalledWith(401);
  });
});
