import type { Pool } from 'pg';
import type { ChecklistItemKey, ChecklistItemState, PreapprovalChecklist } from '@trade-request/shared';

/**
 * Per-request pre-approval checklist persistence. Stored as JSONB on
 * trade_requests, keyed by item: { "<key>": { checked, value, by, at } }.
 * `by`/`at` are stamped server-side on every change (the audit value). The
 * checklist locks once the request reaches a terminal status.
 */

const TERMINAL_STATUSES = new Set(['Approved', 'Rejected', 'Completed']);

interface ChecklistRow {
  preapproval_checklist: PreapprovalChecklist | null;
}

/** Returns the checklist (possibly empty), or null when the request is missing. */
export async function fetchChecklist(pool: Pool, requestId: string): Promise<PreapprovalChecklist | null> {
  const { rows } = await pool.query<ChecklistRow>('SELECT preapproval_checklist FROM trade_requests WHERE id = $1', [
    requestId,
  ]);
  if (rows.length === 0) return null;
  return rows[0].preapproval_checklist ?? {};
}

export type SetChecklistResult =
  { ok: true; checklist: PreapprovalChecklist } | { ok: false; reason: 'not_found' | 'locked' };

/**
 * Upsert a single checklist item, stamping who/when. Refuses once the request
 * is in a terminal status (the decision is made — the checklist is a record).
 */
export async function setChecklistItem(
  pool: Pool,
  requestId: string,
  key: ChecklistItemKey,
  input: { checked: boolean; value?: string },
  byName: string,
): Promise<SetChecklistResult> {
  const { rows } = await pool.query<{ status: string }>('SELECT status FROM trade_requests WHERE id = $1', [requestId]);
  if (rows.length === 0) return { ok: false, reason: 'not_found' };
  if (TERMINAL_STATUSES.has(rows[0].status)) return { ok: false, reason: 'locked' };

  const state: ChecklistItemState = {
    checked: input.checked,
    value: input.value ?? '',
    by: byName,
    at: new Date().toISOString(),
  };
  const { rows: updated } = await pool.query<ChecklistRow>(
    `UPDATE trade_requests
     SET preapproval_checklist = jsonb_set(COALESCE(preapproval_checklist, '{}'::jsonb), ARRAY[$2], $3::jsonb, true)
     WHERE id = $1
     RETURNING preapproval_checklist`,
    [requestId, key, JSON.stringify(state)],
  );
  return { ok: true, checklist: updated[0]?.preapproval_checklist ?? {} };
}
