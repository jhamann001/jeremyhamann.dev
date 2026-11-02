import { describe, it, expect } from 'vitest';
import { DRIFT_ALLOW_LIST, type DriftAllowListEntry } from '@/lib/trade-requests/drift/registry-drift-allow-list';

/**
 * Regression guard mandated by the source plan and the ticket blueprint:
 * every household name in `DRIFT_ALLOW_LIST` MUST appear at least once in the
 * runtime active_accounts loader's household name set. A typo on either side,
 * or a legitimate household rename in Meridian that misses the allow-list
 * update, would otherwise silently break alert suppression — the household
 * would still be persisted under its new name but the allow-list would key
 * off the old name and the page would fire on every nightly run.
 *
 * 2026-Q3 Meridian-format cutover: the static `households.json` file and
 * the `importHouseholds.mjs` regeneration script are retired. The runtime
 * household source is now the Meridian active_accounts JSON file under
 * `gs://${MERIDIAN_SNAPSHOT_BUCKET}/meridian/active_accounts/`. The
 * allow-list contract is identical — only the diagnostic message and the
 * fixture-load step are updated.
 *
 * The failure message below is the verbatim diagnostic template from the
 * plan's "Allow-list contract" section so the on-call engineer reading red
 * CI has the diagnostic loop spelled out without spelunking through the
 * test file.
 */

// Empty as of the 2026-Q3 positions-vs-Meridian drift cutover (plan
// `docs/plans/2026-q3-position-drift.md` §5.G + §12 Q2 RESOLVED 2026-05-13).
const REQUIRED_LAUNCH_ENTRIES: readonly string[] = [];

function buildDiagnostic(entry: DriftAllowListEntry): string {
  return [
    `Household "${entry.householdName}" is in DRIFT_ALLOW_LIST`,
    `(reason: ${entry.reason}; notes: ${entry.notes}) but no row in`,
    'the runtime active_accounts loader has this householdName.',
    '',
    'Was the household renamed in the Meridian active_accounts export?',
    '  - If YES: update DRIFT_ALLOW_LIST in the same PR that uploads',
    '    the new active_accounts JSON to',
    '    gs://${MERIDIAN_SNAPSHOT_BUCKET}/meridian/active_accounts/.',
    '  - If NO: this is a typo — fix either the Meridian export or',
    '    the allow-list so they match.',
  ].join('\n');
}

describe('DRIFT_ALLOW_LIST', () => {
  it('contains every launch entry mandated by the source plan', () => {
    const names = DRIFT_ALLOW_LIST.map((entry) => entry.householdName);
    for (const required of REQUIRED_LAUNCH_ENTRIES) {
      expect(names).toContain(required);
    }
  });

  it('requires a non-empty `notes` field on every entry', () => {
    for (const entry of DRIFT_ALLOW_LIST) {
      expect(
        entry.notes.trim().length,
        `DRIFT_ALLOW_LIST entry "${entry.householdName}" has an empty notes field — notes are mandatory so a future maintainer can distinguish "typo" from "household renamed"`,
      ).toBeGreaterThan(0);
    }
  });

  it('every allow-list householdName appears in the runtime household source', () => {
    // Short-circuit: with DRIFT_ALLOW_LIST empty post-cutover, there is no
    // household to verify against the active_accounts loader. When entries
    // are re-added in a future PR, replace this guard with a real
    // `loadMeridianActiveAccountsFromFile()` call against a checked-in
    // fixture. The diagnostic string above already documents the new
    // workflow so the next maintainer has a paved path.
    if (DRIFT_ALLOW_LIST.length === 0) {
      expect(DRIFT_ALLOW_LIST).toEqual([]);
      return;
    }

    // Unreachable until allow-list re-populates. Kept as a compile-time
    // reminder that the contract requires an active_accounts load step.
    throw new Error('DRIFT_ALLOW_LIST is non-empty but no active_accounts fixture is wired in this test yet.');
  });

  it('the diagnostic template renders correctly for a hypothetical rename (self-test of the message)', () => {
    const fake: DriftAllowListEntry = {
      householdName: 'Renamed Family',
      reason: 'awaiting_mirror_mode',
      unblocksWhenPlanShips: 'docs/plans/example.md',
      notes: 'Hypothetical for the diagnostic self-test.',
    };
    const message = buildDiagnostic(fake);
    expect(message).toContain('Household "Renamed Family" is in DRIFT_ALLOW_LIST');
    expect(message).toContain('reason: awaiting_mirror_mode');
    expect(message).toContain('Was the household renamed in the Meridian active_accounts export?');
    expect(message).toContain('meridian/active_accounts/');
  });
});
