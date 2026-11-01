import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { AuthUser } from '@trade-request/shared';
import pool from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { DRIFT_ALLOW_LIST } from '../services/registryDriftAllowList.js';
import { clampHistoryDays, fetchDriftHistory, fetchDriftRunDetail } from '../services/driftHistoryQuery.js';
import {
  clampHistoryDays as clampAccountDriftHistoryDays,
  fetchAccountDriftHistory,
  fetchAccountDriftRun,
} from '../services/positionDriftAccountsPersistence.js';
import { analyzeExclusionOverlapForRun } from '../services/driftExclusionAnalysis.js';
import {
  DRIFT_OVERRIDE_REASONS,
  clearOverride,
  fetchActiveOverrides,
  upsertOverride,
} from '../services/driftStatusOverrides.js';

const router = Router();

// Open to ALL authenticated users (advisors + traders). The `/api/drift` mount
// in `server/src/index.ts` enforces `requireAuth` + CSRF + rate limiting, so a
// valid session is still required — there is just no longer a role restriction.
// The drift surface is read-only (history / run detail / allow-list / exclusion
// overlap); the run-trigger endpoints live under `/api/internal` and remain
// gated separately. (Was trader-only; opened 2026-06 per ops request.)

/**
 * Newest-first drift run history. `days` query param falls back to 30 for any
 * non-finite, non-positive, or > 90 value (matches `internal.ts` semantics).
 * Cache-Control: no-store, private mirrors the internal route — the JSON body
 * carries household names + max-delta values derived from PII-adjacent data.
 */
router.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = clampHistoryDays(req.query.days);
    const runs = await fetchDriftHistory(pool, days);
    res.set('Cache-Control', 'no-store, private');
    res.json({ days, runs });
  } catch (err) {
    next(err);
  }
});

/**
 * Static allow-list of known-expected divergences. Mirrors the
 * `/api/internal/drift/allow-list` shape so the dashboard can drive the
 * "Allow-listed" badge by name lookup.
 */
router.get('/allow-list', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store, private');
    res.json({ entries: DRIFT_ALLOW_LIST });
  } catch (err) {
    next(err);
  }
});

