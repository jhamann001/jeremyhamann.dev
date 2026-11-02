import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isMaterialAllocationChange, riskAllocation, type BaseAllocation } from "@/lib/trade-requests/new-request-allocation";
import { NativeHttpError, SEGMENT, SERVICE_PARSE, bodyOf, nativeRoutes, route, type NativeResponse } from "@/lib/trade-requests/native/reads/http";
import { loadRequest } from "@/lib/trade-requests/native/reads/requests";
import { getCachedClients, tradeRequestWarehouseConfigured } from "@/lib/trade-requests/native/reads/sources";
import { emitTradeRequestEvent } from "@/lib/trade-requests/native/side-effects";
import {
  ALLOCATION_TRADE_TYPES,
  createRequestSchema,
  delegatedResubmitConcurrencySchema,
  paramId,
  updateStatusSchema,
  type CreateRequestBody,
} from "./request-schemas";
import { AUDIT_INSERT_SQL, FORBIDDEN, STALE_MESSAGE, WriteRefused, actingUser, aoaWrite, pgCode, refusable, type WriteUser } from "./support";

// Create, resubmit and status change, ported from trade-request d41b6c9
// server/src/routes/requests.ts (:525-940, :947-1210, :1272-1364) with the
// asset location engine removed (ticket semantics): a new request stores no
// execution plan and a resubmission leaves a stored plan as it was.

type Account = { id: string; clientId: string; accountNumber: string; accountType: string; balance: number };

const FULL_FORM: readonly string[] = ALLOCATION_TRADE_TYPES;
const TERMINAL = ["Approved", "Rejected", "Completed"];
const MAX_RETRIES = 3;
const DUPLICATE_WINDOW_SECONDS = 300;
const DUPLICATE_NOTE =
  "An identical request was submitted again within the duplicate-detection window; no new request was created.";

function generateRequestId(): string {
  return `REQ-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function toISODate(val: unknown): string | null {
  if (!val) return null;
  const d = val instanceof Date ? val : new Date(String(val));
  return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
}

/** warehouse.ts:1106-1110: the cached client list's accounts for one client. */
async function clientAccounts(clientId: string): Promise<Account[]> {
  return (await getCachedClients()).find((c) => c.id === clientId)?.accounts ?? [];
}

/** warehouse.ts:1139-1149: stable account ids by account number from the cached client list. */
async function accountIdMap(accountNumbers: string[]): Promise<Record<string, string>> {
  const requested = new Set(accountNumbers);
  const map: Record<string, string> = {};
  for (const client of await getCachedClients()) {
    for (const account of client.accounts) if (requested.has(account.accountNumber)) map[account.accountNumber] = account.id;
  }
  return map;
}

/** requestQueries.ts:464-485. */
async function findLastAllocationForClient(clientId: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ risk_profile: number; base_allocation: BaseAllocation | null; equity_strategies: Array<{ benchmark: string; allocation: number }> | null }>>(
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
  const r = rows[0];
  return r ? { riskProfile: r.risk_profile, baseAllocation: r.base_allocation ?? { equity: 0, fixed: 0, cash: 0 }, equityStrategies: r.equity_strategies ?? [] } : null;
}

async function requestIdForKey(key: string, advisorId: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    "SELECT id FROM trade_request.trade_requests WHERE idempotency_key = $1::uuid AND advisor_id = $2::uuid",
    key,
    advisorId,
  );
  return rows[0]?.id ?? null;
}

/** requestQueries.ts:434-457: same advisor, client, type, amount and account set within five minutes, not Rejected. */
async function findRecentDuplicate(advisorId: string, body: CreateRequestBody): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM trade_request.trade_requests
      WHERE advisor_id = $1::uuid
        AND client_id = $2
        AND trade_type = $3
        AND trade_amount IS NOT DISTINCT FROM $4::text
        AND status <> 'Rejected'
        AND ARRAY(SELECT unnest(selected_accounts) ORDER BY 1) = ARRAY(SELECT unnest($5::text[]) ORDER BY 1)
        AND created_at > NOW() - make_interval(secs => $6::int)
      ORDER BY created_at DESC
      LIMIT 1`,
    advisorId,
    body.clientId,
    body.tradeType,
    body.tradeAmount || null,
    body.selectedAccounts,
    DUPLICATE_WINDOW_SECONDS,
  );
  return rows[0]?.id ?? null;
}

