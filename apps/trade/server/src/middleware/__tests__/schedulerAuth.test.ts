import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const { jwtVerifyMock, createRemoteJWKSetMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
  createRemoteJWKSetMock: vi.fn(() => () => ({})),
}));

vi.mock('jose', () => ({
  jwtVerify: jwtVerifyMock,
  createRemoteJWKSet: createRemoteJWKSetMock,
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createReqRes(authHeader?: string) {
  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
    requestId: 'req-1',
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    req,
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

const VALID_EMAIL = 'trade-request-scheduler@project.iam.gserviceaccount.com';
const VALID_AUDIENCE = 'https://trade-request-xxxx-uc.a.run.app';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SCHEDULER_SERVICE_ACCOUNT_EMAIL = VALID_EMAIL;
  process.env.SCHEDULER_AUDIENCE = VALID_AUDIENCE;
});

afterEach(() => {
  delete process.env.SCHEDULER_SERVICE_ACCOUNT_EMAIL;
  delete process.env.SCHEDULER_AUDIENCE;
});

describe('requireSchedulerAuth', () => {
  it('returns 503 when env vars are missing', async () => {
    delete process.env.SCHEDULER_SERVICE_ACCOUNT_EMAIL;
    const { requireSchedulerAuth } = await import('../schedulerAuth.js');
    const { req, res, next } = createReqRes('Bearer x');
    await requireSchedulerAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const { requireSchedulerAuth } = await import('../schedulerAuth.js');
    const { req, res, next } = createReqRes();
    await requireSchedulerAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the header is not a Bearer token', async () => {
    const { requireSchedulerAuth } = await import('../schedulerAuth.js');
    const { req, res, next } = createReqRes('Basic abc');
    await requireSchedulerAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() on a valid token', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        iss: 'https://accounts.google.com',
        aud: VALID_AUDIENCE,
        email: VALID_EMAIL,
        email_verified: true,
      },
    });
    const { requireSchedulerAuth } = await import('../schedulerAuth.js');
    const { req, res, next } = createReqRes('Bearer fake.jwt.token');
    await requireSchedulerAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(jwtVerifyMock).toHaveBeenCalledWith(
      'fake.jwt.token',
      expect.anything(),
      expect.objectContaining({ audience: VALID_AUDIENCE }),
    );
  });

  it('rejects a token with the wrong issuer', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        iss: 'https://evil.example.com',
        aud: VALID_AUDIENCE,
        email: VALID_EMAIL,
        email_verified: true,
      },
    });
    const { requireSchedulerAuth } = await import('../schedulerAuth.js');
    const { req, res, next } = createReqRes('Bearer t');
    await requireSchedulerAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token with the wrong email', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        iss: 'https://accounts.google.com',
        aud: VALID_AUDIENCE,
        email: 'attacker@project.iam.gserviceaccount.com',
        email_verified: true,
      },
    });
    const { requireSchedulerAuth } = await import('../schedulerAuth.js');
    const { req, res, next } = createReqRes('Bearer t');
    await requireSchedulerAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token where email_verified is false', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        iss: 'https://accounts.google.com',
        aud: VALID_AUDIENCE,
        email: VALID_EMAIL,
        email_verified: false,
      },
    });
    const { requireSchedulerAuth } = await import('../schedulerAuth.js');
    const { req, res, next } = createReqRes('Bearer t');
    await requireSchedulerAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects when jwtVerify throws (expired, bad signature, wrong audience)', async () => {
    jwtVerifyMock.mockRejectedValueOnce(new Error('token expired'));
    const { requireSchedulerAuth } = await import('../schedulerAuth.js');
    const { req, res, next } = createReqRes('Bearer t');
    await requireSchedulerAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
