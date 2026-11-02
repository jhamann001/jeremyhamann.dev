import "server-only";

import { Prisma } from "@prisma/client";
import { crmIdentityReadsEnabled } from "@/lib/flags";
import { withUserScope, type Identity } from "@/lib/rls";
import { CRM_ID_VIEW_ROLES, canViewCrmId } from "@/lib/crm/visibility";
import {
  crmParentRelationshipLabel,
  readCrmParentOverrides,
} from "@/lib/data/crm-parent-resolution";
import { buildCrmWindow, crmWindowLimit, type CrmWindowRequest } from "@/lib/data/crm-window";
import { householdDisplayCtes, householdSourceKeySql } from "@/lib/data/household-display";

export const CRM_EXPLORER_ROLES = CRM_ID_VIEW_ROLES;

export const CRM_EXPLORER_TYPES = [
  "HOUSEHOLD",
  "CONTACT",
  "DEAL",
  "TRANSFER",
  "TASK",
  "EMAIL",
  "ACTIVITY",
  "APPOINTMENT",
] as const;

export type CrmExplorerType = (typeof CRM_EXPLORER_TYPES)[number];
export type CrmLifecycleState = "ACTIVE" | "MERGED" | "ARCHIVED";
export const CRM_EXPLORER_PAGE_SIZE = 100;
export const CRM_EXPLORER_MAX_PAGE_SIZE = 200;
export const CRM_CONNECTION_LIMIT = 200;
// The canonical registry now contains tens of thousands of identities. Its
// read-only RLS-scoped list/detail queries can exceed Prisma's five-second
// interactive-transaction default on a cold dev instance. Keep the exception
// local to the Explorer rather than weakening transaction bounds app-wide.
export const CRM_EXPLORER_TRANSACTION_TIMEOUT_MS = 15_000;
export const CRM_EXPLORER_TRANSACTION_MAX_WAIT_MS = 5_000;
export const CRM_EXPLORER_STATEMENT_TIMEOUT_MS = 10_000;
export const CRM_EXPLORER_LOCK_TIMEOUT_MS = 2_000;
export const CRM_EXPLORER_STATS_CACHE_MS = 30_000;

export const CRM_EXPLORER_TRANSACTION_OPTIONS = {
  timeout: CRM_EXPLORER_TRANSACTION_TIMEOUT_MS,
  maxWait: CRM_EXPLORER_TRANSACTION_MAX_WAIT_MS,
} as const;

type CrmExplorerStatsCache = {
  expiresAt: number;
  value: CrmExplorerStats;
};

let crmExplorerStatsCache: CrmExplorerStatsCache | null = null;

export function invalidateCrmExplorerStatsCache(): void {
  crmExplorerStatsCache = null;
}

export async function applyCrmExplorerDatabaseBounds(
  tx: Prisma.TransactionClient,
): Promise<void> {
  // These interactive reads combine RLS-protected source tables. Their plan
  // estimates can trigger expensive LLVM compilation even for a tiny result.
  // Keep JIT off only for this transaction; pooled connections retain their
  // defaults, and every RLS/content-version check still runs unchanged.
  await tx.$executeRaw`SELECT set_config('jit', 'off', true)`;
  await tx.$executeRaw`SELECT set_config(
    'statement_timeout', ${String(CRM_EXPLORER_STATEMENT_TIMEOUT_MS)}, true
  )`;
  await tx.$executeRaw`SELECT set_config(
    'lock_timeout', ${String(CRM_EXPLORER_LOCK_TIMEOUT_MS)}, true
  )`;
}

function logCrmExplorerTiming(
  operation: "list" | "detail",
  timings: Record<string, number | boolean>,
): void {
  if (process.env.APP_ENV?.toLowerCase() !== "dev") return;
  console.info(JSON.stringify({ event: "crm_explorer_timing", operation, ...timings }));
}

export function canReadCrmExplorer(role: string | null | undefined): boolean {
  return canViewCrmId(role);
}

export function crmExplorerAvailable(role: string | null | undefined): boolean {
  return crmIdentityReadsEnabled() && canReadCrmExplorer(role);
}

export function normalizeCrmExplorerType(value: string | null | undefined): CrmExplorerType | null {
  return CRM_EXPLORER_TYPES.includes(value as CrmExplorerType)
    ? (value as CrmExplorerType)
    : null;
}

export function normalizeCrmLifecycleState(
  value: string | null | undefined,
): CrmLifecycleState | null {
  return value === "ACTIVE" || value === "MERGED" || value === "ARCHIVED"
    ? value
    : null;
}