/** requests.ts:595-627: the request that already exists; a content duplicate is recorded on it first. */
async function returnExisting(user: WriteUser, body: CreateRequestBody, existingId: string, reason: "idempotency-key" | "duplicate-content"): Promise<NativeResponse> {
  if (reason === "duplicate-content") {
    console.warn(JSON.stringify({
      event: "trade_request_duplicate_suppressed",
      tradeType: body.tradeType,
      clientCount: (body.clientIds ?? [body.clientId]).length,
      accountCount: body.selectedAccounts.length,
    }));
    await aoaWrite((tx) => tx.$executeRawUnsafe(AUDIT_INSERT_SQL, existingId, user.name, user.id, "Duplicate Submission Suppressed", DUPLICATE_NOTE))
      .catch((err: unknown) => {
        if (err instanceof WriteRefused) throw err;
        console.error(JSON.stringify({ event: "trade_request_duplicate_log_failed", code: pgCode(err) ?? "unknown" }));
      });
  }
  return { status: 200, body: { data: await loadRequest(existingId) } };
}

/** requests.ts:668-747 and :987-1066, without holdings (only the engine read them). */
async function resolveAccounts(body: CreateRequestBody): Promise<Account[]> {
  if (body.manualEntry && body.manualAccounts?.length) {
    return body.manualAccounts.map((a, i) => ({
      id: a.accountNumber || `manual-${Date.now()}-${i}`,
      clientId: body.clientId,
      accountNumber: a.accountNumber,
      accountType: a.accountType,
      balance: a.balance,
    }));
  }
  if (body.accountsData?.length) {
    const byNumber = new Map(body.accountsData.map((a) => [a.accountNumber, a]));
    const missing = body.selectedAccounts.filter((n) => !byNumber.has(n));
    if (missing.length > 0) throw new NativeHttpError(400, `Account data missing for: ${missing.join(", ")}`);
    return body.selectedAccounts.map((n) => {
      const a = byNumber.get(n)!;
      return { id: a.accountNumber, clientId: body.clientId, accountNumber: a.accountNumber, accountType: a.accountType, balance: a.balance };
    });
  }
  const allClientIds = body.clientIds ?? [body.clientId];
  if (tradeRequestWarehouseConfigured()) {
    let found: Account[];
    try {
      found = (await Promise.all(allClientIds.map((clientId) => clientAccounts(clientId)))).flat();
    } catch {
      // requests.ts:701-708 raises AppError(502) with a timeout or unavailable text; the standalone error handler
      // answers every AppError of 500 or above with "Internal server error" (errorHandler.ts:33-35).
      throw new NativeHttpError(502, "Internal server error");
    }
    const byNumber = new Map(found.map((a) => [a.accountNumber, a]));
    const missing = body.selectedAccounts.filter((n) => !byNumber.has(n));
    if (missing.length > 0) throw new NativeHttpError(400, `Account(s) not found for the selected client(s): ${missing.join(", ")}`);
    return body.selectedAccounts.map((n) => byNumber.get(n)!);
  }
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; client_id: string; account_number: string; account_type: string; balance: string }>>(
    `SELECT id::text AS id, client_id, account_number, account_type, balance::text AS balance
       FROM trade_request.accounts WHERE account_number = ANY($1::text[]) AND client_id = ANY($2::text[])`,
    body.selectedAccounts,
    allClientIds,
  );
  if (rows.length !== body.selectedAccounts.length) {
    throw new NativeHttpError(400, "One or more selected accounts do not belong to the specified client(s)");
  }
  return rows.map((r) => ({ id: r.id, clientId: r.client_id, accountNumber: r.account_number, accountType: r.account_type, balance: parseFloat(r.balance) || 0 }));
}

/** requests.ts:48-67: stable account ids for listed accounts; enrichment failure never blocks the request. */
async function stableAccountIds(accounts: Account[], fromClientAccountData: boolean): Promise<Record<string, string>> {
  if (!fromClientAccountData || accounts.length === 0 || !tradeRequestWarehouseConfigured()) return {};
  try {
    return await accountIdMap(accounts.map((a) => a.accountNumber));
  } catch {
    console.warn(JSON.stringify({ event: "request_account_id_persistence_failed", accountCount: accounts.length }));
    return {};
  }
}

