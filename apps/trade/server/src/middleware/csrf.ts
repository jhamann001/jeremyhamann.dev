import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { sendError } from './errorHandler.js';

const CSRF_COOKIE = 'csrf-token';
const CSRF_HEADER = 'x-csrf-token';
const TOKEN_LENGTH = 32;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function generateToken(): string {
  return randomBytes(TOKEN_LENGTH).toString('hex');
}

/**
 * Session-bound CSRF protection (with double-submit cookie fallback for
 * unauthenticated requests). For authenticated users the authoritative token
 * lives in `req.session.csrfToken`; the JS-readable cookie is only a delivery
 * mechanism so the client can echo it back in the X-CSRF-Token header.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  let token: string;

  if (req.isAuthenticated?.() && req.session) {
    if (!req.session.csrfToken) {
      req.session.csrfToken = generateToken();
    }
    token = req.session.csrfToken;
  } else {
    token = req.cookies?.[CSRF_COOKIE] || generateToken();
  }

  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'strict',
    path: '/',
  });

  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const headerToken = req.headers[CSRF_HEADER] as string | undefined;
  if (!headerToken || headerToken !== token) {
    sendError(res, 403, 'Invalid or missing CSRF token');
    return;
  }

  next();
}