const runDetailParams = z.object({
  runDateLocal: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'runDateLocal must be YYYY-MM-DD')
    .refine((s) => {
      const d = new Date(`${s}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) return false;
      // Reject month/day overflow that JS silently coerces (e.g. 2026-02-30 → 2026-03-02).
      return d.toISOString().slice(0, 10) === s;
    }, 'runDateLocal must be a valid calendar date'),
  // Cap matches advisor-friendly household names; the column itself has no
  // length cap so a hostile session shouldn't be able to push a 10 KB string.
  householdName: z.string().min(1).max(200),
});

/**
 * Drill-down for one (run_date_local, household_name) row. Returns 404 when
 * the row does not exist; the unique constraint on the table makes the
 * `LIMIT 1` query deterministic.
 */
router.get('/runs/:runDateLocal/:householdName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { runDateLocal, householdName } = runDetailParams.parse(req.params);
    const run = await fetchDriftRunDetail(pool, runDateLocal, householdName);
    if (run === null) {
      res.status(404).json({ error: 'drift run not found' });
      return;
    }
    res.set('Cache-Control', 'no-store, private');
    res.json({ run });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.issues });
      return;
    }
    next(err);
  }
});

// ─── Drift v2 (per-account) ─────────────────────────────────────────────────
//
// Three additive routes under `/api/drift/v2/*`. Backed by the new
// `position_drift_accounts` table. v1 `/api/drift/{history,runs/...,allow-list}`
// stays reachable until the retirement follow-up PR (plan §9).
// All three are trader-only via the router-wide `requireRole('trader')` gate
// at the top of this file.

const accountDriftRunParams = z.object({
  runDateLocal: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'runDateLocal must be YYYY-MM-DD')
    .refine((s) => {
      const d = new Date(`${s}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) return false;
      return d.toISOString().slice(0, 10) === s;
    }, 'runDateLocal must be a valid calendar date'),
});

const exclusionOverlapQuery = z.object({
  runDateLocal: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'runDateLocal must be YYYY-MM-DD')
    .refine((s) => {
      const d = new Date(`${s}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) return false;
      return d.toISOString().slice(0, 10) === s;
    }, 'runDateLocal must be a valid calendar date')
    .optional(),
});

interface ExclusionOverlapCacheEntry {
  expiresAtMs: number;
  report: Awaited<ReturnType<typeof analyzeExclusionOverlapForRun>>;
}

const EXCLUSION_OVERLAP_CACHE_TTL_MS = 60 * 60 * 1000;
const exclusionOverlapCache = new Map<string, ExclusionOverlapCacheEntry>();

function isExclusionOverlapDiagnosticEnabled(): boolean {
  return process.env.DRIFT_EXCLUSION_OVERLAP_DIAGNOSTIC_ENABLED === 'true';
}

function exclusionOverlapCacheKey(runDateLocal?: string): string {
  return `${process.env.NODE_ENV ?? 'development'}:${runDateLocal ?? '__latest__'}`;
}

router.get('/v2/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = clampAccountDriftHistoryDays(req.query.days);
    const runs = await fetchAccountDriftHistory(pool, days);
    // Attach the active (non-expired) manual override to each row. The computed
    // status is untouched; the client applies the override for display and to
    // exclude the account from the actionable out-of-tolerance count.
    const overrides = await fetchActiveOverrides(
      pool,
      runs.map((r) => r.accountId),
    );
    const withOverrides = runs.map((r) => ({ ...r, override: overrides.get(r.accountId) ?? null }));
    res.set('Cache-Control', 'no-store, private');
    res.json({ days, runs: withOverrides });
  } catch (err) {
    next(err);
  }
});

// ─── Manual status overrides (trader-only writes) ───────────────────────────
// Sticky, per-account acceptance of an out-of-tolerance row for a known reason.
// Reads are folded into /v2/history above; these endpoints set / clear.

const overrideBodySchema = z
  .object({
    reason: z.enum(DRIFT_OVERRIDE_REASONS as unknown as [string, ...string[]]),
    note: z.string().max(2000).optional().default(''),
    // YYYY-MM-DD or null (no expiry). Only meaningful for time-bound reasons.
    expiresOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'expiresOn must be YYYY-MM-DD')
      .nullable()
      .optional(),
  })
  .refine((b) => b.reason !== 'other' || b.note.trim().length > 0, {
    message: 'note is required when reason is "other"',
    path: ['note'],
  });

const overrideAccountParam = z.object({
  accountId: z.string().min(1).max(100),
});

router.put(
  '/v2/overrides/:accountId',
  requireRole('trader'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { accountId } = overrideAccountParam.parse(req.params);
      const body = overrideBodySchema.parse(req.body);
      const user = req.user as AuthUser;
      const override = await upsertOverride(pool, {
        accountId,
        reason: body.reason as (typeof DRIFT_OVERRIDE_REASONS)[number],
        note: body.note ?? '',
        expiresOn: body.expiresOn ?? null,
        setBy: user.id,
        setByName: user.name,
      });
      res.json({ accountId, override });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: err.issues });
        return;
      }
      next(err);
    }
  },
);

router.delete(
  '/v2/overrides/:accountId',
  requireRole('trader'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { accountId } = overrideAccountParam.parse(req.params);
      const cleared = await clearOverride(pool, accountId);
      res.json({ accountId, cleared });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: err.issues });
        return;
      }
      next(err);
    }
  },
);

router.get('/v2/runs/:runDateLocal', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { runDateLocal } = accountDriftRunParams.parse(req.params);
    const run = await fetchAccountDriftRun(pool, runDateLocal);
    if (run === null) {
      res.status(404).json({ error: 'drift run not found', runDateLocal });
      return;
    }
    res.set('Cache-Control', 'no-store, private');
    res.json(run);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.issues });
      return;
    }
    next(err);
  }
});

router.get('/v2/allow-list', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store, private');
    res.json({ entries: DRIFT_ALLOW_LIST });
  } catch (err) {
    next(err);
  }
});

router.head('/v2/exclusion-overlap', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store, private');
    if (!isExclusionOverlapDiagnosticEnabled()) {
      res.status(404).end();
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/v2/exclusion-overlap', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store, private');
    if (!isExclusionOverlapDiagnosticEnabled()) {
      res.status(404).json({ error: 'drift exclusion overlap diagnostic disabled' });
      return;
    }

    const { runDateLocal } = exclusionOverlapQuery.parse(req.query);
    const cacheKey = exclusionOverlapCacheKey(runDateLocal);
    const cached = exclusionOverlapCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      res.json(cached.report);
      return;
    }

    const report = await analyzeExclusionOverlapForRun(pool, { runDateLocal });
    if (report === null) {
      res.status(404).json({ error: 'drift run not found', runDateLocal: runDateLocal ?? null });
      return;
    }

    exclusionOverlapCache.set(cacheKey, {
      expiresAtMs: Date.now() + EXCLUSION_OVERLAP_CACHE_TTL_MS,
      report,
    });
    res.json(report);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.issues });
      return;
    }
    next(err);
  }
});

export default router;
