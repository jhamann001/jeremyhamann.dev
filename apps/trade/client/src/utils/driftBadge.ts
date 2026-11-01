import type { DriftHistoryRow } from '@trade-request/shared';

/**
 * "Would alert" badge classifier for the drift dashboard. Mirrors the
 * server-side alert filter at `server/src/services/registryDriftAlert.ts:69-81`
 * verbatim:
 *
 *   const allBreaches = households.filter(
 *     h => h.breach && h.coverageStatus !== 'unmapped_account'
 *   );
 *   const alerting = allBreaches.filter(
 *     h => !DRIFT_ALLOW_LIST_NAMES.has(h.householdName) && ...
 *   );
 *
 * The historical-row UI deliberately does NOT consult the runner's
 * `breachInsertedHouseholdNames` (the second clause on line 80 there) — that's
 * an idempotency check the runner does at insert time, not a property of a
 * persisted row. A row that already lives in `registry_drift_runs` is, by
 * construction, a row whose insert succeeded.
 *
 * Precedence:
 *   1. coverage_status === 'unmapped_account' → 'unmapped' (regardless of breach
 *      OR allow-list membership; an unmapped account is config drift, not
 *      engine drift, and "Allow-listed" would be misleading).
 *   2. !breach → 'clean'
 *   3. breach && allow-listed → 'allow-listed'
 *   4. otherwise → 'would-alert'
 */

export type DriftBadgeKind = 'clean' | 'would-alert' | 'allow-listed' | 'unmapped';

export function computeBreachBadge(
  row: Pick<DriftHistoryRow, 'breach' | 'coverageStatus' | 'householdName'>,
  allowList: ReadonlySet<string>,
): DriftBadgeKind {
  if (row.coverageStatus === 'unmapped_account') return 'unmapped';
  if (!row.breach) return 'clean';
  if (allowList.has(row.householdName)) return 'allow-listed';
  return 'would-alert';
}