export function crmExplorerLikePattern(value: string): string {
  return `%${value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

type RawMapping = {
  id: string;
  identity_id: string;
  identity_type: CrmExplorerType;
  source_system: string;
  source_namespace: string;
  source_key: string;
  mapping_state: string;
  first_seen_at: Date;
  last_seen_at: Date;
  superseded_at: Date | null;
  display_name: string | null;
  source_observed_at: Date | null;
  route_kind: string | null;
  route_key: string | null;
  parent_source_key: string | null;
};

export type CrmExplorerMapping = {
  id: string;
  sourceSystem: string;
  sourceNamespace: string;
  sourceKey: string;
  mappingState: string;
  firstSeenAt: string;
  lastSeenAt: string;
  supersededAt: string | null;
  displayName: string | null;
  sourceObservedAt: string | null;
  href: string | null;
};

export type CrmExplorerListItem = {
  id: string;
  identityType: CrmExplorerType;
  lifecycleState: CrmLifecycleState;
  mergedIntoId: string | null;
  firstSeenAt: string;
  updatedAt: string;
  aliasCount: number;
  openExceptionCount: number;
  latestSeenAt: string | null;
  mappings: CrmExplorerMapping[];
};

export type CrmExplorerStats = {
  identities: number;
  sourceAliases: number;
  openExceptions: number;
  potentialDuplicates: number;
  latestSeenAt: string | null;
};

async function readCrmExplorerStats(
  tx: Prisma.TransactionClient,
  fresh = false,
  // Navigation already scans these relations for its content version. Accept
  // the aggregates from that same scan instead of repeating RLS/source checks.
  navigationRow?: RawCrmExplorerStats,
): Promise<{ value: CrmExplorerStats; cacheHit: boolean }> {
  const now = Date.now();
  if (!fresh && crmExplorerStatsCache && crmExplorerStatsCache.expiresAt > now) {
    return { value: crmExplorerStatsCache.value, cacheHit: true };
  }

  // crm_identity_app_read is exactly EXISTS(a visible source mapping), and its
  // non-null identity_id FK guarantees every visible mapping has an identity.
  // Derive that same identity population while checking mapping/source RLS once,
  // not via an identity->mapping lookup plus two more complete mapping scans.
  // Do not filter mapping state or identity lifecycle: neither is in that policy.
  // The policy/FK invariant and all-role parity are covered by integration tests.
  const row = navigationRow ?? (await tx.$queryRaw<RawCrmExplorerStats[]>`
    WITH visible_mapping_stats AS MATERIALIZED (
      SELECT count(DISTINCT identity_id)::bigint AS identities,
        count(*)::bigint AS source_aliases, max(last_seen_at) AS latest_seen_at
      FROM app.crm_source_mapping
    )
    SELECT
      mapping_stats.identities, mapping_stats.source_aliases,
      (SELECT count(*) FROM app.crm_identity_exception WHERE exception_state = 'OPEN')::bigint
        AS open_exceptions,
      (SELECT count(*) FROM app.crm_duplicate_candidate candidate
        WHERE candidate.source_active
          AND (
            candidate.status = 'NEW'
            OR (candidate.status = 'SNOOZED' AND candidate.snoozed_until <= now())
          ))::bigint AS potential_duplicates,
      mapping_stats.latest_seen_at
    FROM visible_mapping_stats mapping_stats`)[0];

  const value = {
    identities: Number(row?.identities ?? 0),
    sourceAliases: Number(row?.source_aliases ?? 0),
    openExceptions: Number(row?.open_exceptions ?? 0),
    potentialDuplicates: Number(row?.potential_duplicates ?? 0),
    latestSeenAt: row?.latest_seen_at?.toISOString() ?? null,
  };
  crmExplorerStatsCache = { expiresAt: Date.now() + CRM_EXPLORER_STATS_CACHE_MS, value };
  return { value, cacheHit: false };
}

type RawCrmExplorerStats = {
  identities: bigint;
  source_aliases: bigint;
  open_exceptions: bigint;
  potential_duplicates: bigint;
  latest_seen_at: Date | null;
};

export async function readCrmWindowStats(tx: Prisma.TransactionClient): Promise<CrmExplorerStats> {
  return (await readCrmExplorerStats(tx, true)).value;
}

export type CrmWindowMeta = CrmExplorerStats & { total: number; pageCount: number };

export type CrmExplorerQuery = {
  page?: number;
  pageSize?: number;
  q?: string;
  type?: string;
  state?: string;
  exceptionsOnly?: boolean;
};

export type CrmExplorerListResult =
  | {
      ok: true;
      rows: CrmExplorerListItem[];
      stats: CrmExplorerStats;
      total: number;
      page: number;
      pageCount: number;
      pageSize: number;
      snapshot: string;
      query: string;
      type: CrmExplorerType | null;
      state: CrmLifecycleState | null;
      exceptionsOnly: boolean;
    }
  | { ok: false; reason: "forbidden" | "disabled" };

/**
 * A scoped content version shared by CRM's two independent paging contracts.
 * Only digests leave SQL: source records are never downloaded to fingerprint
 * the registry. Mapping and relationship changes may alter labels, links and
 * candidate membership without touching an identity's updated_at.
 * Call inside the list's repeatable-read RLS transaction, with fresh summaries.
 */
export async function readCrmNavigationState(tx: Prisma.TransactionClient): Promise<{
  snapshot: string;
  stats: CrmExplorerStats;
}> {
  const projections = [
    Prisma.sql`SELECT id, to_jsonb(i)::text AS value FROM app.crm_identity i`,
    Prisma.sql`SELECT id, to_jsonb(m)::text AS value, last_seen_at FROM app.crm_source_mapping m`,
    Prisma.sql`SELECT id, to_jsonb(e)::text AS value, exception_state FROM app.crm_identity_exception e`,
    Prisma.sql`SELECT id, to_jsonb(o)::text AS value FROM app.crm_parent_override o`,
    Prisma.sql`SELECT id, (to_jsonb(c) || jsonb_build_object('snooze_due', c.snoozed_until <= now()))::text AS value,
        source_active, status, snoozed_until
      FROM app.crm_duplicate_candidate c`,
    Prisma.sql`SELECT sf_id AS id, jsonb_build_array(sf_id, name, synced_at)::text AS value FROM mirror.household`,
    Prisma.sql`SELECT sf_id AS id, jsonb_build_array(sf_id, first_name, last_name, household_id, synced_at)::text AS value FROM mirror.client`,
    Prisma.sql`SELECT id, jsonb_build_array(id, sf_deal_id, name, household_sf_id, client_sf_id, updated_at)::text AS value FROM app.deal`,
    Prisma.sql`SELECT id, jsonb_build_array(id, client_first_name, client_last_name, household_sf_id, client_sf_id, updated_at)::text AS value FROM app.transfer`,
    Prisma.sql`SELECT sf_id AS id, jsonb_build_array(sf_id, subject, household_sf_id, synced_at)::text AS value FROM mirror.email`,
    Prisma.sql`SELECT sf_id AS id, jsonb_build_array(sf_id, subject, household_sf_id, synced_at)::text AS value FROM mirror.activity`,
    Prisma.sql`SELECT sf_id AS id, jsonb_build_array(sf_id, subject, household_sf_id, synced_at)::text AS value FROM mirror.task`,
    Prisma.sql`SELECT external_key AS id, jsonb_build_array(external_key, client_name, meeting_type, client_sf_id, synced_at)::text AS value FROM mirror.appointment`,
  ];
  // Each table contributes its exact ordered digest and any summary aggregates
  // in one pass. In particular, source-mapping RLS used to run three times here
  // (version, alias count, latest timestamp). Only compile-time aliases are raw.
  const aggregates = [
    Prisma.sql`, count(*)::bigint AS identities`,
    Prisma.sql`, count(*)::bigint AS source_aliases, max(last_seen_at) AS latest_seen_at`,
    Prisma.sql`, count(*) FILTER (WHERE exception_state = 'OPEN')::bigint AS open_exceptions`,
    Prisma.empty,
    Prisma.sql`, count(*) FILTER (WHERE source_active AND (
      status = 'NEW' OR (status = 'SNOOZED' AND snoozed_until <= now())
    ))::bigint AS potential_duplicates`,
  ];
  const names = projections.map((_, index) => Prisma.raw(`source_${index}`));
  const versions = projections.map((projection, index) => Prisma.sql`
    ${names[index]} AS MATERIALIZED (
      SELECT md5(coalesce(string_agg(md5(source.value), '' ORDER BY source.id), '')) AS version
        ${aggregates[index] ?? Prisma.empty}
      FROM (${projection}) source
    )`);
  const [version] = await tx.$queryRaw<Array<RawCrmExplorerStats & { snapshot: string }>>(Prisma.sql`
    WITH ${Prisma.join(versions)}
    SELECT md5(concat_ws(':', ${Prisma.join(names.map((name) => Prisma.sql`${name}.version`))})) AS snapshot,
           source_0.identities, source_1.source_aliases, source_1.latest_seen_at,
           source_2.open_exceptions, source_4.potential_duplicates
      FROM ${Prisma.join(names, ' CROSS JOIN ')}`);
  if (!version?.snapshot) throw new Error("crm_navigation_version_unavailable");
  const stats = await readCrmExplorerStats(tx, true, version);
  return { snapshot: version.snapshot, stats: stats.value };
}

function mappingHref(routeKind: string | null, routeKey: string | null): string | null {
  if (routeKind === "command_center") return "/command-center";
  if (!routeKey) return null;
  const key = encodeURIComponent(routeKey);
  if (routeKind === "household") return `/households/${key}`;
  if (routeKind === "contact") return `/client-portrait/${key}`;
  if (routeKind === "deal") return `/deals/${key}`;
  if (routeKind === "transfer") return `/asset-transfer/${key}`;
  return null;
}

function coerceMapping(
  row: RawMapping,
  parentRouteKeys: Map<string, string> = new Map(),
): CrmExplorerMapping {
  const parentRouteKey = row.parent_source_key
    ? parentRouteKeys.get(row.parent_source_key.slice(0, 15)) ?? null
    : null;
  return {
    id: row.id,
    sourceSystem: row.source_system,
    sourceNamespace: row.source_namespace,
    sourceKey: row.source_key,
    mappingState: row.mapping_state,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    supersededAt: row.superseded_at?.toISOString() ?? null,
    displayName: row.display_name,
    sourceObservedAt: row.source_observed_at?.toISOString() ?? null,
    href: mappingHref(row.route_kind, row.route_key ?? parentRouteKey),
  };
}

async function mappingsForIdentityIds(
  tx: Prisma.TransactionClient,
  identityIds: string[],
  includeInlineParentRoutes = true,
): Promise<{
  byIdentity: Map<string, CrmExplorerMapping[]>;
  identityTypes: Map<string, CrmExplorerType>;
}> {
  const byIdentity = new Map<string, CrmExplorerMapping[]>();
  const identityTypes = new Map<string, CrmExplorerType>();
  if (identityIds.length === 0) return { byIdentity, identityTypes };

  const rows = await tx.$queryRaw<RawMapping[]>(Prisma.sql`
    SELECT m.id, m.identity_id, i.identity_type, m.source_system, m.source_namespace,
           m.source_key, m.mapping_state, m.first_seen_at, m.last_seen_at,
           m.superseded_at,
           CASE
             WHEN m.source_system = 'CRM' AND m.source_namespace = 'household'
               THEN h.name
             WHEN m.source_system = 'CRM' AND m.source_namespace = 'contact'
               THEN nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '')
             WHEN m.source_system = 'AOA' AND m.source_namespace = 'deal'
               THEN d.name
             WHEN m.source_system = 'CRM' AND m.source_namespace = 'opportunity'
               THEN od.name
             WHEN m.source_system = 'AOA' AND m.source_namespace = 'transfer'
               THEN nullif(btrim(concat_ws(' ', t.client_first_name, t.client_last_name)), '')
             WHEN m.source_system = 'CRM' AND m.source_namespace = 'email'
               THEN e.subject
             WHEN m.source_system = 'CRM' AND m.source_namespace = 'activity'
               THEN a.subject
             WHEN m.source_system = 'CRM' AND m.source_namespace = 'task'
               THEN tk.subject
             WHEN m.source_system = 'CALENDAR' AND m.source_namespace = 'appointment'
               THEN nullif(btrim(concat_ws(' · ', ap.client_name, ap.meeting_type)), '')
             ELSE NULL
           END AS display_name,
           CASE
             WHEN h.sf_id IS NOT NULL THEN h.synced_at
             WHEN c.sf_id IS NOT NULL THEN c.synced_at
             WHEN d.id IS NOT NULL THEN d.updated_at
             WHEN od.id IS NOT NULL THEN od.updated_at
             WHEN t.id IS NOT NULL THEN t.updated_at
             WHEN e.sf_id IS NOT NULL THEN e.synced_at
             WHEN a.sf_id IS NOT NULL THEN a.synced_at
             WHEN tk.sf_id IS NOT NULL THEN tk.synced_at
             WHEN ap.external_key IS NOT NULL THEN ap.synced_at
             ELSE NULL
           END AS source_observed_at,
           CASE
             WHEN h.sf_id IS NOT NULL THEN 'household'
             WHEN c.sf_id IS NOT NULL THEN 'contact'
             WHEN d.id IS NOT NULL OR od.id IS NOT NULL THEN 'deal'
             WHEN t.id IS NOT NULL THEN 'transfer'
             WHEN e.sf_id IS NOT NULL OR a.sf_id IS NOT NULL OR tk.sf_id IS NOT NULL
               THEN 'household'
             WHEN ap.client_sf_id IS NOT NULL THEN 'contact'
             WHEN ap.external_key IS NOT NULL THEN 'command_center'
             ELSE NULL
           END AS route_kind,
           CASE
             WHEN h.sf_id IS NOT NULL THEN h.sf_id
             WHEN c.sf_id IS NOT NULL THEN c.sf_id
             WHEN d.id IS NOT NULL THEN d.id
             WHEN od.id IS NOT NULL THEN od.id
             WHEN t.id IS NOT NULL THEN t.id
             WHEN e.sf_id IS NOT NULL AND ${includeInlineParentRoutes} THEN (
               SELECT hm.source_key
                 FROM app.crm_source_mapping hm
                WHERE hm.source_system = 'CRM'
                  AND hm.source_namespace = 'household'
                  AND left(hm.source_key, 15) = left(e.household_sf_id, 15)
                  AND hm.mapping_state = 'ACTIVE'
                ORDER BY hm.first_seen_at, hm.id
                LIMIT 1
             )
             WHEN a.sf_id IS NOT NULL AND ${includeInlineParentRoutes} THEN (
               SELECT hm.source_key
                 FROM app.crm_source_mapping hm
                WHERE hm.source_system = 'CRM'
                  AND hm.source_namespace = 'household'
                  AND left(hm.source_key, 15) = left(a.household_sf_id, 15)
                  AND hm.mapping_state = 'ACTIVE'
                ORDER BY hm.first_seen_at, hm.id
               LIMIT 1
             )
             WHEN tk.sf_id IS NOT NULL AND ${includeInlineParentRoutes} THEN (
               SELECT hm.source_key
                 FROM app.crm_source_mapping hm
                WHERE hm.source_system = 'CRM'
                  AND hm.source_namespace = 'household'
                  AND left(hm.source_key, 15) = left(tk.household_sf_id, 15)
                  AND hm.mapping_state = 'ACTIVE'
                ORDER BY hm.first_seen_at, hm.id
                LIMIT 1
             )
             WHEN ap.client_sf_id IS NOT NULL THEN ap.client_sf_id
             ELSE NULL
           END AS route_key,
           CASE
             WHEN e.sf_id IS NOT NULL THEN e.household_sf_id
             WHEN a.sf_id IS NOT NULL THEN a.household_sf_id
             WHEN tk.sf_id IS NOT NULL THEN tk.household_sf_id
             ELSE NULL
           END AS parent_source_key
      FROM app.crm_source_mapping m
      JOIN app.crm_identity i ON i.id = m.identity_id
      LEFT JOIN mirror.household h
        ON m.source_system = 'CRM' AND m.source_namespace = 'household'
       AND h.sf_id = m.source_key
      LEFT JOIN mirror.client c
        ON m.source_system = 'CRM' AND m.source_namespace = 'contact'
       AND c.sf_id = m.source_key
      LEFT JOIN app.deal d
        ON m.source_system = 'AOA' AND m.source_namespace = 'deal'
       AND d.id = m.source_key
      LEFT JOIN app.deal od
        ON m.source_system = 'CRM' AND m.source_namespace = 'opportunity'
       AND od.sf_deal_id = m.source_key
      LEFT JOIN app.transfer t
        ON m.source_system = 'AOA' AND m.source_namespace = 'transfer'
       AND t.id = m.source_key
      LEFT JOIN mirror.email e
        ON m.source_system = 'CRM' AND m.source_namespace = 'email'
       AND e.sf_id = m.source_key
      LEFT JOIN mirror.activity a
        ON m.source_system = 'CRM' AND m.source_namespace = 'activity'
       AND a.sf_id = m.source_key
      LEFT JOIN mirror.task tk
        ON m.source_system = 'CRM' AND m.source_namespace = 'task'
       AND tk.sf_id = m.source_key
      LEFT JOIN mirror.appointment ap
        ON m.source_system = 'CALENDAR' AND m.source_namespace = 'appointment'
       AND ap.external_key = m.source_key
     WHERE m.identity_id IN (${Prisma.join(identityIds)})
     ORDER BY m.identity_id, m.mapping_state, m.first_seen_at, m.id`);

  const parentRouteKeys = new Map<string, string>();
  if (!includeInlineParentRoutes) {
    const parentKeys = [...new Set(
      rows
        .map((row) => row.parent_source_key?.slice(0, 15) ?? "")
        .filter(Boolean),
    )];
    if (parentKeys.length > 0) {
      const parentRows = await tx.$queryRaw<Array<{
        canonical_source_key: string;
        source_key: string;
      }>>(Prisma.sql`
        SELECT DISTINCT ON (left(m.source_key, 15))
               left(m.source_key, 15) AS canonical_source_key,
               m.source_key
          FROM app.crm_source_mapping m
         WHERE m.source_system = 'CRM'
           AND m.source_namespace = 'household'
           AND m.mapping_state = 'ACTIVE'
           AND left(m.source_key, 15) IN (${Prisma.join(parentKeys)})
         ORDER BY left(m.source_key, 15), m.first_seen_at, m.id`);
      for (const parentRow of parentRows) {
        parentRouteKeys.set(parentRow.canonical_source_key, parentRow.source_key);
      }
    }
  }

  for (const row of rows) {
    const current = byIdentity.get(row.identity_id) ?? [];
    current.push(coerceMapping(row, parentRouteKeys));
    byIdentity.set(row.identity_id, current);
    identityTypes.set(row.identity_id, row.identity_type);
  }
  return { byIdentity, identityTypes };
}

export type CrmIdentitySummary = {
  id: string;
  identityType: CrmExplorerType;
  displayName: string | null;
  href: string | null;
};

export type CrmIdentitySummaryResult =
  | { ok: true; rows: CrmIdentitySummary[] }
  | { ok: false; reason: "forbidden" | "disabled" | "invalid" };

/**
 * Resolve a bounded set of internal CRM IDs to display-only metadata for the
 * relationship workspace. Raw source keys and aliases never leave this seam.
 */
export async function getCrmIdentitySummaries(
  identity: Identity,
  identityIds: readonly string[],
): Promise<CrmIdentitySummaryResult> {
  if (!canReadCrmExplorer(identity.role)) return { ok: false, reason: "forbidden" };
  if (!crmIdentityReadsEnabled()) return { ok: false, reason: "disabled" };

  const ids = [...new Set(identityIds.map((value) => value.trim()))];
  if (
    ids.length === 0
    || ids.length > 251
    || ids.some((value) => !/^(?:hld|con|dea|xfr)_[a-z0-9]+$/.test(value))
  ) {
    return { ok: false, reason: "invalid" };
  }

  return withUserScope(identity, async (tx) => {
    await applyCrmExplorerDatabaseBounds(tx);
    const { byIdentity, identityTypes } = await mappingsForIdentityIds(tx, ids, false);
    const householdIds = ids.filter((id) => identityTypes.get(id) === "HOUSEHOLD");
    // Graph labels follow the operating-view naming rule. The Explorer's raw
    // source-mapping labels remain untouched so their provenance stays visible.
    const householdRows = householdIds.length === 0 ? [] : await tx.$queryRaw<Array<{
      identity_id: string;
      display_name: string;
      sf_id: string;
    }>>(Prisma.sql`
      WITH ${householdDisplayCtes(true, Prisma.sql`ARRAY(
        SELECT source_key FROM app.crm_source_mapping
         WHERE identity_id IN (${Prisma.join(householdIds)})
           AND mapping_state = 'ACTIVE'
           AND source_system = 'CRM'
           AND source_namespace = 'household'
      )`)}
      SELECT DISTINCT ON (mapping.identity_id)
             mapping.identity_id, household.display_name, household.sf_id
        FROM app.crm_source_mapping mapping
        JOIN visible_household source
          ON ${householdSourceKeySql(Prisma.sql`source.sf_id`)}
           = ${householdSourceKeySql(Prisma.sql`mapping.source_key`)}
        JOIN household_display household
          ON ${householdSourceKeySql(Prisma.sql`household.sf_id`)}
           = ${householdSourceKeySql(Prisma.sql`source.canonical_sf_id`)}
       WHERE mapping.identity_id IN (${Prisma.join(householdIds)})
         AND mapping.mapping_state = 'ACTIVE'
         AND mapping.source_system = 'CRM'
         AND mapping.source_namespace = 'household'
       ORDER BY mapping.identity_id, mapping.first_seen_at, mapping.id, household.sf_id`);
    const householdByIdentity = new Map(householdRows.map((row) => [row.identity_id, row]));
    return {
      ok: true as const,
      rows: ids.flatMap((id) => {
        const identityType = identityTypes.get(id);
        if (!identityType) return [];
        const mappings = byIdentity.get(id) ?? [];
        const preferred = mappings.find(
          (mapping) => mapping.mappingState === "ACTIVE" && Boolean(mapping.displayName),
        ) ?? mappings.find((mapping) => mapping.mappingState === "ACTIVE")
          ?? mappings[0];
        const household = householdByIdentity.get(id);
        return [{
          id,
          identityType,
          displayName: household?.display_name ?? preferred?.displayName ?? null,
          href: household ? mappingHref("household", household.sf_id) : preferred?.href ?? null,
        }];
      }),
    };
  }, CRM_EXPLORER_TRANSACTION_OPTIONS);
}

export async function listCrmIdentities(
  identity: Identity,
  query: CrmExplorerQuery = {},
): Promise<CrmExplorerListResult> {
  return readCrmIdentityRows(identity, query);
}

export async function listCrmIdentityWindow(identity: Identity, query: CrmExplorerQuery, window: CrmWindowRequest) {
  crmWindowLimit(window);
  const result = await readCrmIdentityRows(identity, { ...query, page: window.firstPage, pageSize: window.pageSize }, window);
  if (!result.ok) return result;
  return { ok: true as const, ...buildCrmWindow(window, result.rows, result.total,
    ["identities", identity.role ?? "", identity.email ?? "", result.query, result.type, result.state, result.exceptionsOnly],
    { ...result.stats, total: result.total, pageCount: result.pageCount }) };
}

async function readCrmIdentityRows(
  identity: Identity, query: CrmExplorerQuery = {}, window?: CrmWindowRequest,
): Promise<CrmExplorerListResult> {
  if (!canReadCrmExplorer(identity.role)) return { ok: false, reason: "forbidden" };
  if (!crmIdentityReadsEnabled()) return { ok: false, reason: "disabled" };

  const page = Math.min(1_000_000, Math.max(1, Math.floor(Number(query.page) || 1)));
  const pageSize = Math.min(CRM_EXPLORER_MAX_PAGE_SIZE, Math.max(
    CRM_EXPLORER_PAGE_SIZE, Math.floor(Number(query.pageSize) || CRM_EXPLORER_PAGE_SIZE),
  ));
  const q = query.q?.trim().slice(0, 200) ?? "";
  const pattern = q ? crmExplorerLikePattern(q) : null;
  const type = normalizeCrmExplorerType(query.type);
  const state = normalizeCrmLifecycleState(query.state);
  const exceptionsOnly = query.exceptionsOnly === true;
  const filtered = Boolean(q || type || state || exceptionsOnly);
  const startedAt = Date.now();

  const where = Prisma.sql`
    WHERE (${type}::text IS NULL OR i.identity_type = ${type})
      AND (${state}::text IS NULL OR i.lifecycle_state = ${state})
      AND (
        ${pattern}::text IS NULL
        OR i.id ILIKE ${pattern} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM app.crm_source_mapping sm
           WHERE sm.identity_id = i.id
             AND sm.source_key ILIKE ${pattern} ESCAPE '\\'
        )
      )
      AND (
        NOT ${exceptionsOnly}
        OR EXISTS (
          SELECT 1
            FROM app.crm_source_mapping em
            JOIN app.crm_identity_exception e ON e.source_mapping_id = em.id
           WHERE em.identity_id = i.id AND e.exception_state = 'OPEN'
        )
      )`;

  return withUserScope(identity, async (tx) => {
    await applyCrmExplorerDatabaseBounds(tx);
    const rowsStartedAt = Date.now();
    const rawRows = await tx.$queryRaw<
      Array<{
        id: string;
        identity_type: CrmExplorerType;
        lifecycle_state: CrmLifecycleState;
        merged_into_id: string | null;
        first_seen_at: Date;
        updated_at: Date;
        alias_count: bigint;
        open_exception_count: bigint;
        latest_seen_at: Date | null;
      }>
    >(Prisma.sql`
      WITH page_rows AS MATERIALIZED (
        SELECT i.id, i.identity_type, i.lifecycle_state, i.merged_into_id,
               i.first_seen_at, i.updated_at
          FROM app.crm_identity i
          ${where}
         ORDER BY i.updated_at DESC, i.id
         LIMIT ${window ? crmWindowLimit(window) : pageSize}
        OFFSET ${(page - 1) * pageSize}
      ), mapping_summary AS (
        SELECT m.identity_id, count(*)::bigint AS alias_count,
               max(m.last_seen_at) AS latest_seen_at
          FROM app.crm_source_mapping m
          JOIN page_rows p ON p.id = m.identity_id
         GROUP BY m.identity_id
      ), exception_summary AS (
        SELECT m.identity_id, count(*)::bigint AS open_exception_count
          FROM app.crm_identity_exception e
          JOIN app.crm_source_mapping m ON m.id = e.source_mapping_id
          JOIN page_rows p ON p.id = m.identity_id
         WHERE e.exception_state = 'OPEN'
         GROUP BY m.identity_id
      )
      SELECT p.id, p.identity_type, p.lifecycle_state, p.merged_into_id,
             p.first_seen_at, p.updated_at,
             coalesce(ms.alias_count, 0)::bigint AS alias_count,
             coalesce(es.open_exception_count, 0)::bigint AS open_exception_count,
             ms.latest_seen_at
        FROM page_rows p
        LEFT JOIN mapping_summary ms ON ms.identity_id = p.id
        LEFT JOIN exception_summary es ON es.identity_id = p.id
       ORDER BY p.updated_at DESC, p.id`);
    const rowsMs = Date.now() - rowsStartedAt;

    const mappingsStartedAt = Date.now();
    const { byIdentity: mappings } = await mappingsForIdentityIds(
      tx,
      rawRows.map((row) => row.id),
      false,
    );
    const mappingsMs = Date.now() - mappingsStartedAt;

    const statsStartedAt = Date.now();
    // The legacy API retains its global version contract. The window path
    // versions only its bounded, fully rendered prefix and still reads every
    // exact summary fresh in this same RLS/repeatable-read transaction.
    const navigation = window
      ? { stats: await readCrmWindowStats(tx), snapshot: "" }
      : await readCrmNavigationState(tx);
    const statsMs = Date.now() - statsStartedAt;

    // The unfiltered total is already part of the fresh scoped summary. Avoid
    // a windowed total on the ordered page query: PostgreSQL must otherwise scan
    // every matching identity before it can return the first 100 rows, which can
    // exhaust the Explorer's bounded transaction on a cold dev instance.
    let totalNumber = navigation.stats.identities;
    let countMs = 0;
    if (filtered) {
      const countStartedAt = Date.now();
      const [countRow] = await tx.$queryRaw<Array<{ total: bigint }>>(
        Prisma.sql`SELECT count(*)::bigint AS total FROM app.crm_identity i ${where}`,
      );
      totalNumber = Number(countRow?.total ?? 0);
      countMs = Date.now() - countStartedAt;
    }
    logCrmExplorerTiming("list", {
      totalMs: Date.now() - startedAt,
      rowsMs,
      mappingsMs,
      statsMs,
      countMs,
      statsCacheHit: false,
      resultCount: rawRows.length,
      filtered,
    });
    return {
      ok: true as const,
      rows: rawRows.map((row) => ({
        id: row.id,
        identityType: row.identity_type,
        lifecycleState: row.lifecycle_state,
        mergedIntoId: row.merged_into_id,
        firstSeenAt: row.first_seen_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        aliasCount: Number(row.alias_count),
        openExceptionCount: Number(row.open_exception_count),
        latestSeenAt: row.latest_seen_at?.toISOString() ?? null,
        mappings: mappings.get(row.id) ?? [],
      })),
      stats: navigation.stats,
      snapshot: navigation.snapshot,
      total: totalNumber,
      page,
      pageCount: Math.max(1, Math.ceil(totalNumber / pageSize)),
      pageSize,
      query: q,
      type,
      state,
      exceptionsOnly,
    };
  }, { ...CRM_EXPLORER_TRANSACTION_OPTIONS, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

type ConnectionCode =
  | "CONTACT_MEMBER_OF_HOUSEHOLD"
  | "DEAL_FOR_HOUSEHOLD"
  | "DEAL_FOR_CONTACT"
  | "TRANSFER_FOR_HOUSEHOLD"
  | "TRANSFER_FOR_CONTACT"
  | "TRANSFER_FROM_DEAL"
  | "EMAIL_FOR_HOUSEHOLD"
  | "ACTIVITY_FOR_HOUSEHOLD"
  | "TASK_FOR_HOUSEHOLD"
  | "APPOINTMENT_FOR_CONTACT"
  | "APPOINTMENT_FOR_HOUSEHOLD";

const CONNECTION_LABELS: Record<ConnectionCode, { forward: string; reverse: string }> = {
  CONTACT_MEMBER_OF_HOUSEHOLD: { forward: "Member of household", reverse: "Household member" },
  DEAL_FOR_HOUSEHOLD: { forward: "For household", reverse: "Household deal" },
  DEAL_FOR_CONTACT: { forward: "For contact", reverse: "Contact deal" },
  TRANSFER_FOR_HOUSEHOLD: { forward: "For household", reverse: "Household transfer" },
  TRANSFER_FOR_CONTACT: { forward: "For contact", reverse: "Contact transfer" },
  TRANSFER_FROM_DEAL: { forward: "Created from deal", reverse: "Related transfer" },
  EMAIL_FOR_HOUSEHOLD: { forward: "For household", reverse: "Household email" },
  ACTIVITY_FOR_HOUSEHOLD: { forward: "For household", reverse: "Household activity" },
  TASK_FOR_HOUSEHOLD: { forward: "For household", reverse: "Household task" },
  APPOINTMENT_FOR_CONTACT: { forward: "For contact", reverse: "Contact appointment" },
  APPOINTMENT_FOR_HOUSEHOLD: { forward: "For household", reverse: "Household appointment" },
};

export type CrmExplorerException = {
  id: string;
  sourceMappingId: string;
  reasonCode: string;
  state: string;
  resolutionCode: string | null;
  detectedAt: string;
  resolvedAt: string | null;
};

export type CrmExplorerConnection = {
  identityId: string;
  identityType: CrmExplorerType;
  relationship: string;
  direction: "OUTGOING" | "INCOMING";
  displayName: string | null;
  href: string | null;
};

export type CrmExplorerManualParent = {
  id: string;
  sourceMappingId: string;
  parentIdentityId: string;
  parentIdentityType: CrmExplorerType;
  relationshipCode: string;
  confirmedBy: string;
  confirmedAt: string;
  displayName: string | null;
  href: string | null;
};

export type CrmExplorerDetail = {
  id: string;
  identityType: CrmExplorerType;
  lifecycleState: CrmLifecycleState;
  mergedIntoId: string | null;
  mergedFromIds: string[];
  firstSeenAt: string;
  updatedAt: string;
  mappings: CrmExplorerMapping[];
  exceptions: CrmExplorerException[];
  manualParents: CrmExplorerManualParent[];
  connections: CrmExplorerConnection[];
  connectionTotal: number;
  connectionsTruncated: boolean;
};

export type CrmExplorerDetailResult =
  | { ok: true; detail: CrmExplorerDetail | null }
  | { ok: false; reason: "forbidden" | "disabled" };

function connectionLinksForIdentity(
  identityType: CrmExplorerType,
  identityId: string,
): Prisma.Sql {
  switch (identityType) {
    case "HOUSEHOLD":
      return Prisma.sql`
        SELECT DISTINCT cm.identity_id AS from_id, hm.identity_id AS to_id,
               'CONTACT_MEMBER_OF_HOUSEHOLD'::text AS relation
          FROM app.crm_source_mapping hm
          JOIN mirror.client c
            ON hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND hm.source_key = c.household_id AND hm.mapping_state = 'ACTIVE'
          JOIN app.crm_source_mapping cm
            ON cm.source_system = 'CRM' AND cm.source_namespace = 'contact'
           AND cm.source_key = c.sf_id
         WHERE hm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT dm.identity_id, hm.identity_id, 'DEAL_FOR_HOUSEHOLD'::text
          FROM app.crm_source_mapping hm
          JOIN app.deal d
            ON d.household_sf_id IS NOT NULL
           AND left(hm.source_key, 15) = left(d.household_sf_id, 15)
          JOIN app.crm_source_mapping dm
            ON dm.source_system = 'AOA' AND dm.source_namespace = 'deal'
           AND dm.source_key = d.id
         WHERE hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND hm.mapping_state = 'ACTIVE' AND hm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT tm.identity_id, hm.identity_id, 'TRANSFER_FOR_HOUSEHOLD'::text
          FROM app.crm_source_mapping hm
          JOIN app.transfer t
            ON t.household_sf_id IS NOT NULL
           AND left(hm.source_key, 15) = left(t.household_sf_id, 15)
          JOIN app.crm_source_mapping tm
            ON tm.source_system = 'AOA' AND tm.source_namespace = 'transfer'
           AND tm.source_key = t.id
         WHERE hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND hm.mapping_state = 'ACTIVE' AND hm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT em.identity_id, hm.identity_id, 'EMAIL_FOR_HOUSEHOLD'::text
          FROM app.crm_source_mapping hm
          JOIN mirror.email e
            ON left(hm.source_key, 15) = left(e.household_sf_id, 15)
          JOIN app.crm_source_mapping em
            ON em.source_system = 'CRM' AND em.source_namespace = 'email'
           AND em.source_key = e.sf_id
         WHERE hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND hm.mapping_state = 'ACTIVE' AND hm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT am.identity_id, hm.identity_id, 'ACTIVITY_FOR_HOUSEHOLD'::text
          FROM app.crm_source_mapping hm
          JOIN mirror.activity a
            ON left(hm.source_key, 15) = left(a.household_sf_id, 15)
          JOIN app.crm_source_mapping am
            ON am.source_system = 'CRM' AND am.source_namespace = 'activity'
           AND am.source_key = a.sf_id
         WHERE hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND hm.mapping_state = 'ACTIVE' AND hm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT tkm.identity_id, hm.identity_id, 'TASK_FOR_HOUSEHOLD'::text
          FROM app.crm_source_mapping hm
          JOIN mirror.task tk
            ON left(hm.source_key, 15) = left(tk.household_sf_id, 15)
          JOIN app.crm_source_mapping tkm
            ON tkm.source_system = 'CRM' AND tkm.source_namespace = 'task'
           AND tkm.source_key = tk.sf_id
         WHERE hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND hm.mapping_state = 'ACTIVE' AND hm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT apm.identity_id, hm.identity_id, 'APPOINTMENT_FOR_HOUSEHOLD'::text
          FROM app.crm_source_mapping hm
          JOIN mirror.client c
            ON hm.source_key = c.household_id
          JOIN mirror.appointment ap
            ON ap.client_sf_id IS NOT NULL AND ap.client_sf_id = c.sf_id
          JOIN app.crm_source_mapping apm
            ON apm.source_system = 'CALENDAR' AND apm.source_namespace = 'appointment'
           AND apm.source_key = ap.external_key
         WHERE hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND hm.mapping_state = 'ACTIVE' AND hm.identity_id = ${identityId}`;

    case "CONTACT":
      return Prisma.sql`
        SELECT DISTINCT cm.identity_id AS from_id, hm.identity_id AS to_id,
               'CONTACT_MEMBER_OF_HOUSEHOLD'::text AS relation
          FROM app.crm_source_mapping cm
          JOIN mirror.client c
            ON cm.source_key = c.sf_id
          JOIN app.crm_source_mapping hm
            ON hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND hm.source_key = c.household_id AND hm.mapping_state = 'ACTIVE'
         WHERE cm.source_system = 'CRM' AND cm.source_namespace = 'contact'
           AND cm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT dm.identity_id, cm.identity_id, 'DEAL_FOR_CONTACT'::text
          FROM app.crm_source_mapping cm
          JOIN app.deal d
            ON d.client_sf_id IS NOT NULL AND d.client_sf_id = cm.source_key
          JOIN app.crm_source_mapping dm
            ON dm.source_system = 'AOA' AND dm.source_namespace = 'deal'
           AND dm.source_key = d.id
         WHERE cm.source_system = 'CRM' AND cm.source_namespace = 'contact'
           AND cm.mapping_state = 'ACTIVE' AND cm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT tm.identity_id, cm.identity_id, 'TRANSFER_FOR_CONTACT'::text
          FROM app.crm_source_mapping cm
          JOIN app.transfer t
            ON t.client_sf_id IS NOT NULL AND t.client_sf_id = cm.source_key
          JOIN app.crm_source_mapping tm
            ON tm.source_system = 'AOA' AND tm.source_namespace = 'transfer'
           AND tm.source_key = t.id
         WHERE cm.source_system = 'CRM' AND cm.source_namespace = 'contact'
           AND cm.mapping_state = 'ACTIVE' AND cm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT apm.identity_id, cm.identity_id, 'APPOINTMENT_FOR_CONTACT'::text
          FROM app.crm_source_mapping cm
          JOIN mirror.appointment ap
            ON ap.client_sf_id IS NOT NULL AND ap.client_sf_id = cm.source_key
          JOIN app.crm_source_mapping apm
            ON apm.source_system = 'CALENDAR' AND apm.source_namespace = 'appointment'
           AND apm.source_key = ap.external_key
         WHERE cm.source_system = 'CRM' AND cm.source_namespace = 'contact'
           AND cm.mapping_state = 'ACTIVE' AND cm.identity_id = ${identityId}`;

    case "DEAL":
      return Prisma.sql`
        SELECT DISTINCT dm.identity_id AS from_id, hm.identity_id AS to_id,
               'DEAL_FOR_HOUSEHOLD'::text AS relation
          FROM app.crm_source_mapping dm
          JOIN app.deal d ON dm.source_key = d.id
          JOIN app.crm_source_mapping hm
            ON hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND left(hm.source_key, 15) = left(d.household_sf_id, 15)
           AND hm.mapping_state = 'ACTIVE'
         WHERE dm.source_system = 'AOA' AND dm.source_namespace = 'deal'
           AND d.household_sf_id IS NOT NULL AND dm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT dm.identity_id, cm.identity_id, 'DEAL_FOR_CONTACT'::text
          FROM app.crm_source_mapping dm
          JOIN app.deal d ON dm.source_key = d.id
          JOIN app.crm_source_mapping cm
            ON cm.source_system = 'CRM' AND cm.source_namespace = 'contact'
           AND cm.source_key = d.client_sf_id AND cm.mapping_state = 'ACTIVE'
         WHERE dm.source_system = 'AOA' AND dm.source_namespace = 'deal'
           AND d.client_sf_id IS NOT NULL AND dm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT tm.identity_id, dm.identity_id, 'TRANSFER_FROM_DEAL'::text
          FROM app.crm_source_mapping dm
          JOIN app.transfer t ON t.deal_id IS NOT NULL AND t.deal_id = dm.source_key
          JOIN app.crm_source_mapping tm
            ON tm.source_system = 'AOA' AND tm.source_namespace = 'transfer'
           AND tm.source_key = t.id
         WHERE dm.source_system = 'AOA' AND dm.source_namespace = 'deal'
           AND dm.mapping_state = 'ACTIVE' AND dm.identity_id = ${identityId}`;

    case "TRANSFER":
      return Prisma.sql`
        SELECT DISTINCT tm.identity_id AS from_id, hm.identity_id AS to_id,
               'TRANSFER_FOR_HOUSEHOLD'::text AS relation
          FROM app.crm_source_mapping tm
          JOIN app.transfer t ON tm.source_key = t.id
          JOIN app.crm_source_mapping hm
            ON hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND left(hm.source_key, 15) = left(t.household_sf_id, 15)
           AND hm.mapping_state = 'ACTIVE'
         WHERE tm.source_system = 'AOA' AND tm.source_namespace = 'transfer'
           AND t.household_sf_id IS NOT NULL AND tm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT tm.identity_id, cm.identity_id, 'TRANSFER_FOR_CONTACT'::text
          FROM app.crm_source_mapping tm
          JOIN app.transfer t ON tm.source_key = t.id
          JOIN app.crm_source_mapping cm
            ON cm.source_system = 'CRM' AND cm.source_namespace = 'contact'
           AND cm.source_key = t.client_sf_id AND cm.mapping_state = 'ACTIVE'
         WHERE tm.source_system = 'AOA' AND tm.source_namespace = 'transfer'
           AND t.client_sf_id IS NOT NULL AND tm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT tm.identity_id, dm.identity_id, 'TRANSFER_FROM_DEAL'::text
          FROM app.crm_source_mapping tm
          JOIN app.transfer t ON tm.source_key = t.id
          JOIN app.crm_source_mapping dm
            ON dm.source_system = 'AOA' AND dm.source_namespace = 'deal'
           AND dm.source_key = t.deal_id AND dm.mapping_state = 'ACTIVE'
         WHERE tm.source_system = 'AOA' AND tm.source_namespace = 'transfer'
           AND t.deal_id IS NOT NULL AND tm.identity_id = ${identityId}`;

    case "EMAIL":
      return Prisma.sql`
        SELECT DISTINCT em.identity_id AS from_id, hm.identity_id AS to_id,
               'EMAIL_FOR_HOUSEHOLD'::text AS relation
          FROM app.crm_source_mapping em
          JOIN mirror.email e ON em.source_key = e.sf_id
          JOIN app.crm_source_mapping hm
            ON hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND left(hm.source_key, 15) = left(e.household_sf_id, 15)
           AND hm.mapping_state = 'ACTIVE'
         WHERE em.source_system = 'CRM' AND em.source_namespace = 'email'
           AND em.identity_id = ${identityId}`;

    case "ACTIVITY":
      return Prisma.sql`
        SELECT DISTINCT am.identity_id AS from_id, hm.identity_id AS to_id,
               'ACTIVITY_FOR_HOUSEHOLD'::text AS relation
          FROM app.crm_source_mapping am
          JOIN mirror.activity a ON am.source_key = a.sf_id
          JOIN app.crm_source_mapping hm
            ON hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND left(hm.source_key, 15) = left(a.household_sf_id, 15)
           AND hm.mapping_state = 'ACTIVE'
         WHERE am.source_system = 'CRM' AND am.source_namespace = 'activity'
           AND am.identity_id = ${identityId}`;

    case "TASK":
      return Prisma.sql`
        SELECT DISTINCT tkm.identity_id AS from_id, hm.identity_id AS to_id,
               'TASK_FOR_HOUSEHOLD'::text AS relation
          FROM app.crm_source_mapping tkm
          JOIN mirror.task tk ON tkm.source_key = tk.sf_id
          JOIN app.crm_source_mapping hm
            ON hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND left(hm.source_key, 15) = left(tk.household_sf_id, 15)
           AND hm.mapping_state = 'ACTIVE'
         WHERE tkm.source_system = 'CRM' AND tkm.source_namespace = 'task'
           AND tkm.identity_id = ${identityId}`;

    case "APPOINTMENT":
      return Prisma.sql`
        SELECT DISTINCT apm.identity_id AS from_id, cm.identity_id AS to_id,
               'APPOINTMENT_FOR_CONTACT'::text AS relation
          FROM app.crm_source_mapping apm
          JOIN mirror.appointment ap ON apm.source_key = ap.external_key
          JOIN app.crm_source_mapping cm
            ON cm.source_system = 'CRM' AND cm.source_namespace = 'contact'
           AND cm.source_key = ap.client_sf_id AND cm.mapping_state = 'ACTIVE'
         WHERE apm.source_system = 'CALENDAR' AND apm.source_namespace = 'appointment'
           AND ap.client_sf_id IS NOT NULL AND apm.identity_id = ${identityId}
        UNION
        SELECT DISTINCT apm.identity_id, hm.identity_id, 'APPOINTMENT_FOR_HOUSEHOLD'::text
          FROM app.crm_source_mapping apm
          JOIN mirror.appointment ap ON apm.source_key = ap.external_key
          JOIN mirror.client c ON c.sf_id = ap.client_sf_id
          JOIN app.crm_source_mapping hm
            ON hm.source_system = 'CRM' AND hm.source_namespace = 'household'
           AND hm.source_key = c.household_id AND hm.mapping_state = 'ACTIVE'
         WHERE apm.source_system = 'CALENDAR' AND apm.source_namespace = 'appointment'
           AND ap.client_sf_id IS NOT NULL AND apm.identity_id = ${identityId}`;
  }
}

export async function getCrmIdentityDetail(
  identity: Identity,
  crmId: string,
): Promise<CrmExplorerDetailResult> {
  if (!canReadCrmExplorer(identity.role)) return { ok: false, reason: "forbidden" };
  if (!crmIdentityReadsEnabled()) return { ok: false, reason: "disabled" };
  const startedAt = Date.now();

  return withUserScope(identity, async (tx) => {
    await applyCrmExplorerDatabaseBounds(tx);
    const identityStartedAt = Date.now();
    const [row] = await tx.$queryRaw<
      Array<{
        id: string;
        identity_type: CrmExplorerType;
        lifecycle_state: CrmLifecycleState;
        merged_into_id: string | null;
        first_seen_at: Date;
        updated_at: Date;
      }>
    >`
      SELECT id, identity_type, lifecycle_state, merged_into_id, first_seen_at, updated_at
        FROM app.crm_identity
       WHERE id = ${crmId}
       LIMIT 1`;
    const identityMs = Date.now() - identityStartedAt;
    if (!row) {
      logCrmExplorerTiming("detail", {
        totalMs: Date.now() - startedAt,
        identityMs,
        found: false,
      });
      return { ok: true as const, detail: null };
    }

    const mappingsStartedAt = Date.now();
    const { byIdentity: mappings } = await mappingsForIdentityIds(tx, [row.id]);
    const mappingRows = mappings.get(row.id) ?? [];
    const mappingsMs = Date.now() - mappingsStartedAt;
    const metadataStartedAt = Date.now();
    const detailRows = await tx.$queryRaw<
      Array<{
        kind: "EXCEPTION" | "MERGED_FROM";
        id: string | null;
        source_mapping_id: string | null;
        reason_code: string | null;
        exception_state: string | null;
        resolution_code: string | null;
        detected_at: Date | null;
        resolved_at: Date | null;
        merged_id: string | null;
      }>
    >`
      SELECT 'EXCEPTION'::text AS kind, e.id, e.source_mapping_id, e.reason_code,
             e.exception_state, e.resolution_code, e.detected_at, e.resolved_at,
             NULL::text AS merged_id
        FROM app.crm_identity_exception e
        JOIN app.crm_source_mapping m ON m.id = e.source_mapping_id
       WHERE m.identity_id = ${row.id}
      UNION ALL
      SELECT 'MERGED_FROM'::text, NULL::text, NULL::text, NULL::text,
             NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz, i.id
        FROM app.crm_identity i
       WHERE i.merged_into_id = ${row.id}
       ORDER BY kind, exception_state NULLS LAST, detected_at DESC NULLS LAST,
                id NULLS LAST, merged_id NULLS LAST`;
    const metadataMs = Date.now() - metadataStartedAt;
    const exceptionRows = detailRows.filter((item) => item.kind === "EXCEPTION");
    const mergedFromIds = detailRows.flatMap((item) => item.merged_id ? [item.merged_id] : []);

    // Build only the relationship paths that can apply to this identity type.
    // Every path starts from the selected CRM ID, avoiding cross-table OR
    // predicates that force PostgreSQL to assemble the full relationship graph.
    const connectionLinks = connectionLinksForIdentity(row.identity_type, row.id);
    const connectionsStartedAt = Date.now();
    const [rawConnections, manualParentRows] = await Promise.all([
      tx.$queryRaw<
        Array<{
          from_id: string;
          to_id: string;
          relation: ConnectionCode;
          total_count: bigint;
        }>
      >(Prisma.sql`
      WITH links AS (${connectionLinks}), selected AS (
        SELECT from_id, to_id, relation,
               count(*) OVER()::bigint AS total_count
          FROM links
         WHERE from_id = ${row.id} OR to_id = ${row.id}
         ORDER BY relation, from_id, to_id
         LIMIT ${CRM_CONNECTION_LIMIT}
      )
      SELECT from_id, to_id, relation, total_count FROM selected`),
      readCrmParentOverrides(tx, row.id),
    ]);
    const connectionsMs = Date.now() - connectionsStartedAt;

    const otherIds = [
      ...new Set(
        [
          ...rawConnections.map((connection) =>
            connection.from_id === row.id ? connection.to_id : connection.from_id,
          ),
          ...manualParentRows.map((override) => override.parent_identity_id),
        ],
      ),
    ];
    const connectionMappingsStartedAt = Date.now();
    const {
      byIdentity: otherMappings,
      identityTypes: otherTypes,
    } = await mappingsForIdentityIds(tx, otherIds);
    const connectionMappingsMs = Date.now() - connectionMappingsStartedAt;

    const sourceConnections: CrmExplorerConnection[] = rawConnections.flatMap((connection) => {
      const outgoing = connection.from_id === row.id;
      const otherId = outgoing ? connection.to_id : connection.from_id;
      const otherType = otherTypes.get(otherId);
      if (!otherType) return [];
      const preferred = otherMappings.get(otherId)?.find((mapping) => mapping.mappingState === "ACTIVE")
        ?? otherMappings.get(otherId)?.[0];
      const labels = CONNECTION_LABELS[connection.relation];
      return [{
        identityId: otherId,
        identityType: otherType,
        relationship: outgoing ? labels.forward : labels.reverse,
        direction: outgoing ? "OUTGOING" as const : "INCOMING" as const,
        displayName: preferred?.displayName ?? null,
        href: preferred?.href ?? null,
      }];
    });
    const manualParents: CrmExplorerManualParent[] = manualParentRows.flatMap((override) => {
      const parentType = otherTypes.get(override.parent_identity_id);
      if (!parentType) return [];
      const preferred = otherMappings.get(override.parent_identity_id)
        ?.find((mapping) => mapping.mappingState === "ACTIVE")
        ?? otherMappings.get(override.parent_identity_id)?.[0];
      return [{
        id: override.id,
        sourceMappingId: override.source_mapping_id,
        parentIdentityId: override.parent_identity_id,
        parentIdentityType: parentType,
        relationshipCode: override.relationship_code,
        confirmedBy: override.confirmed_by,
        confirmedAt: override.confirmed_at.toISOString(),
        displayName: preferred?.displayName ?? null,
        href: preferred?.href ?? null,
      }];
    });
    const manualConnections: CrmExplorerConnection[] = manualParents.map((override) => ({
      identityId: override.parentIdentityId,
      identityType: override.parentIdentityType,
      relationship: crmParentRelationshipLabel(override.relationshipCode),
      direction: "OUTGOING",
      displayName: override.displayName,
      href: override.href,
    }));
    const sourceConnectionKeys = new Set(
      sourceConnections.map((connection) => `${connection.identityId}:${connection.direction}`),
    );
    const uniqueManualConnections = manualConnections.filter(
      (connection) => !sourceConnectionKeys.has(`${connection.identityId}:${connection.direction}`),
    );
    const connections = [...uniqueManualConnections, ...sourceConnections];
    const connectionTotal = Number(rawConnections[0]?.total_count ?? 0)
      + uniqueManualConnections.length;
    logCrmExplorerTiming("detail", {
      totalMs: Date.now() - startedAt,
      identityMs,
      mappingsMs,
      metadataMs,
      connectionsMs,
      connectionMappingsMs,
      connectionCount: connections.length,
      found: true,
    });

    return {
      ok: true as const,
      detail: {
        id: row.id,
        identityType: row.identity_type,
        lifecycleState: row.lifecycle_state,
        mergedIntoId: row.merged_into_id,
        mergedFromIds,
        firstSeenAt: row.first_seen_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        mappings: mappingRows,
        exceptions: exceptionRows.flatMap((exception) => exception.id
          && exception.source_mapping_id
          && exception.reason_code
          && exception.exception_state
          && exception.detected_at
          ? [{
          id: exception.id,
          sourceMappingId: exception.source_mapping_id,
          reasonCode: exception.reason_code,
          state: exception.exception_state,
          resolutionCode: exception.resolution_code,
          detectedAt: exception.detected_at.toISOString(),
          resolvedAt: exception.resolved_at?.toISOString() ?? null,
        }]
          : []),
        manualParents,
        connections,
        connectionTotal,
        connectionsTruncated: connectionTotal > connections.length,
      },
    };
  }, CRM_EXPLORER_TRANSACTION_OPTIONS);
}
