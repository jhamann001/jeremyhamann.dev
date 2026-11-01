import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { csrfProtection } from '../csrf.js';

function createMockReqRes(method: string, cookieToken?: string, headerToken?: string) {
  const req = {
    method,
    cookies: cookieToken ? { 'csrf-token': cookieToken } : {},
    headers: headerToken ? { 'x-csrf-token': headerToken } : {},
  } as unknown as Request;

  const res = {
    cookie: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

describe('csrfProtection', () => {
  it('allows GET requests without a token', () => {
    const { req, res, next } = createMockReqRes('GET');
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('sets a csrf cookie if none exists on GET', () => {
    const { req, res, next } = createMockReqRes('GET');
    csrfProtection(req, res, next);
    expect(res.cookie).toHaveBeenCalledWith('csrf-token', expect.any(String), expect.any(Object));
    expect(next).toHaveBeenCalled();
  });

  it('rejects POST with no csrf header', () => {
    const { req, res, next } = createMockReqRes('POST', 'valid-token');
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects POST with mismatched csrf header', () => {
    const { req, res, next } = createMockReqRes('POST', 'valid-token', 'wrong-token');
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows POST with matching csrf header', () => {
    const token = 'matching-token';
    const { req, res, next } = createMockReqRes('POST', token, token);
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows HEAD requests without a token', () => {
    const { req, res, next } = createMockReqRes('HEAD');
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects DELETE with no csrf header', () => {
    const { req, res, next } = createMockReqRes('DELETE', 'token');
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
