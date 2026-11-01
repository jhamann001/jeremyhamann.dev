// Limits for the public demo, where every visitor shares one firm until the nightly reset. Only active
// with PERSONA_SIGN_IN=on.
//
// - Caps on what visitors can add (requests, users, exclusions), so the shared data stays bounded.
// - Requests show the client's real name: the names typed or sent by the browser are replaced from the
//   client list, manual client entry is off, and a household name the model provider doesn't know is
//   dropped. Otherwise one visitor's text would head the queue every other visitor sees.

import type { Pool, PoolClient } from 'pg';
import pool from '../db/pool.js';
import { AppError } from '../middleware/errorHandler.js';
import * as warehouse from '../services/warehouse.js';
import { loadHouseholdConfigCached } from '../services/householdConfigCache.js';
import logger from '../lib/logger.js';
import { personaSignInEnabled } from './personas.js';

// Counts include the seed (20 requests, 4 users, 3 exclusions). `lock` is the kind's advisory-lock key,
// under QUOTA_LOCK_NAMESPACE.
const QUOTAS = {
  requests: { lock: 1, sql: 'SELECT count(*)::int AS n FROM trade_requests', max: 300, label: 'trade requests' },
  users: { lock: 2, sql: 'SELECT count(*)::int AS n FROM users', max: 30, label: 'users' },
  exclusions: {
    lock: 3,
    sql: 'SELECT ((SELECT count(*) FROM client_exclusions) + (SELECT count(*) FROM account_exclusions))::int AS n',
    max: 400,
    label: 'exclusions',
  },
} as const;
const QUOTA_LOCK_NAMESPACE = 7401;

export type DemoQuota = keyof typeof QUOTAS;

/**
 * Call inside the transaction that writes the rows, before it writes them: refuses the write if it would
 * take the demo past its cap. `adding` is the net number of rows the transaction adds (a batch's adds
 * minus its removes).
 *
 * It takes a transaction-scoped advisory lock first, so writers of the same kind count one at a time and
 * each one sees what the one before it committed. Checking before the transaction instead let a batch, or
 * several requests at once, all pass the check and overshoot the cap together.
 */
export async function holdDemoQuota(db: PoolClient, kind: DemoQuota, adding: number): Promise<void> {
  if (!personaSignInEnabled() || adding <= 0) return;
  const { lock, max, label, sql } = QUOTAS[kind];
  await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [QUOTA_LOCK_NAMESPACE, lock]);
  const { rows } = await db.query<{ n: number }>(sql);
  const held = rows[0].n;
  if (held + adding <= max) return;
  const until = `The demo holds up to ${max} ${label} until its nightly reset (3 AM Eastern)`;
  throw new AppError(
    429,
    held >= max
      ? `${until}. Please try again tomorrow.`
      : `${until}, and this change would add ${adding} with room for ${max - held}. Please make a smaller change.`,
  );
}

/**
 * For a route that writes its rows without a transaction of its own: runs `write` in one that holds the
 * cap (see holdDemoQuota). Outside the demo it is just `write(pool)`.
 */
export async function withDemoQuota<T>(
  kind: DemoQuota,
  adding: number,
  write: (db: Pool | PoolClient) => Promise<T>,
): Promise<T> {
  if (!personaSignInEnabled()) return write(pool);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await holdDemoQuota(db, kind, adding);
    const result = await write(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

interface RequestNames {
  clientId: string;
  clientName: string;
  clientIds?: string[];
  clientNames?: string[];
  manualEntry?: boolean;
  householdId?: number | null;
  householdName?: string | null;
}

/** Replaces client and household names on a new or resubmitted request with the firm's own. */
export async function useFirmNames(body: RequestNames): Promise<void> {
  if (!personaSignInEnabled()) return;
  if (body.manualEntry || body.clientId.startsWith('manual-')) {
    throw new AppError(400, 'Manual client entry is turned off in the public demo. Pick a client from the list.');
  }
  const clients = await warehouse.getCachedClients();
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const firmName = (id: string) => {
    const name = nameOf.get(id);
    if (!name) throw new AppError(400, `Unknown client: ${id.slice(0, 40)}`);
    return name;
  };
  body.clientName = firmName(body.clientId);
  if (body.clientIds) body.clientNames = body.clientIds.map(firmName);

  if (body.householdName != null) {
    let known = false;
    try {
      known = (await loadHouseholdConfigCached()).householdNames.has(body.householdName);
    } catch (err) {
      logger.warn({ event: 'demo_household_check_failed', message: err instanceof Error ? err.message : String(err) }, 'household check failed; dropping the household tag');
    }
    if (!known) {
      body.householdId = null;
      body.householdName = null;
    }
  }
}
