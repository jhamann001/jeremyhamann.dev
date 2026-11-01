import { Router } from 'express';
import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import * as warehouse from '../services/warehouse.js';
import { loadHouseholdConfigCached } from '../services/householdConfigCache.js';
import { ActiveAccountsLoadError } from '../services/meridianActiveAccounts.js';
import { resolveHouseholdsForClients } from '../services/householdResolution.js';
import logger from '../lib/logger.js';
import { sendError } from '../middleware/errorHandler.js';

const router = Router();

/**
 * GET /api/households/resolve?clientIds=A,B&accountIds=ULID1,ULID2
 *
 * See `docs/plans/2026-q2-trade-request-householding.md` §5.4.
 *
 * Wire-format binding (Decision log #4): `accountIds[]` carries Apex ULIDs
 * only — the form translates `selectedAccts` (account numbers) → ULIDs via
 * `clientMap` before calling. Non-ULID entries return 400.
 *
 * Silent-fallback contract (Decision log #2): callers MUST treat a 503 as
 * "no firm household on file, proceed as today." Demo mode and
 * `!warehouse.isConfigured()` short-circuit to an empty 200 response so the
 * sidecar never appears in those environments.
 */

const ULID_RE = /^[0-9A-Z]{26}$/;
const MAX_LIST_ENTRIES = 50;

function parseIdsList(raw: unknown, validator: (s: string) => boolean): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'string') {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'must be a comma-separated string',
      },
    ]);
  }
  if (raw === '') return [];
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length > MAX_LIST_ENTRIES) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.too_big,
        path: [],
        maximum: MAX_LIST_ENTRIES,
        origin: 'array',
        inclusive: true,
        exact: false,
        message: `list exceeds maximum of ${MAX_LIST_ENTRIES}`,
      },
    ]);
  }
  for (const p of parts) {
    if (!validator(p)) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: [],
          message: `invalid entry: "${p}"`,
        },
      ]);
    }
  }
  return parts;
}

const isNonEmptyString = (s: string): boolean => s.length > 0 && s.length <= 100;
const isUlid = (s: string): boolean => ULID_RE.test(s);

router.get('/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientIds = parseIdsList(req.query.clientIds, isNonEmptyString);
    const accountIds = parseIdsList(req.query.accountIds, isUlid);

    // Demo short-circuit — never call the GCS loader for demo sessions.
    if (req.isDemo) {
      res.json({
        data: {
          households: [],
          unresolvedClientIds: clientIds,
          unresolvedAccountIds: accountIds,
        },
      });
      return;
    }

    // Local-dev short-circuit — without Warehouse the Client.id values are
    // local UUIDs, not Apex ULIDs, so `HouseholdConfig.byAccountNumber`
    // (keyed by ULID) cannot match. Treat as silent fallback. Plan §6
    // Step 3 (N8).
    if (!warehouse.isConfigured()) {
      res.json({
        data: {
          households: [],
          unresolvedClientIds: clientIds,
          unresolvedAccountIds: accountIds,
        },
      });
      return;
    }

    let householdConfig;
    try {
      householdConfig = await loadHouseholdConfigCached();
    } catch (err) {
      if (err instanceof ActiveAccountsLoadError) {
        logger.warn({ err }, 'household_data_unavailable — returning 503 for silent-fallback');
        sendError(res, 503, 'household_data_unavailable');
        return;
      }
      throw err;
    }

    const clients = await warehouse.getCachedClients();

    const result = resolveHouseholdsForClients({
      clientIds,
      accountIds,
      clients,
      householdConfig,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
