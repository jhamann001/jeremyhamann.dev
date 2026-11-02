import { Prisma } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import type { Identity } from "./types";
import type { DealRow, DealStage } from "./deal-types";
import { householdDealKey, maskCedarRidgeUserId } from "./deal-types";
import { canSeeArchivedDeals } from "./deal-archive";
import { resolveCrmRouteKey } from "@/lib/crm/resolve";
import type { DealDirectoryFilters } from "@/lib/navigation/deals-query";
import type { ProgressivePage } from "@/lib/navigation/progressive-page";
import type { StageFilter } from "@/components/deals/deal-filter";
import type { DealSuggestions } from "@/components/deals/deal-form";
import { DEAL_STAGES } from "./deal-types";

// Deals seam (TDD ticket §4 — signatures FROZEN: D3 imports `getDeal`, and the
// Stage-2 `app ∪ mirror` union reimplements these BODIES only; no component or
// page changes then). Every read runs inside `withUserScope`, so the Postgres RLS
// policies decide visibility — the functions add NO role branching. Today the
// locked posture (ADR-4) reads all rows for every app role; when book scoping is
// tightened later, these functions change not at all.
//
// DECIMAL TRAP (carried, see lib/data/households.ts): `amount`, `person_aum`,
// `potential_aum` are Postgres `numeric` → Prisma hands back Decimal objects at
// runtime, which do NOT serialize across the Server → Client Component boundary
// (DealsTable is "use client"). Coerce with Number() HERE, at the seam, before a
// row ever reaches a component. Same for the KPI aggregates (COUNT → bigint,
// SUM → numeric).

// One KPI aggregate per stage PRESENT in the visible set (GROUP BY semantics —
// the KPI row zero-fills missing stages). Aggregated in SQL inside the same
// user scope as the table reads, so KPIs are policy-consistent with the table
// by construction.
export type DealPipelineKpi = {
  stage: DealStage;
  count: number;
  totalAmount: number;
};

// Full §3 column list, shared by listDeals/getDeal so the two can never drift.
const coerce = (r: DealRow): DealRow => ({
  ...r,
  amount: Number(r.amount),
  person_aum: r.person_aum == null ? null : Number(r.person_aum),
  potential_aum: r.potential_aum == null ? null : Number(r.potential_aum),
});

export type DealDirectoryMeta = {
  counts: Record<StageFilter, number>;
  archivedCount: number | null;
  kpis: DealPipelineKpi[];
};
export type DealDirectoryPage = ProgressivePage<DealRow, DealDirectoryMeta>;

// Explicit output projection: schema additions must not silently reach the browser.
const DIRECTORY_COLUMNS = Prisma.sql`id, source, sf_deal_id, name, client_first_name, client_last_name,
  household_name, household_sf_id, client_sf_id, amount, stage, stage_raw,
  created_date, close_date, last_activity_date, owner_name, owner_sf_user_id, secondary_owner,
  person_aum, potential_aum, cedar_ridge_user_id, statements, asset_mapped, plaid_linked,
  account_last4, account_type, transferring_firm, employer, rolling_into, lost_from,
  archived_reason, stage_history, created_by, updated_by, created_at, updated_at,
  archived_at, archived_by`;

function directoryWhere(filters: DealDirectoryFilters): Prisma.Sql {
  const q = filters.query.trim().toLowerCase();
  return Prisma.sql`${filters.archived ? Prisma.sql`archived_at IS NOT NULL` : Prisma.sql`archived_at IS NULL`}
    AND ${filters.archived || filters.stage === "all" ? Prisma.sql`TRUE` : filters.stage === "no_statements"
      ? Prisma.sql`statements = FALSE` : Prisma.sql`stage::text = ${filters.stage}`}
    AND (${q} = '' OR strpos(lower(concat(client_first_name, ' ', client_last_name)), ${q}) > 0
      OR strpos(lower(COALESCE(household_name, '')), ${q}) > 0
      OR strpos(lower(name), ${q}) > 0 OR strpos(lower(COALESCE(account_type, '')), ${q}) > 0
      OR strpos(lower(COALESCE(account_last4, '')), ${q}) > 0
      OR strpos(lower(COALESCE(transferring_firm, '')), ${q}) > 0)`;
}

