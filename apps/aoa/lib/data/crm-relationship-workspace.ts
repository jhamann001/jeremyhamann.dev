import "server-only";

import { Prisma } from "@prisma/client";
import { crmIdentityReadsEnabled, crmRelationshipsEnabled } from "@/lib/flags";
import {
  canReadCrmRelationships,
  getCrmRelationshipTraversal,
  type CrmRelationshipTraversalFailureReason,
} from "@/lib/data/crm-relationships";
import { getCrmIdentitySummaries } from "@/lib/data/crm-explorer";
import { householdDisplayCtes, householdSourceKeySql } from "@/lib/data/household-display";
import { withUserScope, type Identity } from "@/lib/rls";
import type {
  RelationshipGraphEdge,
  RelationshipGraphNode,
  RelationshipWorkspaceData,
} from "@/components/crm/RelationshipGraph";

const UI_NODE_LIMIT = 24;
const HOUSEHOLD_SEARCH_LIMIT = 12;

const TYPE_LABELS: Record<string, string> = {
  HOUSEHOLD: "Household",
  CONTACT: "Person",
  DEAL: "Deal",
  TRANSFER: "Asset transfer",
};

export type CrmRelationshipWorkspaceResult =
  | { ok: true; data: RelationshipWorkspaceData }
  | { ok: false; reason: CrmRelationshipTraversalFailureReason };

export type CrmRelationshipHouseholdMatch = {
  identityId: string;
  name: string;
  crmId: string;
};

export type CrmRelationshipHouseholdSearchResult =
  | { ok: true; rows: CrmRelationshipHouseholdMatch[] }
  | { ok: false; reason: "forbidden" | "disabled" };

