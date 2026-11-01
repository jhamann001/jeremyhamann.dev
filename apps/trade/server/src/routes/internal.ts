import { Router, type Request, type Response, type NextFunction } from 'express';
import pool from '../db/pool.js';
import logger from '../lib/logger.js';
import { requireSchedulerAuth } from '../middleware/schedulerAuth.js';
import { buildDailyDigest, sendDailyDigest, sendDigestToTarget } from '../services/digest.js';
import { previewDriftCheck, runDriftCheck } from '../services/registryDriftRunner.js';
import { SnapshotLoadError } from '../services/meridianSnapshot.js';
import { ActiveAccountsLoadError } from '../services/meridianActiveAccounts.js';
import { DRIFT_ALLOW_LIST } from '../services/registryDriftAllowList.js';
import { clampHistoryDays, fetchDriftHistory } from '../services/driftHistoryQuery.js';
import { readServiceState } from '../services/serviceMode.js';
import { readSecret, sameSecret } from '../lib/secrets.js';
import { resetDemo } from '../demo/reset.js';

const router = Router();

let demoResetRunning = false;

/**
 * The demo's reset: reseeds the demo data and reruns the jobs against the stand-ins (see demo/reset.ts).
 * The Worker in front calls it nightly and never forwards this path from outside. It exists only while
 * the stand-ins run (DEMO_STAND_INS=on) and DEMO_RESET_TOKEN is set, and needs that token in
 * x-demo-reset-token. One at a time: the stand-ins' clock is shared by the whole process.
 */
router.post('/demo-reset', async (req: Request, res: Response, next: NextFunction) => {
  const expected = readSecret('DEMO_RESET_TOKEN');
  if (process.env.DEMO_STAND_INS !== 'on' || !expected) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!sameSecret(req.header('x-demo-reset-token'), expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (demoResetRunning) {
    res.status(409).json({ error: 'A reset is already running' });
    return;
  }
  demoResetRunning = true;
  try {
    res.json({ data: await resetDemo() });
  } catch (err) {
    next(err);
  } finally {
    demoResetRunning = false;
  }
});

/**
 * Why a sending job must stay silent (ticket): the service is frozen or MCP-only, or this job's
 * standalone sender switch is off. Null when it may run. A failed read throws, so nothing is sent.
 */
async function inertReason(sender: 'digestSender' | 'driftSender'): Promise<'service_mode' | 'sender_off' | null> {
  const state = await readServiceState();
  if (state.mode !== 'active') return 'service_mode';
  return state[sender] === 'off' ? 'sender_off' : null;
}

/**
 * Cloud Scheduler target. Protected by OIDC verification — see
 * requireSchedulerAuth for the accepted iss/aud/email claims. Idempotent:
 * re-invoking the same calendar day returns { sent: false, reason: 'already_posted' }.
 */
router.post('/digest/daily', requireSchedulerAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const inert = await inertReason('digestSender');
    if (inert) {
      logger.info({ event: 'digest_inert', reason: inert }, 'daily digest skipped: nothing posted or claimed');
      res.json({ sent: false, reason: inert });
      return;
    }
    const result = await sendDailyDigest(pool);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * One-shot test delivery. Renders today's digest with live data and sends it
 * to `target` (Slack channel ID or user ID) without writing to digest_runs,
 * so it can be invoked repeatedly while iterating on copy. Reuses the
 * Scheduler OIDC auth so it can only be triggered by a controlled principal.
 */
router.post('/digest/test-send', requireSchedulerAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { target?: unknown };
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    if (!target) {
      res.status(400).json({ error: 'target (Slack channel or user id) is required' });
      return;
    }
    const inert = await inertReason('digestSender');
    if (inert) {
      logger.info({ event: 'digest_inert', reason: inert }, 'digest test-send skipped');
      res.json({ sent: false, reason: inert });
      return;
    }
    const result = await sendDigestToTarget(pool, target);
    res.json({ sent: result.sent, target: result.target, total: result.summary.total });
  } catch (err) {
    next(err);
  }
});

/**
 * Dev-only preview of the digest text. Lets engineers iterate on copy without
 * posting to Slack or writing to digest_runs. Gate is NODE_ENV !== 'production'
 * so that in deployed environments this route simply doesn't exist.
 */
if (process.env.NODE_ENV !== 'production') {
  router.get('/digest/preview', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { text, summary } = await buildDailyDigest(pool);
      res.json({ text, summary });
    } catch (err) {
      next(err);
    }
  });
}

/**
 * The execution-plan registry export and its development preview are retired (ticket): the weekday
 * drift check compares positions with the Meridian templates and reads nothing from stored execution plans.
 * Both paths are refused before authentication so nothing is built or logged.
 */
