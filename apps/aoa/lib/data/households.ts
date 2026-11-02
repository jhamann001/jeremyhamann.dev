import { withUserScope } from "@/lib/rls";
import { Prisma } from "@prisma/client";
import type {
  Identity,
  HouseholdRow,
  HouseholdListRow,
  HouseholdMember,
  HouseholdDetail,
  HouseholdDeal,
} from "./types";
import {
  householdDealKey,
  householdAumFromDeals,
  householdAumFromDealsByKey,
  pickHouseholdAum,
  type HouseholdClientAumRow,
  summarizeHouseholdDeals,
} from "./deal-types";
import {
  householdInvestmentAumState,
  householdInvestmentAumStateForSources,
  investmentAccountBaseSql,
} from "./investment-accounts";
import {
  FIRM_HOUSEHOLD_ID,
  FIRM_HOUSEHOLD_NAME,
  FIRM_HOUSEHOLD_ADVISOR_EMAIL,
  HOUSEHOLD_KIND_FIRM,
  canSeeFirmHousehold,
} from "./firm-household";
import {
  crmCanonicalHouseholdSourceKeysForCanonical,
  resolveCrmRouteKey,
} from "@/lib/crm/resolve";
import { crmIdentityReadsEnabled } from "@/lib/flags";
import { householdDirectoryDisplayCtes, householdDisplayCtes } from "./household-display";
import { likePattern } from "./search";
import type {
  HouseholdDirectoryFilters,
  HouseholdStageCounts,
} from "@/components/households/directory-results";
import {
  logDetailTiming,
  logDirectoryFailure,
  logDirectoryTiming,
} from "@/lib/observability/structured-log";
import {
  DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS,
  HOUSEHOLD_DIRECTORY_MAX_PAGE_SIZE,
  householdDirectoryQueryKey,
} from "@/lib/navigation/household-query";
import { householdDirectoryFastPathEnabled } from "@/lib/household-directory-fast-path";
import { startHouseholdPreviewTiming } from "@/lib/observability/household-preview-timing";
import {
  applyHouseholdDirectoryDatabaseBounds,
  HOUSEHOLD_DIRECTORY_LOCK_TIMEOUT_MS,
  HOUSEHOLD_DIRECTORY_STATEMENT_TIMEOUT_MS,
  HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS,
} from "./household-directory-bounds";

// REAL reads: every query runs inside `withUserScope`, so Postgres RLS scopes the
// rows to the caller's book of business (Ops/Admin see the firm; an advisor sees
// only their own). Mirrors the proven dashboard read pattern (app/(authenticated)/dashboard).

// Raw list row before the seam coercion: numerics arrive as Prisma Decimals,
// count(*) as a BigInt. The retained `apex_aum` SQL alias now represents
// confirmed custodial balances, with `has_schwab` preserving source labeling.
type RawHouseholdListRow = Omit<HouseholdListRow, "aum" | "member_count" | "aum_source"> & {
  aum: unknown; // Decimal at runtime
  apex_aum: unknown; // Decimal at runtime (sum(numeric)) — null = no/unknown accounts
  aum_pending: boolean;
  has_schwab: boolean;
  member_count: bigint;
};

