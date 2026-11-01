/**
 * Known-divergence household allow-list for the nightly registry drift job.
 *
 * Entries here are persisted with `breach === true` but are **excluded** from
 * the Slack alert payload. The list lives as a typed `const` (not config, not
 * env var, not DB) so each entry is tied to the specific downstream plan that
 * will close the gap — see `unblocksWhenPlanShips`. When that plan ships, its
 * PR removes the entry and adds a regression test asserting the household now
 * reports `breach === false`.
 *
 * The four launch entries below match the canonical household names in
 * `active_accounts.numbers` (verified May 11, 2026). The companion test
 * `__tests__/registryDriftAllowList.test.ts` fails CI with a verbatim
 * diagnostic message if any entry's `householdName` is no longer present in
 * `server/src/config/households.json` — that is the regression guard against
 * a typo or a silent household rename.
 */

// The wire shape lives in `@trade-request/shared/types.ts` so the dashboard
// API and the server-side const stay structurally identical via the type
// system. Re-export here so existing consumers (`registryDriftAlert.ts`,
// `registryDriftAllowList.test.ts`, etc.) keep their import paths unchanged.
import type { DriftAllowListEntry, DriftAllowListReason } from '@trade-request/shared';

export type { DriftAllowListEntry, DriftAllowListReason };

/**
 * Empty as of the 2026-Q3 positions-vs-Meridian drift cutover (plan §5.G +
 * §12 Q2 RESOLVED 2026-05-13). The four prior entries (Whitaker Family,
 * Martha and Graham Ellis, Example Household, Hazel Moreno) all cited
 * engine-side modelling rationale (within-type spread, mirror mode,
 * per-account risk). On the new positions-vs-template comparison those
 * rationales no longer apply: the engine is not on the comparison's input
 * side. If a real positions-vs-template divergence emerges that warrants
 * suppression, re-add it here with a new `reason` enum value.
 */
export const DRIFT_ALLOW_LIST: readonly DriftAllowListEntry[] = [];

export const DRIFT_ALLOW_LIST_NAMES: ReadonlySet<string> = new Set<string>(
  DRIFT_ALLOW_LIST.map((entry) => entry.householdName),
);

export function isAllowListed(householdName: string): boolean {
  return DRIFT_ALLOW_LIST_NAMES.has(householdName);
}
