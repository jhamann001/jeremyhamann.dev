import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import logger from '../lib/logger.js';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public userMessage?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function sendError(res: Response, status: number, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error: message, requestId: (res.req as Request)?.requestId, ...extra });
}

const isProd = process.env.NODE_ENV === 'production';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId;

  if (err instanceof z.ZodError) {
    logger.warn({ err, requestId }, 'Validation error');
    const details = isProd ? err.issues.map((e) => ({ path: e.path, message: e.message })) : err.issues;
    sendError(res, 400, 'Validation failed', { details });
    return;
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, requestId }, 'Request error');
      sendError(res, err.statusCode, err.userMessage ?? 'Internal server error');
    } else {
      logger.warn({ err, requestId }, 'Request error');
      sendError(res, err.statusCode, err.userMessage ?? err.message);
    }
    return;
  }

  const statusCode =
    (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    logger.warn({ err, requestId }, 'Request error');
    sendError(res, statusCode, isProd ? 'Bad request' : err.message || 'Bad request');
    return;
  }

  logger.error({ err, requestId }, 'Request error');
  sendError(res, 500, 'Internal server error');
}
