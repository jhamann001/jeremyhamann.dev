import "server-only";

import { Prisma } from "@prisma/client";
import {
  CRM_ID_CATALOG,
  CRM_PHASE_4_DERIVATION_CATALOG,
  type CrmIdType,
} from "@/lib/crm/contracts";
import { crmRelationshipsEnabled } from "@/lib/flags";
import { withUserScope, type Identity } from "@/lib/rls";

export const CRM_RELATIONSHIP_READ_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
]);

export const CRM_RELATIONSHIP_TYPES = [
  "HOUSEHOLD_HAS_MEMBER",
  "DEAL_FOR_HOUSEHOLD",
  "TRANSFER_FOR_HOUSEHOLD",
] as const;

export type CrmRelationshipType = (typeof CRM_RELATIONSHIP_TYPES)[number];
export type CrmRelationshipDirection = "OUTGOING" | "INCOMING";

export const CRM_RELATIONSHIP_DEFAULT_DEPTH = 1;
export const CRM_RELATIONSHIP_MAX_DEPTH = 4;
export const CRM_RELATIONSHIP_ROW_LIMIT = 250;
export const CRM_RELATIONSHIP_TRANSACTION_TIMEOUT_MS = 15_000;
export const CRM_RELATIONSHIP_TRANSACTION_MAX_WAIT_MS = 5_000;

const CRM_RELATIONSHIP_TRANSACTION_OPTIONS = {
  timeout: CRM_RELATIONSHIP_TRANSACTION_TIMEOUT_MS,
  maxWait: CRM_RELATIONSHIP_TRANSACTION_MAX_WAIT_MS,
} as const;

const RELATIONSHIP_TYPES = new Set<string>(CRM_RELATIONSHIP_TYPES);
const CRM_ID_PATTERN = /^([a-z]{3})_[a-z0-9]+$/;
const CRM_ID_MAX_LENGTH = 64;

const TYPE_BY_PREFIX = new Map<string, CrmIdType>(
  Object.entries(CRM_ID_CATALOG).map(([type, contract]) => [
    contract.prefix,
    type as CrmIdType,
  ]),
);

const PHASE_4_ENDPOINT_TYPES = new Set<CrmIdType>(
  Object.values(CRM_PHASE_4_DERIVATION_CATALOG).flatMap((derivation) => [
    derivation.from.identityType,
    derivation.to.identityType,
  ]),
);

export type CrmRelationshipTraversalRow = {
  relationshipId: string;
  relationshipType: CrmRelationshipType;
  fromIdentityId: string;
  toIdentityId: string;
  parentIdentityId: string;
  endpointIdentityId: string;
  endpointIdentityType: CrmIdType;
  direction: CrmRelationshipDirection;
  depth: number;
};

export type CrmRelationshipTraversalFailureReason =
  | "forbidden"
  | "missing_context"
  | "disabled"
  | "invalid_identity_id"
  | "record_identity_id"
  | "unsupported_identity_type"
  | "invalid_depth"
  | "invalid_relationship_type"
  | "not_found"
  | "row_limit_exceeded";

export type CrmRelationshipTraversalResult =
  | {
      ok: true;
      rootIdentityId: string;
      rootIdentityType: CrmIdType;
      maxDepth: number;
      relationshipTypes: CrmRelationshipType[];
      rows: CrmRelationshipTraversalRow[];
    }
  | { ok: false; reason: CrmRelationshipTraversalFailureReason };

export type CrmRelationshipTraversalQuery = {
  maxDepth?: number;
  relationshipTypes?: readonly string[];
};

type ValidatedRoot =
  | { ok: true; type: CrmIdType }
  | { ok: false; reason: CrmRelationshipTraversalFailureReason };

type RawRoot = { id: string; identity_type: CrmIdType };

type RawTraversalRow = {
  relationship_id: string;
  relationship_type: CrmRelationshipType;
  from_identity_id: string;
  to_identity_id: string;
  parent_identity_id: string;
  endpoint_identity_id: string;
  endpoint_identity_type: CrmIdType;
  direction: CrmRelationshipDirection;
  depth: number;
};

export function canReadCrmRelationships(role: string | null | undefined): boolean {
  return CRM_RELATIONSHIP_READ_ROLES.has(role ?? "");
}

export function hasCrmRelationshipReadContext(identity: Identity): boolean {
  return canReadCrmRelationships(identity.role) && Boolean(identity.email?.trim());
}

