import type { Pool } from '@/lib/trade-requests/pg-compat';
import type { AccountDriftOverride, DriftOverrideReason } from '@/lib/trade-requests/shared-types';

/**
 * Manual, sticky, per-account drift-status overrides. A trader marks an
 * out-of-tolerance account as accepted for a known reason; the override
 * persists across nightly runs (keyed by Apex ULID) until cleared. The computed
 * drift status is never mutated — these are joined in at read time and applied
 * for display + the actionable count. Time-bound reasons carry an `expires_on`
 * so a finished transition stops suppressing drift on its own.
 */

export const DRIFT_OVERRIDE_REASONS: readonly DriftOverrideReason[] = [
  'asset_location',
  'tax_constraint',
  'active_transition',
  'intentional_cash',
  'concentrated_position',
  'template_error',
  'direct_index_noise',
  'other',
];

export function isDriftOverrideReason(value: unknown): value is DriftOverrideReason {
  return typeof value === 'string' && (DRIFT_OVERRIDE_REASONS as readonly string[]).includes(value);
}

/** Human-readable reason labels for notification copy. */
const OVERRIDE_REASON_LABEL: Record<DriftOverrideReason, string> = {
  asset_location: 'asset location',
  tax_constraint: 'tax-constrained',
  active_transition: 'active transition',
  intentional_cash: 'intentional cash',
  concentrated_position: 'concentrated position',
  template_error: 'template error',
  direct_index_noise: 'direct-index noise',
  other: 'override',
};

interface OverrideRowSql {
  account_id: string;
  reason: DriftOverrideReason;
  note: string;
  expires_on: string | null;
  set_by_name: string;
  updated_at: string;
}

function mapOverrideRow(row: OverrideRowSql): AccountDriftOverride {
  return {
    reason: row.reason,
    note: row.note,
    expiresOn: row.expires_on,
    setByName: row.set_by_name,
    setAt: row.updated_at,
  };
}

/**
 * Active (non-expired) overrides keyed by account_id. An override with an
 * `expires_on` strictly before today no longer applies. Pass `accountIds` to
 * scope the lookup to a run's accounts; omit to fetch all active overrides.
 */
export async function fetchActiveOverrides(
  pool: Pool,
  accountIds?: readonly string[],
): Promise<Map<string, AccountDriftOverride>> {
  const scoped = accountIds !== undefined;
  if (scoped && accountIds.length === 0) return new Map();

  const where = scoped
    ? `WHERE account_id = ANY($1::varchar[]) AND (expires_on IS NULL OR expires_on >= CURRENT_DATE)`
    : `WHERE (expires_on IS NULL OR expires_on >= CURRENT_DATE)`;
  const params = scoped ? [accountIds] : [];

  const { rows } = await pool.query<OverrideRowSql>(
    `SELECT account_id, reason, note, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, set_by_name, updated_at
     FROM trade_request.drift_status_overrides
     ${where}`,
    params,
  );

  const byAccount = new Map<string, AccountDriftOverride>();
  for (const row of rows) byAccount.set(row.account_id, mapOverrideRow(row));
  return byAccount;
}

export interface UpsertOverrideInput {
  accountId: string;
  reason: DriftOverrideReason;
  note: string;
  /** ISO date (YYYY-MM-DD) or null for no expiry. */
  expiresOn: string | null;
  setBy: string | null;
  setByName: string;
}

export async function upsertOverride(pool: Pool, input: UpsertOverrideInput): Promise<AccountDriftOverride> {
  const { rows } = await pool.query<OverrideRowSql>(
    `INSERT INTO trade_request.drift_status_overrides (account_id, reason, note, expires_on, set_by, set_by_name, updated_at)
     VALUES ($1, $2, $3, $4::date, $5::uuid, $6, now())
     ON CONFLICT (account_id) DO UPDATE SET
       reason = EXCLUDED.reason,
       note = EXCLUDED.note,
       expires_on = EXCLUDED.expires_on,
       set_by = EXCLUDED.set_by,
       set_by_name = EXCLUDED.set_by_name,
       updated_at = now(),
       -- Re-setting the override (often with a new re-check date) re-arms the
       -- reminder: clear the notified marker so the new date can fire again.
       recheck_notified_at = NULL
     RETURNING account_id, reason, note, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, set_by_name, updated_at`,
    [input.accountId, input.reason, input.note, input.expiresOn, input.setBy, input.setByName],
  );
  return mapOverrideRow(rows[0]);
}

/** Returns true when a row was removed, false when there was nothing to clear. */
export async function clearOverride(pool: Pool, accountId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM trade_request.drift_status_overrides WHERE account_id = $1`, [accountId]);
  return (rowCount ?? 0) > 0;
}

interface DueRecheckRow {
  account_id: string;
  account_title: string;
  reason: DriftOverrideReason;
  set_by: string;
  expires_on: string;
}

/**
 * Notify the trader who set an override once its re-check date has arrived.
 * Finds overrides with `expires_on <= today` that haven't been notified yet
 * (and have a known setter), drops an in-app notification on each setter, and
 * stamps `recheck_notified_at` so the reminder fires once — not every day.
 *
 * Runs inside the daily drift job; returns the number of reminders sent.
 */
export async function sweepOverrideRechecks(pool: Pool): Promise<number> {
  const { rows } = await pool.query<DueRecheckRow>(
    `SELECT o.account_id,
            COALESCE(p.account_title, o.account_id) AS account_title,
            o.reason,
            o.set_by::text AS set_by,
            to_char(o.expires_on, 'YYYY-MM-DD') AS expires_on
     FROM trade_request.drift_status_overrides o
     LEFT JOIN LATERAL (
       SELECT account_title FROM trade_request.position_drift_accounts
       WHERE account_id = o.account_id
       ORDER BY run_date_local DESC
       LIMIT 1
     ) p ON true
     WHERE o.expires_on IS NOT NULL
       AND o.expires_on <= CURRENT_DATE
       AND o.recheck_notified_at IS NULL
       AND o.set_by IS NOT NULL`,
  );

  let sent = 0;
  for (const row of rows) {
    const label = OVERRIDE_REASON_LABEL[row.reason] ?? 'override';
    const body = `Drift re-check due: "${row.account_title}" — your ${label} override reached its ${row.expires_on} re-check date and is now back on the action list.`;
    // Insert the notification, then stamp the marker. Stamping is gated on
    // recheck_notified_at IS NULL so a concurrent run can't double-send.
    await pool.query(`INSERT INTO trade_request.notifications (user_id, body, request_id) VALUES ($1::uuid, $2, NULL)`, [
      row.set_by,
      body,
    ]);
    await pool.query(
      `UPDATE trade_request.drift_status_overrides SET recheck_notified_at = now()
       WHERE account_id = $1 AND recheck_notified_at IS NULL`,
      [row.account_id],
    );
    sent += 1;
  }
  return sent;
}