/** requests.ts:334-367. */
async function validateStrategyRationales(body: CreateRequestBody, baseAllocation: BaseAllocation): Promise<void> {
  if (!FULL_FORM.includes(body.tradeType)) return;
  let rationaleRequired = body.tradeType === "Initial Funding";
  if (body.tradeType === "Rebalance" || body.tradeType === "Cash Deposit") {
    const isManualClient = body.manualEntry === true || body.clientId.startsWith("manual-");
    const previous = isManualClient ? null : await findLastAllocationForClient(body.clientId);
    rationaleRequired =
      !previous ||
      isMaterialAllocationChange({ riskProfile: body.riskProfile!, baseAllocation, equityStrategies: body.equityStrategies }, previous);
  }
  if (!rationaleRequired) return;
  const issues: z.ZodIssue[] = body.equityStrategies.flatMap((strategy, index) =>
    strategy.rationale.trim()
      ? []
      : [{
          code: z.ZodIssueCode.custom,
          message: "Each equity strategy must have a rationale for a new or materially changed allocation",
          path: ["equityStrategies", index, "rationale"],
        }],
  );
  if (issues.length > 0) throw new z.ZodError(issues);
}

/** Everything create and resubmit compute before writing; `values` are the shared column values ($1-$26) in SQL order. */
async function prepare(body: CreateRequestBody): Promise<{ totalValue: number; values: unknown[] }> {
  const isFullForm = FULL_FORM.includes(body.tradeType);
  const baseAllocation = isFullForm && body.riskProfile ? riskAllocation(body.riskProfile) : { equity: 0, fixed: 0, cash: 0 };
  const accounts = await resolveAccounts(body);
  const totalValue = accounts.reduce((sum, a) => sum + a.balance, 0);
  const accountIdByNumber = await stableAccountIds(accounts, !body.manualEntry && Boolean(body.accountsData?.length));
  await validateStrategyRationales(body, baseAllocation);
  const rebalanceAll = body.tradeType === "Initial Funding" || body.tradeType === "Rebalance" ? true : body.rebalanceAll;
  const metadata = accounts.map((a) => ({
    accountId: body.manualEntry ? null : (accountIdByNumber[a.accountNumber] ?? (body.accountsData?.length ? null : a.id)),
    accountNumber: a.accountNumber,
    accountType: a.accountType,
    balance: a.balance,
  }));
  const values = [
    body.clientId,
    body.clientName,
    JSON.stringify(body.clientIds ?? [body.clientId]),
    JSON.stringify(body.clientNames ?? [body.clientName]),
    body.tradeType,
    body.tradeAmount || null,
    body.depositAccount || null,
    rebalanceAll,
    String(totalValue),
    body.selectedAccounts,
    JSON.stringify(metadata),
    body.priority,
    body.advisorNotes || null,
    isFullForm ? body.residence : null,
    isFullForm ? body.liquidationApproval === "Yes" : null,
    isFullForm ? body.advisorExclusions || null : null,
    isFullForm ? body.clientExclusions || null : null,
    isFullForm ? JSON.stringify(body.esgFilters) : null,
    isFullForm ? body.riskProfile : null,
    isFullForm ? JSON.stringify(baseAllocation) : null,
    isFullForm ? JSON.stringify(body.equityStrategies) : null,
    body.tradeType === "Raise Cash" ? body.raiseCashReason || null : null,
    body.tradeType === "Raise Cash" && body.liquidityDeadline ? toISODate(body.liquidityDeadline) : null,
    body.tradeType === "Liquidate" ? body.liquidateOption || null : null,
    body.tradeType === "Liquidate" ? body.liquidatePositions || null : null,
    body.assetLocationMode,
  ];
  return { totalValue, values };
}

// $1-$26 are prepare().values; the plan column is never written here.
const INSERT_REQUEST_SQL = `INSERT INTO trade_request.trade_requests
  (client_id, client_name, client_ids, client_names, trade_type, trade_amount, deposit_account, rebalance_all,
   total_value, selected_accounts, account_metadata, priority, advisor_notes, residence, liquidation_approval,
   advisor_exclusions, client_exclusions, esg_filters, risk_profile, base_allocation, equity_strategies,
   raise_cash_reason, liquidity_deadline, liquidate_option, liquidate_positions, asset_location_mode,
   id, advisor_id, status, idempotency_key, household_id, household_name, created_at, updated_at)
  VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8::boolean, $9::numeric, $10::text[], $11::jsonb, $12, $13, $14,
          $15::boolean, $16, $17, $18::jsonb, $19::int, $20::jsonb, $21::jsonb, $22, $23::date, $24, $25, $26,
          $27, $28::uuid, 'Pending Review', $29::uuid, $30::bigint, $31,
          date_trunc('milliseconds', NOW()), date_trunc('milliseconds', NOW()))`;