export function validateCrmRelationshipRoot(value: string): ValidatedRoot {
  if (value.length < 5 || value.length > CRM_ID_MAX_LENGTH) {
    return { ok: false, reason: "invalid_identity_id" };
  }
  const match = CRM_ID_PATTERN.exec(value);
  if (!match) return { ok: false, reason: "invalid_identity_id" };

  const type = TYPE_BY_PREFIX.get(match[1]);
  if (!type || type === "RELATIONSHIP") {
    return { ok: false, reason: "invalid_identity_id" };
  }
  if (!CRM_ID_CATALOG[type].graphEndpoint) {
    return { ok: false, reason: "record_identity_id" };
  }
  if (!PHASE_4_ENDPOINT_TYPES.has(type)) {
    return { ok: false, reason: "unsupported_identity_type" };
  }
  return { ok: true, type };
}

export function normalizeCrmRelationshipDepth(value: unknown): number | null {
  if (value === undefined) return CRM_RELATIONSHIP_DEFAULT_DEPTH;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 1 && value <= CRM_RELATIONSHIP_MAX_DEPTH ? value : null;
}

export function normalizeCrmRelationshipTypes(
  values: readonly string[] | undefined,
): CrmRelationshipType[] | null {
  if (values === undefined) return [...CRM_RELATIONSHIP_TYPES];
  if (values.length === 0 || values.some((value) => !RELATIONSHIP_TYPES.has(value))) {
    return null;
  }
  return [...new Set(values as readonly CrmRelationshipType[])].sort();
}

function mapTraversalRow(row: RawTraversalRow): CrmRelationshipTraversalRow {
  return {
    relationshipId: row.relationship_id,
    relationshipType: row.relationship_type,
    fromIdentityId: row.from_identity_id,
    toIdentityId: row.to_identity_id,
    parentIdentityId: row.parent_identity_id,
    endpointIdentityId: row.endpoint_identity_id,
    endpointIdentityType: row.endpoint_identity_type,
    direction: row.direction,
    depth: row.depth,
  };
}

/**
 * Traverse the reviewed Phase 4 relationship graph for display and diagnostics.
 * This never resolves source keys, returns evidence, or answers authorization.
 */