function directoryOrder(filters: DealDirectoryFilters): Prisma.Sql {
  if (!filters.sortKey) return filters.archived ? Prisma.sql`archived_at DESC, id` : Prisma.sql`created_date DESC, id`;
  const column = {
    client: Prisma.sql`lower(concat(client_first_name, ' ', client_last_name)) COLLATE "C"`,
    household: Prisma.sql`lower(COALESCE(household_name, '')) COLLATE "C"`,
    amount: Prisma.sql`amount`,
    stage: Prisma.sql`(CASE stage WHEN 'WON' THEN 'funded' WHEN 'LOST' THEN 'lost'
      WHEN 'POTENTIAL' THEN 'potential' WHEN 'COMMITTED' THEN 'potential-committed'
      ELSE 'potential-in process' END) COLLATE "C"`,
    account: Prisma.sql`lower(concat_ws(' · ', NULLIF(account_type, ''), NULLIF(account_last4, ''), NULLIF(transferring_firm, ''))) COLLATE "C"`,
    created: Prisma.sql`created_date`, close: Prisma.sql`close_date`,
  }[filters.sortKey];
  return Prisma.sql`${column} ${filters.sortDir === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`} NULLS LAST,
    ${filters.archived ? Prisma.sql`archived_at DESC` : Prisma.sql`created_date DESC`}, id`;
}

/** One RLS statement computes whole-scope metadata and only the requested rows. */
export async function getDealDirectory(identity: Identity, filters: DealDirectoryFilters,
  page = 1, pageSize = 100): Promise<DealDirectoryPage> {
  if (filters.archived && !canSeeArchivedDeals(identity.role)) throw new Error("deals_removed_forbidden");
  page = Math.max(1, Math.min(1_000_000, Math.floor(page) || 1));
  pageSize = Math.max(100, Math.min(200, Math.floor(pageSize) || 100));
  const canSeeRemoved = canSeeArchivedDeals(identity.role);
  const result = await withUserScope(identity, (tx) => tx.$queryRaw<{
    rows: DealRow[]; total: bigint; snapshot: string; all_count: bigint; missing_count: bigint;
    archived_count: bigint; kpis: DealPipelineKpi[];
  }[]>(Prisma.sql`
    WITH visible AS MATERIALIZED (
      SELECT ${DIRECTORY_COLUMNS} FROM app.deal WHERE archived_at IS NULL OR ${canSeeRemoved}
    ), filtered AS MATERIALIZED (
      SELECT * FROM visible WHERE ${directoryWhere(filters)}
    ), page_rows AS (
      SELECT * FROM filtered ORDER BY ${directoryOrder(filters)} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    ), stage_counts AS (
      SELECT stage, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS "totalAmount"
      FROM visible WHERE archived_at IS NULL GROUP BY stage
    )
    SELECT COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY ${directoryOrder(filters)}) FROM page_rows p), '[]'::jsonb) AS rows,
      (SELECT COUNT(*) FROM filtered) AS total,
      (SELECT md5(COALESCE(string_agg(md5(to_jsonb(v)::text), '' ORDER BY id), '') || ${JSON.stringify(filters)}) FROM visible v) AS snapshot,
      (SELECT COUNT(*) FROM visible WHERE archived_at IS NULL) AS all_count,
      (SELECT COUNT(*) FROM visible WHERE archived_at IS NULL AND NOT statements) AS missing_count,
      (SELECT COUNT(*) FROM visible WHERE archived_at IS NOT NULL) AS archived_count,
      COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY stage) FROM stage_counts s), '[]'::jsonb) AS kpis
  `));
  const envelope = result[0];
  if (!envelope) throw new Error("deals_directory_unavailable");
  const counts = Object.fromEntries(["all", "no_statements", ...DEAL_STAGES].map(stage => [stage, 0])) as Record<StageFilter, number>;
  counts.all = Number(envelope.all_count);
  counts.no_statements = Number(envelope.missing_count);
  const kpis = envelope.kpis.map(kpi => ({ ...kpi, count: Number(kpi.count), totalAmount: Number(kpi.totalAmount) }));
  for (const kpi of kpis) counts[kpi.stage] = kpi.count;
  const total = Number(envelope.total);
  return { rows: envelope.rows.map(row => maskCedarRidgeUserId(coerce(row), identity.role)), page, pageSize,
    total, pageCount: Math.max(1, Math.ceil(total / pageSize)), snapshot: envelope.snapshot,
    meta: { counts, archivedCount: canSeeRemoved ? Number(envelope.archived_count) : null, kpis } };
}

/** Explicit user-requested export only: every matching row, never the mounted window. */
export async function exportMatchingDeals(identity: Identity, filters: DealDirectoryFilters): Promise<DealRow[]> {
  if (filters.archived) throw new Error("deals_removed_export_forbidden");
  const rows = await withUserScope(identity, tx => tx.$queryRaw<DealRow[]>(Prisma.sql`
    SELECT ${DIRECTORY_COLUMNS} FROM app.deal WHERE ${directoryWhere(filters)} ORDER BY ${directoryOrder(filters)}
  `));
  return rows.map(row => maskCedarRidgeUserId(coerce(row), identity.role));
}

/** Only the requested form reads distinct suggestion fields; the directory never downloads them. */
export async function getDealSuggestions(identity: Identity): Promise<DealSuggestions> {
  const rows = await withUserScope(identity, tx => tx.$queryRaw<DealSuggestions[]>(Prisma.sql`
    WITH active AS MATERIALIZED (
      SELECT id, created_date, trim(client_first_name) AS first, trim(client_last_name) AS last,
        trim(concat(trim(client_first_name), ' ', trim(client_last_name))) AS "full",
        household_name, household_sf_id FROM app.deal WHERE archived_at IS NULL
    ), client_names AS (
      SELECT DISTINCT ON ("full") * FROM active WHERE "full" <> '' ORDER BY "full", created_date DESC, id
    ), household_defaults AS (
      SELECT DISTINCT ON ("full") "full", household_name, household_sf_id FROM active
      WHERE household_name IS NOT NULL ORDER BY "full", created_date DESC, id
    ), clients AS (
      SELECT a.first, a.last, a."full",
        COALESCE(a.household_name, h.household_name) AS household_name,
        CASE WHEN a.household_name IS NOT NULL THEN a.household_sf_id ELSE h.household_sf_id END AS household_sf_id
      FROM client_names a LEFT JOIN household_defaults h ON h."full" = a."full"
    ), households AS (
      SELECT DISTINCT household_name FROM active WHERE NULLIF(trim(household_name), '') IS NOT NULL
    ) SELECT COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY "full") FROM clients c), '[]'::jsonb) AS clients,
      COALESCE((SELECT jsonb_agg(household_name ORDER BY household_name) FROM households), '[]'::jsonb) AS households
  `));
  const result = rows[0] ?? { clients: [], households: [] };
  return { clients: result.clients.sort((a, b) => a.full.localeCompare(b.full)),
    households: result.households.sort((a, b) => a.localeCompare(b)) };
}

// D7 (WO ticket): default reads EXCLUDE archived deals — this ONE filter is
// keeps legacy scoped readers archive-free. The progressive directory and
// explicit full-query export apply this same archive exclusion independently.
// Archived rows are reachable only via the gated Removed view/listArchivedDeals
// and getDeal (deliberate: deep links render a labeled read-only state).
export async function listDeals(identity: Identity): Promise<DealRow[]> {
  const rows = await withUserScope(identity, (tx) =>
    tx.$queryRaw<DealRow[]>`
      SELECT id, source, sf_deal_id, name, client_first_name, client_last_name,
             household_name, household_sf_id, client_sf_id, amount, stage, stage_raw,
             created_date, close_date, last_activity_date,
             owner_name, owner_sf_user_id, secondary_owner,
             person_aum, potential_aum, cedar_ridge_user_id,
             statements, asset_mapped, plaid_linked,
             account_last4, account_type, transferring_firm,
             employer, rolling_into, lost_from, archived_reason, stage_history,
             created_by, updated_by, created_at, updated_at,
             archived_at, archived_by
      FROM app.deal
      WHERE archived_at IS NULL
      ORDER BY created_date DESC, id`,
  );
  return rows.map((r) => maskCedarRidgeUserId(coerce(r), identity.role));
}

// getDeal DOES return archived rows (decision noted in the D7 blueprint,
// within the WO's latitude): a deep link / stale modal route to an archived
// deal renders a clearly-labeled read-only "Removed" state (DealDetail keys on
// archived_at) instead of a confusing 404. There is no list path to archived
// deals outside the gated Removed view.
// D8 QC fix (MEDIUM-2, PR #80): `archived_reason` (which can carry a
// free-text operator note) is a Removed-view detail, gated to ADMIN +
// OPERATIONS everywhere else — so THIS seam nulls it for every other role
// before the row can reach a component. DealDetail renders the reason only
// when present, so non-ops deep links show the labeled Removed state with no
// reason line.
export async function getDeal(
  identity: Identity,
  id: string,
): Promise<DealRow | null> {
  const resolvedId = await resolveCrmRouteKey(identity, "DEAL", id);
  const rows = await withUserScope(identity, (tx) =>
    tx.$queryRaw<DealRow[]>`
      SELECT id, source, sf_deal_id, name, client_first_name, client_last_name,
             household_name, household_sf_id, client_sf_id, amount, stage, stage_raw,
             created_date, close_date, last_activity_date,
             owner_name, owner_sf_user_id, secondary_owner,
             person_aum, potential_aum, cedar_ridge_user_id,
             statements, asset_mapped, plaid_linked,
             account_last4, account_type, transferring_firm,
             employer, rolling_into, lost_from, archived_reason, stage_history,
             created_by, updated_by, created_at, updated_at,
             archived_at, archived_by
      FROM app.deal
      WHERE id = ${resolvedId}
      LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  const deal = coerce(row);
  const masked = maskCedarRidgeUserId(deal, identity.role);
  if (!canSeeArchivedDeals(identity.role)) masked.archived_reason = null;
  return masked;
}

