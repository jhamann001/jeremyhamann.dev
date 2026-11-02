import { z } from "zod";
import { prisma } from "@/lib/db";
import { standaloneRole } from "../registry";
import { identityIdFor } from "./actor";
import { NativeHttpError, SEGMENT, nativeRoutes, ok, queryOf, route } from "./http";

// Request reads ported from trade-request d41b6c9: server/src/services/requestQueries.ts:20-502 (without the
// plan verifier) and server/src/routes/requests.ts:299, :408-521, :1223-1240. Numeric, bigint and date
// columns are read as text so the mapping sees what node-postgres returns.

const FORCED_ADVISOR_NAME = "Rachel Moss";
const MAX_EXPORT_ROWS = 5000;

const REQUEST_COLUMNS = `
  tr.id, tr.client_id, tr.client_name, tr.client_ids, tr.client_names, u.name AS advisor_name, tr.trade_type,
  tr.trade_amount, tr.deposit_account, tr.rebalance_all, tr.status, tr.created_at, tr.updated_at,
  tr.selected_accounts, tr.total_value::text AS total_value, tr.priority, tr.advisor_notes, tr.residence,
  tr.liquidation_approval, tr.advisor_exclusions, tr.client_exclusions, tr.esg_filters, tr.risk_profile,
  tr.base_allocation, tr.equity_strategies, tr.raise_cash_reason, tr.liquidity_deadline::text AS liquidity_deadline,
  tr.liquidate_option, tr.liquidate_positions, tr.execution_plan, tr.account_metadata, tr.asset_location_mode,
  tr.household_id::text AS household_id, tr.household_name`;
const REQUEST_FROM = `FROM trade_request.trade_requests tr LEFT JOIN trade_request.users u ON u.id = tr.advisor_id`;
const AUDIT_SELECT = `SELECT id::text AS id, request_id, user_name, action, notes, created_at, channel FROM trade_request.audit_logs`;

type Json = unknown;
export type RequestRow = {
  id: string; client_id: string; client_name: string | null; client_ids: string[] | null; client_names: string[] | null;
  advisor_name: string | null; trade_type: string; trade_amount: string | null; deposit_account: string | null;
  rebalance_all: boolean | null; status: string; created_at: Date | string; updated_at: Date | string | null;
  selected_accounts: string[] | null; total_value: string; priority: string | null; advisor_notes: string | null;
  residence: string | null; liquidation_approval: boolean | null; advisor_exclusions: string | null;
  client_exclusions: string | null; esg_filters: Json | null; risk_profile: number | null;
  base_allocation: { equity: number; fixed: number; cash: number } | null; equity_strategies: Json[] | null;
  raise_cash_reason: string | null; liquidity_deadline: string | null; liquidate_option: string | null;
  liquidate_positions: string | null; execution_plan: Json[] | null; account_metadata: Json[] | null;
  asset_location_mode: string | null; household_id: string | null; household_name: string | null;
};
export type AuditRow = { id: string; request_id: string; user_name: string; action: string; notes: string | null; created_at: Date | string; channel: string };

/** requestQueries.ts:70-75 */
function toISODate(val: unknown): string | null {
  if (!val) return null;
  const d = val instanceof Date ? val : new Date(String(val));
  return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
}

/** requestQueries.ts:77-82 */
function toISOString(val: Date | string | null, fallback: Date | string | null): string {
  if (val instanceof Date) return val.toISOString();
  if (val != null) return String(val);
  if (fallback instanceof Date) return fallback.toISOString();
  if (fallback != null) return String(fallback);
  return new Date().toISOString();
}

const VALID_LIQUIDATE_OPTIONS = new Set<string>(["Entire Account", "Specific Positions"]);
const LIQUIDATE_OPTION_ALIASES: Record<string, string> = { Liquidate_Entire_Account: "Entire Account" };