// $1-$26 are prepare().values; household and plan columns are left as they are (requests.ts:1104-1108, ticket).
const RESUBMIT_SQL = `UPDATE trade_request.trade_requests SET
  client_id = $1, client_name = $2, client_ids = $3::jsonb, client_names = $4::jsonb,
  trade_type = $5, trade_amount = $6, deposit_account = $7, rebalance_all = $8::boolean,
  status = 'Pending Review', total_value = $9::numeric,
  selected_accounts = $10::text[], account_metadata = $11::jsonb, priority = $12, advisor_notes = $13,
  residence = $14, liquidation_approval = $15::boolean, advisor_exclusions = $16, client_exclusions = $17,
  esg_filters = $18::jsonb, risk_profile = $19::int, base_allocation = $20::jsonb, equity_strategies = $21::jsonb,
  raise_cash_reason = $22, liquidity_deadline = $23::date, liquidate_option = $24, liquidate_positions = $25,
  asset_location_mode = $26, updated_at = date_trunc('milliseconds', NOW())
  WHERE id = $27 AND status = 'Needs Info' AND updated_at = $28::timestamptz`;

export const createRequest = nativeRoutes(route("POST", "/requests", refusable(async (_params, call, actor) => {
  const user = await actingUser(actor);
  const body = createRequestSchema.parse(bodyOf(call), SERVICE_PARSE);
  body.selectedAccounts = [...new Set(body.selectedAccounts)];

  if (body.idempotencyKey) {
    const existing = await requestIdForKey(body.idempotencyKey, user.id);
    if (existing) return returnExisting(user, body, existing, "idempotency-key");
  }
  const duplicate = await findRecentDuplicate(user.id, body);
  if (duplicate) return returnExisting(user, body, duplicate, "duplicate-content");

  if (!body.manualEntry && user.role === "advisor" && tradeRequestWarehouseConfigured()) {
    for (const clientId of body.clientIds ?? [body.clientId]) {
      if ((await clientAccounts(clientId)).length === 0) throw new NativeHttpError(403, `Client ${clientId} not found or you do not have access`);
    }
  }

  const { totalValue, values } = await prepare(body);
  const auditNote = FULL_FORM.includes(body.tradeType)
    ? `Risk Profile ${body.riskProfile} applied.`
    : body.tradeType === "Raise Cash"
      ? `Cash raise requested: ${body.tradeAmount}. Priority: ${body.priority}.`
      : `${body.liquidateOption} liquidation requested. Priority: ${body.priority}.`;
  const paired = body.householdId != null && body.householdName != null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const id = generateRequestId();
    try {
      await aoaWrite(async (tx) => {
        await tx.$executeRawUnsafe(
          INSERT_REQUEST_SQL,
          ...values,
          id,
          user.id,
          body.idempotencyKey || null,
          paired ? body.householdId : null,
          paired ? body.householdName : null,
        );
        await tx.$executeRawUnsafe(AUDIT_INSERT_SQL, id, user.name, user.id, "Created Request", auditNote);
      });
    } catch (err) {
      if (pgCode(err) === "23505") {
        if (body.idempotencyKey) {
          const existing = await requestIdForKey(body.idempotencyKey, user.id);
          if (existing) return { status: 200, body: { data: await loadRequest(existing) } };
        }
        if (attempt < MAX_RETRIES - 1) continue;
      }
      throw err;
    }
    void emitTradeRequestEvent({
      kind: "submitted",
      request: {
        requestId: id,
        clientName: body.clientName,
        clientNames: body.clientNames,
        tradeType: body.tradeType,
        priority: body.priority,
        submittedBy: user.name,
        totalValue,
        accounts: body.selectedAccounts,
        advisorNotes: body.advisorNotes || undefined,
      },
    });
    return { status: 201, body: { data: await loadRequest(id) } };
  }
  throw new Error("trade_request_id_retries_exhausted");
})));

