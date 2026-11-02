import type { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger.js';
import { readServiceState, type ServiceMode } from '../services/serviceMode.js';
import { sendError } from './errorHandler.js';

export const FROZEN_MESSAGE =
  'Trade Requests is briefly read-only while it is being moved — try again in a few minutes.';
export const MCP_ONLY_MESSAGE =
  'Trade Requests has moved to the advisor platform. Only MCP and Connected Apps remain on this site.';
export const MODE_UNAVAILABLE_MESSAGE = 'Trade Requests is temporarily unavailable — try again in a few minutes.';

export type GuardDecision = 'allow' | 'frozen' | 'mcp-only';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reachable in every mode. Scheduler jobs make themselves inert (routes/internal.ts); the machine
 * surface carries the mode controls; MCP, its OAuth sign-in and discovery documents keep MCP running,
 * and MCP's own sign-in records stay writable.
 */
const ALWAYS_PREFIXES = [
  '/api/internal',
  '/api/machine',
  '/api/service-mode',
  '/mcp',
  '/.well-known',
  '/register',
  '/authorize',
  '/token',
  '/revoke',
  '/oauth/google/callback',
];

/** Connected Apps: MCP sessions and tokens live in MCP's own tables, which never move. */
const CONNECTED_APPS_PREFIXES = ['/api/me/mcp-sessions', '/api/me/mcp-tokens', '/api/client-errors'];

/** Standalone sign-in and session upkeep (no Trade Request record changes). */
const SIGN_IN_PATHS = new Set([
  '/auth/google',
  '/auth/google/callback',
  '/auth/dev-login',
  '/auth/sign-in-options',
  '/auth/persona',
  '/auth/me',
  '/auth/config',
  '/auth/logout',
  '/auth/extend-session',
]);

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** Express routes ignore letter case and a trailing slash, so the decision does too. */
const normalize = (path: string) => path.toLowerCase().replace(/\/+$/, '') || '/';

/** The decision for one request in one mode. Anything not listed is refused (deny by default). */
export function serviceModeDecision(mode: ServiceMode, method: string, rawPath: string): GuardDecision {
  if (mode === 'active') return 'allow';
  const path = normalize(rawPath);
  if (ALWAYS_PREFIXES.some((p) => under(path, p))) return 'allow';
  if (CONNECTED_APPS_PREFIXES.some((p) => under(path, p))) return 'allow';
  if (SIGN_IN_PATHS.has(path)) return 'allow';
  const safe = SAFE_METHODS.has(method.toUpperCase());
  if (mode === 'frozen') return safe || path === '/auth/demo' ? 'allow' : 'frozen';
  // MCP-only: the static client loads (it then shows only Connected Apps); every API and screen action is refused.
  return safe && !under(path, '/api') && !under(path, '/auth') ? 'allow' : 'mcp-only';
}

/** GET /api/service-mode: the effective mode only, for the static client's banner and MCP-only view. */
export async function serviceModeRoute(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { mode } = await readServiceState();
    res.set('Cache-Control', 'no-store');
    res.json({ mode });
  } catch (err) {
    next(err);
  }
}

/**
 * Mounted in index.ts before every route except health. Reads the mode for each request that some
 * non-active mode would refuse; a request every mode allows never touches the database.
 */
export async function serviceModeGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (
    serviceModeDecision('frozen', req.method, req.path) === 'allow' &&
    serviceModeDecision('mcp-only', req.method, req.path) === 'allow'
  ) {
    next();
    return;
  }
  let mode: ServiceMode;
  try {
    mode = (await readServiceState()).mode;
  } catch (err) {
    logger.error(
      {
        event: 'service_mode_read_failed',
        requestId: req.requestId,
        message: err instanceof Error ? err.message : String(err),
      },
      'service mode read failed; request refused',
    );
    sendError(res, 503, MODE_UNAVAILABLE_MESSAGE, { code: 'service_mode_unavailable' });
    return;
  }
  const decision = serviceModeDecision(mode, req.method, req.path);
  if (decision === 'allow') {
    next();
    return;
  }
  logger.info({ event: 'service_mode_refused', requestId: req.requestId, mode, method: req.method }, 'request refused');
  if (decision === 'frozen') sendError(res, 423, FROZEN_MESSAGE, { code: 'service_frozen' });
  else sendError(res, 403, MCP_ONLY_MESSAGE, { code: 'service_mcp_only' });
}