function normalizeLiquidateOption(raw: string | null): string {
  if (!raw || raw === "nan") return "";
  if (VALID_LIQUIDATE_OPTIONS.has(raw)) return raw;
  return LIQUIDATE_OPTION_ALIASES[raw] ?? "";
}

/** requestQueries.ts:96-98 */
function escapeILikePattern(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : String(value));

/** requestQueries.ts:100-184, without the plan verifier: the stored plan passes through and no `validation` is added. */
export function mapRowToRequest(r: RequestRow, auditRows: AuditRow[]) {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name ?? "",
    clientIds: r.client_ids ?? [r.client_id],
    clientNames: r.client_names ?? [r.client_name ?? ""],
    advisor: FORCED_ADVISOR_NAME,
    submittedBy: r.advisor_name ?? FORCED_ADVISOR_NAME,
    tradeType: r.trade_type,
    tradeAmount: r.trade_amount ?? "",
    depositAccount: r.deposit_account ?? "",
    rebalanceAll: r.rebalance_all ?? false,
    status: r.status,
    date: iso(r.created_at),
    updatedAt: toISOString(r.updated_at, r.created_at),
    selectedAccounts: r.selected_accounts ?? [],
    totalValue: parseFloat(r.total_value) || 0,
    priority: r.priority ?? "",
    advisorNotes: r.advisor_notes ?? "",
    residence: r.residence ?? "Other",
    liquidationApproval: r.liquidation_approval == null ? "" : r.liquidation_approval ? "Yes" : "No",
    advisorExclusions: r.advisor_exclusions ?? "",
    clientExclusions: r.client_exclusions ?? "",
    esgFilters: r.esg_filters ?? {
      fossilFuels: false, tobacco: false, weapons: false, alcohol: false, gambling: false, other: false,
      otherDescription: "", none: true,
    },
    riskProfile: r.risk_profile,
    baseAllocation: r.base_allocation ?? { equity: 0, fixed: 0, cash: 0 },
    equityStrategies: r.equity_strategies ?? [],
    raiseCashReason: r.raise_cash_reason ?? "",
    liquidityDeadline: toISODate(r.liquidity_deadline),
    liquidateOption: normalizeLiquidateOption(r.liquidate_option),
    liquidatePositions: r.liquidate_positions ?? "",
    executionPlan: r.execution_plan ?? [],
    accountMetadata: r.account_metadata ?? undefined,
    assetLocationMode: r.asset_location_mode ?? "priority",
    householdId: r.household_id == null ? null : Number.parseInt(r.household_id, 10) || null,
    householdName: r.household_name ?? null,
    auditLog: auditRows.map((a) => ({
      id: a.id,
      date: iso(a.created_at),
      user: a.user_name,
      action: a.action,
      notes: a.notes ?? "",
      channel: a.channel === "aoa" ? "aoa" : "standalone",
    })),
  };
}
export type NativeTradeRequest = ReturnType<typeof mapRowToRequest>;

async function withAudit(rows: RequestRow[]): Promise<NativeTradeRequest[]> {
  if (rows.length === 0) return [];
  const audit = await prisma.$queryRawUnsafe<AuditRow[]>(
    `${AUDIT_SELECT} WHERE request_id = ANY($1::text[]) ORDER BY created_at DESC`,
    rows.map((r) => r.id),
  );
  const byRequest = new Map<string, AuditRow[]>();
  for (const a of audit) byRequest.set(a.request_id, [...(byRequest.get(a.request_id) ?? []), a]);
  return rows.map((r) => mapRowToRequest(r, byRequest.get(r.id) ?? []));
}

/** requestQueries.ts:199-217 */
export async function getRequestCounts() {
  const rows = await prisma.$queryRawUnsafe<Array<{ status: string; count: string }>>(
    `SELECT status, COUNT(*)::text AS count FROM trade_request.trade_requests GROUP BY status`,
  );
  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    counts[row.status] = parseInt(row.count);
    total += counts[row.status];
  }
  return {
    total,
    pendingReview: counts["Pending Review"] ?? 0,
    needsInfo: counts["Needs Info"] ?? 0,
    approved: (counts["Approved"] ?? 0) + (counts["Completed"] ?? 0),
  };
}

