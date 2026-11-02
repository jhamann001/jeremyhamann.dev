import type { EmailEnvelopeCoverage } from "@/lib/email-search/envelope";
import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import { crmCanonicalHouseholdSourceKeys } from "@/lib/crm/resolve";
import { isHouseholdHistoryId } from "@/lib/navigation/household-history-query";
import { EMAIL_SEARCH_PAGE_SIZE, normalizeEmailSearchTerm } from "@/lib/email-search/term";
import { EMAIL_BODY_WITHOUT_BCC } from "./email-body";
import type { HouseholdEmail, Identity } from "./types";

// ticket: subject, retained body and authoritative sender/To/Cc metadata. Server-side over
// every authorized stored email for the household, not a filter over loaded rows.
// Same household resolution and RLS path as the paged history read
// (lib/data/household-history.ts): the canonical group is resolved again on every
// request, then mirror.household / mirror.email RLS decide what the caller can see.
// Matching is literal and case-insensitive (strpos over lower()), so %, _ and regex
// metacharacters are ordinary characters. Bcc header lines are removed from the
// searchable and returned body (EMAIL_BODY_WITHOUT_BCC).
//
// The term is never logged, stored or put in a snapshot: the snapshot binds a hash.

export type HouseholdEmailSearchPage = {
  rows: HouseholdEmail[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  /** All stored emails visible to the caller for this household (the searched population). */
  searched: number;
  metadataCoverage: EmailEnvelopeCoverage;
  snapshot: string;
};

export async function searchHouseholdEmails(
  identity: Identity,
  householdId: string,
  rawTerm: unknown,
  { page = 1 }: { page?: number } = {},
): Promise<HouseholdEmailSearchPage | null> {
  const term = normalizeEmailSearchTerm(rawTerm);
  if (!term || !isHouseholdHistoryId(householdId)) return null;
  const resolved = await crmCanonicalHouseholdSourceKeys(identity, householdId);
  const keys = [...new Set(resolved.filter(Boolean).map(key => key.slice(0, 15)))].sort();
  if (!keys.length || keys.length > 16) return null;
  const requestedPage = Number.isFinite(page) ? Math.max(1, Math.min(1_000_000, Math.trunc(page))) : 1;
  const size = EMAIL_SEARCH_PAGE_SIZE;
  const needle = term.toLowerCase();
  return withUserScope(identity, async tx => {
    const visible = await tx.$queryRaw<Array<{ sf_id: string }>>(Prisma.sql`
      SELECT sf_id FROM mirror.household WHERE left(sf_id, 15) IN (${Prisma.join(keys)}) ORDER BY sf_id`);
    if (!visible.length) return null;
    const visibleKeys = [...new Set(visible.map(row => row.sf_id.slice(0, 15)))].sort();
    const where = Prisma.sql`left(household_sf_id, 15) IN (${Prisma.join(visibleKeys)})`;
    const matches = Prisma.sql`(strpos(lower(coalesce(subject, '')), lower(${needle})) > 0
      OR strpos(lower(coalesce(${EMAIL_BODY_WITHOUT_BCC}, '')), lower(${needle})) > 0
      OR (email_envelope->>'state' = 'MATCHED' AND (
        strpos(lower(coalesce(email_envelope->'sender'->>'name', '')), lower(${needle})) > 0
        OR strpos(lower(coalesce(email_envelope->'sender'->>'address', '')), lower(${needle})) > 0
        OR EXISTS (SELECT 1 FROM jsonb_array_elements((email_envelope->'to') || (email_envelope->'cc')) AS recipient
          WHERE strpos(lower(coalesce(recipient->>'name', '')), lower(${needle})) > 0
            OR strpos(lower(coalesce(recipient->>'address', '')), lower(${needle})) > 0))))`;
    // Bind coverage and matches to the same stored population; never hash bodies.
    const [counts] = await tx.$queryRaw<Array<{ searched: bigint; total: bigint; version: string; matched: bigint; enriched: bigint; missing: bigint; unavailable: bigint; ambiguous: bigint; unknown: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS searched,
        count(*) FILTER (WHERE email_envelope->>'state' = 'MATCHED')::bigint AS matched,
        count(*) FILTER (WHERE email_envelope->>'state' = 'MATCHED' AND (email_envelope->'sender' <> 'null'::jsonb OR jsonb_array_length(email_envelope->'to') > 0 OR jsonb_array_length(email_envelope->'cc') > 0))::bigint AS enriched,
        count(*) FILTER (WHERE email_envelope->>'state' = 'MISSING')::bigint AS missing,
        count(*) FILTER (WHERE email_envelope->>'state' = 'UNAVAILABLE')::bigint AS unavailable,
        count(*) FILTER (WHERE email_envelope->>'state' = 'AMBIGUOUS')::bigint AS ambiguous,
        count(*) FILTER (WHERE email_envelope IS NULL)::bigint AS unknown,
        count(*) FILTER (WHERE ${matches})::bigint AS total,
        md5(coalesce(string_agg(sf_id || ':' || xmin::text, ',' ORDER BY sf_id), '')) AS version
      FROM mirror.email WHERE ${where}`);
    const total = Number(counts?.total ?? 0);
    const pageCount = Math.max(1, Math.ceil(total / size));
    const currentPage = Math.min(requestedPage, pageCount);
    const rows = total === 0 ? [] : await tx.$queryRaw<HouseholdEmail[]>(Prisma.sql`
      SELECT sf_id, subject, ${EMAIL_BODY_WITHOUT_BCC} AS body, sent_at, source_modified_at, email_envelope
      FROM mirror.email WHERE ${where} AND ${matches}
      ORDER BY sent_at DESC NULLS LAST, sf_id ASC LIMIT ${size} OFFSET ${(currentPage - 1) * size}`);
    const snapshot = createHash("sha256").update(JSON.stringify({
      kind: "email-search", term: createHash("sha256").update(needle).digest("hex"),
      sourceKeys: keys, visibleKeys, total, version: counts?.version ?? "",
    })).digest("hex");
    return { rows, page: currentPage, pageSize: size, total, pageCount,
      searched: Number(counts?.searched ?? 0), snapshot,
      metadataCoverage: { matched: Number(counts?.matched ?? 0), enriched: Number(counts?.enriched ?? 0), missing: Number(counts?.missing ?? 0), unavailable: Number(counts?.unavailable ?? 0), ambiguous: Number(counts?.ambiguous ?? 0), unknown: Number(counts?.unknown ?? 0) } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