export async function listHouseholds(id: Identity): Promise<HouseholdListRow[]> {
  const canonicalHouseholds = crmIdentityReadsEnabled();
  // member_count: REAL join onto mirror.client (RLS-scoped like the household —
  // lead_advisor_email is denormalized onto client, so counts match visibility).
  // advisor_name: resolved from mirror.advisor reference data (LEFT JOIN — an
  // unmatched email yields NULL and the UI falls back to the raw email).
  //
  // Same custodial-first fallback chain as the detail page, in bulk:
  //   • confirmed Apex + Schwab balances, normalized to 15-char household keys.
  //     Pending balances suppress the total; only ABSENT custodial rows permit
  //     a deals/mirror fallback. Zero-valued and closed-only accounts stay $0.
  //   • deals fallback: ONE companion pull of the minimal non-archived deal
  //     rows in the SAME withUserScope tx; the per-household totals (incl. the
  //     completeness gate) are computed in TS by householdAumFromDealsByKey —
  //     the same pure semantics getHousehold uses, never a partial SQL sum.
  // Both tables carry their own RLS policies, so running inside withUserScope
  // keeps every aggregate scoped to the caller's book automatically.
  // ticket: the firm household ("Cedar Ridge Wealth") is synthetic — never a
  // mirror.household row — so its accounts don't join into any real household
  // above (no household has an sf_id starting FIRM-CEDAR-RIDGE). We pull its SOD
  // total + account count separately in the SAME tx and inject the row below,
  // gated to canSeeFirmHousehold. RLS still applies: for an advisor the firm rows are
  // invisible (the own_book policy's household join can't reach FIRM-CEDAR-RIDGE),
  // so firmCount is 0 and nothing is injected even before the role gate.
  const { rows, dealRows, firm } = await withUserScope(id, async (tx) => {
    const rows = await tx.$queryRaw<RawHouseholdListRow[]>`
      WITH ${householdDisplayCtes(canonicalHouseholds)}, member_rollup AS (
        SELECT left(source.canonical_sf_id, 15) AS canonical15,
               count(c.sf_id) AS member_count,
               bool_or(es.employment_state = 'ACTIVE') AS has_active_employee,
               bool_or(es.employment_state = 'FORMER') AS has_former_employee
          FROM visible_household source
          LEFT JOIN mirror.client c
            ON left(c.household_id, 15) = left(source.sf_id, 15)
          LEFT JOIN app.employee_client_status es
            ON left(es.client_sf_id, 15) = left(c.sf_id, 15)
           AND app.employee_badge_is_current(es.client_sf_id)
         GROUP BY 1
      ), account_base AS MATERIALIZED (
        ${investmentAccountBaseSql()}
      ), apex_rollup AS (
        SELECT source.canonical15,
               COALESCE(sum(account.account_aum) FILTER (WHERE account.balance_current), 0) AS apex_aum,
               bool_or(account.account_status IS DISTINCT FROM 'CLOSED' AND NOT account.balance_current) AS aum_pending,
               bool_or(account.custodian = 'Schwab') AS has_schwab
          FROM (SELECT DISTINCT left(sf_id, 15) AS source15, left(canonical_sf_id, 15) AS canonical15
                  FROM visible_household) source
          JOIN account_base account
            ON left(account.household_sf_id, 15) = source.source15
           AND account.confirmed
         GROUP BY 1
      )
      SELECT h.sf_id, display.display_name AS name, display.source_names,
             h.status, h.stage, h.aum, h.lead_advisor_email,
             h.household_kind,
             CASE
               WHEN member.has_active_employee THEN 'ACTIVE'
               WHEN member.has_former_employee THEN 'FORMER'
               ELSE NULL
             END AS "employeeStatus",
             a.name AS advisor_name,
             apx.apex_aum,
             COALESCE(apx.aum_pending, false) AS aum_pending,
             COALESCE(apx.has_schwab, false) AS has_schwab,
             COALESCE(member.member_count, 0)::bigint AS member_count
      FROM visible_household h
      JOIN household_display display ON display.sf_id = h.sf_id
      LEFT JOIN mirror.advisor a ON a.email = h.lead_advisor_email
      LEFT JOIN member_rollup member
        ON member.canonical15 = left(h.sf_id, 15)
      LEFT JOIN apex_rollup apx
        ON apx.canonical15 = left(h.sf_id, 15)
      WHERE (
        NOT ${canonicalHouseholds}
        OR left(h.canonical_sf_id, 15) = left(h.sf_id, 15)
      )`;
    const dealRows = await tx.$queryRaw<
      (Omit<HouseholdClientAumRow, "person_aum"> & { person_aum: unknown })[]
    >`
      WITH visible_deal AS MATERIALIZED (
        SELECT household_sf_id, client_sf_id, person_aum
        FROM app.deal
        WHERE archived_at IS NULL
          AND household_sf_id IS NOT NULL
      ), canonical_overlay AS MATERIALIZED (
        SELECT overlay.source_key, overlay.canonical_source_key
        FROM app.resolve_crm_canonical_household_overlays(
          CASE WHEN ${canonicalHouseholds}
            THEN ARRAY(SELECT DISTINCT deal.household_sf_id FROM visible_deal deal)
            ELSE ARRAY[]::text[]
          END
        ) overlay
      )
      SELECT COALESCE(overlay.canonical_source_key, deal.household_sf_id)
               AS household_sf_id,
             deal.client_sf_id,
             deal.person_aum
      FROM visible_deal deal
      LEFT JOIN canonical_overlay overlay
        ON overlay.source_key = deal.household_sf_id`;
    const firmRows = await tx.$queryRaw<{ total: unknown; n: bigint; has_schwab: boolean }[]>`
      WITH accounts AS (${investmentAccountBaseSql()})
      SELECT CASE WHEN bool_or(account_status IS DISTINCT FROM 'CLOSED' AND NOT balance_current)
               THEN NULL ELSE COALESCE(sum(account_aum) FILTER (WHERE balance_current), 0) END AS total,
             count(*) AS n, bool_or(custodian = 'Schwab') AS has_schwab
      FROM accounts WHERE is_firm AND confirmed`;
    return { rows, dealRows, firm: firmRows[0] };
  });

  // Deals-derived AUM per 15-char household key (person_aum Number()-coerced
  // first — the pure helpers never see a raw Decimal).
  const dealsAumByKey = householdAumFromDealsByKey(
    dealRows.map((r) => ({
      ...r,
      person_aum: r.person_aum == null ? null : Number(r.person_aum),
    })),
  );

  // `aum`/`apex_aum` are Postgres numerics → Prisma Decimal objects at runtime
  // (despite the typings); `count(*)` is a bigint → BigInt. Neither is
  // serializable across the Server → Client Component boundary (HouseholdsTable
  // is "use client"), so coerce everything to plain numbers here, at the seam,
  // before the row ever reaches a component. pickHouseholdAum then resolves the
  // chain per row (real Apex $0 wins; all-null → null, never a fabricated 0).
  const list = rows.map(({ apex_aum, aum_pending, has_schwab, ...r }) => {
    const apexAum = apex_aum == null ? null : Number(apex_aum);
    const mirrorAum = r.aum == null ? null : Number(r.aum);
    const dealKey = householdDealKey(r.sf_id);
    const dealsAum = dealKey == null ? null : (dealsAumByKey.get(dealKey) ?? null);
    const { aum, source } = pickHouseholdAum(apexAum, dealsAum, mirrorAum);
    return {
      ...r,
      aum: aum_pending ? null : aum,
      // null aum = every source unknown — no meaningful source label.
      aum_source: aum_pending || aum == null ? null : source === "apex" && has_schwab ? "custodians" as const : source,
      member_count: Number(r.member_count),
    };
  });

  // ticket: inject the synthetic "Cedar Ridge Wealth" firm household — visible to
  // ADMIN/OPS/HoA only, and only when it actually has accounts. Its aum is the
  // firm SOD total (Apex — ties to the custodian). It carries no client members
  // and no stage, so the Clients/Prospects/Lost count KPIs ignore it and the
  // Client-AUM KPI (which excludes FIRM) does not roll it in.
  if (canSeeFirmHousehold(id.role) && firm && Number(firm.n) > 0) {
    list.push({
      sf_id: FIRM_HOUSEHOLD_ID,
      name: FIRM_HOUSEHOLD_NAME,
      status: null,
      stage: null,
      aum: firm.total == null ? null : Number(firm.total),
      lead_advisor_email: FIRM_HOUSEHOLD_ADVISOR_EMAIL,
      household_kind: HOUSEHOLD_KIND_FIRM,
      advisor_name: null,
      aum_source: firm.has_schwab ? "custodians" : "apex",
      member_count: 0,
      employeeStatus: null,
    });
  }

  // Sort on the EFFECTIVE aum (the chain result), largest first, NULLS LAST —
  // the same order the old `ORDER BY h.aum DESC NULLS LAST` gave, now applied
  // after the chain resolves in TS. Name tie-break keeps the order stable.
  return list.sort((a, b) => {
    if (a.aum == null && b.aum == null) return a.name.localeCompare(b.name);
    if (a.aum == null) return 1;
    if (b.aum == null) return -1;
    return b.aum - a.aum || a.name.localeCompare(b.name);
  });
}

