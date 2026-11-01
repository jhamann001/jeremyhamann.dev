import type { AuthUser, UserRole } from '@trade-request/shared';
import pool from '../db/pool.js';
import { mapRow } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { FROZEN_MESSAGE } from '../middleware/serviceModeGuard.js';
import { readServiceState } from './serviceMode.js';

const COLUMNS =
  'id, google_id, email, name, picture, role, slack_user_id, theme_preference, is_active, last_login, created_at';

/**
 * Resolves the person an Ops Portal delegated call acts for to the service's own user
 * record, matched by verified company email regardless of `is_active` (owner
 * ruling D1: no roster entry is needed to act through Ops Portal). When no record
 * exists, an inactive shadow row is inserted so audit entries, own-request
 * checks and notifications have a stable actor id.
 *
 * The returned user carries the role mapped from the person's current Ops Portal
 * role, never the standalone roster role.
 */
export async function resolveDelegatedActor(email: string, name: string, role: UserRole): Promise<AuthUser> {
  const normalized = email.trim().toLowerCase();

  const found = await pool.query(
    `SELECT ${COLUMNS} FROM users WHERE lower(email) = $1 ORDER BY created_at ASC LIMIT 1`,
    [normalized],
  );
  let row = found.rows[0];

  if (!row) {
    // Provisioning is a user-administration write: while the service is not active (ticket) a first-time
    // Ops Portal user is refused rather than given a row the final change copy may already have missed.
    if ((await readServiceState()).mode !== 'active') {
      throw new AppError(423, 'delegated actor provisioning refused: service not active', FROZEN_MESSAGE);
    }
    const inserted = await pool.query(
      `INSERT INTO users (email, name, role, is_active, ops_portal_provisioned_at)
       VALUES ($1, $2, 'advisor', false, NOW())
       ON CONFLICT (email) DO NOTHING
       RETURNING ${COLUMNS}`,
      [normalized, name],
    );
    row = inserted.rows[0];
    if (!row) {
      // A concurrent first call inserted the same email between our SELECT and INSERT.
      const raced = await pool.query(`SELECT ${COLUMNS} FROM users WHERE email = $1`, [normalized]);
      row = raced.rows[0];
    }
  }

  if (!row) throw new Error('Delegated actor could not be resolved');
  return { ...mapRow(row), role };
}
