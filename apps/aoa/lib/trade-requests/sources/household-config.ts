import { z } from 'zod';

/**
 * Canonical type definitions for the runtime household-mapping layer.
 *
 * History: prior to the 2026-Q3 Meridian-format cutover, this module also
 * owned a synchronous `loadHouseholdConfig()` reader against the committed
 * `server/src/config/households.json` file plus an `importHouseholds.mjs`
 * upstream generator. Both are retired — the Meridian `active_accounts.json`
 * GCS file is now the runtime household source (see
 * `server/src/services/meridianActiveAccounts.ts`).
 *
 * What stays here:
 *   - `HouseholdEntry` / `HouseholdConfig` interfaces (the shape consumed by
 *     `positionDriftAccounts.ts`, `registryDrift.ts`, etc.)
 *   - The `HouseholdEntrySchema` Zod schema (re-used by the active_accounts
 *     loader to validate its emitted entries).
 *   - The `HouseholdConfigError` class (typed error surface for loaders).
 *
 * What is gone:
 *   - `loadHouseholdConfig()` (sync, file-based — replaced by the GCS loader)
 *   - `_loadHouseholdConfigFrom(path)` (test-only file loader — replaced by
 *     `loadMeridianActiveAccountsFromFile(path)`)
 *   - `resetHouseholdConfigForTests()` (no per-process cache to reset)
 *   - `parseConfig` / `defaultConfigPath` helpers (now in the loader)
 *
 * See `docs/plans/2026-q3-drift-v2-meridian-format-cutover.md`.
 */

export class HouseholdConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HouseholdConfigError';
  }
}

export const HouseholdEntrySchema = z.object({
  accountNumber: z.string().min(1),
  householdName: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, 'householdName must be non-blank'),
  accountTitle: z.string().optional(),
  /**
   * Apex household identifier (additive — defaults to undefined for back-compat
   * with consumers that don't read it). Populated when the source is the
   * Meridian active_accounts.json export; absent on synthetic test fixtures
   * that only need the householdName mapping.
   */
  householdId: z.number().int().positive().optional(),
  /**
   * Account-type metadata from active_accounts.json (e.g. "NA", "NA non-taxable").
   * Additive — used by the drift tax layer to gate the transition-candidate flag
   * to taxable accounts. Absent on synthetic fixtures.
   */
  accountType: z.string().optional(),
});

export interface HouseholdEntry {
  accountNumber: string;
  householdName: string;
  accountTitle?: string;
  householdId?: number;
  accountType?: string;
}

/**
 * Is an account taxable (for gating the tax-transition-candidate flag)?
 *
 * Authoritative signal: Apex `apex_daily_accounts.ownership_type` ∈
 * {INDIVIDUAL, JOINT, ENTITY, RETIREMENT} — only RETIREMENT is non-taxable.
 * When ownership_type is unavailable, fall back to the messy active_accounts
 * `account_type` string (observed values: NA, NA non-taxable, S1, IRA, FB) —
 * treating any retirement-ish marker as non-taxable. Unknown on BOTH → not
 * taxable, so the flag stays conservative (never mislabels an unconfirmable
 * account as a transition candidate).
 */
const NON_TAXABLE_ACCOUNT_TYPE_RE = /non[-\s]?taxable|\bira\b|roth|sep|simple|401|403|retire/i;

export function isTaxableAccount(ownershipType: string | undefined, accountType: string | undefined): boolean {
  if (ownershipType) return ownershipType.trim().toUpperCase() !== 'RETIREMENT';
  if (!accountType) return false;
  return !NON_TAXABLE_ACCOUNT_TYPE_RE.test(accountType);
}

export interface HouseholdConfig {
  byAccountNumber: ReadonlyMap<string, HouseholdEntry>;
  householdNames: ReadonlySet<string>;
  entries: readonly HouseholdEntry[];
}
