import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError, errorHandler } from '../errorHandler.js';

function makeMocks(requestId?: string) {
  const req = { requestId } as unknown as Request;
  const res = {
    req,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe('errorHandler', () => {
  it('returns correct status for AppError', () => {
    const { req, res, next } = makeMocks('req-123');
    errorHandler(new AppError(404, 'Not found'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not found', requestId: 'req-123' });
  });

  it('returns 400 for ZodError', () => {
    const { req, res, next } = makeMocks();
    const schema = z.object({ name: z.string() });
    let zodErr: z.ZodError;
    try {
      schema.parse({ name: 123 });
    } catch (e) {
      zodErr = e as z.ZodError;
    }
    errorHandler(zodErr!, req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Validation failed', details: expect.any(Array) }),
    );
  });

  it('returns 500 for generic errors', () => {
    const { req, res, next } = makeMocks('req-456');
    errorHandler(new Error('something broke'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error', requestId: 'req-456' });
  });

  it('returns 409 for AppError with conflict status', () => {
    const { req, res, next } = makeMocks();
    errorHandler(new AppError(409, 'Already exists'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Already exists' }));
  });

  it('includes requestId when available', () => {
    const { req, res, next } = makeMocks('test-request-id');
    errorHandler(new AppError(400, 'Bad'), req, res, next);
    expect(res.json).toHaveBeenCalledWith({ error: 'Bad', requestId: 'test-request-id' });
  });

  it('returns generic message for 5xx AppError without userMessage', () => {
    const { req, res, next } = makeMocks('req-500');
    errorHandler(new AppError(502, 'Upstream timeout'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error', requestId: 'req-500' });
  });

  it('returns userMessage for 5xx AppError when explicitly set', () => {
    const { req, res, next } = makeMocks('req-502');
    errorHandler(new AppError(502, 'Upstream timeout', 'Account data source timed out'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: 'Account data source timed out', requestId: 'req-502' });
  });
});