export async function dealPipelineKpis(
  identity: Identity,
): Promise<DealPipelineKpi[]> {
  const rows = await withUserScope(identity, (tx) =>
    tx.$queryRaw<{ stage: DealStage; count: bigint; totalAmount: unknown }[]>`
      SELECT stage,
             COUNT(*)                 AS "count",
             COALESCE(SUM(amount), 0) AS "totalAmount"
      FROM app.deal
      WHERE archived_at IS NULL
      GROUP BY stage`,
  );
  return rows.map((r) => ({
    stage: r.stage,
    count: Number(r.count), // COUNT(*) → bigint at runtime
    totalAmount: Number(r.totalAmount), // SUM(numeric) → Decimal at runtime
  }));
}

/**
 * Archived ("Removed") deals, newest removal first — the D7 Removed view.
 * App-side product gate FIRST (the O1 listAuditLog precedent, fail closed):
 * ADMIN + OPERATIONS only; other roles get [] and the DB is never touched.
 * (The locked RLS posture reads all rows for every role, so the gate lives at
 * the seam, exactly like the audit-log read.)
 */
export async function listArchivedDeals(
  identity: Identity,
): Promise<DealRow[]> {
  if (!canSeeArchivedDeals(identity.role)) return [];
  const rows = await withUserScope(identity, (tx) =>
    tx.$queryRaw<DealRow[]>`
      SELECT id, source, sf_deal_id, name, client_first_name, client_last_name,
             household_name, household_sf_id, client_sf_id, amount, stage, stage_raw,
             created_date, close_date, last_activity_date,
             owner_name, owner_sf_user_id, secondary_owner,
             person_aum, potential_aum, cedar_ridge_user_id,
             statements, asset_mapped, plaid_linked,
             account_last4, account_type, transferring_firm,
             employer, rolling_into, lost_from, archived_reason, stage_history,
             created_by, updated_by, created_at, updated_at,
             archived_at, archived_by
      FROM app.deal
      WHERE archived_at IS NOT NULL
      ORDER BY archived_at DESC, id`,
  );
  return rows.map((r) => maskCedarRidgeUserId(coerce(r), identity.role));
}

