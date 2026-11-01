import type { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import logger from '../lib/logger.js';
import { sendError } from './errorHandler.js';

// Google's OIDC discovery document lists this as the JWKS URI. The public keys
// rotate periodically; createRemoteJWKSet caches them and refetches on miss.
// Mirrors the requireSchedulerAuth precedent (see schedulerAuth.ts).
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const ALLOWED_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI));

interface MachineClaims {
  email?: string;
  email_verified?: boolean;
}

/** Parse a comma-separated service-account allowlist into a lowercased Set. */
function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Verifies the OIDC ID token that a machine caller (e.g. OPS_PORTAL's `ops-portal-run@`
 * service account) attaches to requests against the /api/machine surface. The
 * token is a Google-signed JWT with:
 *   - iss = https://accounts.google.com
 *   - aud = MACHINE_AUDIENCE      (this Cloud Run service's own base URL)
 *   - email = one of ALLOWED_MACHINE_SA (comma-separated service-account allowlist)
 *   - email_verified = true
 *
 * This mirrors requireSchedulerAuth exactly, with two differences:
 *   1. The accepted principal is an allowlist (multiple SAs), not a single email.
 *   2. Status-code split: token/transport/audience/issuer failures → 401;
 *      principal failures (email off allowlist, email_verified !== true) → 403.
 *
 * Because our Cloud Run service is deployed with --allow-unauthenticated
 * (public routing, per-route auth handled in-app), this middleware is the only
 * thing protecting /api/machine from unauthenticated callers. When the env is
 * unset it short-circuits with 503 (the intended default-off state).
 */
export async function requireMachineAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const expectedAudience = process.env.MACHINE_AUDIENCE;
  const allowed = parseAllowlist(process.env.ALLOWED_MACHINE_SA);

  if (!expectedAudience || allowed.size === 0) {
    logger.error(
      { requestId: req.requestId },
      'Machine auth called without MACHINE_AUDIENCE / ALLOWED_MACHINE_SA configured',
    );
    sendError(res, 503, 'Machine endpoint is not configured');
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

  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      audience: expectedAudience,
      // Google ID tokens are RS256; pin it (belt-and-suspenders — jose already
      // rejects alg:none / key-confusion against an asymmetric remote JWKS).
      algorithms: ['RS256'],
    }));
  } catch (err) {
    // Covers bad signature, expired token, and wrong audience.
    logger.warn({ err, requestId: req.requestId }, 'Machine token verification failed');
    sendError(res, 401, 'Invalid token');
    return;
  }

  if (typeof payload.iss !== 'string' || !ALLOWED_ISSUERS.has(payload.iss)) {
    logger.warn({ iss: payload.iss, requestId: req.requestId }, 'Machine token rejected: bad issuer');
    sendError(res, 401, 'Invalid token');
    return;
  }

  const claims = payload as MachineClaims;
  const email = claims.email?.toLowerCase();
  if (claims.email_verified !== true) {
    logger.warn({ requestId: req.requestId }, 'Machine token rejected: email not verified');
    sendError(res, 403, 'Forbidden');
    return;
  }
  if (!email || !allowed.has(email)) {
    // Never log the email itself (PII discipline).
    logger.warn({ requestId: req.requestId }, 'Machine token rejected: principal not on allowlist');
    sendError(res, 403, 'Forbidden');
    return;
  }

  req.machineCaller = email;
  next();
}
