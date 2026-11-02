import "server-only";

import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { crmReportingEnabled } from "@/lib/flags";
import { withUserScope, type Identity } from "@/lib/rls";
import type {
  CrmReportDataset,
  CrmReportFilter,
  CrmReportMetric,
  CrmReportQuery,
  CrmReportValue,
} from "@/lib/crm/reporting-contracts";
import { parseCrmReportQuery } from "@/lib/crm/reporting-query";
import { drsStageTaskProgressJoin } from "@/lib/data/drs-workflow-query";
import {
  ASSET_MAPPER_TITLE,
  DECISION_HIDDEN_TASK_TITLES,
  PARTIAL_ACAT_ONLY_TASK_TITLES,
  STATEMENTS_TITLE,
} from "@/lib/data/transfer-types";

export const CRM_REPORTING_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
]);
export const CRM_REPORTING_ROW_LIMIT = 100;
export const CRM_REPORTING_TRANSACTION_TIMEOUT_MS = 12_000;
export const CRM_REPORTING_TRANSACTION_MAX_WAIT_MS = 3_000;
export const CRM_REPORTING_STATEMENT_TIMEOUT_MS = 8_000;
export const CRM_REPORTING_LOCK_TIMEOUT_MS = 2_000;

const REPORTING_TRANSACTION_OPTIONS = {
  timeout: CRM_REPORTING_TRANSACTION_TIMEOUT_MS,
  maxWait: CRM_REPORTING_TRANSACTION_MAX_WAIT_MS,
} as const;

type ReportingFailureReason = "disabled" | "forbidden" | "missing_context";

export type CrmReportingResult =
  | { ok: true; datasets: CrmReportDataset[] }
  | { ok: false; reason: ReportingFailureReason };

type RawHouseholdAumRow = {
  household_id: string | null;
  household: string | null;
  advisor: string | null;
  client_stage: string | null;
  aum: unknown;
  accounts: bigint | null;
  members: bigint | null;
  aum_as_of: Date | null;
  total_rows: bigint;
  snapshot?: string;
  total_aum: unknown;
  total_accounts: unknown;
  latest_aum_as_of: Date | null;
  effective_page: number;
  page_count: number;
};

type RawDealPipelineRow = {
  stage: string | null;
  owner: string | null;
  deals: bigint | null;
  pipeline_value: unknown;
  average_age_days: number | null;
  overdue: bigint | null;
  earliest_overdue_close: Date | null;
  next_expected_close: Date | null;
  source_as_of: Date | null;
  latest_source_as_of: Date | null;
  total_rows: bigint;
  snapshot?: string;
  total_deals: unknown;
  total_pipeline_value: unknown;
  total_overdue: unknown;
  effective_page: number;
  page_count: number;
};

type RawClientEngagementRow = {
  household_id: string | null;
  household: string | null;
  advisor: string | null;
  open_tasks: bigint | null;
  last_call: Date | null;
  last_email: Date | null;
  last_interaction: Date | null;
  days_since_interaction: number | null;
  total_rows: bigint;
  snapshot?: string;
  total_open_tasks: unknown;
  no_recorded_interaction: unknown;
  stale_90_days: unknown;
  latest_interaction: Date | null;
  effective_page: number;
  page_count: number;
};

type RawTransferFundingRow = {
  stage: string | null;
  owner: string | null;
  funding_type: string | null;
  transfers: bigint | null;
  transfer_value: unknown;
  average_days_in_stage: number | null;
  stalled: bigint | null;
  open_checklist_items: unknown;
  source_as_of: Date | null;
  latest_source_as_of: Date | null;
  total_rows: bigint;
  snapshot?: string;
  total_transfers: unknown;
  in_flight_value: unknown;
  funded_value: unknown;
  total_stalled: unknown;
  total_open_checklist_items: unknown;
  effective_page: number;
  page_count: number;
};

export function canReadCrmReporting(role: string | null | undefined): boolean {
  return CRM_REPORTING_ROLES.has(role ?? "");
}

export function hasCrmReportingReadContext(identity: Identity): boolean {
  return canReadCrmReporting(identity.role) && Boolean(identity.email);
}