// T4 (Asset Transfer composition, ticket; TDD ticket ADR-9 — signature
// FROZEN there): the transfer detail's REAL deals rollup, keyed by the
// self-contained `household_sf_id` linkage (deals ADR-7 / transfers ADR-6).
// Same SELECT + ORDER BY as `listDeals` plus the household WHERE; same
// `withUserScope` posture; same `coerce` (Decimal→Number at the seam).
// D7 merge note: archived deals are excluded here too — a removed deal must
// not count in a transfer's funding picture.
// tkt-deals-dedupe: normalize BOTH sides of the household↔deal join to the
// 15-char prefix (see getHousehold). `app.deal.household_sf_id` is 15-char for
// legacy import rows and 18-char for live-feed rows, and the caller's
// `transfer.household_sf_id` may itself be either width — `householdDealKey`
// clips the bound id and `left(household_sf_id, 15)` clips the stored one, so
// the join matches regardless of width. Fails closed on a null key.
export async function dealsForHousehold(
  identity: Identity,
  householdSfId: string,
): Promise<DealRow[]> {
  const dealKey = householdDealKey(householdSfId);
  if (!dealKey) return [];
  const rows = await withUserScope(identity, (tx) =>
    tx.$queryRaw<DealRow[]>`
      SELECT id, source, sf_deal_id, name, client_first_name, client_last_name,
             household_name, household_sf_id, client_sf_id, amount, stage, stage_raw,
             created_date, close_date, last_activity_date,
             owner_name, owner_sf_user_id, secondary_owner,
             person_aum, potential_aum, cedar_ridge_user_id,
             statements, asset_mapped, plaid_linked,
             account_last4, account_type, transferring_firm,
             employer, rolling_into, lost_from, archived_reason, stage_history,
             created_by, updated_by, created_at, updated_at,
             archived_at, archived_by
      FROM app.deal
      WHERE left(household_sf_id, 15) = ${dealKey}
        AND archived_at IS NULL
      ORDER BY created_date DESC, id`,
  );
  return rows.map((r) => maskCedarRidgeUserId(coerce(r), identity.role));
}

