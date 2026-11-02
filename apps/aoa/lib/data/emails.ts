import { withUserScope } from "@/lib/rls";
import { Prisma } from "@prisma/client";
import type { Identity, HouseholdEmail } from "./types";
import { EMAIL_BODY_WITHOUT_BCC } from "./email-body";

// REAL read: a household's CRM emails, RLS-scoped via withUserScope. The
// mirror.email policies scope rows to the caller's book (Ops/Admin see the firm;
// an advisor sees emails only for households in their book — the EXISTS-join
// rides mirror.household's own RLS). Newest first; nulls sort last. Capped at 50
// (the card renders all returned rows in a capped-height scroll box — 50 recent
// is a generous ceiling without dragging the whole history / a heavy payload;
// matches activityForHousehold).
//
// `sent_at`/`source_modified_at` are Postgres timestamptz → Date at runtime,
// which is serializable across the Server→Client boundary — leave them as-is.
export async function emailsForHousehold(
  id: Identity,
  householdSfId: string,
): Promise<HouseholdEmail[]> {
  return emailsForHouseholdSources(id, [householdSfId]);
}

export async function emailsForHouseholdSources(
  id: Identity,
  householdSfIds: string[],
): Promise<HouseholdEmail[]> {
  const keys = [
    ...new Set(householdSfIds.filter(Boolean).map((value) => value.slice(0, 15))),
  ].slice(0, 16);
  if (keys.length === 0) return [];
  return withUserScope(id, (tx) =>
    tx.$queryRaw<HouseholdEmail[]>(Prisma.sql`
      SELECT sf_id, subject, ${EMAIL_BODY_WITHOUT_BCC} AS body, sent_at, source_modified_at, email_envelope
      FROM mirror.email
      WHERE left(household_sf_id, 15) IN (${Prisma.join(keys)})
      ORDER BY sent_at DESC NULLS LAST
      LIMIT 50`),
  );
}
