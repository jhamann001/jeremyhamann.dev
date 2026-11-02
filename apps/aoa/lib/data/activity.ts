import { withUserScope } from "@/lib/rls";
import { Prisma } from "@prisma/client";
import type { Identity, HouseholdActivity } from "./types";

// REAL read: a household's CRM call activity, RLS-scoped via withUserScope.
// The mirror.activity policies scope rows to the caller's book (Ops/Admin see
// the firm; an advisor sees activity only for households in their book — the
// EXISTS-join rides mirror.household's own RLS). Newest first; nulls sort last.
// Capped at 50 (a generous ceiling for the "Activity & notes" card without
// dragging the whole call history).
//
// `activity_at`/`source_modified_at` are Postgres timestamptz → Date at
// runtime, which is serializable across the Server→Client boundary — leave them
// as-is.
export async function activityForHousehold(
  id: Identity,
  householdSfId: string,
): Promise<HouseholdActivity[]> {
  return activityForHouseholdSources(id, [householdSfId]);
}

export async function activityForHouseholdSources(
  id: Identity,
  householdSfIds: string[],
): Promise<HouseholdActivity[]> {
  const keys = [
    ...new Set(householdSfIds.filter(Boolean).map((value) => value.slice(0, 15))),
  ].slice(0, 16);
  if (keys.length === 0) return [];
  return withUserScope(id, (tx) =>
    tx.$queryRaw<HouseholdActivity[]>(Prisma.sql`
      SELECT sf_id, subject, note, activity_at, owner_name, source_modified_at
      FROM mirror.activity
      WHERE left(household_sf_id, 15) IN (${Prisma.join(keys)})
      ORDER BY activity_at DESC NULLS LAST
      LIMIT 50`),
  );
}