router.get(['/meridian-registry', '/meridian-registry/preview'], (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

/**
 * Nightly registry drift Cloud Scheduler target. Behavior:
 * - 204 No Content + `drift_disabled` info log when `DRIFT_ENABLED !== 'true'`
 *   (build-time / merge-gate kill switch — the runner is NOT invoked, so
 *   accidental Scheduler pings while the GCS bucket and the active_accounts +
 *   templates JSON files are still being provisioned are a no-op rather than
 *   503-storming.
 * - 200 with a `DriftRunSummary` on success (whether or not Slack actually
 *   posted; `summary.alert.sent` reports the shadow-mode decision).
 * - 503 when the Meridian snapshot fails to load. Cloud Scheduler retry
 *   policy handles the transient case; no `registry_drift_runs` rows are
 *   written for an aborted run so a successful retry still INSERTs cleanly.
 * - All other errors propagate to the default error handler (500).
 *
 * `Cache-Control: no-store, private` mirrors the registry route — the JSON
 * body contains household-level deltas derived from PII-adjacent data.
 */
router.post('/drift/check', requireSchedulerAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store, private');
    if (process.env.DRIFT_ENABLED !== 'true') {
      logger.info({ event: 'drift_disabled' }, 'drift runner short-circuited (DRIFT_ENABLED!=true)');
      res.status(204).end();
      return;
    }
    const inert = await inertReason('driftSender');
    if (inert) {
      logger.info({ event: 'drift_inert', reason: inert }, 'drift check skipped: no alert, reminder or result written');
      res.json({ ran: false, reason: inert });
      return;
    }
    const summary = await runDriftCheck({ pool });
    res.json(summary);
  } catch (err) {
    if (err instanceof SnapshotLoadError) {
      logger.warn(
        { event: 'drift_check_unavailable', source: err.source, message: err.message },
        'drift check returned 503 (snapshot load failed)',
      );
      res.status(503).json({ error: 'snapshot_unavailable', source: err.source, message: err.message });
      return;
    }
    if (err instanceof ActiveAccountsLoadError) {
      logger.warn(
        { event: 'drift_check_unavailable', source: err.source, message: err.message },
        'drift check returned 503 (active_accounts load failed)',
      );
      res.status(503).json({ error: 'active_accounts_unavailable', source: err.source, message: err.message });
      return;
    }
    next(err);
  }
});

/**
 * Read-only preview that builds the registry, loads the snapshot, and runs
 * the pure comparison — without persisting rows or posting to Slack. Same
 * OIDC gate as `/drift/check`, PLUS an explicit `NODE_ENV ∈ {development,
 * test}` allow-list as defense-in-depth (per the source plan): an unset
 * NODE_ENV in any deployed environment must NOT expose the PII payload,
 * which an OIDC-only gate would do if the scheduler SA were ever granted
 * dashboard access. The gate fires BEFORE any registry/snapshot work so
 * the deny path is fast and never touches Postgres or GCS. We return 404
 * (not 403) so production never leaks the route's existence — same shape
 * as if the route had not been registered. Same `no-store, private`
 * cache directive as the registry route for the same PII-adjacency reason.
 */
router.post('/drift/check/preview', requireSchedulerAuth, async (_req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    res.status(404).end();
    return;
  }
  try {
    const result = await previewDriftCheck(pool);
    res.set('Cache-Control', 'no-store, private');
    res.json({
      tolerancePct: result.tolerancePct,
      positions: {
        accountCount: result.positions.accountCount,
        businessDate: result.positions.businessDate,
      },
      snapshot: {
        generatedAt: result.snapshot.generatedAt ?? null,
        entryCount: result.snapshot.entries.length,
      },
      comparison: result.comparison,
    });
  } catch (err) {
    if (err instanceof SnapshotLoadError) {
      res.status(503).json({ error: 'snapshot_unavailable', source: err.source, message: err.message });
      return;
    }
    if (err instanceof ActiveAccountsLoadError) {
      res.status(503).json({ error: 'active_accounts_unavailable', source: err.source, message: err.message });
      return;
    }
    next(err);
  }
});

/**
 * Surface the static allow-list to the frontend dashboard so it can grey-out
 * known-expected divergences with a rationale link. Same OIDC gate (the
 * dashboard fetches via the same service-to-service auth path as the digest
 * routes). `Cache-Control: no-store, private` because the dashboard caches
 * server-side; we want a refetch on every dashboard load.
 */
router.get('/drift/allow-list', requireSchedulerAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store, private');
    res.json({ entries: DRIFT_ALLOW_LIST });
  } catch (err) {
    next(err);
  }
});

/**
 * History endpoint backing the dashboard's trend view. Returns rows ordered
 * newest-first and capped at 90 days × ~25 households = ~2,250 rows worst
 * case; the explicit LIMIT keeps the response bounded even if a future
 * change widens the household roster.
 */
router.get('/drift/history', requireSchedulerAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = clampHistoryDays(req.query.days);
    const runs = await fetchDriftHistory(pool, days);
    res.set('Cache-Control', 'no-store, private');
    res.json({ days, runs });
  } catch (err) {
    next(err);
  }
});

export default router;