export async function getCrmRelationshipTraversal(
  identity: Identity,
  rootIdentityId: string,
  query: CrmRelationshipTraversalQuery = {},
): Promise<CrmRelationshipTraversalResult> {
  if (!canReadCrmRelationships(identity.role)) {
    return { ok: false, reason: "forbidden" };
  }
  if (!hasCrmRelationshipReadContext(identity)) {
    return { ok: false, reason: "missing_context" };
  }
  if (!crmRelationshipsEnabled()) return { ok: false, reason: "disabled" };

  const root = validateCrmRelationshipRoot(rootIdentityId);
  if (!root.ok) return root;

  const maxDepth = normalizeCrmRelationshipDepth(query.maxDepth);
  if (maxDepth === null) return { ok: false, reason: "invalid_depth" };

  const relationshipTypes = normalizeCrmRelationshipTypes(query.relationshipTypes);
  if (relationshipTypes === null) {
    return { ok: false, reason: "invalid_relationship_type" };
  }

  return withUserScope(identity, async (tx) => {
    const roots = await tx.$queryRaw<RawRoot[]>(Prisma.sql`
      SELECT id, identity_type
        FROM app.crm_identity
       WHERE id = ${rootIdentityId}
         AND lifecycle_state = 'ACTIVE'
         AND merged_into_id IS NULL
       LIMIT 1`);
    const activeRoot = roots[0];
    if (!activeRoot || activeRoot.identity_type !== root.type) {
      return { ok: false as const, reason: "not_found" as const };
    }

    const rawRows = await tx.$queryRaw<RawTraversalRow[]>(Prisma.sql`
      WITH RECURSIVE eligible_edge AS MATERIALIZED (
        SELECT relationship.id AS relationship_id,
               relationship.relationship_type,
               relationship.from_identity_id,
               relationship.to_identity_id,
               from_identity.identity_type AS from_identity_type,
               to_identity.identity_type AS to_identity_type
          FROM app.crm_relationship relationship
          JOIN app.crm_identity from_identity
            ON from_identity.id = relationship.from_identity_id
           AND from_identity.lifecycle_state = 'ACTIVE'
           AND from_identity.merged_into_id IS NULL
          JOIN app.crm_identity to_identity
            ON to_identity.id = relationship.to_identity_id
           AND to_identity.lifecycle_state = 'ACTIVE'
           AND to_identity.merged_into_id IS NULL
         WHERE relationship.relationship_state = 'ACTIVE'
           AND relationship.relationship_type IN (${Prisma.join(relationshipTypes)})
      ), walk AS (
        SELECT edge.relationship_id,
               edge.relationship_type,
               edge.from_identity_id,
               edge.to_identity_id,
               ${rootIdentityId}::text AS parent_identity_id,
               CASE
                 WHEN edge.from_identity_id = ${rootIdentityId}
                   THEN edge.to_identity_id
                 ELSE edge.from_identity_id
               END AS endpoint_identity_id,
               CASE
                 WHEN edge.from_identity_id = ${rootIdentityId}
                   THEN edge.to_identity_type
                 ELSE edge.from_identity_type
               END AS endpoint_identity_type,
               CASE
                 WHEN edge.from_identity_id = ${rootIdentityId}
                   THEN 'OUTGOING'::text
                 ELSE 'INCOMING'::text
               END AS direction,
               1 AS depth,
               ARRAY[
                 ${rootIdentityId}::text,
                 CASE
                   WHEN edge.from_identity_id = ${rootIdentityId}
                     THEN edge.to_identity_id
                   ELSE edge.from_identity_id
                 END
               ]::text[] AS visited_identity_ids
          FROM eligible_edge edge
         WHERE edge.from_identity_id = ${rootIdentityId}
            OR edge.to_identity_id = ${rootIdentityId}

        UNION ALL

        SELECT edge.relationship_id,
               edge.relationship_type,
               edge.from_identity_id,
               edge.to_identity_id,
               walk.endpoint_identity_id,
               CASE
                 WHEN edge.from_identity_id = walk.endpoint_identity_id
                   THEN edge.to_identity_id
                 ELSE edge.from_identity_id
               END,
               CASE
                 WHEN edge.from_identity_id = walk.endpoint_identity_id
                   THEN edge.to_identity_type
                 ELSE edge.from_identity_type
               END,
               CASE
                 WHEN edge.from_identity_id = walk.endpoint_identity_id
                   THEN 'OUTGOING'::text
                 ELSE 'INCOMING'::text
               END,
               walk.depth + 1,
               walk.visited_identity_ids || CASE
                 WHEN edge.from_identity_id = walk.endpoint_identity_id
                   THEN edge.to_identity_id
                 ELSE edge.from_identity_id
               END
          FROM walk
          JOIN eligible_edge edge
            ON edge.from_identity_id = walk.endpoint_identity_id
            OR edge.to_identity_id = walk.endpoint_identity_id
         WHERE walk.depth < ${maxDepth}
           AND NOT (
             CASE
               WHEN edge.from_identity_id = walk.endpoint_identity_id
                 THEN edge.to_identity_id
               ELSE edge.from_identity_id
             END = ANY(walk.visited_identity_ids)
           )
      ), first_visit AS (
        SELECT DISTINCT ON (relationship_id)
               relationship_id,
               relationship_type,
               from_identity_id,
               to_identity_id,
               parent_identity_id,
               endpoint_identity_id,
               endpoint_identity_type,
               direction,
               depth
          FROM walk
         ORDER BY relationship_id, depth, parent_identity_id, endpoint_identity_id
      )
      SELECT relationship_id,
             relationship_type,
             from_identity_id,
             to_identity_id,
             parent_identity_id,
             endpoint_identity_id,
             endpoint_identity_type,
             direction,
             depth
        FROM first_visit
       ORDER BY depth, relationship_type, relationship_id, endpoint_identity_id
       LIMIT ${CRM_RELATIONSHIP_ROW_LIMIT + 1}`);

    if (rawRows.length > CRM_RELATIONSHIP_ROW_LIMIT) {
      return { ok: false as const, reason: "row_limit_exceeded" as const };
    }

    return {
      ok: true as const,
      rootIdentityId: activeRoot.id,
      rootIdentityType: activeRoot.identity_type,
      maxDepth,
      relationshipTypes,
      rows: rawRows.map(mapTraversalRow),
    };
  }, CRM_RELATIONSHIP_TRANSACTION_OPTIONS);
}
