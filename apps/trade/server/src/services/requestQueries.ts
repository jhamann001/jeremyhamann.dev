import type {
  AssetLocationMode,
  AuthChannel,
  AuthUser,
  AuditEntry,
  BaseAllocation,
  EquityStrategy,
  LastAllocationData,
  RequestStatus,
  TradeRequest,
  ValidationResult,
} from '@trade-request/shared';
import pool from '../db/pool.js';
import { recordDb } from '../db/recordSource.js';
import { FORCED_ADVISOR_NAME } from '../lib/advisorDisplay.js';
import { AppError } from '../middleware/errorHandler.js';
import { verifyStoredPlans, type EngineCaller } from './engineUse.js';

// ─── DB row shapes ──────────────────────────────────────────────────────────

export interface DbTradeRequestRow {
  id: string;
  client_id: string;
  client_name: string | null;
  client_ids: string[] | null;
  client_names: string[] | null;
  advisor_id: string;
  advisor_name: string | null;
  trade_type: TradeRequest['tradeType'];
  trade_amount: string | null;
  deposit_account: string | null;
  rebalance_all: boolean | null;
  status: RequestStatus;
  created_at: Date | string;
  updated_at: Date | string;
  selected_accounts: string[] | null;
  total_value: string;
  priority: TradeRequest['priority'] | null;
  advisor_notes: string | null;
  residence: TradeRequest['residence'] | null;
  liquidation_approval: boolean | null;
  advisor_exclusions: string | null;
  client_exclusions: string | null;
  esg_filters: TradeRequest['esgFilters'] | null;
  risk_profile: number | null;
  base_allocation: BaseAllocation | null;
  equity_strategies: EquityStrategy[] | null;
  raise_cash_reason: string | null;
  liquidity_deadline: string | null;
  liquidate_option: TradeRequest['liquidateOption'] | null;
  liquidate_positions: string | null;
  execution_plan: TradeRequest['executionPlan'] | null;
  account_metadata: TradeRequest['accountMetadata'] | null;
  asset_location_mode: AssetLocationMode | null;
  household_id: string | number | null;
  household_name: string | null;
}

