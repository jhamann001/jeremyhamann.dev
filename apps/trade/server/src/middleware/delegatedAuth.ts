import type { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { isOpsPortalRole, mapOpsPortalRole } from '@trade-request/shared';
import logger from '../lib/logger.js';
import { sendError } from './errorHandler.js';
import { ALLOWED_DOMAINS } from './auth.js';
import { resolveDelegatedActor } from '../services/delegatedActor.js';

// Delegated surface (/api/ops-portal) for the advisor platform. Every call carries two
// identities:
//   1. Authorization: Bearer <Google OIDC ID token> for OPS_PORTAL's runtime service
//      account (application identity), verified like requireMachineAuth.
//   2. X-OPS-PORTAL-Actor-Assertion: <JWT> minted by the advisor platform for this call and signed by
//      the SAME service account through IAM signJwt (person identity): sub is
//      the person's verified company email, ops_portal_role their current advisor platform role.
// The assertion is verified against Google's published keys for that service
// account and its issuer must equal the application token's email, so no other
// caller can use it; sub is signed, so it cannot be re-pointed at another
// person; exp bounds its validity.
//
// Default-off: with OPS_PORTAL_DELEGATED_AUDIENCE or OPS_PORTAL_DELEGATED_CALLER_SA unset,
// every call is refused with 503 before any query.

const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const SERVICE_ACCOUNT_JWKS_BASE = 'https://www.googleapis.com/service_accounts/v1/jwk/';
export const ACTOR_ASSERTION_HEADER = 'x-ops-portal-actor-assertion';
export const LOCAL_CALLER = 'ops-portal-local@delegated.invalid';
const MAX_ASSERTION_LIFETIME_S = 300;
const CLOCK_TOLERANCE_S = 30;

const googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI));
const serviceAccountJwks = new Map<string, JWTVerifyGetKey>();

function serviceAccountKeys(email: string): JWTVerifyGetKey {
  let keys = serviceAccountJwks.get(email);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(SERVICE_ACCOUNT_JWKS_BASE + encodeURIComponent(email)));
    serviceAccountJwks.set(email, keys);
  }
  return keys;
}

function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Local/test mode: HS256 with a shared key, never in production. */
function localKey(): Uint8Array | null {
  const key = process.env.OPS_PORTAL_DELEGATED_LOCAL_KEY;
  if (process.env.NODE_ENV === 'production' || !key) return null;
  return new TextEncoder().encode(key);
}

type RefusalCode =
  | 'delegated_not_configured'
  | 'caller_unauthenticated'
  | 'caller_not_permitted'
  | 'person_unconfirmed'
  | 'role_unconfirmed'
  | 'role_not_permitted';

const REFUSAL_MESSAGES: Record<RefusalCode, string> = {
  delegated_not_configured: 'Delegated access is not configured',
  caller_unauthenticated: 'Invalid caller token',
  caller_not_permitted: 'Caller is not permitted',
  person_unconfirmed: 'The person could not be confirmed',
  role_unconfirmed: 'The role could not be confirmed',
  role_not_permitted: 'Role has no Trade Request access',
};

const REFUSAL_STATUS: Record<RefusalCode, number> = {
  delegated_not_configured: 503,
  caller_unauthenticated: 401,
  caller_not_permitted: 403,
  person_unconfirmed: 401,
  role_unconfirmed: 401,
  role_not_permitted: 403,
};

function refuse(req: Request, res: Response, code: RefusalCode): void {
  // Static reason code only: never the email, name, role or any token content.
  logger.warn({ requestId: req.requestId, reason: code }, 'Delegated call refused');
  sendError(res, REFUSAL_STATUS[code], REFUSAL_MESSAGES[code], { code });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function emailDomainAllowed(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  return ALLOWED_DOMAINS.includes(email.slice(at + 1).toLowerCase());
}

export async function requireDelegatedCaller(req: Request, res: Response, next: NextFunction): Promise<void> {
  const audience = process.env.OPS_PORTAL_DELEGATED_AUDIENCE;
  const allowed = parseAllowlist(process.env.OPS_PORTAL_DELEGATED_CALLER_SA);
  if (!audience || allowed.size === 0) {
    refuse(req, res, 'delegated_not_configured');
    return;
  }

  const local = localKey();

  // ── 1. Application identity ──────────────────────────────────────────────
  const token = bearerToken(req);
  if (!token) {
    refuse(req, res, 'caller_unauthenticated');
    return;
  }

  let caller: JWTPayload;
  try {
    ({ payload: caller } = local
      ? await jwtVerify(token, local, { audience, issuer: LOCAL_CALLER, algorithms: ['HS256'] })
      : await jwtVerify(token, googleJwks, { audience, issuer: GOOGLE_ISSUERS, algorithms: ['RS256'] }));
  } catch {
    refuse(req, res, 'caller_unauthenticated');
    return;
  }

  const callerEmail = typeof caller.email === 'string' ? caller.email.toLowerCase() : '';
  if ((!local && caller.email_verified !== true) || !callerEmail || !allowed.has(callerEmail)) {
    refuse(req, res, 'caller_not_permitted');
    return;
  }

  // ── 2. Person identity ───────────────────────────────────────────────────
  const assertion = req.headers[ACTOR_ASSERTION_HEADER];
  if (typeof assertion !== 'string' || !assertion.trim()) {
    refuse(req, res, 'person_unconfirmed');
    return;
  }

  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(assertion.trim(), local ?? serviceAccountKeys(callerEmail), {
      audience,
      issuer: local ? LOCAL_CALLER : callerEmail,
      algorithms: local ? ['HS256'] : ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_S,
      maxTokenAge: `${MAX_ASSERTION_LIFETIME_S}s`,
    }));
  } catch {
    refuse(req, res, 'person_unconfirmed');
    return;
  }

  if (
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number' ||
    claims.exp - claims.iat > MAX_ASSERTION_LIFETIME_S
  ) {
    refuse(req, res, 'person_unconfirmed');
    return;
  }

  const email = typeof claims.sub === 'string' ? claims.sub.trim().toLowerCase() : '';
  const name = typeof claims.name === 'string' ? claims.name.trim() : '';
  if (!email || !emailDomainAllowed(email) || !name || name.length > 255) {
    refuse(req, res, 'person_unconfirmed');
    return;
  }

  // ── 3. Role and authority (owner ruling D1) ──────────────────────────────
  if (!isOpsPortalRole(claims.ops_portal_role)) {
    refuse(req, res, 'role_unconfirmed');
    return;
  }
  const role = mapOpsPortalRole(claims.ops_portal_role);
  if (!role) {
    refuse(req, res, 'role_not_permitted');
    return;
  }

  try {
    req.user = await resolveDelegatedActor(email, name, role);
  } catch (err) {
    next(err);
    return;
  }
  req.authChannel = 'opsPortal';
  req.isDemo = false;
  next();
}