function householdLikePattern(value: string): string {
  return `%${value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

/**
 * Household/member search for the Relationships landing page. Confirmed source
 * groups return their surviving household and identity; source labels remain
 * searchable without exposing duplicate routes or changing CRM records.
 */
export async function searchCrmRelationshipHouseholds(
  identity: Identity,
  rawQuery: string,
): Promise<CrmRelationshipHouseholdSearchResult> {
  if (!canReadCrmRelationships(identity.role)) return { ok: false, reason: "forbidden" };
  if (!crmRelationshipsEnabled()) return { ok: false, reason: "disabled" };

  const query = rawQuery.trim().slice(0, 100);
  if (query.length < 2) return { ok: true, rows: [] };
  const pattern = householdLikePattern(query);
  const prefix = `${query.replace(/[%_\\]/g, "\\$&")}%`;

  return withUserScope(identity, async (tx) => {
    await tx.$executeRaw`SELECT set_config('jit', 'off', true)`;
    const rows = await tx.$queryRaw<Array<{
      identity_id: string;
      name: string;
      crm_id: string;
    }>>(Prisma.sql`
      WITH ${householdDisplayCtes(crmIdentityReadsEnabled())}, candidates AS (
        SELECT identity.id AS identity_id,
               household.display_name AS name,
               household.sf_id AS crm_id,
               CASE
                 WHEN lower(household.display_name) = lower(${query}) THEN 0
                 WHEN household.display_name ILIKE ${prefix} ESCAPE '\\' THEN 1
                 ELSE 2
               END AS match_rank,
               row_number() OVER (
                 PARTITION BY identity.id
                 ORDER BY mapping.first_seen_at, mapping.id
               ) AS mapping_rank
          FROM app.crm_identity identity
          JOIN app.crm_source_mapping mapping
            ON mapping.identity_id = identity.id
           AND mapping.mapping_state = 'ACTIVE'
           AND mapping.source_system = 'CRM'
           AND mapping.source_namespace = 'household'
          JOIN household_display household
            ON ${householdSourceKeySql(Prisma.sql`household.sf_id`)}
             = ${householdSourceKeySql(Prisma.sql`mapping.source_key`)}
         WHERE identity.identity_type = 'HOUSEHOLD'
           AND identity.lifecycle_state = 'ACTIVE'
           AND (
             household.display_name ILIKE ${pattern} ESCAPE '\\'
             OR EXISTS (
               SELECT 1 FROM unnest(household.source_names || household.member_names) search_name
                WHERE search_name ILIKE ${pattern} ESCAPE '\\'
             )
           )
      )
      SELECT identity_id, name, crm_id
        FROM candidates
       WHERE mapping_rank = 1
       ORDER BY match_rank, name, identity_id
       LIMIT ${HOUSEHOLD_SEARCH_LIMIT}`);

    return {
      ok: true as const,
      rows: rows.map((row) => ({
        identityId: row.identity_id,
        name: row.name,
        crmId: row.crm_id,
      })),
    };
  }, { timeout: 10_000, maxWait: 5_000 });
}

function semanticEndpoints(row: {
  relationshipType: string;
  fromIdentityId: string;
  toIdentityId: string;
}): { parentId: string; childId: string } {
  if (row.relationshipType === "HOUSEHOLD_HAS_MEMBER") {
    return { parentId: row.fromIdentityId, childId: row.toIdentityId };
  }
  return { parentId: row.toIdentityId, childId: row.fromIdentityId };
}

export async function getCrmRelationshipWorkspace(
  identity: Identity,
  rootIdentityId: string,
): Promise<CrmRelationshipWorkspaceResult> {
  const traversal = await getCrmRelationshipTraversal(identity, rootIdentityId, {
    maxDepth: 2,
  });
  if (!traversal.ok) return traversal;

  const depthById = new Map<string, number>([[traversal.rootIdentityId, 0]]);
  const typeById = new Map<string, string>([[
    traversal.rootIdentityId,
    traversal.rootIdentityType,
  ]]);
  for (const row of traversal.rows) {
    const priorDepth = depthById.get(row.endpointIdentityId);
    if (priorDepth === undefined || row.depth < priorDepth) {
      depthById.set(row.endpointIdentityId, row.depth);
    }
    typeById.set(row.endpointIdentityId, row.endpointIdentityType);
  }

  const allIds = [...depthById.keys()].sort((left, right) =>
    (depthById.get(left) ?? 99) - (depthById.get(right) ?? 99)
      || left.localeCompare(right));
  const visibleIds = [
    traversal.rootIdentityId,
    ...allIds.filter((id) => id !== traversal.rootIdentityId),
  ].slice(0, UI_NODE_LIMIT);
  const visibleIdSet = new Set(visibleIds);
  const summaries = await getCrmIdentitySummaries(identity, visibleIds);
  const summaryById = new Map(
    summaries.ok ? summaries.rows.map((row) => [row.id, row] as const) : [],
  );

  const nodes: RelationshipGraphNode[] = visibleIds.map((id) => {
    const summary = summaryById.get(id);
    const identityType = summary?.identityType ?? typeById.get(id) ?? "CONTACT";
    return {
      id,
      identityType,
      label: summary?.displayName ?? `${TYPE_LABELS[identityType] ?? identityType} record`,
      href: summary?.href ?? null,
      depth: depthById.get(id) ?? 0,
      root: id === traversal.rootIdentityId,
    };
  });

  const edgeByCoordinate = new Map<string, RelationshipGraphEdge>();
  for (const row of traversal.rows) {
    if (!visibleIdSet.has(row.fromIdentityId) || !visibleIdSet.has(row.toIdentityId)) {
      continue;
    }
    const { parentId, childId } = semanticEndpoints(row);
    const coordinate = `${row.relationshipType}:${parentId}:${childId}`;
    if (edgeByCoordinate.has(coordinate)) continue;
    edgeByCoordinate.set(coordinate, {
      id: row.relationshipId,
      relationshipType: row.relationshipType,
      parentId,
      childId,
    });
  }

  return {
    ok: true,
    data: {
      rootIdentityId: traversal.rootIdentityId,
      nodes,
      edges: [...edgeByCoordinate.values()],
      totalNodeCount: allIds.length,
    },
  };
}
