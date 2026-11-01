import type { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import logger from '../lib/logger.js';
import { sendError } from './errorHandler.js';

// Google's OIDC discovery document lists this as the JWKS URI. The public keys
// rotate periodically; createRemoteJWKSet caches them and refetches on miss.
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const ALLOWED_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI));

interface SchedulerClaims {
  email?: string;
  email_verified?: boolean;
}

/**
 * Verifies the OIDC ID token that Cloud Scheduler attaches to outgoing HTTP
 * requests. The token is a Google-signed JWT with:
 *   - iss = https://accounts.google.com
 *   - aud = SCHEDULER_AUDIENCE   (the Cloud Run service URL we configure)
 *   - email = SCHEDULER_SERVICE_ACCOUNT_EMAIL (a dedicated service account)
 *   - email_verified = true
 *
 * Because our Cloud Run service is deployed with --allow-unauthenticated
 * (public routing, with per-route auth handled in-app), this middleware is the
 * only thing protecting /api/internal/digest/daily from being invoked by
 * unauthenticated callers.
 */
export async function requireSchedulerAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const expectedEmail = process.env.SCHEDULER_SERVICE_ACCOUNT_EMAIL;
  const expectedAudience = process.env.SCHEDULER_AUDIENCE;

  if (!expectedEmail || !expectedAudience) {
    logger.error(
      { requestId: req.requestId },
      'Scheduler auth called without SCHEDULER_SERVICE_ACCOUNT_EMAIL / SCHEDULER_AUDIENCE configured',
    );
    sendError(res, 503, 'Scheduler endpoint is not configured');
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    sendError(res, 401, 'Missing bearer token');
    return;
  }
  const token = header.slice(7).trim();
  if (!token) {
    sendError(res, 401, 'Missing bearer token');
    return;
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience: expectedAudience,
    });

    if (typeof payload.iss !== 'string' || !ALLOWED_ISSUERS.has(payload.iss)) {
      logger.warn({ iss: payload.iss, requestId: req.requestId }, 'Scheduler token rejected: bad issuer');
      sendError(res, 401, 'Invalid token');
      return;
    }

    const claims = payload as SchedulerClaims;
    if (claims.email !== expectedEmail) {
      logger.warn({ email: claims.email, requestId: req.requestId }, 'Scheduler token rejected: email mismatch');
      sendError(res, 401, 'Invalid token');
      return;
    }
    if (claims.email_verified !== true) {
      logger.warn({ requestId: req.requestId }, 'Scheduler token rejected: email not verified');
      sendError(res, 401, 'Invalid token');
      return;
    }

    next();
  } catch (err) {
    logger.warn({ err, requestId: req.requestId }, 'Scheduler token verification failed');
    sendError(res, 401, 'Invalid token');
  }
}
