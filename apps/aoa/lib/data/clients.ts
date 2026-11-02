import { withUserScope } from "@/lib/rls";
import { Prisma } from "@prisma/client";
import { canViewCedarRidgeUserId } from "./client-field-authz";
import type { Identity, ClientDetail, ClientListRow, HouseholdRow } from "./types";
import { resolveCrmRouteKey } from "@/lib/crm/resolve";
import { crmIdentityReadsEnabled } from "@/lib/flags";
import type {
  ClientDirectoryFilters,
  ClientStageCounts,
} from "@/components/client-portrait/directory-results";
import { logDirectoryTiming } from "@/lib/observability/structured-log";
import { householdDisplayCtes, householdSourceKeySql } from "./household-display";

// REAL read: client identity + its household context, RLS-scoped via withUserScope.

// Materialize normalized join keys once per visible row. Keeping the CASE/regex
// expressions out of the client × household join avoids repeating them for
// every candidate pair on a large book, while preserving opaque imported IDs.
function clientHouseholdCtes(canonicalReads: boolean): Prisma.Sql {
  return Prisma.sql`
    ${householdDisplayCtes(canonicalReads)}, visible_client AS MATERIALIZED (
      SELECT c.*, ${householdSourceKeySql(Prisma.sql`c.household_id`)} AS household_source_key
        FROM mirror.client c
       WHERE c.household_id IS NULL OR c.sf_id <> c.household_id
    ), canonical_contact_overlay AS MATERIALIZED (
      SELECT overlay.source_key, overlay.canonical_source_key
        FROM app.resolve_crm_canonical_contact_overlays(
          CASE WHEN ${canonicalReads}
            THEN ARRAY(SELECT c.sf_id FROM visible_client c)
            ELSE ARRAY[]::text[]
          END
        ) overlay
    ), keyed_household_overlay AS MATERIALIZED (
      SELECT canonical_source_key,
             ${householdSourceKeySql(Prisma.sql`source_key`)} AS household_source_key,
             ${householdSourceKeySql(Prisma.sql`canonical_source_key`)} AS canonical_household_key
        FROM canonical_overlay
    ), client_household AS MATERIALIZED (
      SELECT c.*,
             COALESCE(overlay.canonical_source_key, c.household_id) AS resolved_household_id,
             COALESCE(overlay.canonical_household_key, c.household_source_key) AS resolved_household_key
        FROM visible_client c
        LEFT JOIN keyed_household_overlay overlay
          ON overlay.household_source_key = c.household_source_key
    ), keyed_household AS MATERIALIZED (
      SELECT ${householdSourceKeySql(Prisma.sql`h.sf_id`)} AS household_key,
             h.stage, display.display_name, display.source_names
        FROM base_household h
        LEFT JOIN household_display display ON display.sf_id = h.sf_id
    )`;
}

// The Client Portrait picker (/client-portrait): every client the caller can see
// (RLS-scoped by lead_advisor_email — Ops/Admin the firm, an advisor their own
// book), with household name/stage + advisor display name folded in. Placeholder
// rows the retired households-as-clients feed left behind (sf_id = household_id)
// are excluded here too, so the picker only ever lists real people even if the
// one-time purge hasn't run yet.
/**
 * List clients using an already RLS-scoped transaction.
 *
 * Callers must obtain `tx` from `withUserScope`; keeping the query available at
 * this seam lets pages that need related reads share one transaction instead of
 * opening several competing interactive transactions.
 */
export async function listClientsWithinUserScope(
  tx: Prisma.TransactionClient,
): Promise<ClientListRow[]> {
  const canonicalReads = crmIdentityReadsEnabled();
  await applyClientDirectoryDatabaseBounds(tx);
  return tx.$queryRaw<ClientListRow[]>`
      WITH ${clientHouseholdCtes(canonicalReads)}
      SELECT c.sf_id,
             trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name,
             c.resolved_household_id AS household_id,
             h.display_name AS household_name,
             h.stage AS household_stage,
             c.lead_advisor_email,
             a.name  AS advisor_name,
             es.employment_state::text AS "employeeStatus"
      FROM client_household c
      LEFT JOIN canonical_contact_overlay contact_overlay
        ON left(contact_overlay.source_key, 15) = left(c.sf_id, 15)
      LEFT JOIN keyed_household h ON h.household_key = c.resolved_household_key
      LEFT JOIN mirror.advisor  a ON a.email = c.lead_advisor_email
      LEFT JOIN app.employee_client_status es
        ON left(es.client_sf_id, 15) = left(c.sf_id, 15)
       AND app.employee_badge_is_current(es.client_sf_id)
      WHERE contact_overlay.source_key IS NULL
      ORDER BY name`;
}