export interface DbAuditLogRow {
  id: string;
  request_id: string;
  created_at: Date | string;
  user_name: string;
  action: string;
  notes: string | null;
  channel: AuthChannel;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toISODate(val: unknown): string | null {
  if (!val) return null;
  const d = val instanceof Date ? val : new Date(String(val));
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

function toISOString(val: Date | string | null, fallback: Date | string | null): string {
  if (val instanceof Date) return val.toISOString();
  if (val != null) return String(val);
  if (fallback instanceof Date) return fallback.toISOString();
  if (fallback != null) return String(fallback);
  return new Date().toISOString();
}

const VALID_LIQUIDATE_OPTIONS = new Set<string>(['Entire Account', 'Specific Positions']);
const LIQUIDATE_OPTION_ALIASES: Record<string, TradeRequest['liquidateOption']> = {
  Liquidate_Entire_Account: 'Entire Account',
};

function normalizeLiquidateOption(raw: string | null): TradeRequest['liquidateOption'] {
  if (!raw || raw === 'nan') return '';
  if (VALID_LIQUIDATE_OPTIONS.has(raw)) return raw as TradeRequest['liquidateOption'];
  return LIQUIDATE_OPTION_ALIASES[raw] ?? '';
}

/** Escape `%`, `_`, and `\` for use in PostgreSQL ILIKE ... ESCAPE '\\'. */
export function escapeILikePattern(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function mapRowToRequest(
  r: DbTradeRequestRow,
  auditRows: DbAuditLogRow[],
  caller: EngineCaller = 'service',
): TradeRequest {
  const auditLog: AuditEntry[] = auditRows.map((a) => ({
    id: a.id,
    date: a.created_at instanceof Date ? a.created_at.toISOString() : String(a.created_at),
    user: a.user_name,
    action: a.action,
    notes: a.notes ?? '',
    channel: a.channel === 'opsPortal' ? 'opsPortal' : 'standalone',
  }));

  const executionPlan = r.execution_plan ?? [];
  let validation: ValidationResult | undefined;
  if (executionPlan.length > 0 && r.base_allocation) {
    const grandTotal = executionPlan.reduce((sum, p) => sum + (p.accountValue ?? 0), 0);
    const isDepositOnly = r.trade_type === 'Cash Deposit' && !(r.rebalance_all ?? false);
    validation = verifyStoredPlans(caller, executionPlan, {
      grandTotal,
      baseAllocation: r.base_allocation,
      isDepositOnly,
    });
  }

  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name ?? '',
    clientIds: r.client_ids ?? [r.client_id],
    clientNames: r.client_names ?? [r.client_name ?? ''],
    advisor: FORCED_ADVISOR_NAME,
    // `advisor_name` here is `users.name` joined on `advisor_id` — i.e. the
    // actual user who submitted the request. The DB column happens to be
    // labelled "advisor" because at one point it was. We expose it as
    // `submittedBy` and keep `advisor` forced to Rachel Moss for the
    // client-of-record display.
    submittedBy: r.advisor_name ?? FORCED_ADVISOR_NAME,
    tradeType: r.trade_type,
    tradeAmount: r.trade_amount ?? '',
    depositAccount: r.deposit_account ?? '',
    rebalanceAll: r.rebalance_all ?? false,
    status: r.status,
    date: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: toISOString(r.updated_at, r.created_at),
    selectedAccounts: r.selected_accounts ?? [],
    totalValue: parseFloat(r.total_value) || 0,
    priority: r.priority ?? '',
    advisorNotes: r.advisor_notes ?? '',
    residence: r.residence ?? 'Other',
    liquidationApproval: r.liquidation_approval == null ? '' : r.liquidation_approval ? 'Yes' : 'No',
    advisorExclusions: r.advisor_exclusions ?? '',
    clientExclusions: r.client_exclusions ?? '',
    esgFilters: r.esg_filters ?? {
      fossilFuels: false,
      tobacco: false,
      weapons: false,
      alcohol: false,
      gambling: false,
      other: false,
      otherDescription: '',
      none: true,
    },
    riskProfile: r.risk_profile,
    baseAllocation: r.base_allocation ?? { equity: 0, fixed: 0, cash: 0 },
    equityStrategies: r.equity_strategies ?? [],
    raiseCashReason: r.raise_cash_reason ?? '',
    liquidityDeadline: toISODate(r.liquidity_deadline),
    liquidateOption: normalizeLiquidateOption(r.liquidate_option),
    liquidatePositions: r.liquidate_positions ?? '',
    executionPlan,
    ...(validation ? { validation } : {}),
    accountMetadata: r.account_metadata ?? undefined,
    assetLocationMode: r.asset_location_mode ?? 'priority',
    // Defaulting policy (B3): NULL DB column → `null` on the wire (NOT
    // `undefined`), so JSON serialization keeps the field present and
    // downstream consumers can distinguish "untagged" from "missing".
    // `household_id` is BIGINT in Postgres; node-postgres returns it as a
    // string by default. Coerce to a positive integer or null.
    householdId:
      r.household_id == null
        ? null
        : typeof r.household_id === 'number'
          ? r.household_id
          : Number.parseInt(r.household_id, 10) || null,
    householdName: r.household_name ?? null,
    auditLog,
  };
}

// ─── Query functions ────────────────────────────────────────────────────────

export interface RequestCounts {
  total: number;
  pendingReview: number;
  needsInfo: number;
  approved: number;
}

// Both advisors and traders see the full request queue — there is no
// per-advisor scoping on reads. (Write operations like resubmit still check
// ownership; see requests.ts.)
export async function getRequestCounts(_user: AuthUser): Promise<RequestCounts> {
  const { rows } = await recordDb().query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM trade_requests GROUP BY status`,
  );

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    counts[row.status] = parseInt(row.count);
    total += counts[row.status];
  }

  return {
    total,
    pendingReview: counts['Pending Review'] ?? 0,
    needsInfo: counts['Needs Info'] ?? 0,
    approved: (counts['Approved'] ?? 0) + (counts['Completed'] ?? 0),
  };
}

export interface ListRequestsOptions {
  limit: number;
  before?: string;
  q?: string;
  fetchAll?: boolean;
}

export interface ListRequestsResult {
  data: TradeRequest[];
  nextCursor: string | null;
  truncated?: boolean;
}

const MAX_EXPORT_ROWS = 5000;

export async function listRequests(
  _user: AuthUser,
  opts: ListRequestsOptions,
  caller: EngineCaller = 'service',
): Promise<ListRequestsResult> {
  const fetchAll = opts.fetchAll === true;
  const searchQ = opts.q?.trim() ? opts.q.trim() : '';
  const limit = fetchAll ? MAX_EXPORT_ROWS : searchQ ? Math.min(opts.limit, 50) : opts.limit;
  const before = fetchAll ? undefined : opts.before;

  let cursorTimestamp: string | undefined;
  let cursorId: string | undefined;
  if (before) {
    const parts = before.split('|');
    cursorTimestamp = parts[0];
    cursorId = parts[1];
    if (isNaN(new Date(cursorTimestamp).getTime())) {
      throw new AppError(400, 'Invalid cursor: must be a valid ISO timestamp');
    }
  }

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let paramIdx = 1;

  if (searchQ) {
    const pattern = `%${escapeILikePattern(searchQ)}%`;
    const p = paramIdx++;
    params.push(pattern);
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
      conditions.push(`(tr.created_at, tr.id) < ($${paramIdx}, $${paramIdx + 1})`);
      params.push(cursorTimestamp, cursorId);
      paramIdx += 2;
    } else {
      conditions.push(`tr.created_at < $${paramIdx++}`);
      params.push(cursorTimestamp);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitClause = `LIMIT $${paramIdx}`;
  params.push(limit + 1);

  const { rows } = await recordDb().query<DbTradeRequestRow>(
    `
    SELECT tr.*, u.name AS advisor_name
    FROM trade_requests tr
    LEFT JOIN users u ON u.id = tr.advisor_id
    ${whereClause}
    ORDER BY tr.created_at DESC, tr.id DESC
    ${limitClause}
  `,
    params,
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  if (pageRows.length === 0) {
    return { data: [], nextCursor: null };
  }

  const requestIds = pageRows.map((r) => r.id);
  const { rows: allAuditRows } = await recordDb().query<DbAuditLogRow>(
    'SELECT * FROM audit_logs WHERE request_id = ANY($1) ORDER BY created_at DESC',
    [requestIds],
  );

  const auditByRequest: Record<string, DbAuditLogRow[]> = {};
  for (const a of allAuditRows) {
    if (!auditByRequest[a.request_id]) auditByRequest[a.request_id] = [];
    auditByRequest[a.request_id].push(a);
  }

  const requests = pageRows.map((r) => mapRowToRequest(r, auditByRequest[r.id] ?? [], caller));

  if (fetchAll) {
    return { data: requests, nextCursor: null, truncated: rows.length > MAX_EXPORT_ROWS };
  }

  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore
    ? (lastRow.created_at instanceof Date ? lastRow.created_at.toISOString() : String(lastRow.created_at)) +
      `|${lastRow.id}`
    : null;

  return { data: requests, nextCursor };
}

/**
 * Read-only list of trade requests belonging to any of the given client ids
 * (= cedar_ridge_user_ids), most-recent first. Reuses `mapRowToRequest` + the
 * audit-batch pattern from `listRequests` (does NOT re-implement mapping), and
 * the proven single-id client filter idiom `client_ids @> to_jsonb($n::text)`
 * (see findLastAllocationForClient / getLastAllocation / mcp/tools.ts),
 * extended to N ids via an OR chain plus a `client_id = ANY($1)` primary-column
 * match. Powers the OIDC-gated machine endpoint. Capped at MACHINE_MAX_ROWS.
 */
export async function listRequestsForClientIds(clientIds: string[]): Promise<TradeRequest[]> {
  if (clientIds.length === 0) return [];
  // Internal cap (defense-in-depth): the route already rejects >50 ids, but a
  // future caller must not be able to build an unbounded OR-chain of JSONB
  // containment clauses. Dedupe + clamp here regardless of the caller.
  const ids = [...new Set(clientIds)].slice(0, 50);

  const maxRows = Number(process.env.MACHINE_MAX_ROWS ?? 500);

  // $1 = the id array (for the primary `client_id` column via ANY);
  // $2..$(n+1) = each id, used with the proven `@>` containment idiom against
  // the JSONB `client_ids` array. This avoids relying on the unverified jsonb
  // `?|` operator while still matching household legs.
  const params: (string[] | string | number)[] = [ids];
  const containsClauses = ids.map((_, i) => `tr.client_ids @> to_jsonb($${i + 2}::text)`).join(' OR ');
  params.push(...ids);
  const limitIdx = params.length + 1;
  params.push(maxRows);

  const { rows } = await pool.query<DbTradeRequestRow>(
    `SELECT tr.*, u.name AS advisor_name
     FROM trade_requests tr
     LEFT JOIN users u ON u.id = tr.advisor_id
     WHERE tr.client_id = ANY($1) OR ${containsClauses}
     ORDER BY tr.created_at DESC, tr.id DESC
     LIMIT $${limitIdx}`,
    params,
  );
  if (rows.length === 0) return [];

  const requestIds = rows.map((r) => r.id);
  const { rows: auditRows } = await pool.query<DbAuditLogRow>(
    'SELECT * FROM audit_logs WHERE request_id = ANY($1) ORDER BY created_at DESC',
    [requestIds],
  );

  const auditByRequest: Record<string, DbAuditLogRow[]> = {};
  for (const a of auditRows) {
    if (!auditByRequest[a.request_id]) auditByRequest[a.request_id] = [];
    auditByRequest[a.request_id].push(a);
  }

  return rows.map((r) => mapRowToRequest(r, auditByRequest[r.id] ?? []));
}

export async function loadRequest(id: string, caller: EngineCaller = 'service'): Promise<TradeRequest> {
  const { rows } = await recordDb().query<DbTradeRequestRow>(
    `SELECT tr.*, u.name AS advisor_name
     FROM trade_requests tr
     LEFT JOIN users u ON u.id = tr.advisor_id
     WHERE tr.id = $1`,
    [id],
  );
  if (rows.length === 0) throw new AppError(404, `Request ${id} not found`);

  const { rows: auditRows } = await recordDb().query<DbAuditLogRow>(
    'SELECT * FROM audit_logs WHERE request_id = $1 ORDER BY created_at DESC',
    [id],
  );

  return mapRowToRequest(rows[0], auditRows, caller);
}

/**
 * How far back the content-based duplicate guard looks.
 *
 * Sized to the retry window of a phantom failure — the browser gives up on a
 * create at 120s (WRITE_TIMEOUT_MS in client/src/api/client.ts) and the advisor
 * clicks again shortly after — NOT to "any duplicate ever". A wider window
 * would start suppressing genuinely intended repeat requests.
 */
const DUPLICATE_WINDOW_SECONDS = 300;

export interface DuplicateProbe {
  advisorId: string;
  clientId: string;
  tradeType: string;
  tradeAmount: string | null;
  selectedAccounts: string[];
}

/**
 * Find a recent request from the same advisor with identical content.
 *
 * This is the belt to the idempotency key's braces. The key only dedups when
 * the client presents the SAME key on a retry; this guard needs nothing from
 * the client, so a client-side regression (or a second browser tab) can no
 * longer turn a retry into a duplicate trade request.
 *
 * Account order is normalized on both sides — the column is `text[]` and two
 * submissions of the same selection are not guaranteed to arrive in the same
 * order. `Rejected` rows are excluded on purpose: re-submitting something a
 * trader turned down is legitimate, not a duplicate.
 */
export async function findRecentDuplicate(probe: DuplicateProbe): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM trade_requests
      WHERE advisor_id = $1
        AND client_id = $2
        AND trade_type = $3
        AND trade_amount IS NOT DISTINCT FROM $4
        AND status <> 'Rejected'
        AND ARRAY(SELECT unnest(selected_accounts) ORDER BY 1)
          = ARRAY(SELECT unnest($5::text[]) ORDER BY 1)
        AND created_at > NOW() - make_interval(secs => $6)
      ORDER BY created_at DESC
      LIMIT 1`,
    [
      probe.advisorId,
      probe.clientId,
      probe.tradeType,
      probe.tradeAmount,
      probe.selectedAccounts,
      DUPLICATE_WINDOW_SECONDS,
    ],
  );
  return rows[0]?.id ?? null;
}

// Any authenticated user (advisor or trader) may read any request.
export async function getRequestForUser(
  _user: AuthUser,
  id: string,
  caller: EngineCaller = 'service',
): Promise<TradeRequest> {
  return loadRequest(id, caller);
}

export async function findLastAllocationForClient(clientId: string): Promise<LastAllocationData | null> {
  const { rows } = await recordDb().query(
    `SELECT risk_profile, base_allocation, equity_strategies
     FROM trade_requests
     WHERE (client_id = $1 OR client_ids @> to_jsonb($1::text))
       AND trade_type IN ('Initial Funding', 'Rebalance')
       AND status IN ('Approved', 'Completed')
       AND risk_profile IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT 1`,
    [clientId],
  );

  if (rows.length === 0) return null;

  const r = rows[0];
  return {
    riskProfile: r.risk_profile,
    baseAllocation: r.base_allocation ?? { equity: 0, fixed: 0, cash: 0 },
    equityStrategies: r.equity_strategies ?? [],
  };
}

export async function getLastAllocation(user: AuthUser, clientId: string): Promise<LastAllocationData | null> {
  if (user.role === 'advisor') {
    const { rows: owned } = await recordDb().query(
      `SELECT 1 FROM trade_requests
       WHERE (client_id = $1 OR client_ids @> to_jsonb($1::text))
         AND advisor_id = $2
       LIMIT 1`,
      [clientId, user.id],
    );
    if (owned.length === 0) {
      throw new AppError(403, 'You do not have access to this client');
    }
  }

  return findLastAllocationForClient(clientId);
}