export const resubmitRequest = nativeRoutes(route("PUT", `/requests/${SEGMENT}`, refusable(async ([rawId], call, actor) => {
  const user = await actingUser(actor);
  const id = paramId.parse(rawId);
  const body = createRequestSchema.parse(bodyOf(call), SERVICE_PARSE);
  body.selectedAccounts = [...new Set(body.selectedAccounts)];
  const { expectedUpdatedAt } = delegatedResubmitConcurrencySchema.parse(bodyOf(call), SERVICE_PARSE);

  const rows = await prisma.$queryRawUnsafe<Array<{ advisor_id: string | null; status: string; updated_at: Date }>>(
    "SELECT advisor_id::text AS advisor_id, status, updated_at FROM trade_request.trade_requests WHERE id = $1",
    id,
  );
  if (rows.length === 0) throw new NativeHttpError(404, `Request ${id} not found`);
  const row = rows[0];
  if (user.role === "advisor" && row.advisor_id !== user.id) throw new NativeHttpError(403, "You do not have access to this request");
  if (new Date(row.updated_at).getTime() !== new Date(expectedUpdatedAt).getTime()) throw new NativeHttpError(409, STALE_MESSAGE);
  if (row.status !== "Needs Info") throw new NativeHttpError(409, 'Only requests in "Needs Info" status can be resubmitted.');

  const { values } = await prepare(body);
  await aoaWrite(async (tx) => {
    const updated = await tx.$executeRawUnsafe(RESUBMIT_SQL, ...values, id, expectedUpdatedAt);
    if (updated === 0) throw new NativeHttpError(409, STALE_MESSAGE);
    await tx.$executeRawUnsafe(
      AUDIT_INSERT_SQL, id, user.name, user.id, "Request Resubmitted", body.advisorNotes || "Advisor updated and resubmitted request.",
    );
  });
  const request = await loadRequest(id);
  void emitTradeRequestEvent({ kind: "resubmitted", requestId: id, clientName: body.clientName, changedBy: user.name });
  return { status: 200, body: { data: request } };
})));

export const statusChange = nativeRoutes(route("PUT", `/requests/${SEGMENT}/status`, refusable(async ([rawId], call, actor) => {
  const user = await actingUser(actor);
  if (user.role !== "trader") return FORBIDDEN;
  const id = paramId.parse(rawId);
  const body = updateStatusSchema.parse(bodyOf(call), SERVICE_PARSE);

  const rows = await prisma.$queryRawUnsafe<Array<{ status: string; client_name: string | null; advisor_id: string | null; advisor_slack_id: string | null }>>(
    `SELECT tr.status, tr.client_name, tr.advisor_id::text AS advisor_id, u.slack_user_id AS advisor_slack_id
       FROM trade_request.trade_requests tr
       LEFT JOIN trade_request.users u ON u.id = tr.advisor_id
      WHERE tr.id = $1`,
    id,
  );
  if (rows.length === 0) throw new NativeHttpError(404, `Request ${id} not found`);
  const existing = rows[0];
  if (TERMINAL.includes(existing.status)) throw new NativeHttpError(409, `Cannot modify a ${existing.status.toLowerCase()} request.`);

  await aoaWrite(async (tx) => {
    const updated = await tx.$executeRawUnsafe(
      "UPDATE trade_request.trade_requests SET status = $1, updated_at = date_trunc('milliseconds', NOW()) WHERE id = $2 AND updated_at = $3::timestamptz",
      body.status,
      id,
      body.expectedUpdatedAt,
    );
    if (updated === 0) throw new NativeHttpError(409, STALE_MESSAGE);
    await tx.$executeRawUnsafe(AUDIT_INSERT_SQL, id, user.name, user.id, `Status changed to ${body.status}`, body.note || "No additional notes.");
  });
  const request = await loadRequest(id);
  void emitTradeRequestEvent({
    kind: "status_changed",
    requestId: id,
    clientName: existing.client_name ?? "",
    newStatus: body.status,
    note: body.note,
    changedBy: user.name,
    submitterId: existing.advisor_id,
    submitterSlackId: existing.advisor_slack_id ?? null,
  });
  return { status: 200, body: { data: request } };
})));
