import "server-only";

import { Prisma } from "@prisma/client";
import { crmIdentityReadsEnabled } from "@/lib/flags";
import { withUserScope, type Identity } from "@/lib/rls";
import { canViewCrmId } from "@/lib/crm/visibility";

export const CRM_PARENT_CANDIDATE_LIMIT = 20;

const PARENT_TYPES: Record<string, readonly string[]> = {
  CONTACT: ["HOUSEHOLD"],
  DEAL: ["HOUSEHOLD", "CONTACT"],
  TRANSFER: ["HOUSEHOLD", "CONTACT"],
  EMAIL: ["HOUSEHOLD"],
  ACTIVITY: ["HOUSEHOLD"],
  TASK: ["HOUSEHOLD"],
  APPOINTMENT: ["CONTACT", "HOUSEHOLD"],
};

export type CrmParentCandidate = {
  crmId: string;
  identityType: string;
  displayName: string | null;
  sourceSystem: string;
  sourceNamespace: string;
  sourceKey: string;
};

export type CrmParentCandidateSearchResult =
  | { status: "complete"; candidates: CrmParentCandidate[] }
  | { status: "failed"; candidates: [] };

export type CrmParentOverrideRow = {
  id: string;
  source_mapping_id: string;
  child_identity_id: string;
  parent_identity_id: string;
  parent_identity_type: string;
  relationship_code: string;
  confirmed_by: string;
  confirmed_at: Date;
};

export function allowedCrmParentTypes(childType: string): readonly string[] {
  return PARENT_TYPES[childType] ?? [];
}

export function crmParentSuggestionQuery(displayName: string | null | undefined): string {
  const name = displayName?.split("·")[0]?.trim() ?? "";
  const tokens = name.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? [];
  const useful = tokens.filter((token) => !["and", "appointment", "meeting"].includes(token.toLowerCase()));
  return (useful.at(-1) ?? "").slice(0, 100);
}

function likePattern(value: string): string {
  return `%${value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

function isCrmParentId(value: string): boolean {
  return /^(?:con|hld)_[A-Za-z0-9_-]{3,96}$/i.test(value);
}

export function crmParentRelationshipLabel(code: string): string {
  const parent = code.endsWith("_TO_CONTACT") ? "contact" : "household";
  return `For ${parent} · manually confirmed`;
}

export async function readCrmParentOverrides(
  tx: Prisma.TransactionClient,
  childIdentityId: string,
): Promise<CrmParentOverrideRow[]> {
  return tx.$queryRaw<CrmParentOverrideRow[]>(Prisma.sql`
    SELECT o.id, o.source_mapping_id, o.child_identity_id, o.parent_identity_id,
           p.identity_type AS parent_identity_type, o.relationship_code,
           o.confirmed_by, o.confirmed_at
      FROM app.crm_parent_override o
      JOIN app.crm_identity p ON p.id = o.parent_identity_id
     WHERE o.child_identity_id = ${childIdentityId}
     ORDER BY o.confirmed_at, o.id`);
}

export async function searchCrmParentCandidates(
  identity: Identity,
  childType: string,
  query: string,
): Promise<CrmParentCandidate[]> {
  if (!crmIdentityReadsEnabled() || !canViewCrmId(identity.role)) return [];
  const parentTypes = allowedCrmParentTypes(childType);
  const q = query.trim().slice(0, 100);
  if (!q || parentTypes.length === 0) return [];
  const pattern = likePattern(q);
  const internalIdMatches = isCrmParentId(q)
    ? Prisma.sql`
        UNION ALL
        SELECT m.identity_id AS crm_id,
               CASE m.source_namespace
                 WHEN 'household' THEN 'HOUSEHOLD'::text
                 ELSE 'CONTACT'::text
               END AS identity_type,
               m.source_system, m.source_namespace, m.source_key,
               CASE m.source_namespace
                 WHEN 'household' THEN h.name
                 ELSE nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '')
               END AS display_name
          FROM app.crm_source_mapping m
          LEFT JOIN mirror.household h
            ON m.source_namespace = 'household'
           AND left(h.sf_id, 15) = left(m.source_key, 15)
          LEFT JOIN mirror.client c
            ON m.source_namespace = 'contact'
           AND left(c.sf_id, 15) = left(m.source_key, 15)
         WHERE m.identity_id = ${q}
           AND m.mapping_state = 'ACTIVE'
           AND m.source_system = 'CRM'
           AND m.source_namespace IN ('household', 'contact')`
    : Prisma.empty;

  return withUserScope(identity, async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', '10000', true)`;
    return tx.$queryRaw<CrmParentCandidate[]>(Prisma.sql`
      WITH source_matches AS MATERIALIZED (
        SELECT 'HOUSEHOLD'::text AS identity_type,
               'household'::text AS source_namespace,
               left(h.sf_id, 15) AS canonical_source_key,
               h.name AS display_name
          FROM mirror.household h
         WHERE h.sf_id IS NOT NULL
           AND (
             h.sf_id ILIKE ${pattern} ESCAPE '\\'
             OR h.name ILIKE ${pattern} ESCAPE '\\'
           )
        UNION ALL
        SELECT 'CONTACT'::text AS identity_type,
               'contact'::text AS source_namespace,
               left(c.sf_id, 15) AS canonical_source_key,
               nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '') AS display_name
          FROM mirror.client c
         WHERE c.sf_id IS NOT NULL
           AND (
             c.sf_id ILIKE ${pattern} ESCAPE '\\'
             OR nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '')
                ILIKE ${pattern} ESCAPE '\\'
           )
      ), matching_mappings AS MATERIALIZED (
        SELECT m.identity_id AS crm_id, source.identity_type,
               m.source_system, m.source_namespace, m.source_key,
               source.display_name
          FROM source_matches source
          JOIN LATERAL (
            SELECT candidate.identity_id, candidate.source_system,
                   candidate.source_namespace, candidate.source_key
              FROM app.crm_source_mapping candidate
             WHERE candidate.mapping_state = 'ACTIVE'
               AND candidate.source_system = 'CRM'
               AND candidate.source_namespace = source.source_namespace
               AND left(candidate.source_key, 15) = source.canonical_source_key
             ORDER BY candidate.first_seen_at, candidate.id
             LIMIT 10
          ) m ON true
        ${internalIdMatches}
      ), choices AS (
        SELECT DISTINCT ON (candidate.crm_id) candidate.*
          FROM matching_mappings candidate
          JOIN app.crm_identity i
            ON i.id = candidate.crm_id
           AND i.lifecycle_state = 'ACTIVE'
           AND i.identity_type = candidate.identity_type
           AND i.identity_type IN (${Prisma.join(parentTypes)})
         ORDER BY candidate.crm_id, (candidate.display_name IS NULL),
                  candidate.source_namespace, candidate.source_key
      )
      SELECT crm_id AS "crmId", identity_type AS "identityType",
             display_name AS "displayName", source_system AS "sourceSystem",
             source_namespace AS "sourceNamespace", source_key AS "sourceKey"
        FROM choices
       ORDER BY display_name NULLS LAST, crm_id
       LIMIT ${CRM_PARENT_CANDIDATE_LIMIT}`);
  }, { timeout: 15_000, maxWait: 5_000 });
}

