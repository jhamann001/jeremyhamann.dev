import { Router, type Request, type Response, type NextFunction } from 'express';
import { sendError } from '../middleware/errorHandler.js';
import clientRoutes from './clients.js';
import clientExclusionRoutes from './exclusions.js';
import householdRoutes from './households.js';
import notificationRoutes from './notifications.js';
import requestRoutes from './requests.js';

// Delegated surface for Ops Portal, mounted at /api/ops-portal behind
// requireDelegatedCaller. It re-mounts the existing route modules so every
// business rule, guard and safeguard applies exactly as for the standalone app,
// with req.user set to the confirmed person and the role mapped from their
// current Ops Portal role.
//
// Only the operations the Ops Portal Trade Requests workspace uses are reachable: the
// allowlist below names each method and path. Anything else — including the
// asset location engine and its pre-fill holdings reads (owner ruling D4), and
// any route added to these modules later — is 404 until it is listed here.

const SEGMENT = '[^/]+';

// Express matches paths case-insensitively and tolerates a trailing slash, so
// the allowlist does too.
const ALLOWED: ReadonlyArray<readonly [method: string, path: string]> = [
  ['GET', '/requests'],
  ['GET', '/requests/counts'],
  ['GET', `/requests/last-allocation/${SEGMENT}`],
  ['GET', `/requests/${SEGMENT}`],
  ['POST', '/requests'],
  ['PUT', `/requests/${SEGMENT}`],
  ['GET', `/requests/${SEGMENT}/checklist`],
  ['PUT', `/requests/${SEGMENT}/checklist`],
  ['PUT', `/requests/${SEGMENT}/status`],
  ['GET', '/notifications'],
  ['PATCH', `/notifications/${SEGMENT}/read`],
  ['POST', '/notifications/read-all'],
  ['GET', '/clients'],
  ['GET', '/clients/exclusions/export'],
  ['POST', '/clients/exclusions/bulk'],
  ['POST', '/clients/account-exclusions/bulk'],
  ['POST', `/clients/account-exclusions/${SEGMENT}/batch`],
  ['GET', `/clients/${SEGMENT}/exclusions`],
  ['POST', `/clients/${SEGMENT}/exclusions`],
  ['POST', `/clients/${SEGMENT}/exclusions/batch`],
  ['DELETE', `/clients/${SEGMENT}/exclusions/${SEGMENT}`],
  ['GET', '/households/resolve'],
];

const ALLOWED_PATTERNS = ALLOWED.map(([method, path]) => ({
  method,
  pattern: new RegExp(`^${path}/?$`, 'i'),
}));

export function isDelegatedOperationAllowed(method: string, path: string): boolean {
  const verb = method === 'HEAD' ? 'GET' : method.toUpperCase();
  return ALLOWED_PATTERNS.some((entry) => entry.method === verb && entry.pattern.test(path));
}

/**
 * Mounted at /api/ops-portal before requireDelegatedCaller, so an unlisted operation is
 * refused without verifying tokens or resolving (or provisioning) an actor.
 */
export function requireDelegatedOperation(req: Request, res: Response, next: NextFunction): void {
  if (!isDelegatedOperationAllowed(req.method, req.path)) {
    sendError(res, 404, 'Not found');
    return;
  }
  next();
}

const router = Router();

router.use('/requests', requestRoutes);
router.use('/notifications', notificationRoutes);
router.use('/clients', clientRoutes);
router.use('/clients', clientExclusionRoutes);
router.use('/households', householdRoutes);

router.use((_req, res) => {
  sendError(res, 404, 'Not found');
});

export default router;
