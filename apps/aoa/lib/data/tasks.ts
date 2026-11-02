import { withUserScope } from "@/lib/rls";
import { Prisma } from "@prisma/client";
import type { Identity, HouseholdTask } from "./types";

// REAL read: a household's CRM tasks, RLS-scoped via withUserScope. The
// mirror.task policies scope rows to the caller's book (Ops/Admin see the firm;
// an advisor sees tasks only for households in their book — the EXISTS-join
// rides mirror.household's own RLS). Newest first; nulls sort last.
//
// `source_modified_at` is a Postgres timestamptz → a Date at runtime, which is
// serializable across the Server→Client boundary — leave it as-is.
export async function tasksForHousehold(
  id: Identity,
  householdSfId: string,
): Promise<HouseholdTask[]> {
  return tasksForHouseholdSources(id, [householdSfId]);
}

export async function tasksForHouseholdSources(
  id: Identity,
  householdSfIds: string[],
): Promise<HouseholdTask[]> {
  const keys = [
    ...new Set(householdSfIds.filter(Boolean).map((value) => value.slice(0, 15))),
  ].slice(0, 16);
  if (keys.length === 0) return [];
  return withUserScope(id, (tx) =>
    tx.$queryRaw<HouseholdTask[]>(Prisma.sql`
      SELECT sf_id, subject, status, priority, description, source_modified_at
      FROM mirror.task
      WHERE left(household_sf_id, 15) IN (${Prisma.join(keys)})
      ORDER BY source_modified_at DESC NULLS LAST`),
  );
}