export async function listClients(id: Identity): Promise<ClientListRow[]> {
  return withUserScope(id, listClientsWithinUserScope, CLIENT_DIRECTORY_TRANSACTION_OPTIONS);
}

type RawClientDirectoryEnvelope = {
  snapshot: string;
  rows: ClientListRow[];
  total: bigint;
  page: bigint;
  page_count: bigint;
  counts: ClientStageCounts;
};

export type ClientDirectoryPage = {
  snapshot: string;
  rows: ClientListRow[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  counts: ClientStageCounts;
};

// Match Prisma's existing interactive-transaction defaults. PostgreSQL must
// also cancel active work before that deadline: a Prisma timeout alone does
// not stop a blocked/running query from retaining its pooled connection.
export const CLIENT_DIRECTORY_TRANSACTION_OPTIONS = { timeout: 5_000, maxWait: 2_000 } as const;
export const CLIENT_DIRECTORY_STATEMENT_TIMEOUT_MS = 4_000;
export const CLIENT_DIRECTORY_LOCK_TIMEOUT_MS = 1_000;

export async function applyClientDirectoryDatabaseBounds(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('jit', 'off', true)`;
  await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(CLIENT_DIRECTORY_STATEMENT_TIMEOUT_MS)}, true)`;
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(CLIENT_DIRECTORY_LOCK_TIMEOUT_MS)}, true)`;
}

/**
 * Bounded Client Portrait directory read.
 *
 * Unlike `listClients` (retained for workflows that genuinely need the complete
 * visible population), this function filters, sorts, counts, and paginates in
 * PostgreSQL. Only the requested page crosses the RSC boundary. The whole query
 * remains inside one `withUserScope` transaction, so the optimization cannot
 * widen the caller's RLS-visible book.
 */
export async function getClientDirectory(
  id: Identity,
  filters: ClientDirectoryFilters,
  requestedPage: number,
  requestedPageSize: number,
): Promise<ClientDirectoryPage> {
  const canonicalReads = crmIdentityReadsEnabled();
  const pageSize = Math.min(200, Math.max(1, Math.trunc(requestedPageSize) || 1));
  const page = Math.max(1, Math.trunc(requestedPage) || 1);
  const queryPattern = `%${filters.query.trim()}%`;

  const startedAt = performance.now();
  const envelopes = await withUserScope(id, async (tx) => {
    // Complex RLS/canonical-overlay estimates can trigger LLVM compilation for
    // a 100-row response. Keep this setting transaction-local, as in CRM.
    await applyClientDirectoryDatabaseBounds(tx);
    return tx.$queryRaw<RawClientDirectoryEnvelope[]>`
      WITH ${clientHouseholdCtes(canonicalReads)}, current_employee_status AS MATERIALIZED (
        -- Evaluate the security-definer freshness check only for actual,
        -- RLS-visible employee records, not once per client (including NULL
        -- left-join matches). Reuse exactly this set for the version and page.
        SELECT es.client_sf_id, es.employment_state
          FROM app.employee_client_status es
         WHERE app.employee_badge_is_current(es.client_sf_id)
           AND EXISTS (
             SELECT 1 FROM visible_client c
              WHERE left(c.sf_id, 15) = left(es.client_sf_id, 15)
           )
      ), directory AS MATERIALIZED (
        SELECT c.sf_id,
               trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name,
               c.resolved_household_id AS household_id,
               h.display_name AS household_name,
               h.source_names AS household_source_names,
               h.stage AS household_stage,
               c.lead_advisor_email,
               a.name AS advisor_name,
               CASE lower(regexp_replace(trim(COALESCE(h.stage, '')), '\\s+', ' ', 'g'))
                 WHEN 'client' THEN 'client'
                 WHEN 'prospect' THEN 'prospect'
                 WHEN 'lost prospect' THEN 'lost_prospect'
                 WHEN 'lost client' THEN 'lost_client'
                 ELSE NULL
               END AS stage_key
          FROM client_household c
          LEFT JOIN canonical_contact_overlay contact_overlay
            ON left(contact_overlay.source_key, 15) = left(c.sf_id, 15)
          LEFT JOIN keyed_household h ON h.household_key = c.resolved_household_key
          LEFT JOIN mirror.advisor a ON a.email = c.lead_advisor_email
         WHERE contact_overlay.source_key IS NULL
      ), stats AS (
        SELECT count(*)::bigint AS all_count,
               count(*) FILTER (WHERE stage_key = 'client')::bigint AS client_count,
               count(*) FILTER (WHERE stage_key = 'prospect')::bigint AS prospect_count,
               count(*) FILTER (WHERE stage_key = 'lost_prospect')::bigint AS lost_prospect_count,
               count(*) FILTER (WHERE stage_key = 'lost_client')::bigint AS lost_client_count
          FROM directory
      ), filtered AS MATERIALIZED (
        SELECT *
          FROM directory
         WHERE (${filters.stage} = 'all' OR stage_key = ${filters.stage})
           AND (
             ${filters.query.trim()} = ''
             OR name ILIKE ${queryPattern}
             OR COALESCE(household_name, '') ILIKE ${queryPattern}
             OR EXISTS (SELECT 1 FROM unnest(household_source_names) source_name
                         WHERE source_name ILIKE ${queryPattern})
             OR COALESCE(advisor_name, '') ILIKE ${queryPattern}
             OR COALESCE(lead_advisor_email, '') ILIKE ${queryPattern}
           )
      ), directory_version AS (
        SELECT md5(
          COALESCE((SELECT string_agg(md5(to_jsonb(filtered)::text), '' ORDER BY sf_id) FROM filtered), '')
          || COALESCE((SELECT to_jsonb(stats)::text FROM stats), '')
          || COALESCE((SELECT string_agg(md5(to_jsonb(visible_client)::text), '' ORDER BY sf_id) FROM visible_client), '')
          || COALESCE((SELECT string_agg(md5(to_jsonb(canonical_contact_overlay)::text), '' ORDER BY source_key) FROM canonical_contact_overlay), '')
          || COALESCE((SELECT string_agg(md5(to_jsonb(canonical_overlay)::text), '' ORDER BY source_key) FROM canonical_overlay), '')
          || COALESCE((SELECT string_agg(md5(jsonb_build_array(sf_id, display_name, source_names)::text), '' ORDER BY sf_id) FROM household_display), '')
          || COALESCE((SELECT string_agg(md5(jsonb_build_array(c.sf_id, es.employment_state, es.client_sf_id IS NOT NULL)::text), '' ORDER BY c.sf_id)
               FROM visible_client c LEFT JOIN current_employee_status es
                 ON left(es.client_sf_id, 15) = left(c.sf_id, 15)), '')
        ) AS snapshot
      ), page_meta AS (
        SELECT count(*)::bigint AS total,
               GREATEST(1, CEIL(count(*)::numeric / ${pageSize})::bigint) AS page_count,
               LEAST(
                 ${page}::bigint,
                 GREATEST(1, CEIL(count(*)::numeric / ${pageSize})::bigint)
               ) AS page
          FROM filtered
      ), bounded_rows AS (
        SELECT filtered.*,
               row_number() OVER (
                 ORDER BY
                   CASE WHEN ${filters.sortKey} = 'name' AND ${filters.sortDir} = 'asc'
                     THEN lower(name) END ASC,
                   CASE WHEN ${filters.sortKey} = 'name' AND ${filters.sortDir} = 'desc'
                     THEN lower(name) END DESC,
                   CASE WHEN ${filters.sortKey} = 'household' AND ${filters.sortDir} = 'asc'
                     THEN lower(COALESCE(household_name, '')) END ASC,
                   CASE WHEN ${filters.sortKey} = 'household' AND ${filters.sortDir} = 'desc'
                     THEN lower(COALESCE(household_name, '')) END DESC,
                   lower(name) ASC,
                   sf_id ASC
               ) AS row_order
          FROM filtered
         LIMIT ${pageSize}
        OFFSET (((SELECT page FROM page_meta) - 1) * ${pageSize})
      ), page_rows AS (
        SELECT bounded_rows.*,
               CASE
                 WHEN es.employment_state = 'ACTIVE' THEN 'ACTIVE'
                 WHEN es.employment_state = 'FORMER' THEN 'FORMER'
                 ELSE NULL
               END AS "employeeStatus"
          FROM bounded_rows
          LEFT JOIN current_employee_status es
            ON left(es.client_sf_id, 15) = left(bounded_rows.sf_id, 15)
      )
      SELECT (SELECT snapshot FROM directory_version) AS snapshot, COALESCE(
               (SELECT jsonb_agg(to_jsonb(page_rows) - 'stage_key' - 'row_order' - 'household_source_names'
                                 ORDER BY row_order)
                  FROM page_rows),
               '[]'::jsonb
             ) AS rows,
             page_meta.total,
             page_meta.page,
             page_meta.page_count,
             jsonb_build_object(
               'all', stats.all_count,
               'client', stats.client_count,
               'prospect', stats.prospect_count,
               'lost_prospect', stats.lost_prospect_count,
               'lost_client', stats.lost_client_count
             ) AS counts
        FROM page_meta CROSS JOIN stats`;
  }, CLIENT_DIRECTORY_TRANSACTION_OPTIONS);

  const envelope = envelopes[0];
  logDirectoryTiming("client_portrait", performance.now() - startedAt, envelope?.rows.length ?? 0);
  if (!envelope) {
    return {
      snapshot: "d41d8cd98f00b204e9800998ecf8427e",
      rows: [],
      total: 0,
      page: 1,
      pageCount: 1,
      pageSize,
      counts: { all: 0, client: 0, prospect: 0, lost_prospect: 0, lost_client: 0 },
    };
  }
  return {
    snapshot: envelope.snapshot,
    rows: envelope.rows,
    total: Number(envelope.total),
    page: Number(envelope.page),
    pageCount: Number(envelope.page_count),
    pageSize,
    counts: Object.fromEntries(
      Object.entries(envelope.counts).map(([key, value]) => [key, Number(value)]),
    ) as ClientStageCounts,
  };
}

type ClientRow = {
  sf_id: string;
  name: string;
  email: string | null;
  household_id: string;
  cedar_ridge_user_id: string | null;
  employee_status: "ACTIVE" | "FORMER" | null;
};

export async function getClientWithHousehold(
  id: Identity,
  sfId: string,
): Promise<ClientDetail | null> {
  const resolvedSfId = await resolveCrmRouteKey(id, "CONTACT", sfId);
  return withUserScope(id, async (tx) => {
    const rows = await tx.$queryRaw<ClientRow[]>`
      SELECT sf_id,
             trim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS name,
             email,
             household_id,
             cedar_ridge_user_id,
             es.employment_state::text AS employee_status
      FROM mirror.client c
      LEFT JOIN app.employee_client_status es
        ON left(es.client_sf_id, 15) = left(c.sf_id, 15)
       AND app.employee_badge_is_current(es.client_sf_id)
      WHERE c.sf_id = ${resolvedSfId}
      LIMIT 1`;
    const client = rows[0];
    if (!client) return null;

    const canonicalHouseholdId = crmIdentityReadsEnabled()
      ? (await tx.$queryRaw<Array<{ sf_id: string }>>`
          SELECT app.resolve_crm_canonical_household_source_key(
            ${client.household_id}
          ) AS sf_id`)[0]?.sf_id ?? client.household_id
      : client.household_id;

    const households = await tx.$queryRaw<HouseholdRow[]>`
      WITH ${householdDisplayCtes(crmIdentityReadsEnabled(), Prisma.sql`ARRAY[${canonicalHouseholdId}]::text[]`)}
      SELECT h.sf_id, display.display_name AS name, h.status, h.stage, h.aum, h.lead_advisor_email
      FROM mirror.household h
      JOIN household_display display ON display.sf_id = h.sf_id
      WHERE ${householdSourceKeySql(Prisma.sql`h.sf_id`)} = ${householdSourceKeySql(Prisma.sql`${canonicalHouseholdId}::text`)}
      LIMIT 1`;
    const household = households[0] ?? null;

    return {
      sf_id: client.sf_id,
      name: client.name,
      email: client.email,
      employeeStatus: client.employee_status,
      // `aum` is a Postgres numeric → a Prisma Decimal at runtime (despite the
      // `number | null` type). Coerce at the seam (cf. lib/data/households.ts)
      // so headers can format it — a raw Decimal renders as "2450000 AUM".
      household: household
        ? { ...household, aum: household.aum == null ? null : Number(household.aum) }
        : null,
      // cedar_ridge_user_id is a sensitive internal join key: include it ONLY for
      // ADMIN/OPERATIONS (client-field-authz). For every other role the key is
      // omitted entirely, so the value never enters the RSC payload. The DB read
      // is RLS-scoped either way; this is the visibility gate on top.
      ...(canViewCedarRidgeUserId(id.role)
        ? { cedarRidgeUserId: client.cedar_ridge_user_id }
        : {}),
    };
  });
}

/**
 * SERVER-SIDE JOIN KEY read: the raw `cedar_ridge_user_id` for a client the caller
 * can see, for looking up that client's linked external reads (trade requests,
 * S2). RLS-scoped via withUserScope — returns null for a client outside the
 * caller's book (or unknown), so it NEVER widens visibility.
 *
 * This is NOT the display value: the human-readable id stays role-gated via
 * `cedarRidgeUserId` / canViewCedarRidgeUserId on getClientWithHousehold. It is
 * deliberately NOT placed on ClientDetail/PortraitDetail so it can never be
 * serialized to the browser through a whole-object prop — the caller holds it as
 * a local server-side const and passes it ONLY to a server component that uses
 * it as the argument to a server-side read. Never render it, never hand it to a
 * "use client" component.
 */
export async function getCedarRidgeUserIdForLinkedReads(
  id: Identity,
  sfId: string,
): Promise<string | null> {
  const resolvedSfId = await resolveCrmRouteKey(id, "CONTACT", sfId);
  return withUserScope(id, async (tx) => {
    const rows = await tx.$queryRaw<{ cedar_ridge_user_id: string | null }[]>`
      SELECT cedar_ridge_user_id
      FROM mirror.client
      WHERE sf_id = ${resolvedSfId}
      LIMIT 1`;
    return rows[0]?.cedar_ridge_user_id ?? null;
  });
}

/**
 * SERVER-SIDE JOIN KEYS for a household's members — the raw `cedar_ridge_user_id`s
 * of every member client the caller can see, for the household trade-requests
 * union (S3). RLS-scoped via withUserScope, so it NEVER widens visibility.
 * Excludes the retired households-as-clients PLACEHOLDER row (sf_id =
 * household_id, the listClients precedent) and null ids.
 *
 * Returns a bare `string[]` — deliberately NOT on ClientDetail / HouseholdDetail
 * / HouseholdMember so it can never be serialized to the browser via a
 * whole-object prop. The caller holds it as a local server-side const and passes
 * it ONLY to a server component that uses it as the argument to a server-side
 * read. Never render these ids, never hand them to a "use client" component.
 */
export async function getCedarRidgeUserIdsForHousehold(
  id: Identity,
  householdSfId: string,
): Promise<string[]> {
  return getCedarRidgeUserIdsForHouseholdSources(id, [householdSfId]);
}

export async function getCedarRidgeUserIdsForHouseholdSources(
  id: Identity,
  householdSfIds: string[],
): Promise<string[]> {
  const keys = [
    ...new Set(householdSfIds.filter(Boolean).map((value) => value.slice(0, 15))),
  ].slice(0, 16);
  if (keys.length === 0) return [];
  return withUserScope(id, async (tx) => {
    const rows = await tx.$queryRaw<{ cedar_ridge_user_id: string | null }[]>(Prisma.sql`
      SELECT cedar_ridge_user_id
      FROM mirror.client
      WHERE left(household_id, 15) IN (${Prisma.join(keys)})
        AND left(sf_id, 15) <> left(household_id, 15)
        AND cedar_ridge_user_id IS NOT NULL`);
    return [
      ...new Set(
        rows
          .map((r) => r.cedar_ridge_user_id)
          .filter((x): x is string => x != null && x !== ""),
      ),
    ];
  });
}