/** requestQueries.ts:234-329 */
export async function listRequests(opts: { limit: number; before?: string; q?: string; fetchAll?: boolean }) {
  const fetchAll = opts.fetchAll === true;
  const searchQ = opts.q?.trim() ? opts.q.trim() : "";
  const limit = fetchAll ? MAX_EXPORT_ROWS : searchQ ? Math.min(opts.limit, 50) : opts.limit;
  const before = fetchAll ? undefined : opts.before;

  let cursorTimestamp: string | undefined;
  let cursorId: string | undefined;
  if (before) {
    const parts = before.split("|");
    cursorTimestamp = parts[0];
    cursorId = parts[1];
    if (isNaN(new Date(cursorTimestamp).getTime())) throw new NativeHttpError(400, "Invalid cursor: must be a valid ISO timestamp");
  }

  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (searchQ) {
    params.push(`%${escapeILikePattern(searchQ)}%`);
    const p = params.length;
    conditions.push(`(
      tr.id ILIKE $${p} ESCAPE '\\'
      OR COALESCE(tr.client_name, '') ILIKE $${p} ESCAPE '\\'
      OR tr.trade_type::text ILIKE $${p} ESCAPE '\\'
      OR tr.status::text ILIKE $${p} ESCAPE '\\'
      OR COALESCE(u.name, '') ILIKE $${p} ESCAPE '\\'
      OR COALESCE(tr.client_names::text, '') ILIKE $${p} ESCAPE '\\'
      OR COALESCE(tr.client_ids::text, '') ILIKE $${p} ESCAPE '\\'
    )`);
  }
  if (cursorTimestamp) {
    if (cursorId) {
      params.push(cursorTimestamp, cursorId);
      conditions.push(`(tr.created_at, tr.id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`);
    } else {
      params.push(cursorTimestamp);
      conditions.push(`tr.created_at < $${params.length}::timestamptz`);
    }
  }
  params.push(limit + 1);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await prisma.$queryRawUnsafe<RequestRow[]>(
    `SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} ${where} ORDER BY tr.created_at DESC, tr.id DESC LIMIT $${params.length}::int`,
    ...params,
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  if (pageRows.length === 0) return { data: [], nextCursor: null };
  const data = await withAudit(pageRows);
  if (fetchAll) return { data, nextCursor: null, truncated: rows.length > MAX_EXPORT_ROWS };
  const last = pageRows[pageRows.length - 1];
  return { data, nextCursor: hasMore ? `${iso(last.created_at)}|${last.id}` : null };
}

/** requestQueries.ts:340-383, for the Client Portrait projection. */
export async function listRequestsForClientIds(clientIds: string[]): Promise<NativeTradeRequest[]> {
  if (clientIds.length === 0) return [];
  const ids = [...new Set(clientIds)].slice(0, 50);
  const maxRows = Number(process.env.MACHINE_MAX_ROWS ?? 500);
  const contains = ids.map((_, i) => `tr.client_ids @> to_jsonb($${i + 2}::text)`).join(" OR ");
  const rows = await prisma.$queryRawUnsafe<RequestRow[]>(
    `SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} WHERE tr.client_id = ANY($1::text[]) OR ${contains}
      ORDER BY tr.created_at DESC, tr.id DESC LIMIT $${ids.length + 2}::int`,
    ids, ...ids, maxRows,
  );
  return withAudit(rows);
}

/** requestQueries.ts:385-401 */
export async function loadRequest(id: string): Promise<NativeTradeRequest> {
  const rows = await prisma.$queryRawUnsafe<RequestRow[]>(`SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} WHERE tr.id = $1`, id);
  if (rows.length === 0) throw new NativeHttpError(404, `Request ${id} not found`);
  const audit = await prisma.$queryRawUnsafe<AuditRow[]>(`${AUDIT_SELECT} WHERE request_id = $1 ORDER BY created_at DESC`, id);
  return mapRowToRequest(rows[0], audit);
}

/** requestQueries.ts:464-485 */
async function findLastAllocationForClient(clientId: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ risk_profile: number | null; base_allocation: Json | null; equity_strategies: Json[] | null }>>(
    `SELECT risk_profile, base_allocation, equity_strategies
       FROM trade_request.trade_requests
      WHERE (client_id = $1 OR client_ids @> to_jsonb($1::text))
        AND trade_type IN ('Initial Funding', 'Rebalance')
        AND status IN ('Approved', 'Completed')
        AND risk_profile IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1`,
    clientId,
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return { riskProfile: r.risk_profile, baseAllocation: r.base_allocation ?? { equity: 0, fixed: 0, cash: 0 }, equityStrategies: r.equity_strategies ?? [] };
}

/** requestQueries.ts:487-502: an advisor only for a client on a request they submitted (as their moved identity). */
async function getLastAllocation(role: "trader" | "advisor", email: string, clientId: string) {
  if (role === "advisor") {
    const identityId = await identityIdFor(email);
    const owned = identityId
      ? await prisma.$queryRawUnsafe<unknown[]>(
          `SELECT 1 FROM trade_request.trade_requests
            WHERE (client_id = $1 OR client_ids @> to_jsonb($1::text)) AND advisor_id = $2::uuid LIMIT 1`,
          clientId, identityId,
        )
      : [];
    if (owned.length === 0) throw new NativeHttpError(403, "You do not have access to this client");
  }
  return findLastAllocationForClient(clientId);
}

/** requests.ts:299 */
const paramId = z.string().min(1, "ID is required").max(50, "ID is too long");

/** requests.ts:420-430 */
const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.string().max(200).optional(),
    all: z.enum(["true", "false"]).optional(),
    q: z.string().max(200).optional(),
  })
  .refine((data) => !(data.all === "true" && data.q != null && data.q.trim().length > 0), {
    message: "Cannot combine search (q) with export mode (all=true)",
    path: ["q"],
  });