type HouseholdDirectorySummaryCounts = {
  clients: number;
  prospects: number;
  lost: number;
};

type HouseholdDirectoryAumSplit = {
  /** Raw custodial total; the displayed total always subtracts firm funds. */
  total: number | null;
  firm: number | null;
  employee: number | null;
  available: boolean;
  sources?: Array<{ custodian: "Apex" | "Schwab"; oldest: string | null; newest: string | null; pending: number }>;
  /** No arbitrary employee attribution for household-only client accounts. */
  employeeScopeComplete?: boolean;
};

type RawHouseholdDirectoryEnvelope = {
  snapshot: string;
  rows: Array<Omit<HouseholdListRow, "aum" | "member_count"> & {
    aum: unknown;
    member_count: unknown;
  }>;
  total: bigint;
  page: bigint;
  page_count: bigint;
  counts: HouseholdStageCounts;
  summary_counts: Record<keyof HouseholdDirectorySummaryCounts, unknown>;
  advisor_options: Array<{ value: string; label: string }>;
  status_options: string[];
  aum_total: unknown;
  aum_firm: unknown;
  aum_employee: unknown;
  aum_available: boolean;
  aum_sources: HouseholdDirectoryAumSplit["sources"];
  employee_scope_complete: boolean;
};

export type HouseholdDirectoryPage = {
  /** Scoped content version, not an authorization token or persisted server snapshot. */
  snapshot: string;
  rows: HouseholdListRow[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  counts: HouseholdStageCounts;
  summaryCounts: HouseholdDirectorySummaryCounts;
  advisorOptions: Array<{ value: string; label: string }>;
  statusOptions: string[];
  aumSplit: HouseholdDirectoryAumSplit;
};

export type HouseholdDirectoryPreviewRow = {
  sf_id: string;
  name: string;
  stage: string | null;
  lead_advisor_email: string;
  advisor_name: string | null;
};

/** The default first page can be selected before any AUM, counts, options or
 * full-book fingerprint work. This is display-only; every row still comes from
 * the caller's RLS-visible households and uses the exact canonical display
 * name and name/sf_id order of getHouseholdDirectory. */
export async function getHouseholdDirectoryPreview(id: Identity): Promise<HouseholdDirectoryPreviewRow[]> {
  const canonicalHouseholds = crmIdentityReadsEnabled();
  const startedAt = performance.now();
  const timing = startHouseholdPreviewTiming();
  const rows = await withUserScope(id, async (tx) => {
    timing?.scoped();
    const preview = await tx.$queryRaw<HouseholdDirectoryPreviewRow[]>`
      WITH ${householdDisplayCtes(canonicalHouseholds, undefined, true)}
      SELECT h.sf_id, display.display_name AS name, h.stage,
             h.lead_advisor_email, advisor.name AS advisor_name
        FROM visible_household h
        JOIN household_display display ON display.sf_id = h.sf_id
        LEFT JOIN mirror.advisor advisor ON advisor.email = h.lead_advisor_email
       WHERE (NOT ${canonicalHouseholds}
          OR left(h.canonical_sf_id, 15) = left(h.sf_id, 15))
         AND lower(regexp_replace(trim(COALESCE(h.stage, '')), '\\s+', ' ', 'g')) = 'client'
       ORDER BY lower(display.display_name), h.sf_id
       LIMIT 100`;
    timing?.queried();
    return preview;
  }, {
    ...HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS,
    onTransactionAcquired: timing?.acquired,
    // Set RLS and all query bounds in one round trip. Cloud SQL setup latency
    // was material in authenticated dev reads, even though the query was fast
    // against the isolated synthetic fixture.
    initialSettingsSql: Prisma.sql`,
      set_config('jit', 'off', true),
      set_config('statement_timeout', ${String(HOUSEHOLD_DIRECTORY_STATEMENT_TIMEOUT_MS)}, true),
      set_config('lock_timeout', ${String(HOUSEHOLD_DIRECTORY_LOCK_TIMEOUT_MS)}, true),
      set_config('enable_nestloop', 'off', true),
      set_config('plan_cache_mode', 'force_generic_plan', true)`,
  }).catch((error: unknown) => {
    timing?.finish("failure");
    logDirectoryFailure("households_preview", performance.now() - startedAt, error);
    throw error;
  });
  timing?.finish("success");
  logDirectoryTiming("households_preview", performance.now() - startedAt, rows.length);
  return rows;
}

/**
 * Bounded Households directory read.
 *
 * This is intentionally separate from `listHouseholds`, whose complete-book
 * contract is still used by operational workflows. The screen needs one page,
 * so PostgreSQL now performs the canonical overlay, effective-AUM calculation,
 * filters, sorting, counts, and LIMIT/OFFSET in one RLS-scoped transaction. The
 * account feed is materialized once and reused for row AUM plus the KPI split.
 */
async function readHouseholdDirectory(
  id: Identity,
  filters: HouseholdDirectoryFilters,
  requestedPage: number,
  requestedPageSize: number,
): Promise<HouseholdDirectoryPage> {
  const canonicalHouseholds = crmIdentityReadsEnabled();
  const showFirm = canSeeFirmHousehold(id.role ?? null);
  const pageSize = Math.min(HOUSEHOLD_DIRECTORY_MAX_PAGE_SIZE, Math.max(1, Math.trunc(requestedPageSize) || 1));
  const page = Math.max(1, Math.trunc(requestedPage) || 1);
  const queryPattern = likePattern(filters.query.trim());

  const startedAt = performance.now();
  const envelopes = await withUserScope(id, async (tx) => {
    await applyHouseholdDirectoryDatabaseBounds(tx);
    return tx.$queryRaw<RawHouseholdDirectoryEnvelope[]>`
      WITH ${householdDirectoryDisplayCtes(canonicalHouseholds)}, account_base AS MATERIALIZED (
        ${investmentAccountBaseSql()}
      ), active_employee AS MATERIALIZED (
        SELECT DISTINCT left(es.client_sf_id, 15) AS client15
          FROM app.employee_client_status es
         WHERE es.employment_state = 'ACTIVE'
           AND app.employee_badge_is_current(es.client_sf_id)
      ), apex_rollup AS (
        SELECT source.canonical15,
               COALESCE(sum(account.account_aum) FILTER (WHERE account.balance_current), 0) AS apex_aum,
               bool_or(account.account_status IS DISTINCT FROM 'CLOSED' AND NOT account.balance_current) AS aum_pending,
               bool_or(account.custodian = 'Schwab') AS has_schwab
          FROM (SELECT DISTINCT left(sf_id, 15) AS source15, left(canonical_sf_id, 15) AS canonical15
                  FROM visible_household) source
          JOIN account_base account
            ON left(account.household_sf_id, 15) = source.source15
           AND account.confirmed
         GROUP BY 1
      ), canonical_deal AS MATERIALIZED (
        SELECT COALESCE(overlay.canonical_source_key, deal.household_sf_id)
                 AS household_sf_id,
               deal.client_sf_id,
               deal.person_aum
          FROM app.deal deal
          LEFT JOIN canonical_overlay overlay
            ON left(overlay.source_key, 15) = left(deal.household_sf_id, 15)
         WHERE deal.archived_at IS NULL
           AND deal.household_sf_id IS NOT NULL
      ), deal_state AS (
        SELECT left(household_sf_id, 15) AS canonical15,
               bool_or(client_sf_id IS NULL) AS incomplete
          FROM canonical_deal
         GROUP BY 1
      ), deal_client AS (
        SELECT left(household_sf_id, 15) AS canonical15,
               client_sf_id,
               max(person_aum) AS person_aum
          FROM canonical_deal
         WHERE client_sf_id IS NOT NULL
           AND person_aum IS NOT NULL
         GROUP BY 1, 2
      ), deal_rollup AS (
        SELECT state.canonical15,
               CASE WHEN state.incomplete THEN NULL ELSE sum(client.person_aum) END AS deal_aum
          FROM deal_state state
          LEFT JOIN deal_client client ON client.canonical15 = state.canonical15
         GROUP BY state.canonical15, state.incomplete
      ), household_directory AS MATERIALIZED (
        SELECT h.sf_id,
               h.display_name AS name,
               h.status,
               h.stage,
               CASE WHEN apex.aum_pending THEN NULL
                    ELSE COALESCE(apex.apex_aum, deals.deal_aum, h.aum) END AS aum,
               h.lead_advisor_email,
               h.household_kind,
               a.name AS advisor_name,
               CASE
                 WHEN apex.aum_pending THEN NULL
                 WHEN apex.has_schwab THEN 'custodians'
                 WHEN apex.apex_aum IS NOT NULL THEN 'apex'
                 WHEN deals.deal_aum IS NOT NULL THEN 'deals'
                 WHEN h.aum IS NOT NULL THEN 'mirror'
                 ELSE NULL
               END AS aum_source
          FROM household_display h
          LEFT JOIN mirror.advisor a ON a.email = h.lead_advisor_email
          LEFT JOIN apex_rollup apex
            ON apex.canonical15 = left(h.sf_id, 15)
          LEFT JOIN deal_rollup deals
            ON deals.canonical15 = left(h.sf_id, 15)
         WHERE NOT ${canonicalHouseholds}
            OR left(h.canonical_sf_id, 15) = left(h.sf_id, 15)
      ), firm_row AS (
        SELECT ${FIRM_HOUSEHOLD_ID}::text AS sf_id,
               ${FIRM_HOUSEHOLD_NAME}::text AS name,
               NULL::text AS status,
               NULL::text AS stage,
               CASE WHEN bool_or(account_status IS DISTINCT FROM 'CLOSED' AND NOT balance_current)
                 THEN NULL ELSE COALESCE(sum(account_aum) FILTER (WHERE balance_current), 0) END AS aum,
               ${FIRM_HOUSEHOLD_ADVISOR_EMAIL}::text AS lead_advisor_email,
               ${HOUSEHOLD_KIND_FIRM}::text AS household_kind,
               NULL::text AS advisor_name,
               CASE WHEN bool_or(custodian = 'Schwab') THEN 'custodians' ELSE 'apex' END AS aum_source
          FROM account_base
         WHERE is_firm AND confirmed
        HAVING ${showFirm} AND count(*) > 0
      ), directory AS MATERIALIZED (
        SELECT household_directory.*,
               CASE lower(regexp_replace(trim(COALESCE(stage, '')), '\\s+', ' ', 'g'))
                 WHEN 'client' THEN 'client'
                 WHEN 'prospect' THEN 'prospect'
                 WHEN 'lost prospect' THEN 'lost_prospect'
                 WHEN 'lost client' THEN 'lost_client'
                 ELSE NULL
               END AS stage_key,
               lower(regexp_replace(trim(COALESCE(lead_advisor_email, '')), '\\s+', ' ', 'g'))
                 AS advisor_key,
               lower(regexp_replace(trim(COALESCE(status, '')), '\\s+', ' ', 'g'))
                 AS status_key
          FROM household_directory
        UNION ALL
        SELECT firm_row.*,
               NULL::text AS stage_key,
               lower(trim(firm_row.lead_advisor_email)) AS advisor_key,
               ''::text AS status_key
          FROM firm_row
      ), stats AS (
        SELECT count(*)::bigint AS all_count,
               count(*) FILTER (WHERE stage_key = 'client')::bigint AS client_count,
               count(*) FILTER (WHERE stage_key = 'prospect')::bigint AS prospect_count,
               count(*) FILTER (WHERE stage_key = 'lost_prospect')::bigint AS lost_prospect_count,
               count(*) FILTER (WHERE stage_key = 'lost_client')::bigint AS lost_client_count
          FROM directory
      ), advisor_options AS (
        SELECT COALESCE(
                 jsonb_agg(jsonb_build_object('value', value, 'label', label)
                           ORDER BY lower(label), value),
                 '[]'::jsonb
               ) AS options
          FROM (
            SELECT advisor_key AS value,
                   max(COALESCE(NULLIF(trim(advisor_name), ''), lead_advisor_email)) AS label
              FROM directory
             WHERE advisor_key <> ''
             GROUP BY advisor_key
          ) option_rows
      ), status_options AS (
        SELECT COALESCE(jsonb_agg(label ORDER BY lower(label)), '[]'::jsonb) AS options
          FROM (
            SELECT status_key, min(trim(status)) AS label
              FROM directory
             WHERE status_key <> ''
             GROUP BY status_key
          ) option_rows
      ), aum_stats AS (
        SELECT sum(account_aum) FILTER (WHERE balance_current) AS total,
               sum(account_aum) FILTER (
                 WHERE balance_current AND is_firm
               ) AS firm,
               sum(account_aum) FILTER (
                 WHERE balance_current AND NOT is_firm AND EXISTS (
                   SELECT 1 FROM active_employee employee
                    WHERE employee.client15 = left(account_base.client_sf_id, 15)
                 )
               ) AS employee,
               bool_and(confirmed) AS confirmed,
               NOT bool_or(custodian = 'Schwab' AND NOT is_firm AND client_sf_id IS NULL
                 AND account_status <> 'CLOSED' AND account_aum <> 0) AS employee_scope_complete,
               count(*)::bigint AS n,
               count(*) FILTER (
                 WHERE account_status IS DISTINCT FROM 'CLOSED'
               )::bigint AS open_n,
               count(*) FILTER (
                 WHERE account_status IS DISTINCT FROM 'CLOSED' AND balance_current
               )::bigint AS current_open_n
          FROM account_base
      ), source_coverage AS (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'custodian', custodian, 'oldest', oldest, 'newest', newest, 'pending', pending
        ) ORDER BY custodian), '[]'::jsonb) AS sources
        FROM (
          SELECT custodian, min(balance_as_of)::text AS oldest, max(balance_as_of)::text AS newest,
                 count(*) FILTER (WHERE NOT confirmed OR
                   (account_status IS DISTINCT FROM 'CLOSED' AND NOT balance_current)) AS pending
            FROM account_base GROUP BY custodian
        ) coverage
      ), filtered AS MATERIALIZED (
        SELECT *
          FROM directory
         WHERE (${filters.stage} = 'all' OR stage_key = ${filters.stage})
           AND (${filters.advisor} = '' OR advisor_key = ${filters.advisor})
           AND (${filters.status} = '' OR status_key = ${filters.status})
           AND (
             ${filters.query.trim()} = ''
             OR name ILIKE ${queryPattern} ESCAPE '\\'
             OR lead_advisor_email ILIKE ${queryPattern} ESCAPE '\\'
             OR COALESCE(advisor_name, '') ILIKE ${queryPattern} ESCAPE '\\'
             OR COALESCE(stage, '') ILIKE ${queryPattern} ESCAPE '\\'
             OR COALESCE(status, '') ILIKE ${queryPattern} ESCAPE '\\'
             OR EXISTS (
               SELECT 1 FROM household_display display,
                    unnest(display.source_names || display.member_names) AS alias(name)
                WHERE display.sf_id = directory.sf_id
                  AND alias.name ILIKE ${queryPattern} ESCAPE '\\'
             )
           )
      ), canonical_version AS (
        -- Source assignments affect member counts/badges even when the same
        -- canonical rows survive and no balances or raw client parents change.
        SELECT md5(COALESCE(string_agg(
                 md5(jsonb_build_array(sf_id, canonical_sf_id)::text),
                 '' ORDER BY sf_id
               ), '')) AS snapshot
          FROM visible_household
      ), member_version AS (
        -- Names affect display/search and must invalidate retained pages after
        -- a rename. Only the digest leaves the database; both tables keep RLS.
        SELECT md5(COALESCE(string_agg(
                 md5(jsonb_build_array(c.sf_id, c.household_id, c.first_name, c.last_name, es.employment_state)::text),
                 '' ORDER BY c.sf_id
               ), '')) AS snapshot
          FROM mirror.client c
          LEFT JOIN app.employee_client_status es
            ON left(es.client_sf_id, 15) = left(c.sf_id, 15)
           AND app.employee_badge_is_current(es.client_sf_id)
      ), directory_version AS (
        -- Only this fixed-length change indicator leaves PostgreSQL. Compute it
        -- from the same RLS-visible statement snapshot as the rows and options.
        -- New/deleted/reordered/changed directory records must restart an append;
        -- offsets from different dataset versions must never be combined.
        SELECT md5(
                 COALESCE((SELECT string_agg(md5(to_jsonb(filtered)::text), '' ORDER BY sf_id)
                             FROM filtered), '')
                 || (SELECT to_jsonb(stats)::text FROM stats)
                 || (SELECT options::text FROM advisor_options)
                 || (SELECT options::text FROM status_options)
                 || (SELECT to_jsonb(aum_stats)::text FROM aum_stats)
                 || (SELECT sources::text FROM source_coverage)
                 || (SELECT snapshot FROM canonical_version)
                 || (SELECT snapshot FROM member_version)
               ) AS snapshot
      ), page_meta AS (
        SELECT count(*)::bigint AS total,
               GREATEST(1, CEIL(count(*)::numeric / ${pageSize})::bigint) AS page_count,
               LEAST(
                 ${page}::bigint,
                 GREATEST(1, CEIL(count(*)::numeric / ${pageSize})::bigint)
               ) AS page
          FROM filtered
      ), page_rows AS MATERIALIZED (
        SELECT filtered.*,
               row_number() OVER (
                 ORDER BY
                   CASE WHEN ${filters.sortKey} = 'name' AND ${filters.sortDir} = 'asc'
                     THEN lower(name) END ASC,
                   CASE WHEN ${filters.sortKey} = 'name' AND ${filters.sortDir} = 'desc'
                     THEN lower(name) END DESC,
                   CASE WHEN ${filters.sortKey} = 'stage' AND ${filters.sortDir} = 'asc'
                     THEN CASE stage_key
                       WHEN 'client' THEN 0 WHEN 'prospect' THEN 1
                       WHEN 'lost_prospect' THEN 2 WHEN 'lost_client' THEN 3 ELSE 99
                     END END ASC,
                   CASE WHEN ${filters.sortKey} = 'stage' AND ${filters.sortDir} = 'desc'
                     THEN CASE stage_key
                       WHEN 'client' THEN 0 WHEN 'prospect' THEN 1
                       WHEN 'lost_prospect' THEN 2 WHEN 'lost_client' THEN 3 ELSE 99
                     END END DESC,
                   CASE WHEN ${filters.sortKey} = 'aum' AND ${filters.sortDir} = 'asc'
                     THEN COALESCE(aum, 0) END ASC,
                   CASE WHEN ${filters.sortKey} = 'aum' AND ${filters.sortDir} = 'desc'
                     THEN COALESCE(aum, 0) END DESC,
                   lower(name) ASC,
                   sf_id ASC
               ) AS row_order
          FROM filtered
         ORDER BY row_order
         LIMIT ${pageSize}
        OFFSET (((SELECT page FROM page_meta) - 1) * ${pageSize})
      ), page_member_sources AS MATERIALIZED (
        -- Reuse one source set for the selected page. A lateral aggregate per
        -- row repeatedly scanned the same visible clients for every household.
        -- Preserve source-row multiplicity and the established 15-character
        -- member join semantics; naming identity is handled separately above.
        SELECT left(source.sf_id, 15) AS source15,
               left(source.canonical_sf_id, 15) AS canonical15
          FROM visible_household source
         WHERE left(source.canonical_sf_id, 15) IN (
           SELECT left(sf_id, 15) FROM page_rows
         )
      ), page_member_rollup AS MATERIALIZED (
        SELECT source.canonical15,
               count(c.sf_id)::bigint AS member_count,
               bool_or(es.employment_state = 'ACTIVE') AS has_active_employee,
               bool_or(es.employment_state = 'FORMER') AS has_former_employee
          FROM page_member_sources source
          LEFT JOIN mirror.client c ON left(c.household_id, 15) = source.source15
          LEFT JOIN app.employee_client_status es
            ON left(es.client_sf_id, 15) = left(c.sf_id, 15)
           AND app.employee_badge_is_current(es.client_sf_id)
         GROUP BY source.canonical15
      ), page_enriched AS (
        SELECT page_rows.*,
               COALESCE(member.member_count, 0)::bigint AS member_count,
               CASE
                 WHEN member.has_active_employee THEN 'ACTIVE'
                 WHEN member.has_former_employee THEN 'FORMER'
                 ELSE NULL
               END AS "employeeStatus"
          FROM page_rows
          LEFT JOIN page_member_rollup member
            ON member.canonical15 = left(page_rows.sf_id, 15)
      )
      SELECT directory_version.snapshot,
             COALESCE(
               (SELECT jsonb_agg(
                         to_jsonb(page_enriched)
                           - 'stage_key' - 'advisor_key' - 'status_key' - 'row_order'
                         ORDER BY row_order
                       ) FROM page_enriched),
               '[]'::jsonb
             ) AS rows,
             page_meta.total,
             page_meta.page,
             page_meta.page_count,
             jsonb_build_object(
               'all', stats.all_count,
               'client', stats.client_count,
               'lost_client', stats.lost_client_count
             ) AS counts,
             jsonb_build_object(
               'clients', stats.client_count,
               'prospects', stats.prospect_count,
               'lost', stats.lost_client_count + stats.lost_prospect_count
             ) AS summary_counts,
             advisor_options.options AS advisor_options,
             status_options.options AS status_options,
             aum_stats.total AS aum_total,
             aum_stats.firm AS aum_firm,
             aum_stats.employee AS aum_employee,
             source_coverage.sources AS aum_sources,
             COALESCE(aum_stats.employee_scope_complete, true) AS employee_scope_complete,
             (
               aum_stats.n > 0
               AND aum_stats.open_n = aum_stats.current_open_n
               AND aum_stats.confirmed
             ) AS aum_available
        FROM page_meta
        CROSS JOIN directory_version
        CROSS JOIN stats
        CROSS JOIN advisor_options
        CROSS JOIN status_options
        CROSS JOIN aum_stats
        CROSS JOIN source_coverage`;
  }, HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS).catch((error: unknown) => {
    logDirectoryFailure("households", performance.now() - startedAt, error);
    throw error;
  });

  const envelope = envelopes[0];
  logDirectoryTiming("households", performance.now() - startedAt, envelope?.rows.length ?? 0);
  if (!envelope) {
    return {
      snapshot: "d41d8cd98f00b204e9800998ecf8427e", rows: [], total: 0, page: 1, pageCount: 1, pageSize,
      counts: { all: 0, client: 0, lost_client: 0 },
      summaryCounts: { clients: 0, prospects: 0, lost: 0 },
      advisorOptions: [], statusOptions: [],
      aumSplit: { total: null, firm: null, employee: null, available: false },
    };
  }

  const aumAvailable = envelope.aum_available;
  return {
    snapshot: envelope.snapshot,
    rows: envelope.rows.map((row) => ({
      ...row,
      aum: row.aum == null ? null : Number(row.aum),
      member_count: Number(row.member_count),
    })),
    total: Number(envelope.total),
    page: Number(envelope.page),
    pageCount: Number(envelope.page_count),
    pageSize,
    counts: Object.fromEntries(
      Object.entries(envelope.counts).map(([key, value]) => [key, Number(value)]),
    ) as HouseholdStageCounts,
    summaryCounts: Object.fromEntries(
      Object.entries(envelope.summary_counts).map(([key, value]) => [key, Number(value)]),
    ) as HouseholdDirectorySummaryCounts,
    advisorOptions: envelope.advisor_options,
    statusOptions: envelope.status_options,
    aumSplit: { ...(aumAvailable
      ? {
          total: envelope.aum_total == null ? 0 : Number(envelope.aum_total),
          firm: envelope.aum_firm == null ? 0 : Number(envelope.aum_firm),
          employee: envelope.aum_employee == null ? 0 : Number(envelope.aum_employee),
          available: true,
        }
      : { total: null, firm: null, employee: null, available: false }),
      sources: envelope.aum_sources ?? [],
      employeeScopeComplete: envelope.employee_scope_complete ?? true,
    },
  };
}

// Several tabs or quick return navigations can request the same expensive
// default page before its first read finishes. Share only that in-flight read
// for the same RLS identity and query. The promise is removed on settlement:
// no rows survive as a cross-request cache, and other roles/books never share
// results. This keeps duplicate exact reads from starving the preview on the
// small dev database without changing the API or filtered views.
const defaultDirectoryReads = new Map<string, Promise<HouseholdDirectoryPage>>();

export function getHouseholdDirectory(
  id: Identity,
  filters: HouseholdDirectoryFilters,
  requestedPage: number,
  requestedPageSize: number,
): Promise<HouseholdDirectoryPage> {
  const isFastDefault = householdDirectoryFastPathEnabled()
    && requestedPage === 1
    && requestedPageSize === 100
    && householdDirectoryQueryKey(filters) === householdDirectoryQueryKey(DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS);
  if (!isFastDefault) {
    return readHouseholdDirectory(id, filters, requestedPage, requestedPageSize);
  }

  const key = JSON.stringify([id.role ?? null, id.email ?? null, crmIdentityReadsEnabled()]);
  const existing = defaultDirectoryReads.get(key);
  if (existing) return existing;

  const read = readHouseholdDirectory(id, filters, requestedPage, requestedPageSize);
  defaultDirectoryReads.set(key, read);
  void read.then(
    () => { if (defaultDirectoryReads.get(key) === read) defaultDirectoryReads.delete(key); },
    () => { if (defaultDirectoryReads.get(key) === read) defaultDirectoryReads.delete(key); },
  );
  return read;
}

export async function getHousehold(
  id: Identity,
  sfId: string,
): Promise<HouseholdDetail | null> {
  return (await getHouseholdPageData(id, sfId)).household;
}

/** Server-only navigation envelope. Raw source IDs stay local to the server
 * page and are never added to the serializable HouseholdDetail contract. */
export type HouseholdPageData = {
  canonicalRouteId: string;
  household: HouseholdDetail | null;
  sourceSfIds: string[];
};

export async function getHouseholdPageData(
  id: Identity,
  sfId: string,
): Promise<HouseholdPageData> {
  const startedAt = performance.now();
  const resolvedSfId = await resolveCrmRouteKey(id, "HOUSEHOLD", sfId);
  // ticket: the firm household is synthetic (never a mirror.household row), so
  // resolve it from config + the RLS-scoped account seam. Role-gated in TS the
  // same way the mirror *_ops_all policies gate the real rows: a caller who
  // cannot see the firm gets null → the detail page 404s (no leak).
  if (resolvedSfId === FIRM_HOUSEHOLD_ID) {
    const household = await getFirmHousehold(id);
    logDetailTiming("household", performance.now() - startedAt);
    return {
      canonicalRouteId: resolvedSfId,
      household,
      sourceSfIds: [resolvedSfId],
    };
  }

  // A confirmed duplicate is one AOA household backed by every RLS-visible
  // CRM source in its reversible canonical group. The survivor remains
  // the display identity; child records are read across the full group.
  const sourceSfIds = await crmCanonicalHouseholdSourceKeysForCanonical(id, resolvedSfId);
  const sourceKeys = [
    ...new Set(sourceSfIds.filter(Boolean).map((value) => value.slice(0, 15))),
  ];

  // Display-only custodial balances over the confirmed canonical source group.
  // A separate RLS transaction avoids nesting interactive transactions.
  const apexState = await householdInvestmentAumStateForSources(id, sourceSfIds);
  const household = await withUserScope<HouseholdDetail | null>(id, async (tx) => {
    const rows = await tx.$queryRaw<HouseholdRow[]>`
      WITH ${householdDisplayCtes(crmIdentityReadsEnabled(), Prisma.sql`ARRAY[${resolvedSfId}]::text[]`)}
      SELECT h.sf_id, display.display_name AS name, h.status, h.stage, h.aum,
             h.lead_advisor_email, h.household_kind
      FROM visible_household h
      JOIN household_display display ON display.sf_id = h.sf_id
      WHERE h.sf_id = ${resolvedSfId}
      LIMIT 1`;
    const household = rows[0];
    if (!household) return null;

    const members = await tx.$queryRaw<HouseholdMember[]>(Prisma.sql`
      WITH raw_member AS MATERIALIZED (
        SELECT c.*
          FROM mirror.client c
         WHERE left(c.household_id, 15) IN (${Prisma.join(sourceKeys)})
           AND left(c.sf_id, 15) <> left(c.household_id, 15)
      ), canonical_contact_overlay AS MATERIALIZED (
        SELECT overlay.source_key, overlay.canonical_source_key
          FROM app.resolve_crm_canonical_contact_overlays(
            CASE WHEN ${crmIdentityReadsEnabled()}
              THEN ARRAY(SELECT member.sf_id FROM raw_member member)
              ELSE ARRAY[]::text[]
            END
          ) overlay
      )
      SELECT c.sf_id,
             trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name,
             c.email,
             es.employment_state::text AS "employeeStatus"
      FROM raw_member c
      LEFT JOIN canonical_contact_overlay contact_overlay
        ON left(contact_overlay.source_key, 15) = left(c.sf_id, 15)
      LEFT JOIN app.employee_client_status es
        ON left(es.client_sf_id, 15) = left(c.sf_id, 15)
       AND app.employee_badge_is_current(es.client_sf_id)
      WHERE contact_overlay.source_key IS NULL
      ORDER BY name, c.sf_id`);

    const advisor = await tx.$queryRaw<{ name: string }[]>`
      SELECT name
      FROM mirror.advisor
      WHERE email = ${household.lead_advisor_email}
      LIMIT 1`;

    // ticket / tkt-deals-dedupe: the household's linked deals. The two sides
    // store the Salesforce id at DIFFERENT widths — `mirror.household.sf_id` is
    // 18-char, while `app.deal.household_sf_id` is 15-char for legacy import
    // rows and 18-char for the live CRM-feed rows. Normalize BOTH sides to
    // the 15-char prefix so every deal matches regardless of width:
    // `householdDealKey` gives the 15-char household key; `left(household_sf_id,
    // 15)` clips the stored deal id to the same prefix. A naive `=` join matched
    // ZERO 18-char feed rows. Same withUserScope as the reads above, so RLS
    // scopes the deals identically (app.deal is all-roles-read; no extra gating
    // — the WO's RLS/PII note). ORDER BY pushes WON/LOST to the bottom, then
    // earliest expected close first (NULLS LAST). archived deals excluded (seam
    // parity with listDeals/dealsForHousehold).
    const dealRows = sourceKeys.length > 0
      ? await tx.$queryRaw<
          (Omit<HouseholdDeal, "amount" | "person_aum"> & {
            amount: unknown;
            person_aum: unknown;
          })[]
        >(Prisma.sql`
          SELECT id, name, client_first_name, client_last_name,
                 stage, amount, close_date, account_type, transferring_firm,
                 client_sf_id, person_aum
          FROM app.deal
          WHERE left(household_sf_id, 15) IN (${Prisma.join(sourceKeys)})
            AND archived_at IS NULL
          ORDER BY (stage IN ('WON', 'LOST')), close_date NULLS LAST`)
      : [];

    // Decimal → number at the seam (the carried Decimal trap — amount AND
    // person_aum are Postgres numerics; a raw Decimal breaks RSC serialization).
    const deals: HouseholdDeal[] = dealRows.map((r) => ({
      ...r,
      amount: Number(r.amount),
      person_aum: r.person_aum == null ? null : Number(r.person_aum),
    }));

    // Header stats folded in JS over the already-scoped rows (one round-trip;
    // the set is small — a household's deals).
    const dealSummary = summarizeHouseholdDeals(deals);

    // tkt-deals-client-link (AUM layer): recompute managed AUM from the deals
    // we already fetched — one person_aum per DISTINCT client_sf_id (the figure
    // repeats across a client's deal rows). `householdAumFromDeals` applies the
    // COMPLETENESS GATE: it returns null (→ mirror fallback) unless EVERY deal
    // row is backfilled with a client_sf_id, so a mid-backfill household shows
    // the mirror value rather than an undercounted partial sum.
    const mirrorAum = household.aum == null ? null : Number(household.aum);
    const dealsAum = householdAumFromDeals(deals);
    // Custodial balances → deals → mirror, except pending never falls back.
    // Retain pickHouseholdAum's legacy label only when the source is Apex-only.
    const selected = apexState.availability === "PENDING"
      ? { aum: null, source: null }
      : pickHouseholdAum(apexState.value, dealsAum, mirrorAum);

    return {
      ...household,
      aum: selected.aum, // pending OR Apex → deals → mirror fallback
      aumSource: selected.source === "apex" ? apexState.source : selected.source,
      aumPending: apexState.availability === "PENDING",
      advisorName: advisor[0]?.name ?? null,
      members,
      deals,
      dealSummary,
      canonicalSourceCount: sourceSfIds.length,
      employeeStatus: members.some((member) => member.employeeStatus === "ACTIVE")
        ? "ACTIVE"
        : members.some((member) => member.employeeStatus === "FORMER")
          ? "FORMER"
          : null,
    };
  });

  logDetailTiming("household", performance.now() - startedAt);
  return {
    canonicalRouteId: resolvedSfId,
    household,
    sourceSfIds,
  };
}

/** Synthetic firm household: the four governed Apex corporate accounts plus
 * reviewed Schwab FIRM_OPERATING accounts. Existing role gate remains intact;
 * no fabricated client or CRM household is created for operating funds. */
async function getFirmHousehold(id: Identity): Promise<HouseholdDetail | null> {
  if (!canSeeFirmHousehold(id.role)) return null;
  const apexState = await householdInvestmentAumState(id, FIRM_HOUSEHOLD_ID);
  return {
    sf_id: FIRM_HOUSEHOLD_ID,
    name: FIRM_HOUSEHOLD_NAME,
    status: null,
    stage: null,
    aum: apexState.value,
    lead_advisor_email: FIRM_HOUSEHOLD_ADVISOR_EMAIL,
    household_kind: HOUSEHOLD_KIND_FIRM,
    aumSource: apexState.availability === "PENDING" ? null : apexState.source,
    aumPending: apexState.availability === "PENDING",
    advisorName: null,
    members: [],
    deals: [],
    dealSummary: summarizeHouseholdDeals([]),
    canonicalSourceCount: 1,
    employeeStatus: null,
  };
}

/** Lean, RLS-scoped household header (sf_id + name) for pages that only need
 *  identity + own-book authorization — e.g. the household-level TWR
 *  Performance report, which must confirm the household is in the caller's
 *  book BEFORE any Warehouse call. null (→ 404) for unknown/out-of-book ids. */
export async function householdHeader(
  id: Identity,
  sfId: string,
): Promise<{ sf_id: string; name: string } | null> {
  if (!sfId) return null;
  const rows = await withUserScope(id, (tx) =>
    tx.$queryRaw<{ sf_id: string; name: string }[]>`
      WITH ${householdDisplayCtes(crmIdentityReadsEnabled(), Prisma.sql`ARRAY[${sfId}]::text[]`)}
      SELECT source.sf_id, display.display_name AS name
      FROM visible_household source
      JOIN household_display display ON display.sf_id = source.canonical_sf_id
      WHERE source.sf_id = ${sfId}
      LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function householdMembers(
  id: Identity,
  sfId: string,
): Promise<HouseholdMember[]> {
  return withUserScope(id, (tx) =>
    tx.$queryRaw<HouseholdMember[]>`
      SELECT sf_id,
             trim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS name,
             email,
             es.employment_state::text AS "employeeStatus"
      FROM mirror.client c
      LEFT JOIN app.employee_client_status es
        ON left(es.client_sf_id, 15) = left(c.sf_id, 15)
       AND app.employee_badge_is_current(es.client_sf_id)
      WHERE c.household_id = ${sfId}
      ORDER BY name`,
  );
}