export async function searchCrmParentCandidatesForReview(
  identity: Identity,
  childType: string,
  query: string,
): Promise<CrmParentCandidateSearchResult> {
  try {
    return {
      status: "complete",
      candidates: await searchCrmParentCandidates(identity, childType, query),
    };
  } catch {
    // Keep client names, CRM IDs, and database details out of logs while still
    // distinguishing an unavailable search from a valid zero-result search.
    console.error(JSON.stringify({
      severity: "ERROR",
      event: "crm_parent_candidate_search_failed",
      component: "crm_explorer",
    }));
    return { status: "failed", candidates: [] };
  }
}

export type ConfirmCrmParentResult = "saved" | "forbidden" | "invalid";

export async function confirmCrmParentOverride(
  identity: Identity,
  input: { exceptionId: string; childCrmId: string; parentCrmId: string },
): Promise<ConfirmCrmParentResult> {
  if (!crmIdentityReadsEnabled() || !canViewCrmId(identity.role) || !identity.email) {
    return "forbidden";
  }
  const exceptionId = input.exceptionId.trim();
  const childCrmId = input.childCrmId.trim();
  const parentCrmId = input.parentCrmId.trim();
  const internalId = /^[A-Za-z0-9_-]{5,128}$/;
  if (!internalId.test(exceptionId) || !internalId.test(childCrmId) || !internalId.test(parentCrmId)) {
    return "invalid";
  }

  try {
    const rows = await withUserScope(identity, (tx) => tx.$queryRaw<Array<{
      saved_override_id: string;
      saved_relationship_code: string;
    }>>(Prisma.sql`
      SELECT * FROM app.confirm_crm_parent_override(
        ${exceptionId}, ${childCrmId}, ${parentCrmId}
      )`));
    return rows.length === 1 ? "saved" : "invalid";
  } catch {
    // Fail closed without revealing whether an exception, source mapping, or
    // candidate CRM identity was absent or outside the caller's permissions.
    return "invalid";
  }
}
