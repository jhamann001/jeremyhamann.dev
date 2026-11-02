import { crmIdentityReadsEnabled } from "@/lib/flags";
import { withUserScope, type Identity } from "@/lib/rls";
import { crmIdMatchesType, type CrmIdType } from "./contracts";

export type RoutableCrmIdType = "HOUSEHOLD" | "CONTACT" | "DEAL" | "TRANSFER";

type SourceCoordinate = {
  sourceSystem: string;
  sourceNamespace: string;
};

const ROUTE_SOURCE: Record<RoutableCrmIdType, SourceCoordinate> = {
  HOUSEHOLD: { sourceSystem: "CRM", sourceNamespace: "household" },
  CONTACT: { sourceSystem: "CRM", sourceNamespace: "contact" },
  DEAL: { sourceSystem: "AOA", sourceNamespace: "deal" },
  TRANSFER: { sourceSystem: "AOA", sourceNamespace: "transfer" },
};

/**
 * Resolve a typed CRM route parameter to the route's existing source key.
 *
 * Existing source IDs remain the primary route keys. When CRM reads are
 * enabled, confirmed household and contact duplicates resolve to the selected
 * canonical source key; other route types preserve their existing source IDs.
 */
export async function resolveCrmRouteKey(
  identity: Identity,
  identityType: RoutableCrmIdType,
  routeId: string,
): Promise<string> {
  if (!crmIdentityReadsEnabled()) return routeId;
  const typedForRoute = crmIdMatchesType(identityType, routeId);
  // A typed ID from another namespace must keep failing closed. Existing source
  // keys do not use the app-owned three-letter-plus-underscore prefix and may
  // continue into the household canonicalization seam below.
  if (!typedForRoute && /^[a-z]{3}_/i.test(routeId)) return routeId;

  const source = ROUTE_SOURCE[identityType];
  return withUserScope(identity, async (tx) => {
    let sourceKey = routeId;
    if (typedForRoute) {
      const rows = await tx.$queryRaw<Array<{ source_key: string }>>`
        SELECT m.source_key
          FROM app.crm_identity i
          JOIN app.crm_source_mapping m ON m.identity_id = i.id
         WHERE i.id = ${routeId}
           AND i.identity_type = ${identityType}
           AND i.lifecycle_state = 'ACTIVE'
           AND m.source_system = ${source.sourceSystem}
           AND m.source_namespace = ${source.sourceNamespace}
           AND m.mapping_state = 'ACTIVE'
         ORDER BY m.first_seen_at, m.id
         LIMIT 2`;
      // More than one active route alias is ambiguous and must fail closed.
      if (rows.length !== 1) return routeId;
      sourceKey = rows[0].source_key;
    }

    if (identityType !== "HOUSEHOLD" && identityType !== "CONTACT") return sourceKey;
    const [canonical] = identityType === "HOUSEHOLD"
      ? await tx.$queryRaw<Array<{ source_key: string }>>`
          SELECT app.resolve_crm_canonical_household_source_key(${sourceKey}) AS source_key`
      : await tx.$queryRaw<Array<{ source_key: string }>>`
          SELECT app.resolve_crm_canonical_contact_source_key(${sourceKey}) AS source_key`;
    return canonical?.source_key || sourceKey;
  });
}

/**
 * Return the RLS-visible CRM household sources represented by one
 * confirmed canonical household. The selected survivor is first. Ambiguous,
 * cyclic, disabled, or unknown mappings fail closed to the resolved source.
 */
export async function crmCanonicalHouseholdSourceKeys(
  identity: Identity,
  householdRouteId: string,
): Promise<string[]> {
  const canonical = await resolveCrmRouteKey(identity, "HOUSEHOLD", householdRouteId);
  return crmCanonicalHouseholdSourceKeysForCanonical(identity, canonical);
}

/**
 * Return a confirmed household source group when the caller has already
 * resolved the route to its canonical source. Detail pages use this seam to
 * avoid resolving the same route two or three times during one navigation.
 */
export async function crmCanonicalHouseholdSourceKeysForCanonical(
  identity: Identity,
  canonical: string,
): Promise<string[]> {
  if (!crmIdentityReadsEnabled()) return [canonical];

  const rows = await withUserScope(identity, (tx) =>
    tx.$queryRaw<Array<{ source_key: string }>>`
      SELECT household.sf_id AS source_key
        FROM app.crm_canonical_household_source_keys(${canonical}) grouped
        JOIN mirror.household household
          ON left(household.sf_id, 15) = left(grouped.source_key, 15)
       ORDER BY CASE
         WHEN left(household.sf_id, 15) = left(${canonical}, 15) THEN 0
         ELSE 1
       END,
       household.sf_id`,
  );
  return rows.length > 0 ? rows.map((row) => row.source_key) : [canonical];
}

/**
 * Resolve an existing source key to its canonical CRM ID. This is the read seam
 * Phase 2B's Operations-only explorer and record ID badges will use.
 */
export async function crmIdentityIdForSource(
  identity: Identity,
  identityType: CrmIdType,
  source: SourceCoordinate,
  sourceKey: string,
): Promise<string | null> {
  if (!crmIdentityReadsEnabled()) return null;

  const rows = await withUserScope(identity, (tx) =>
    tx.$queryRaw<Array<{ id: string }>>`
      SELECT i.id
        FROM app.crm_source_mapping m
        JOIN app.crm_identity i ON i.id = m.identity_id
       WHERE m.source_system = ${source.sourceSystem}
         AND m.source_namespace = ${source.sourceNamespace}
         AND m.source_key = ${sourceKey}
         AND m.mapping_state = 'ACTIVE'
         AND i.identity_type = ${identityType}
         AND i.lifecycle_state = 'ACTIVE'
       LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}

export function crmRouteSource(
  identityType: RoutableCrmIdType,
): SourceCoordinate {
  return ROUTE_SOURCE[identityType];
}
