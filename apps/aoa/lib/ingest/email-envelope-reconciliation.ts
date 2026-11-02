import { Prisma } from "@prisma/client";
import { EMAIL_BODY_HAS_LOGGED_BCC, EMAIL_BODY_WITHOUT_BCC } from "@/lib/data/email-body";
import { sameSourceId, type EmailEnvelope } from "@/lib/email-search/envelope";
import { emailEnvelopeAssignment } from "./email-envelope";

export type EmailEnvelopeObservation = { sf_id: string; household_sf_id: string; email_envelope: EmailEnvelope };
export type EnvelopeReconciliation = {
  received: number; distinct: number; duplicateRows: number; conflictingRecords: number;
  ambiguousStored: number; missingStored: number; householdMismatch: number; stale: number;
  unchanged: number; wouldUpdate: number; updated: number;
};
const stable = (v: unknown): string => JSON.stringify(v, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

// The ingest role already has SELECT/UPDATE under FORCE RLS. No insert, deletion,
// body, source timestamp or household update is possible through this path.
export async function reconcileEmailEnvelopeBatch(
  tx: Prisma.TransactionClient, items: EmailEnvelopeObservation[], apply = false,
): Promise<EnvelopeReconciliation> {
  const groups = new Map<string, EmailEnvelopeObservation[]>();
  for (const item of items) {
    const key = item.sf_id.slice(0, 15);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const result: EnvelopeReconciliation = { received: items.length, distinct: groups.size, duplicateRows: items.length - groups.size,
    conflictingRecords: 0, ambiguousStored: 0, missingStored: 0, householdMismatch: 0, stale: 0, unchanged: 0, wouldUpdate: 0, updated: 0 };
  for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const first = group[0];
    if (group.some(item => stable(item) !== stable(first))) { result.conflictingRecords += 1; continue; }
    const rows = await tx.$queryRaw<Array<{ sf_id: string; household_sf_id: string; email_envelope: EmailEnvelope | null; proposed: EmailEnvelope }>>(Prisma.sql`
      SELECT sf_id, household_sf_id, email_envelope, ${emailEnvelopeAssignment(first.email_envelope)} AS proposed
      FROM mirror.email WHERE left(sf_id, 15) = ${first.sf_id.slice(0, 15)} ORDER BY sf_id FOR UPDATE`);
    if (!rows.length) { result.missingStored += 1; continue; }
    if (rows.length !== 1) { result.ambiguousStored += 1; continue; }
    const row = rows[0];
    if (!sameSourceId(row.household_sf_id, first.household_sf_id)) { result.householdMismatch += 1; continue; }
    if (stable(row.proposed) === stable(row.email_envelope)) {
      const { observed_at: _prior, ...priorContent } = row.email_envelope ?? {};
      const { observed_at: _incoming, ...newContent } = first.email_envelope;
      if (stable(priorContent) === stable(newContent)) result.unchanged += 1;
      else result.stale += 1;
      continue;
    }
    result.wouldUpdate += 1;
    if (apply) {
      result.updated += await tx.$executeRaw`UPDATE mirror.email SET email_envelope = ${JSON.stringify(row.proposed)}::jsonb
        WHERE sf_id = ${row.sf_id} AND household_sf_id = ${row.household_sf_id}`;
    }
  }
  return result;
}

export async function emailEnvelopeReconciliationCoverage(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ total: bigint; matched: bigint; missing: bigint; unavailable: bigint; ambiguous: bigint; unknown: bigint; loggedBccHeaderRows: bigint }>>`
    SELECT count(*)::bigint AS total,
      count(*) FILTER (WHERE email_envelope->>'state' = 'MATCHED')::bigint AS matched,
      count(*) FILTER (WHERE email_envelope->>'state' = 'MISSING')::bigint AS missing,
      count(*) FILTER (WHERE email_envelope->>'state' = 'UNAVAILABLE')::bigint AS unavailable,
      count(*) FILTER (WHERE email_envelope->>'state' = 'AMBIGUOUS')::bigint AS ambiguous,
      count(*) FILTER (WHERE email_envelope IS NULL)::bigint AS unknown,
      -- A subset of total, not another envelope state. Only the row count leaves
      -- the database; metadata preview/apply never rewrite legacy bodies.
      count(*) FILTER (WHERE ${EMAIL_BODY_HAS_LOGGED_BCC})::bigint AS "loggedBccHeaderRows"
      FROM mirror.email`;
  return Object.fromEntries(Object.entries(row).map(([key, count]) => [key, Number(count)]));
}

// Separate from metadata reconciliation: only this explicit, preview-first
// operation can rewrite logged Bcc headers in stored bodies. No row leaves SQL.
export class EmailBodyCleanupConflict extends Error {}
export async function stripLoggedBccBatch(tx: Prisma.TransactionClient, apply = false, expectedRemaining?: number) {
  // One transaction lock binds the count guard and batch; concurrent cleanups
  // cannot both apply the same approved remaining-count snapshot.
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(22020261016::bigint)::text`;
  const count = async () => {
    const [row] = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM mirror.email WHERE ${EMAIL_BODY_HAS_LOGGED_BCC}`;
    const value = Number(row.count);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("cleanup_count_invalid");
    return value;
  };
  const eligible = await count();
  if (apply && expectedRemaining !== eligible) throw new EmailBodyCleanupConflict();
  const wouldUpdate = Math.min(eligible, 500);
  let updated = 0;
  if (apply && wouldUpdate) {
    const [row] = await tx.$queryRaw<Array<{ count: bigint }>>`
      WITH selected AS MATERIALIZED (
        SELECT sf_id FROM mirror.email WHERE ${EMAIL_BODY_HAS_LOGGED_BCC}
        ORDER BY sf_id LIMIT 500 FOR UPDATE
      ), cleaned AS (
        UPDATE mirror.email e SET body = ${EMAIL_BODY_WITHOUT_BCC}
        FROM selected WHERE e.sf_id = selected.sf_id RETURNING 1
      ) SELECT count(*)::bigint AS count FROM cleaned`;
    updated = Number(row.count);
  }
  const remaining = apply ? await count() : eligible;
  if (apply && (updated !== wouldUpdate || remaining !== eligible - updated)) throw new Error("cleanup_reconciliation_failed");
  return { eligible, wouldUpdate, updated, remaining };
}