export const requestCountsHandler = nativeRoutes(route("GET", "/requests/counts", async () => ok(await getRequestCounts())));

export const listRequestsHandler = nativeRoutes(route("GET", "/requests", async (_params, call) => {
  const query = listQuerySchema.parse(queryOf(call));
  const result = await listRequests({ limit: query.limit, before: query.before, q: query.q, fetchAll: query.all === "true" });
  return ok(result.truncated !== undefined ? { data: result.data, truncated: result.truncated } : { data: result.data, nextCursor: result.nextCursor });
}));

export const lastAllocationHandler = nativeRoutes(route("GET", `/requests/last-allocation/${SEGMENT}`, async ([clientId], _call, actor) =>
  ok(await getLastAllocation(standaloneRole(actor), actor.email, paramId.parse(clientId)))));

export const requestDetailHandler = nativeRoutes(route("GET", `/requests/${SEGMENT}`, async ([id]) =>
  ok({ data: await loadRequest(paramId.parse(id)) })));

/** requests.ts:1223-1240 and requestChecklist.ts:18-24; a bad id answers without details. */
export const checklistReadHandler = nativeRoutes(route("GET", `/requests/${SEGMENT}/checklist`, async ([raw]) => {
  const parsed = paramId.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "Validation failed" } };
  const rows = await prisma.$queryRawUnsafe<Array<{ preapproval_checklist: Json | null }>>(
    `SELECT preapproval_checklist FROM trade_request.trade_requests WHERE id = $1`,
    parsed.data,
  );
  if (rows.length === 0) throw new NativeHttpError(404, `Request ${parsed.data} not found`);
  return ok({ checklist: rows[0].preapproval_checklist ?? {} });
}));