async function applyReportingDatabaseBounds(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT set_config(
    'statement_timeout', ${String(CRM_REPORTING_STATEMENT_TIMEOUT_MS)}, true
  )`;
  await tx.$executeRaw`SELECT set_config(
    'lock_timeout', ${String(CRM_REPORTING_LOCK_TIMEOUT_MS)}, true
  )`;
}

function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function humanizeTransferCode(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const words = value.toLowerCase().split("_");
  return words
    .map((word) => word === "acat" || word === "drs"
      ? word.toUpperCase()
      : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function metric(
  label: string,
  value: CrmReportValue,
  format?: CrmReportMetric["format"],
): CrmReportMetric {
  return { label, value, ...(format ? { format } : {}) };
}

function numberFilter(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function textFilter(value: string | undefined): string | null {
  const trimmed = value?.trim();
  const escaped = trimmed?.replace(/[\\%_]/g, "\\$&");
  return escaped ? `%${escaped}%` : null;
}

function reportFilters(
  definitions: Array<Omit<CrmReportFilter, "value">>,
  query: CrmReportQuery,
): CrmReportFilter[] {
  return definitions.map((filter) => ({
    ...filter,
    value: query.filters[filter.key] ?? "",
  }));
}

function reportingRowId(dataset: string, keys: unknown[]): string {
  return `${dataset}:${createHash("sha256").update(JSON.stringify(keys)).digest("hex")}`;
}

function pageCount(totalRows: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalRows / pageSize));
}

const RETRIEVED_AT = () => new Date().toISOString();

function unavailableDataset(
  id: CrmReportDataset["id"],
  label: string,
  description: string,
  columns: CrmReportDataset["columns"],
  defaultColumns: string[],
  query: CrmReportQuery,
  context: Pick<CrmReportDataset, "source" | "sourceAsOfLabel" | "definitions" | "exclusions">,
): CrmReportDataset {
  return {
    id,
    label,
    description,
    columns,
    defaultColumns,
    rows: [],
    rowLinks: [],
    metrics: [],
    filters: [],
    totalRows: 0,
    page: query.page,
    pageSize: query.pageSize,
    pageCount: 1,
    sort: query.sort,
    direction: query.direction,
    available: false,
    source: context.source,
    sourceAsOf: null,
    sourceAsOfLabel: context.sourceAsOfLabel,
    retrievedAt: RETRIEVED_AT(),
    definitions: context.definitions,
    exclusions: context.exclusions,
  };
}

const HOUSEHOLD_COLUMNS: CrmReportDataset["columns"] = [
  { key: "household", label: "Household", sortable: true },
  { key: "advisor", label: "Advisor", sortable: true },
  { key: "clientStage", label: "Client stage", sortable: true },
  { key: "aum", label: "Current AUM", format: "money", sortable: true },
  { key: "accounts", label: "Accounts", format: "number", sortable: true },
  { key: "members", label: "Members", format: "number", sortable: true },
  { key: "aumAsOf", label: "AUM as of", format: "date", sortable: true },
];

const DEAL_COLUMNS: CrmReportDataset["columns"] = [
  { key: "stage", label: "Stage", sortable: true },
  { key: "owner", label: "Owner", sortable: true },
  { key: "deals", label: "Deals", format: "number", sortable: true },
  { key: "pipelineValue", label: "Pipeline value", format: "money", sortable: true },
  { key: "averageAgeDays", label: "Average age", format: "number", sortable: true },
  { key: "overdue", label: "Past expected close", format: "number", sortable: true },
  { key: "earliestOverdueClose", label: "Earliest overdue close", format: "date", sortable: true },
  { key: "nextExpectedClose", label: "Next expected close", format: "date", sortable: true },
];

const ENGAGEMENT_COLUMNS: CrmReportDataset["columns"] = [
  { key: "household", label: "Household", sortable: true },
  { key: "advisor", label: "Advisor", sortable: true },
  { key: "openTasks", label: "Open tasks", format: "number", sortable: true },
  { key: "lastCall", label: "Last call", format: "date", sortable: true },
  { key: "lastEmail", label: "Last email", format: "date", sortable: true },
  { key: "lastInteraction", label: "Last interaction", format: "date", sortable: true },
  { key: "daysSinceInteraction", label: "Days since interaction", format: "number", sortable: true },
];

const TRANSFER_COLUMNS: CrmReportDataset["columns"] = [
  { key: "stage", label: "Stage", sortable: true },
  { key: "owner", label: "Owner", sortable: true },
  { key: "fundingType", label: "Funding type", sortable: true },
  { key: "transfers", label: "Transfers", format: "number", sortable: true },
  { key: "transferValue", label: "Value", format: "money", sortable: true },
  { key: "averageDaysInStage", label: "Average days in stage", format: "number", sortable: true },
  { key: "stalled", label: "14+ days in stage", format: "number", sortable: true },
  { key: "openChecklistItems", label: "Open checklist items", format: "number", sortable: true },
];

const REPORT_CONTEXT: Record<CrmReportDataset["id"], Pick<CrmReportDataset, "source" | "sourceAsOfLabel" | "definitions" | "exclusions">> = {
  household_aum: {
    source: "CRM households and Apex account-value mirror",
    sourceAsOfLabel: "Latest Apex valuation",
    definitions: [
      "Current AUM is the sum of visible Apex account values for each client household.",
      "Accounts counts mirrored Apex accounts; members excludes the household placeholder record.",
    ],
    exclusions: ["Firm households are excluded.", "Households without Apex values remain visible with blank AUM."],
  },
  deal_pipeline: {
    source: "AOA deal pipeline",
    sourceAsOfLabel: "Latest deal update",
    definitions: [
      "Pipeline value is the sum of deal amounts in each stage and owner group.",
      "Past expected close counts open deals whose expected close date is before today.",
    ],
    exclusions: ["Archived and synthetic demo deals are excluded.", "Won and lost deals are not classified as overdue."],
  },
  client_engagement: {
    source: "CRM household, task, call, and email mirrors",
    sourceAsOfLabel: "Latest recorded interaction",
    definitions: [
      "Last interaction is the later of the latest recorded call or email.",
      "Open tasks are tasks whose normalized status is not Completed.",
    ],
    exclusions: ["Firm households are excluded.", "Other interaction types are not included until they are mirrored into AOA."],
  },
  transfers_funding: {
    source: "AOA asset-transfer workflow",
    sourceAsOfLabel: "Latest transfer update",
    definitions: [
      "Value uses the linked deal amount when present, otherwise the transfer value.",
      "Stalled means an unfunded transfer has spent at least 14 days in its current stage.",
    ],
    exclusions: ["Archived and synthetic demo transfers are excluded.", "Decision-stage tasks hidden by the transfer workflow are not counted as open."],
  },
};

async function readHouseholdAumReport(
  identity: Identity,
  query: CrmReportQuery,
): Promise<CrmReportDataset> {
  const minAum = numberFilter(query.filters.minAum);
  const maxAum = numberFilter(query.filters.maxAum);
  const advisor = textFilter(query.filters.advisor);
  const clientStage = textFilter(query.filters.clientStage);
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (query.rangeError) conditions.push(Prisma.sql`FALSE`);
  if (advisor) conditions.push(Prisma.sql`advisor ILIKE ${advisor}`);
  const search = textFilter(query.filters.search);
  if (search) conditions.push(Prisma.sql`(household ILIKE ${search} OR advisor ILIKE ${search})`);
  if (clientStage) conditions.push(Prisma.sql`client_stage ILIKE ${clientStage}`);
  if (query.filters.accountState === "with") conditions.push(Prisma.sql`accounts > 0`);
  if (query.filters.accountState === "without") conditions.push(Prisma.sql`accounts = 0`);
  if (query.filters.aumAge === "current") conditions.push(Prisma.sql`aum_as_of >= CURRENT_DATE - 30`);
  if (query.filters.aumAge === "missing") conditions.push(Prisma.sql`aum_as_of IS NULL`);
  if (query.filters.aumAge?.startsWith("older")) conditions.push(Prisma.sql`aum_as_of IS NOT NULL AND aum_as_of < CURRENT_DATE - ${Number(query.filters.aumAge.slice(5))}::int`);
  if (minAum != null) conditions.push(Prisma.sql`aum >= ${minAum}`);
  if (maxAum != null) conditions.push(Prisma.sql`aum <= ${maxAum}`);
  const sortColumns: Record<string, string> = {
    household: "household",
    advisor: "advisor",
    clientStage: "client_stage",
    aum: "aum",
    accounts: "accounts",
    members: "members",
    aumAsOf: "aum_as_of",
  };
  const order = Prisma.raw(
    query.sort === "aum" && query.direction === "desc"
      ? "aum DESC NULLS LAST, household ASC, household_id ASC"
      : `${sortColumns[query.sort] ?? "aum"} ${query.direction.toUpperCase()} NULLS LAST, household ASC, household_id ASC`,
  );
  const rows = await withUserScope(identity, async (tx) => {
    await applyReportingDatabaseBounds(tx);
    return tx.$queryRaw<RawHouseholdAumRow[]>`
      WITH account_rollup AS (
        SELECT left(household_sf_id, 15) AS household_key,
               count(*)::bigint AS accounts,
               sum(account_aum) AS aum,
               max(balance_as_of) AS aum_as_of
        FROM mirror.client_account_aum
        WHERE source_present
          AND balance_current
        GROUP BY 1
      ),
      member_rollup AS (
        SELECT left(household_id, 15) AS household_key,
               count(*)::bigint AS members
        FROM mirror.client
        WHERE household_id IS NOT NULL
          AND sf_id <> household_id
        GROUP BY 1
      ),
      report_rows AS (
        SELECT h.sf_id AS household_id,
               h.name AS household,
               COALESCE(
                 NULLIF(a.name, ''),
                 NULLIF(h.lead_advisor_email, ''),
                 'Unassigned'
               ) AS advisor,
               COALESCE(NULLIF(h.stage, ''), 'Unknown') AS client_stage,
               ar.aum,
               COALESCE(ar.accounts, 0)::bigint AS accounts,
               COALESCE(mr.members, 0)::bigint AS members,
               ar.aum_as_of
        FROM mirror.household h
        LEFT JOIN mirror.advisor a ON a.email = h.lead_advisor_email
        LEFT JOIN account_rollup ar
          ON ar.household_key = left(h.sf_id, 15)
        LEFT JOIN member_rollup mr
          ON mr.household_key = left(h.sf_id, 15)
        WHERE COALESCE(h.household_kind, 'CLIENT') = 'CLIENT'
      ), filtered_rows AS (
        SELECT * FROM report_rows
        WHERE ${Prisma.join(conditions, " AND ")}
      ), totals AS (
        SELECT count(*)::bigint AS total_rows,
               sum(aum) AS total_aum,
               sum(accounts) AS total_accounts,
               max(aum_as_of) AS latest_aum_as_of,
               md5(coalesce(string_agg(md5(to_jsonb(filtered_rows)::text), '' ORDER BY household_id), '')) AS snapshot
        FROM filtered_rows
      ), bounds AS (
        SELECT *,
               GREATEST(1, ceil(total_rows::numeric / ${query.pageSize})::int) AS page_count,
               LEAST(
                 ${query.page},
                 GREATEST(1, ceil(total_rows::numeric / ${query.pageSize})::int)
               ) AS effective_page
        FROM totals
      ), paged_rows AS (
        SELECT *, row_number() OVER (ORDER BY ${order}) AS page_order
        FROM filtered_rows
        ORDER BY ${order}
        LIMIT ${query.pageSize}
        OFFSET (SELECT (effective_page - 1) * ${query.pageSize} FROM bounds)
      )
      SELECT b.snapshot, p.household_id, p.household, p.advisor, p.client_stage, p.aum,
             p.accounts, p.members, p.aum_as_of,
             b.total_rows, b.total_aum, b.total_accounts, b.latest_aum_as_of,
             b.effective_page, b.page_count
      FROM bounds b
      LEFT JOIN paged_rows p ON TRUE
      ORDER BY p.page_order NULLS LAST`;
  }, REPORTING_TRANSACTION_OPTIONS);

  const totals = rows[0];
  const dataRows = rows.filter((row): row is RawHouseholdAumRow & { household_id: string; household: string; advisor: string; client_stage: string } => row.household_id != null);
  const totalRows = Number(totals?.total_rows ?? 0n);
  const context = REPORT_CONTEXT.household_aum;
  return {
    id: "household_aum",
    snapshot: totals?.snapshot,
    rowIds: dataRows.map((row) => reportingRowId("household_aum", [row.household_id])),
    label: "Households & AUM",
    description: "Current household, advisor, membership, and Apex account-value rollup.",
    columns: HOUSEHOLD_COLUMNS,
    defaultColumns: ["household", "advisor", "aum", "accounts", "members", "aumAsOf"],
    rows: dataRows.map((row) => ({
      household: row.household,
      advisor: row.advisor,
      clientStage: row.client_stage,
      aum: row.aum == null ? null : Number(row.aum),
      accounts: Number(row.accounts),
      members: Number(row.members),
      aumAsOf: isoDate(row.aum_as_of),
    })),
    rowLinks: dataRows.map((row) => ({ household: `/households/${encodeURIComponent(row.household_id)}` })),
    metrics: [
      metric("Households", Number(totals?.total_rows ?? 0n), "number"),
      metric("Current AUM", totals?.total_aum == null ? null : Number(totals.total_aum), "money"),
      metric("Accounts", Number(totals?.total_accounts ?? 0), "number"),
      metric("Latest AUM date", isoDate(totals?.latest_aum_as_of ?? null), "date"),
    ],
    filters: reportFilters([
      { key: "search", label: "Search households or advisors", type: "text", placeholder: "Start typing…" },
      { key: "advisor", label: "Advisor", type: "text", placeholder: "Name or email" },
      { key: "clientStage", label: "Client stage", type: "text", placeholder: "Client, prospect…" },
      { key: "accountState", label: "Accounts", type: "select", options: [
        { value: "", label: "All households" },
        { value: "with", label: "Has Apex accounts" },
        { value: "without", label: "No Apex accounts" },
      ] },
      { key: "aumAge", label: "AUM date window", type: "select", options: [
        { value: "", label: "Any date" },
        { value: "current", label: "Within 30 days" },
        { value: "older30", label: "Older than 30 days" },
        { value: "older60", label: "Older than 60 days" },
        { value: "older90", label: "Older than 90 days" },
        { value: "missing", label: "No Apex date" },
      ] },
      { key: "minAum", label: "Minimum AUM", type: "number", placeholder: "0", helpText: "Enter any amount, with or without commas" },
      { key: "maxAum", label: "Maximum AUM", type: "number", placeholder: "No maximum", helpText: "Enter any amount, with or without commas" },
    ], query),
    totalRows,
    page: Number(totals?.effective_page ?? 1),
    pageSize: query.pageSize,
    pageCount: Number(totals?.page_count ?? pageCount(totalRows, query.pageSize)),
    sort: query.sort,
    direction: query.direction,
    available: true,
    ...context,
    sourceAsOf: isoDate(totals?.latest_aum_as_of ?? null),
    retrievedAt: RETRIEVED_AT(),
    drilldownHref: "/households",
    drilldownLabel: "Open household directory",
  };
}

async function readDealPipelineReport(
  identity: Identity,
  query: CrmReportQuery,
): Promise<CrmReportDataset> {
  const minValue = numberFilter(query.filters.minValue);
  const maxValue = numberFilter(query.filters.maxValue);
  const owner = textFilter(query.filters.owner);
  const allowedStages = new Set(["POTENTIAL", "COMMITTED", "FUNDING", "WON", "LOST"]);
  const stage = allowedStages.has(query.filters.stage ?? "") ? query.filters.stage : null;
  const conditions: Prisma.Sql[] = [
    Prisma.sql`archived_at IS NULL`,
    Prisma.sql`COALESCE(sf_deal_id, '') NOT LIKE 'DEMO-%'`,
  ];
  if (query.rangeError) conditions.push(Prisma.sql`FALSE`);
  if (stage) conditions.push(Prisma.sql`stage::text = ${stage}`);
  if (query.filters.dealState === "open") conditions.push(Prisma.sql`stage NOT IN ('WON', 'LOST')`);
  if (query.filters.dealState === "closed") conditions.push(Prisma.sql`stage IN ('WON', 'LOST')`);
  if (owner) conditions.push(Prisma.sql`COALESCE(NULLIF(owner_name, ''), 'Unassigned') ILIKE ${owner}`);
  const search = textFilter(query.filters.search);
  if (search) conditions.push(Prisma.sql`(COALESCE(NULLIF(owner_name, ''), 'Unassigned') ILIKE ${search} OR stage::text ILIKE ${search})`);
  if (query.filters.closeWindow === "overdue") conditions.push(Prisma.sql`stage NOT IN ('WON', 'LOST') AND close_date < CURRENT_DATE`);
  if (query.filters.closeWindow === "upcoming") conditions.push(Prisma.sql`stage NOT IN ('WON', 'LOST') AND close_date >= CURRENT_DATE`);
  if (query.filters.closeWindow === "missing") conditions.push(Prisma.sql`close_date IS NULL`);
  if (query.filters.closeWindow?.startsWith("next")) conditions.push(Prisma.sql`stage NOT IN ('WON', 'LOST') AND close_date >= CURRENT_DATE AND close_date <= CURRENT_DATE + ${Number(query.filters.closeWindow.slice(4))}`);
  if (minValue != null) conditions.push(Prisma.sql`amount >= ${minValue}`);
  if (maxValue != null) conditions.push(Prisma.sql`amount <= ${maxValue}`);
  const sortColumns: Record<string, string> = {
    stage: "CASE stage WHEN 'POTENTIAL' THEN 1 WHEN 'COMMITTED' THEN 2 WHEN 'FUNDING' THEN 3 WHEN 'WON' THEN 4 WHEN 'LOST' THEN 5 ELSE 6 END",
    owner: "owner",
    deals: "deals",
    pipelineValue: "pipeline_value",
    averageAgeDays: "average_age_days",
    overdue: "overdue",
    earliestOverdueClose: "earliest_overdue_close",
    nextExpectedClose: "next_expected_close",
  };
  const order = Prisma.raw(
    query.sort === "stage" && query.direction === "asc"
      ? `${sortColumns.stage} ASC, pipeline_value DESC, owner ASC`
      : `${sortColumns[query.sort] ?? sortColumns.stage} ${query.direction.toUpperCase()} NULLS LAST, stage ASC, owner ASC`,
  );
  const rows = await withUserScope(identity, async (tx) => {
    await applyReportingDatabaseBounds(tx);
    return tx.$queryRaw<RawDealPipelineRow[]>`
      WITH filtered_deals AS (
        SELECT * FROM app.deal
        WHERE ${Prisma.join(conditions, " AND ")}
      ), report_rows AS (
        SELECT stage::text AS stage,
               COALESCE(NULLIF(owner_name, ''), 'Unassigned') AS owner,
               count(*)::bigint AS deals,
               COALESCE(sum(amount), 0) AS pipeline_value,
               round(avg(GREATEST(CURRENT_DATE - created_date, 0)))::int
                 AS average_age_days,
               count(*) FILTER (
                 WHERE stage NOT IN ('WON', 'LOST')
                   AND close_date < CURRENT_DATE
               )::bigint AS overdue,
               min(close_date) FILTER (
                 WHERE stage NOT IN ('WON', 'LOST')
                   AND close_date < CURRENT_DATE
               ) AS earliest_overdue_close,
               min(close_date) FILTER (
                 WHERE stage NOT IN ('WON', 'LOST')
                   AND close_date >= CURRENT_DATE
               ) AS next_expected_close,
               max(updated_at) AS source_as_of
        FROM filtered_deals
        GROUP BY stage, COALESCE(NULLIF(owner_name, ''), 'Unassigned')
      ), totals AS (
        SELECT count(*)::bigint AS total_rows,
               sum(deals) AS total_deals,
               sum(pipeline_value) AS total_pipeline_value,
               sum(overdue) AS total_overdue,
               max(source_as_of) AS latest_source_as_of,
               md5(coalesce(string_agg(md5(to_jsonb(report_rows)::text), '' ORDER BY stage, owner), '')) AS snapshot
        FROM report_rows
      ), bounds AS (
        SELECT *,
               GREATEST(1, ceil(total_rows::numeric / ${query.pageSize})::int) AS page_count,
               LEAST(
                 ${query.page},
                 GREATEST(1, ceil(total_rows::numeric / ${query.pageSize})::int)
               ) AS effective_page
        FROM totals
      ), paged_rows AS (
        SELECT *, row_number() OVER (ORDER BY ${order}) AS page_order
        FROM report_rows
        ORDER BY ${order}
        LIMIT ${query.pageSize}
        OFFSET (SELECT (effective_page - 1) * ${query.pageSize} FROM bounds)
      )
      SELECT b.snapshot, p.stage, p.owner, p.deals, p.pipeline_value, p.average_age_days,
             p.overdue, p.earliest_overdue_close, p.next_expected_close,
             p.source_as_of, b.latest_source_as_of, b.total_rows, b.total_deals,
             b.total_pipeline_value, b.total_overdue, b.effective_page, b.page_count
      FROM bounds b
      LEFT JOIN paged_rows p ON TRUE
      ORDER BY p.page_order NULLS LAST`;
  }, REPORTING_TRANSACTION_OPTIONS);

  const totals = rows[0];
  const dataRows = rows.filter((row): row is RawDealPipelineRow & { stage: string; owner: string; deals: bigint } => row.stage != null);
  const totalRows = Number(totals?.total_rows ?? 0n);
  const context = REPORT_CONTEXT.deal_pipeline;
  return {
    id: "deal_pipeline",
    snapshot: totals?.snapshot,
    rowIds: dataRows.map((row) => reportingRowId("deal_pipeline", [row.stage, row.owner])),
    label: "Deal pipeline",
    description: "Live non-archived deal counts, value, ownership, and aging by stage.",
    columns: DEAL_COLUMNS,
    defaultColumns: [
      "stage",
      "owner",
      "deals",
      "pipelineValue",
      "averageAgeDays",
      "overdue",
      "earliestOverdueClose",
      "nextExpectedClose",
    ],
    rows: dataRows.map((row) => ({
      stage: row.stage,
      owner: row.owner,
      deals: Number(row.deals),
      pipelineValue: Number(row.pipeline_value),
      averageAgeDays: Number(row.average_age_days),
      overdue: Number(row.overdue),
      earliestOverdueClose: isoDate(row.earliest_overdue_close),
      nextExpectedClose: isoDate(row.next_expected_close),
    })),
    rowLinks: dataRows.map(() => ({})),
    metrics: [
      metric("Deals", Number(totals?.total_deals ?? 0), "number"),
      metric("Pipeline value", totals?.total_pipeline_value == null ? 0 : Number(totals.total_pipeline_value), "money"),
      metric("Past expected close", Number(totals?.total_overdue ?? 0), "number"),
      metric("Stage / owner groups", Number(totals?.total_rows ?? 0n), "number"),
    ],
    filters: reportFilters([
      { key: "search", label: "Search owners or stages", type: "text", placeholder: "Start typing…" },
      { key: "stage", label: "Stage", type: "select", options: [
        { value: "", label: "All stages" },
        ...["POTENTIAL", "COMMITTED", "FUNDING", "WON", "LOST"].map((value) => ({ value, label: value[0] + value.slice(1).toLowerCase() })),
      ] },
      { key: "dealState", label: "Deal state", type: "select", options: [
        { value: "", label: "Open and closed" },
        { value: "open", label: "Open deals" },
        { value: "closed", label: "Won or lost" },
      ] },
      { key: "owner", label: "Owner", type: "text", placeholder: "Owner name" },
      { key: "closeWindow", label: "Expected close", type: "select", options: [
        { value: "", label: "Any close date" },
        { value: "overdue", label: "Past expected close" },
        { value: "upcoming", label: "Upcoming" },
        { value: "missing", label: "No expected close" },
        { value: "next30", label: "Next 30 days" },
        { value: "next60", label: "Next 60 days" },
        { value: "next90", label: "Next 90 days" },
      ] },
      { key: "minValue", label: "Minimum deal value", type: "number", placeholder: "0", helpText: "Enter any amount, with or without commas" },
      { key: "maxValue", label: "Maximum deal value", type: "number", placeholder: "No maximum", helpText: "Enter any amount, with or without commas" },
    ], query),
    totalRows,
    page: Number(totals?.effective_page ?? 1),
    pageSize: query.pageSize,
    pageCount: Number(totals?.page_count ?? pageCount(totalRows, query.pageSize)),
    sort: query.sort,
    direction: query.direction,
    available: true,
    ...context,
    sourceAsOf: totals?.latest_source_as_of?.toISOString() ?? null,
    retrievedAt: RETRIEVED_AT(),
    drilldownHref: "/deals",
    drilldownLabel: "Open deal pipeline",
  };
}

async function readClientEngagementReport(
  identity: Identity,
  query: CrmReportQuery,
): Promise<CrmReportDataset> {
  const advisor = textFilter(query.filters.advisor);
  const minDays = numberFilter(query.filters.minDays);
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (query.rangeError) conditions.push(Prisma.sql`FALSE`);
  if (advisor) conditions.push(Prisma.sql`advisor ILIKE ${advisor}`);
  const search = textFilter(query.filters.search);
  if (search) conditions.push(Prisma.sql`(household ILIKE ${search} OR advisor ILIKE ${search})`);
  if (query.filters.taskState === "open") conditions.push(Prisma.sql`open_tasks > 0`);
  if (query.filters.taskState === "clear") conditions.push(Prisma.sql`open_tasks = 0`);
  if (query.filters.interactionAge === "never") conditions.push(Prisma.sql`last_interaction IS NULL`);
  if (query.filters.interactionAge === "older90") conditions.push(Prisma.sql`days_since_interaction >= 90`);
  if (query.filters.interactionAge === "within30") conditions.push(Prisma.sql`days_since_interaction < 31`);
  if (query.filters.interactionAge === "31to60") conditions.push(Prisma.sql`days_since_interaction >= 31 AND days_since_interaction < 61`);
  if (query.filters.interactionAge === "61to89") conditions.push(Prisma.sql`days_since_interaction >= 61 AND days_since_interaction < 90`);
  if (minDays != null) conditions.push(Prisma.sql`days_since_interaction >= ${Math.floor(minDays)}`);
  const sortColumns: Record<string, string> = {
    household: "household",
    advisor: "advisor",
    openTasks: "open_tasks",
    lastCall: "last_call",
    lastEmail: "last_email",
    lastInteraction: "last_interaction",
    daysSinceInteraction: "days_since_interaction",
  };
  const order = Prisma.raw(
    query.sort === "lastInteraction" && query.direction === "asc"
      ? "last_interaction ASC NULLS FIRST, open_tasks DESC, household ASC, household_id ASC"
      : `${sortColumns[query.sort] ?? "last_interaction"} ${query.direction.toUpperCase()} NULLS LAST, household ASC, household_id ASC`,
  );
  const rows = await withUserScope(identity, async (tx) => {
    await applyReportingDatabaseBounds(tx);
    return tx.$queryRaw<RawClientEngagementRow[]>`
      WITH task_rollup AS (
        SELECT left(household_sf_id, 15) AS household_key,
               count(*) FILTER (
                 WHERE lower(trim(COALESCE(status, ''))) <> 'completed'
               )::bigint AS open_tasks
        FROM mirror.task
        GROUP BY 1
      ),
      call_rollup AS (
        SELECT left(household_sf_id, 15) AS household_key,
               max(activity_at) AS last_call
        FROM mirror.activity
        GROUP BY 1
      ),
      email_rollup AS (
        SELECT left(household_sf_id, 15) AS household_key,
               max(sent_at) AS last_email
        FROM mirror.email
        GROUP BY 1
      ),
      report_rows AS (
        SELECT h.sf_id AS household_id,
               h.name AS household,
               COALESCE(
                 NULLIF(a.name, ''),
                 NULLIF(h.lead_advisor_email, ''),
                 'Unassigned'
               ) AS advisor,
               COALESCE(tr.open_tasks, 0)::bigint AS open_tasks,
               cr.last_call,
               er.last_email,
               GREATEST(cr.last_call, er.last_email) AS last_interaction
        FROM mirror.household h
        LEFT JOIN mirror.advisor a ON a.email = h.lead_advisor_email
        LEFT JOIN task_rollup tr
          ON tr.household_key = left(h.sf_id, 15)
        LEFT JOIN call_rollup cr
          ON cr.household_key = left(h.sf_id, 15)
        LEFT JOIN email_rollup er
          ON er.household_key = left(h.sf_id, 15)
        WHERE COALESCE(h.household_kind, 'CLIENT') = 'CLIENT'
      ),
      dated_rows AS (
        SELECT *,
               CASE
                 WHEN last_interaction IS NULL THEN NULL
                 ELSE GREATEST(CURRENT_DATE - last_interaction::date, 0)::int
               END AS days_since_interaction
        FROM report_rows
      ), filtered_rows AS (
        SELECT * FROM dated_rows
        WHERE ${Prisma.join(conditions, " AND ")}
      ), totals AS (
        SELECT count(*)::bigint AS total_rows,
               sum(open_tasks) AS total_open_tasks,
               count(*) FILTER (WHERE last_interaction IS NULL) AS no_recorded_interaction,
               count(*) FILTER (WHERE days_since_interaction >= 90) AS stale_90_days,
               max(last_interaction) AS latest_interaction,
               md5(coalesce(string_agg(md5(to_jsonb(filtered_rows)::text), '' ORDER BY household_id), '')) AS snapshot
        FROM filtered_rows
      ), bounds AS (
        SELECT *,
               GREATEST(1, ceil(total_rows::numeric / ${query.pageSize})::int) AS page_count,
               LEAST(
                 ${query.page},
                 GREATEST(1, ceil(total_rows::numeric / ${query.pageSize})::int)
               ) AS effective_page
        FROM totals
      ), paged_rows AS (
        SELECT *, row_number() OVER (ORDER BY ${order}) AS page_order
        FROM filtered_rows
        ORDER BY ${order}
        LIMIT ${query.pageSize}
        OFFSET (SELECT (effective_page - 1) * ${query.pageSize} FROM bounds)
      )
      SELECT b.snapshot, p.household_id, p.household, p.advisor, p.open_tasks, p.last_call,
             p.last_email, p.last_interaction, p.days_since_interaction,
             b.total_rows, b.total_open_tasks, b.no_recorded_interaction,
             b.stale_90_days, b.latest_interaction, b.effective_page, b.page_count
      FROM bounds b
      LEFT JOIN paged_rows p ON TRUE
      ORDER BY p.page_order NULLS LAST`;
  }, REPORTING_TRANSACTION_OPTIONS);

  const totals = rows[0];
  const dataRows = rows.filter((row): row is RawClientEngagementRow & { household_id: string; household: string; advisor: string; open_tasks: bigint } => row.household_id != null);
  const totalRows = Number(totals?.total_rows ?? 0n);
  const context = REPORT_CONTEXT.client_engagement;
  return {
    id: "client_engagement",
    snapshot: totals?.snapshot,
    rowIds: dataRows.map((row) => reportingRowId("client_engagement", [row.household_id])),
    label: "Client engagement",
    description: "Household-level CRM calls, emails, and open-task follow-up coverage.",
    columns: ENGAGEMENT_COLUMNS,
    defaultColumns: [
      "household",
      "advisor",
      "openTasks",
      "lastCall",
      "lastEmail",
      "lastInteraction",
      "daysSinceInteraction",
    ],
    rows: dataRows.map((row) => ({
      household: row.household,
      advisor: row.advisor,
      openTasks: Number(row.open_tasks),
      lastCall: isoDate(row.last_call),
      lastEmail: isoDate(row.last_email),
      lastInteraction: isoDate(row.last_interaction),
      daysSinceInteraction: row.days_since_interaction,
    })),
    rowLinks: dataRows.map((row) => ({ household: `/households/${encodeURIComponent(row.household_id)}` })),
    metrics: [
      metric("Households", Number(totals?.total_rows ?? 0n), "number"),
      metric("Open tasks", Number(totals?.total_open_tasks ?? 0), "number"),
      metric("No recorded interaction", Number(totals?.no_recorded_interaction ?? 0), "number"),
      metric("90+ days since interaction", Number(totals?.stale_90_days ?? 0), "number"),
      metric("Latest interaction", isoDate(totals?.latest_interaction ?? null), "date"),
    ],
    filters: reportFilters([
      { key: "search", label: "Search households or advisors", type: "text", placeholder: "Start typing…" },
      { key: "advisor", label: "Advisor", type: "text", placeholder: "Name or email" },
      { key: "taskState", label: "Task status", type: "select", options: [
        { value: "", label: "Any task status" },
        { value: "open", label: "Has open tasks" },
        { value: "clear", label: "No open tasks" },
      ] },
      { key: "interactionAge", label: "Interaction date window", type: "select", options: [
        { value: "", label: "Any date" },
        { value: "never", label: "No recorded interaction" },
        { value: "within30", label: "Within 30 days" },
        { value: "31to60", label: "31–60 days ago" },
        { value: "61to89", label: "61–89 days ago" },
        { value: "older90", label: "90+ days ago" },
      ] },
      { key: "minDays", label: "Minimum days since interaction", type: "number", placeholder: "0" },
    ], query),
    totalRows,
    page: Number(totals?.effective_page ?? 1),
    pageSize: query.pageSize,
    pageCount: Number(totals?.page_count ?? pageCount(totalRows, query.pageSize)),
    sort: query.sort,
    direction: query.direction,
    available: true,
    ...context,
    sourceAsOf: totals?.latest_interaction?.toISOString() ?? null,
    retrievedAt: RETRIEVED_AT(),
    drilldownHref: "/households",
    drilldownLabel: "Open household directory",
  };
}

async function readTransfersFundingReport(
  identity: Identity,
  query: CrmReportQuery,
): Promise<CrmReportDataset> {
  const minValue = numberFilter(query.filters.minValue);
  const maxValue = numberFilter(query.filters.maxValue);
  const owner = textFilter(query.filters.owner);
  const allowedStages = new Set(["DECISION", "IN_TRANSFER", "FUNDED"]);
  const allowedFunding = new Set(["ACAT_FULL", "ACAT_PARTIAL", "CHECK", "WIRE", "ACH", "MANUAL", "DRS"]);
  const stage = allowedStages.has(query.filters.stage ?? "") ? query.filters.stage : null;
  const fundingType = allowedFunding.has(query.filters.fundingType ?? "") ? query.filters.fundingType : null;
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (query.rangeError) conditions.push(Prisma.sql`FALSE`);
  if (stage) conditions.push(Prisma.sql`stage = ${stage}`);
  if (owner) conditions.push(Prisma.sql`owner ILIKE ${owner}`);
  const search = textFilter(query.filters.search);
  if (search) conditions.push(Prisma.sql`(owner ILIKE ${search} OR funding_type ILIKE ${search})`);
  if (fundingType) conditions.push(Prisma.sql`funding_type = ${fundingType}`);
  if (query.filters.fundingState === "missing") conditions.push(Prisma.sql`NULLIF(funding_type, '') IS NULL`);
  if (query.filters.fundingState === "present") conditions.push(Prisma.sql`NULLIF(funding_type, '') IS NOT NULL`);
  if (query.filters.stalledState === "stalled") conditions.push(Prisma.sql`stage <> 'FUNDED' AND days_in_stage >= 14`);
  if (query.filters.stalledState === "moving") conditions.push(Prisma.sql`stage = 'FUNDED' OR days_in_stage < 14`);
  if (query.filters.checklistState === "open") conditions.push(Prisma.sql`open_checklist_items > 0`);
  if (query.filters.checklistState === "clear") conditions.push(Prisma.sql`open_checklist_items = 0`);
  if (query.filters.updatedWindow) conditions.push(Prisma.sql`source_as_of >= CURRENT_DATE - ${Number(query.filters.updatedWindow)}`);
  if (minValue != null) conditions.push(Prisma.sql`transfer_value >= ${minValue}`);
  if (maxValue != null) conditions.push(Prisma.sql`transfer_value <= ${maxValue}`);
  const sortColumns: Record<string, string> = {
    stage: "CASE stage WHEN 'DECISION' THEN 1 WHEN 'IN_TRANSFER' THEN 2 WHEN 'FUNDED' THEN 3 ELSE 4 END",
    owner: "owner",
    fundingType: "funding_type",
    transfers: "transfers",
    transferValue: "transfer_value",
    averageDaysInStage: "average_days_in_stage",
    stalled: "stalled",
    openChecklistItems: "open_checklist_items",
  };
  const order = Prisma.raw(
    query.sort === "stage" && query.direction === "asc"
      ? `${sortColumns.stage} ASC, stalled DESC, transfer_value DESC, owner ASC, funding_type ASC`
      : `${sortColumns[query.sort] ?? sortColumns.stage} ${query.direction.toUpperCase()} NULLS LAST, stage ASC, owner ASC, funding_type ASC`,
  );
  const rows = await withUserScope(identity, async (tx) => {
    await applyReportingDatabaseBounds(tx);
    return tx.$queryRaw<RawTransferFundingRow[]>`
      WITH transfer_rows AS (
        SELECT t.id,
               t.stage::text AS stage,
               COALESCE(
                 NULLIF(t.owner_name, ''),
                 initcap(replace(t.owner_kind::text, '_', ' '))
               ) AS owner,
               t.funding_type::text AS funding_type,
               COALESCE(d.amount, t.value) AS transfer_value,
               GREATEST(CURRENT_DATE - t.stage_entered_at::date, 0)::int
                 AS days_in_stage,
               t.updated_at AS source_as_of,
               CASE WHEN t.funding_type::text = 'DRS'
                 THEN MAX(drs_progress.total - drs_progress.done)
                 ELSE count(k.id) FILTER (
                 WHERE NOT (
                   CASE k.title
                     WHEN ${STATEMENTS_TITLE} THEN
                       COALESCE(k.override_done, d.statements, k.done)
                     WHEN ${ASSET_MAPPER_TITLE} THEN
                       COALESCE(k.override_done, d.asset_mapped, k.done)
                     ELSE k.done
                   END
                 )
               ) END::bigint AS open_checklist_items
        FROM app.transfer t
        LEFT JOIN app.deal d ON d.id = t.deal_id
        LEFT JOIN app.transfer_task k ON k.transfer_id = t.id
          AND t.funding_type::text IS DISTINCT FROM 'DRS'
          AND NOT (
            t.stage::text = 'DECISION'
            AND (
              k.title = ANY(${[...DECISION_HIDDEN_TASK_TITLES]}::text[])
              OR (
                k.title = ANY(${[...PARTIAL_ACAT_ONLY_TASK_TITLES]}::text[])
                AND t.funding_type::text IS DISTINCT FROM 'ACAT_PARTIAL'
              )
            )
          )
        ${drsStageTaskProgressJoin()}
        WHERE t.archived_at IS NULL
          AND t.id NOT LIKE 'DEMO-T-%'
          AND COALESCE(t.deal_sf_id, d.sf_deal_id, '') NOT LIKE 'DEMO-%'
        GROUP BY t.id, d.id
      ),
      filtered_transfers AS (
        SELECT * FROM transfer_rows
        WHERE ${Prisma.join(conditions, " AND ")}
      ), report_rows AS (
        SELECT stage,
               owner,
               funding_type,
               count(*)::bigint AS transfers,
               sum(transfer_value) AS transfer_value,
               round(avg(days_in_stage))::int AS average_days_in_stage,
               count(*) FILTER (
                 WHERE stage <> 'FUNDED' AND days_in_stage >= 14
               )::bigint AS stalled,
               sum(open_checklist_items) AS open_checklist_items,
               max(source_as_of) AS source_as_of
        FROM filtered_transfers
        GROUP BY stage, owner, funding_type
      ), totals AS (
        SELECT count(*)::bigint AS total_rows,
               sum(transfers) AS total_transfers,
               sum(transfer_value) FILTER (WHERE stage <> 'FUNDED') AS in_flight_value,
               sum(transfer_value) FILTER (WHERE stage = 'FUNDED') AS funded_value,
               sum(stalled) AS total_stalled,
               sum(open_checklist_items) AS total_open_checklist_items,
               max(source_as_of) AS latest_source_as_of,
               md5(coalesce(string_agg(md5(to_jsonb(report_rows)::text), '' ORDER BY stage, owner, funding_type), '')) AS snapshot
        FROM report_rows
      ), bounds AS (
        SELECT *,
               GREATEST(1, ceil(total_rows::numeric / ${query.pageSize})::int) AS page_count,
               LEAST(
                 ${query.page},
                 GREATEST(1, ceil(total_rows::numeric / ${query.pageSize})::int)
               ) AS effective_page
        FROM totals
      ), paged_rows AS (
        SELECT *, row_number() OVER (ORDER BY ${order}) AS page_order
        FROM report_rows
        ORDER BY ${order}
        LIMIT ${query.pageSize}
        OFFSET (SELECT (effective_page - 1) * ${query.pageSize} FROM bounds)
      )
      SELECT b.snapshot, p.stage, p.owner, p.funding_type, p.transfers, p.transfer_value,
             p.average_days_in_stage, p.stalled, p.open_checklist_items,
             p.source_as_of, b.latest_source_as_of, b.total_rows, b.total_transfers,
             b.in_flight_value, b.funded_value, b.total_stalled,
             b.total_open_checklist_items, b.effective_page, b.page_count
      FROM bounds b
      LEFT JOIN paged_rows p ON TRUE
      ORDER BY p.page_order NULLS LAST`;
  }, REPORTING_TRANSACTION_OPTIONS);

  const totals = rows[0];
  const dataRows = rows.filter((row): row is RawTransferFundingRow & { stage: string; owner: string; transfers: bigint } => row.stage != null);
  const totalRows = Number(totals?.total_rows ?? 0n);
  const context = REPORT_CONTEXT.transfers_funding;
  return {
    id: "transfers_funding",
    snapshot: totals?.snapshot,
    rowIds: dataRows.map((row) => reportingRowId("transfers_funding", [row.stage, row.owner, row.funding_type])),
    label: "Transfers & funding",
    description: "Live transfer value, ownership, stage aging, funding rails, and checklist workload.",
    columns: TRANSFER_COLUMNS,
    defaultColumns: [
      "stage",
      "owner",
      "fundingType",
      "transfers",
      "transferValue",
      "averageDaysInStage",
      "stalled",
      "openChecklistItems",
    ],
    rows: dataRows.map((row) => ({
      stage: humanizeTransferCode(row.stage, "Unknown"),
      owner: row.owner,
      fundingType: humanizeTransferCode(row.funding_type, "Not set"),
      transfers: Number(row.transfers),
      transferValue: Number(row.transfer_value),
      averageDaysInStage: Number(row.average_days_in_stage),
      stalled: Number(row.stalled),
      openChecklistItems: Number(row.open_checklist_items),
    })),
    rowLinks: dataRows.map(() => ({})),
    metrics: [
      metric("Transfers", Number(totals?.total_transfers ?? 0), "number"),
      metric("In-flight value", Number(totals?.in_flight_value ?? 0), "money"),
      metric("Funded value", Number(totals?.funded_value ?? 0), "money"),
      metric("14+ days in stage", Number(totals?.total_stalled ?? 0), "number"),
      metric("Open checklist items", Number(totals?.total_open_checklist_items ?? 0), "number"),
    ],
    filters: reportFilters([
      { key: "search", label: "Search owners or funding types", type: "text", placeholder: "Start typing…" },
      { key: "stage", label: "Stage", type: "select", options: [
        { value: "", label: "All stages" },
        { value: "DECISION", label: "Decision" },
        { value: "IN_TRANSFER", label: "In transfer" },
        { value: "FUNDED", label: "Funded" },
      ] },
      { key: "owner", label: "Owner", type: "text", placeholder: "Owner name" },
      { key: "fundingType", label: "Funding type", type: "select", options: [
        { value: "", label: "All funding types" },
        ...["ACAT_FULL", "ACAT_PARTIAL", "CHECK", "WIRE", "ACH", "MANUAL", "DRS"].map((value) => ({ value, label: humanizeTransferCode(value, value) })),
      ] },
      { key: "fundingState", label: "Funding type state", type: "select", options: [
        { value: "", label: "Any funding type state" },
        { value: "missing", label: "Missing funding type" },
        { value: "present", label: "Funding type present" },
      ] },
      { key: "stalledState", label: "Stage aging", type: "select", options: [
        { value: "", label: "Any stage age" },
        { value: "stalled", label: "Stalled (14+ days)" },
        { value: "moving", label: "Not stalled" },
      ] },
      { key: "checklistState", label: "Checklist", type: "select", options: [
        { value: "", label: "Any checklist state" },
        { value: "open", label: "Has open items" },
        { value: "clear", label: "No open items" },
      ] },
      { key: "updatedWindow", label: "Updated date window", type: "select", options: [
        { value: "", label: "Any update date" },
        { value: "30", label: "Last 30 days" },
        { value: "60", label: "Last 60 days" },
        { value: "90", label: "Last 90 days" },
      ] },
      { key: "minValue", label: "Minimum value", type: "number", placeholder: "0", helpText: "Enter any amount, with or without commas" },
      { key: "maxValue", label: "Maximum value", type: "number", placeholder: "No maximum", helpText: "Enter any amount, with or without commas" },
    ], query),
    totalRows,
    page: Number(totals?.effective_page ?? 1),
    pageSize: query.pageSize,
    pageCount: Number(totals?.page_count ?? pageCount(totalRows, query.pageSize)),
    sort: query.sort,
    direction: query.direction,
    available: true,
    ...context,
    sourceAsOf: totals?.latest_source_as_of?.toISOString() ?? null,
    retrievedAt: RETRIEVED_AT(),
    drilldownHref: "/asset-transfer",
    drilldownLabel: "Open asset-transfer board",
  };
}

function sanitizedReportingError(datasetId: CrmReportDataset["id"]): void {
  console.error(JSON.stringify({
    event: "crm_reporting_dataset_unavailable",
    datasetId,
  }));
}

export async function getCrmReportingDatasets(
  identity: Identity,
  selectedQuery?: CrmReportQuery,
): Promise<CrmReportingResult> {
  if (!crmReportingEnabled()) return { ok: false, reason: "disabled" };
  if (!canReadCrmReporting(identity.role)) return { ok: false, reason: "forbidden" };
  if (!identity.email) return { ok: false, reason: "missing_context" };

  // Internal callers get the same bounded query contract as URL callers.
  const query = selectedQuery ? parseCrmReportQuery({
    ...selectedQuery.filters, dataset: selectedQuery.dataset,
    page: String(selectedQuery.page), pageSize: String(selectedQuery.pageSize),
    sort: selectedQuery.sort, direction: selectedQuery.direction,
    ...(selectedQuery.columnsExplicit ? { columns: selectedQuery.columns, columnsSubmitted: "1" } : {}),
  }) : parseCrmReportQuery({});
  try {
    const dataset = query.dataset === "household_aum"
      ? await readHouseholdAumReport(identity, query)
      : query.dataset === "deal_pipeline"
        ? await readDealPipelineReport(identity, query)
        : query.dataset === "client_engagement"
          ? await readClientEngagementReport(identity, query)
          : await readTransfersFundingReport(identity, query);
    return { ok: true, datasets: [dataset] };
  } catch {
    sanitizedReportingError(query.dataset);
    const dataset = query.dataset === "household_aum"
      ? unavailableDataset(
          "household_aum", "Households & AUM",
          "Current household, advisor, membership, and Apex account-value rollup.",
          HOUSEHOLD_COLUMNS, ["household", "advisor", "aum", "accounts", "members", "aumAsOf"],
          query, REPORT_CONTEXT.household_aum,
        )
      : query.dataset === "deal_pipeline"
        ? unavailableDataset(
            "deal_pipeline", "Deal pipeline",
            "Live non-archived deal counts, value, ownership, and aging by stage.",
            DEAL_COLUMNS, ["stage", "owner", "deals", "pipelineValue", "averageAgeDays", "overdue", "earliestOverdueClose", "nextExpectedClose"],
            query, REPORT_CONTEXT.deal_pipeline,
          )
        : query.dataset === "client_engagement"
          ? unavailableDataset(
              "client_engagement", "Client engagement",
              "Household-level CRM calls, emails, and open-task follow-up coverage.",
              ENGAGEMENT_COLUMNS, ["household", "advisor", "openTasks", "lastCall", "lastEmail", "lastInteraction", "daysSinceInteraction"],
              query, REPORT_CONTEXT.client_engagement,
            )
          : unavailableDataset(
              "transfers_funding", "Transfers & funding",
              "Live transfer value, ownership, stage aging, funding rails, and checklist workload.",
              TRANSFER_COLUMNS, ["stage", "owner", "fundingType", "transfers", "transferValue", "averageDaysInStage", "stalled", "openChecklistItems"],
              query, REPORT_CONTEXT.transfers_funding,
            );
    return { ok: true, datasets: [dataset] };
  }
}