// tkt-deals-client-link: a single CLIENT's deals, for the Client Portrait.
// Clones `dealsForHousehold`'s structure (withUserScope, same SELECT list,
// Decimal→Number `coerce` at the seam, archived excluded), but the linkage is a
// DIRECT 18-char equality: `app.deal.client_sf_id` carries the CRM
// report's "Person: Contact ID" (003 Contact id) verbatim, the SAME width as
// `mirror.client.sf_id` — so NO 15-char prefix normalization (unlike the
// household 15/18 case). Fails closed on a null/empty client id (no key → no
// match → []). ORDER BY matches getHousehold's deals fold: WON/LOST last, then
// earliest expected close first.
export async function dealsForClient(
  identity: Identity,
  clientSfId: string,
): Promise<DealRow[]> {
  if (!clientSfId) return [];
  const rows = await withUserScope(identity, (tx) =>
    tx.$queryRaw<DealRow[]>`
      SELECT id, source, sf_deal_id, name, client_first_name, client_last_name,
             household_name, household_sf_id, client_sf_id, amount, stage, stage_raw,
             created_date, close_date, last_activity_date,
             owner_name, owner_sf_user_id, secondary_owner,
             person_aum, potential_aum, cedar_ridge_user_id,
             statements, asset_mapped, plaid_linked,
             account_last4, account_type, transferring_firm,
             employer, rolling_into, lost_from, archived_reason, stage_history,
             created_by, updated_by, created_at, updated_at,
             archived_at, archived_by
      FROM app.deal
      WHERE client_sf_id = ${clientSfId}
        AND archived_at IS NULL
      ORDER BY (stage IN ('WON', 'LOST')), close_date NULLS LAST`,
  );
  return rows.map((r) => maskCedarRidgeUserId(coerce(r), identity.role));
}
