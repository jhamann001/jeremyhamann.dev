import { withUserScope } from "@/lib/rls";
import { crmIdentityReadsEnabled } from "@/lib/flags";
import type { Identity } from "./types";
import { householdDisplayCtes } from "./household-display";
import { investmentAccountBaseSql } from "./investment-accounts";
import {
  canSeeFirmHousehold, FIRM_HOUSEHOLD_ID, FIRM_HOUSEHOLD_NAME,
} from "./firm-household";
import {
  applyHouseholdDirectoryDatabaseBounds, HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS,
} from "./household-directory-bounds";

export type HouseholdPickerTarget = {
  sf_id: string;
  name: string;
  source_names: string[];
};

/** Identity-only targets for the ACAT picker. The picker needs no balances,
 * deals, employee badges, or member counts. Keep canonical labels and aliases
 * inside the caller's RLS scope, with deterministic name/id ordering instead
 * of the financial directory's effective-AUM ordering.
 *
 * Preserve the existing synthetic firm target when any confirmed firm account
 * is present. Existence includes closed, zero-valued and pending accounts; it
 * does not depend on a balance being current or positive.
 */
export async function listHouseholdPickerTargets(id: Identity): Promise<HouseholdPickerTarget[]> {
  return withUserScope(id, async tx => {
    await applyHouseholdDirectoryDatabaseBounds(tx);
    return tx.$queryRaw<HouseholdPickerTarget[]>`
      WITH ${householdDisplayCtes(crmIdentityReadsEnabled())}, picker_targets AS (
        SELECT sf_id, display_name AS name, source_names FROM household_display
        UNION ALL
        SELECT ${FIRM_HOUSEHOLD_ID}::text, ${FIRM_HOUSEHOLD_NAME}::text,
               ARRAY[${FIRM_HOUSEHOLD_NAME}]::text[]
         WHERE ${canSeeFirmHousehold(id.role)}
           AND EXISTS (
             SELECT 1 FROM (${investmentAccountBaseSql()}) account
              WHERE account.is_firm AND account.confirmed
           )
      )
      SELECT sf_id, name, source_names FROM picker_targets
       ORDER BY lower(name), name, sf_id`;
  }, HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS);
}
