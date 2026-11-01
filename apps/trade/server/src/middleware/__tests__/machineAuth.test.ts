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

const ALLOWED_SA = 'ops-portal-run@ops-portal.iam.gserviceaccount.com';
const VALID_AUDIENCE = 'https://trade-request-xxxx-uc.a.run.app';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MACHINE_AUDIENCE = VALID_AUDIENCE;
  // Include a second SA + mixed case to exercise the allowlist parser.
  process.env.ALLOWED_MACHINE_SA = `Other-SA@project.iam.gserviceaccount.com, ${ALLOWED_SA}`;
});

afterEach(() => {
  delete process.env.MACHINE_AUDIENCE;
  delete process.env.ALLOWED_MACHINE_SA;
});

describe('requireMachineAuth', () => {
  it('returns 503 when MACHINE_AUDIENCE is missing', async () => {
    delete process.env.MACHINE_AUDIENCE;
    const { requireMachineAuth } = await import('../machineAuth.js');
    const { req, res, next } = createReqRes('Bearer x');
    await requireMachineAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 503 when ALLOWED_MACHINE_SA is empty', async () => {
    process.env.ALLOWED_MACHINE_SA = '   ';
    const { requireMachineAuth } = await import('../machineAuth.js');
    const { req, res, next } = createReqRes('Bearer x');
    await requireMachineAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const { requireMachineAuth } = await import('../machineAuth.js');
    const { req, res, next } = createReqRes();
    await requireMachineAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the header is not a Bearer token', async () => {
    const { requireMachineAuth } = await import('../machineAuth.js');
    const { req, res, next } = createReqRes('Basic abc');
    await requireMachineAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() on a valid, allowlisted token and passes the audience to jwtVerify', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        iss: 'https://accounts.google.com',
        aud: VALID_AUDIENCE,
        email: ALLOWED_SA,
        email_verified: true,
      },
    });
    const { requireMachineAuth } = await import('../machineAuth.js');
    const { req, res, next } = createReqRes('Bearer fake.jwt.token');
    await requireMachineAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(jwtVerifyMock).toHaveBeenCalledWith(
      'fake.jwt.token',
      expect.anything(),
      expect.objectContaining({ audience: VALID_AUDIENCE }),
    );
  });

  it('returns 401 when jwtVerify throws (expired / bad sig / wrong audience)', async () => {
    jwtVerifyMock.mockRejectedValueOnce(new Error('token expired'));
    const { requireMachineAuth } = await import('../machineAuth.js');
    const { req, res, next } = createReqRes('Bearer t');
    await requireMachineAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for a token with the wrong issuer', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        iss: 'https://evil.example.com',
        aud: VALID_AUDIENCE,
        email: ALLOWED_SA,
        email_verified: true,
      },
    });
    const { requireMachineAuth } = await import('../machineAuth.js');
    const { req, res, next } = createReqRes('Bearer t');
    await requireMachineAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the principal email is not on the allowlist', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        iss: 'https://accounts.google.com',
        aud: VALID_AUDIENCE,
        email: 'attacker@project.iam.gserviceaccount.com',
        email_verified: true,
      },
    });
    const { requireMachineAuth } = await import('../machineAuth.js');
    const { req, res, next } = createReqRes('Bearer t');
    await requireMachineAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the email claim is absent', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        iss: 'https://accounts.google.com',
        aud: VALID_AUDIENCE,
        email_verified: true,
      },
    });
    const { requireMachineAuth } = await import('../machineAuth.js');
    const { req, res, next } = createReqRes('Bearer t');
    await requireMachineAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when email_verified is false', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        iss: 'https://accounts.google.com',
        aud: VALID_AUDIENCE,
        email: ALLOWED_SA,
        email_verified: false,
      },
    });
    const { requireMachineAuth } = await import('../machineAuth.js');
    const { req, res, next } = createReqRes('Bearer t');
    await requireMachineAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts an allowlisted email in a different case (case-insensitive match)', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        iss: 'accounts.google.com',
        aud: VALID_AUDIENCE,
        email: ALLOWED_SA.toUpperCase(),
        email_verified: true,
      },
    });
    const { requireMachineAuth } = await import('../machineAuth.js');
    const { req, res, next } = createReqRes('Bearer t');
    await requireMachineAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
