import "server-only";

import { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { FeeRequestValidationError, parseOperationsFeeRequestForm } from "@/lib/operations/fee-request";
import {
  accountNumberMatchesSuffix,
  isSalesforceId,
  maskedAccountSuffix,
  REIMBURSEMENT_PENDING_LIMIT,
  type PendingReimbursement,
  type ReimbursementAccount,
  type ReimbursementClient,
  parseReimbursementTickets,
  type ReimbursementClientSource,
  type ReimbursementField,
  type ReimbursementPrefill,
  type ReimbursementSubmitInput,
  type ReimbursementSubmitResult,
} from "./acat-reimbursement-view";
import { TRANSFER_FEE_REQUESTS_LIMIT, type TransferFeeRequest, type TransferFeeRequestsRead } from "./acat-fee-requests-view";
import {
  createOperationsFeeRequest,
  key,
  maskedAccountLabel,
  operationsFeeRequestDetail,
  type RawAccountOption,
} from "./operations-fee-requests";

// Reads for the reimbursement preview in the ACAT drawer (ticket). Every read runs
// under the caller's row-level-security scope and writes nothing. The only write is
// `createOperationsFeeRequest` (lib/data/operations-fee-requests.ts), called once from
// `createReimbursementRequest` below; the preview reads never call it. A client is only
// ever found by an id: the transfer's link or the record's Cedar Ridge user id. Never by name.

const HOUSEHOLD_OWNER_FILTER = Prisma.sql`(household_id IS NULL OR left(sf_id, 15) <> left(household_id, 15))`;

export type ReimbursementPrefillInput = {
  recordId: string;
  cedarRidgeUserId: string | null;
  maskedAccount: string | null;
};

type ClientRow = { sf_id: string; name: string; household_name: string | null };
type AccountRow = RawAccountOption;

/**
 * The same client rule the Operations Tools intake applies when it saves a request:
 * a client row of mirror.client that is not a household placeholder.
 */
async function clientRows(tx: Prisma.TransactionClient, keys: readonly string[]): Promise<ClientRow[]> {
  if (keys.length === 0) return [];
  return tx.$queryRaw<ClientRow[]>(Prisma.sql`
    SELECT c.sf_id,
           trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name,
           h.name AS household_name
      FROM mirror.client c
      LEFT JOIN mirror.household h
        ON h.sf_id = c.household_id
        OR (
          h.sf_id ~ '^[A-Za-z0-9]{15,18}$'
          AND c.household_id ~ '^[A-Za-z0-9]{15,18}$'
          AND left(h.sf_id, 15) = left(c.household_id, 15)
        )
     WHERE CASE
       WHEN c.sf_id ~ '^[A-Za-z0-9]{15,18}$' THEN upper(left(c.sf_id, 15))
       ELSE upper(c.sf_id)
     END IN (${Prisma.join(keys)})
       AND (c.household_id IS NULL OR left(c.sf_id, 15) <> left(c.household_id, 15))
     ORDER BY c.sf_id
     LIMIT 5`);
}

async function accountRows(tx: Prisma.TransactionClient, clientSfId: string): Promise<AccountRow[]> {
  return tx.$queryRaw<AccountRow[]>(Prisma.sql`
    SELECT custodian_account_id, apex_account_number, account_type, account_status, client_sf_id
      FROM mirror.client_account_aum
     WHERE CASE
       WHEN client_sf_id ~ '^[A-Za-z0-9]{15,18}$' THEN upper(left(client_sf_id, 15))
       ELSE upper(client_sf_id)
     END = ${key(clientSfId)}
       AND source_present
       AND custodian_account_id IS NOT NULL
     ORDER BY account_type NULLS LAST, apex_account_number NULLS LAST, custodian_account_id`);
}

function sameClientFilter(clientSfId: string): Prisma.OperationsFeeRequestWhereInput[] {
  // A Salesforce id names one record in its first 15 characters; any other id compares exactly.
  const sameClient: Prisma.OperationsFeeRequestWhereInput[] = [{ client_sf_id: clientSfId }];
  if (isSalesforceId(clientSfId)) sameClient.push({ client_sf_id: { startsWith: clientSfId.slice(0, 15), mode: "insensitive" } });
  return sameClient;
}

async function pendingFor(tx: Prisma.TransactionClient, clientSfId: string, accountId: string): Promise<PendingReimbursement[]> {
  const rows = await tx.operationsFeeRequest.findMany({
    where: {
      kind: "FEE_CREDIT",
      status: "PENDING",
      account_ids: { has: accountId },
      OR: sameClientFilter(clientSfId),
    },
    orderBy: { submitted_at: "desc" },
    take: REIMBURSEMENT_PENDING_LIMIT,
    select: { id: true, fee_amount: true, fee_types: true, submitted_at: true },
  });
  return rows.map((row) => ({
    id: row.id,
    feeAmount: row.fee_amount?.toFixed(2) ?? null,
    feeTypes: row.fee_types,
    submittedAt: row.submitted_at.toISOString(),
  }));
}

/** Every request of any kind for the client and account, newest first, one row past the limit so a cut list is known. */
async function requestsFor(tx: Prisma.TransactionClient, clientSfId: string, accountId: string): Promise<TransferFeeRequest[]> {
  const rows = await tx.operationsFeeRequest.findMany({
    where: { account_ids: { has: accountId }, OR: sameClientFilter(clientSfId) },
    orderBy: [{ submitted_at: "desc" }, { id: "desc" }],
    take: TRANSFER_FEE_REQUESTS_LIMIT + 1,
    select: { id: true, kind: true, status: true, fee_amount: true, fee_types: true, submitted_at: true, credited_at: true },
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    feeAmount: row.fee_amount?.toFixed(2) ?? null,
    feeTypes: row.fee_types,
    submittedAt: row.submitted_at.toISOString(),
    creditedAt: row.credited_at?.toISOString() ?? null,
  }));
}

function toClient(row: ClientRow, accounts: AccountRow[], suffix: string | null): ReimbursementClient {
  const options: ReimbursementAccount[] = accounts.map((account) => ({
    id: account.custodian_account_id,
    label: maskedAccountLabel(account),
    status: account.account_status,
    matchesTransfer: accountNumberMatchesSuffix(account.apex_account_number, suffix),
  }));
  return { clientSfId: row.sf_id, name: row.name || "Client unavailable", householdName: row.household_name, accounts: options };
}

type ResolvedIdentity = {
  chosen: ClientRow | null;
  source: ReimbursementClientSource;
  client: ReimbursementClient | null;
  accountId: string | null;
};

/**
 * The client and account this transfer resolves to, by id only. The client comes from the transfer's own
 * client link (app.transfer.acat_record_id) and from the record's single Cedar Ridge user id; when both
 * exist and differ, or more than one client resolves, none is chosen. The account is chosen only when
 * exactly one of that client's accounts ends with the transfer's masked suffix. The reimbursement
 * preview and the requests-on-file read both use this one rule.
 */
async function resolveTransferIdentity(tx: Prisma.TransactionClient, input: ReimbursementPrefillInput): Promise<ResolvedIdentity> {
  const suffix = maskedAccountSuffix(input.maskedAccount);
  const transfers = await tx.transfer.findMany({
    where: { acat_record_id: input.recordId },
    select: { client_sf_id: true },
    take: 5,
  });
  const linkedKeys = [...new Set(transfers.flatMap((t) => (t.client_sf_id ? [key(t.client_sf_id)] : [])))];
  const bridgedKeys = input.cedarRidgeUserId
    ? [...new Set((await tx.$queryRaw<Array<{ sf_id: string }>>(Prisma.sql`
        SELECT sf_id
          FROM mirror.client
         WHERE btrim(cedar_ridge_user_id) = ${input.cedarRidgeUserId}
           AND ${HOUSEHOLD_OWNER_FILTER}
         LIMIT 5`)).map((row) => key(row.sf_id)))]
    : [];
  const linked = await clientRows(tx, linkedKeys);
  const bridged = await clientRows(tx, bridgedKeys);
  const linkedResolved = new Set(linked.map((row) => key(row.sf_id)));
  const bridgedResolved = new Set(bridged.map((row) => key(row.sf_id)));
  const all = new Set([...linkedResolved, ...bridgedResolved]);

  let source: ReimbursementClientSource = "none";
  let chosen: ClientRow | null = null;
  if (all.size > 1) {
    source = "conflict";
  } else if (all.size === 1) {
    source = linkedResolved.size === 1 ? "transfer-link" : "directory";
    chosen = (linked[0] ?? bridged[0]) ?? null;
  }
  if (!chosen) return { chosen: null, source, client: null, accountId: null };

  const accounts = await accountRows(tx, chosen.sf_id);
  const client = toClient(chosen, accounts, suffix);
  const matches = client.accounts.filter((account) => account.matchesTransfer);
  return { chosen, source, client, accountId: matches.length === 1 ? matches[0].id : null };
}

/**
 * The best real client and account this transfer resolves to, and the Pending requests
 * already on file for them (see `resolveTransferIdentity` for the rule).
 */
export async function readReimbursementPrefill(identity: Identity, input: ReimbursementPrefillInput): Promise<ReimbursementPrefill> {
  return withUserScope(identity, async (tx) => {
    const resolved = await resolveTransferIdentity(tx, input);
    if (!resolved.chosen || !resolved.client) return { client: null, clientSource: resolved.source, accountId: null, pending: [] };
    const pending = resolved.accountId ? await pendingFor(tx, resolved.chosen.sf_id, resolved.accountId) : [];
    return { client: resolved.client, clientSource: resolved.source, accountId: resolved.accountId, pending };
  }, { maxWait: 10_000, timeout: 15_000 });
}

/**
 * Every request on file for the client and account this transfer resolves to, migrated and
 * newly created alike, under the caller's row-level-security scope. When the transfer cannot be tied to one
 * client and one account by id it reads no requests and says which tie is missing; it never matches by name.
 */
export async function readTransferFeeRequests(identity: Identity, input: ReimbursementPrefillInput): Promise<TransferFeeRequestsRead> {
  return withUserScope(identity, async (tx) => {
    const resolved = await resolveTransferIdentity(tx, input);
    if (!resolved.chosen || !resolved.client) return { identity: "unresolved", reason: "client" } as const;
    const account = resolved.client.accounts.find((option) => option.id === resolved.accountId);
    if (!resolved.accountId || !account) return { identity: "unresolved", reason: "account" } as const;
    const rows = await requestsFor(tx, resolved.chosen.sf_id, resolved.accountId);
    return {
      identity: "resolved",
      clientName: resolved.client.name,
      accountLabel: account.label,
      requests: rows.slice(0, TRANSFER_FEE_REQUESTS_LIMIT),
      truncated: rows.length > TRANSFER_FEE_REQUESTS_LIMIT,
    } as const;
  }, { maxWait: 10_000, timeout: 15_000 });
}

/**
 * Every Operations fee request on file for the transfer's linked client, any kind and any account,
 * newest first. The client is found by id with the same rule as the preview; never by name.
 */
export async function readClientFeeRequests(
  tx: Prisma.TransactionClient,
  clientSfId: string,
): Promise<{ client: boolean; requests: TransferFeeRequest[]; truncated: boolean }> {
  const client = (await clientRows(tx, [key(clientSfId)]))[0];
  if (!client) return { client: false, requests: [], truncated: false };
  const rows = await tx.operationsFeeRequest.findMany({
    where: { OR: sameClientFilter(client.sf_id) },
    orderBy: [{ submitted_at: "desc" }, { id: "desc" }],
    take: TRANSFER_FEE_REQUESTS_LIMIT + 1,
    select: { id: true, kind: true, status: true, fee_amount: true, fee_types: true, submitted_at: true, credited_at: true },
  });
  return {
    client: true,
    requests: rows.slice(0, TRANSFER_FEE_REQUESTS_LIMIT).map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      feeAmount: row.fee_amount?.toFixed(2) ?? null,
      feeTypes: row.fee_types,
      submittedAt: row.submitted_at.toISOString(),
      creditedAt: row.credited_at?.toISOString() ?? null,
    })),
    truncated: rows.length > TRANSFER_FEE_REQUESTS_LIMIT,
  };
}

/** Pending requests for the client and account the user has chosen in the preview. */
export async function readPendingReimbursements(identity: Identity, clientSfId: string, accountId: string): Promise<PendingReimbursement[]> {
  return withUserScope(identity, async (tx) => {
    const clients = await clientRows(tx, [key(clientSfId)]);
    const client = clients[0];
    if (!client) return [];
    const accounts = await accountRows(tx, client.sf_id);
    if (!accounts.some((account) => account.custodian_account_id === accountId)) return [];
    return pendingFor(tx, client.sf_id, accountId);
  }, { maxWait: 10_000, timeout: 15_000 });
}

const FIELD_OF_ERROR: Record<string, ReimbursementField> = {
  clientSfId: "client", accountIds: "account", feeAmount: "amount", feeTypes: "feeTypes",
  reason: "reason", relevantTicketRefs: "tickets",
};

function intakeForm(input: ReimbursementSubmitInput): FormData {
  const form = new FormData();
  form.set("requestKind", "FEE_CREDIT");
  form.set("clientSfId", input.clientSfId);
  form.append("accountIds", input.accountId);
  for (const type of input.feeTypes) form.append("feeTypes", type);
  form.set("feeAmount", input.feeAmount);
  form.set("reason", input.reason);
  form.set("relevantTicketRefs", parseReimbursementTickets(input.tickets).join("\n"));
  return form;
}

/**
 * Creates exactly one Pending Operations Tools fee request for the client and account
 * the user confirmed. It parses with the intake's own parser and writes with the intake's
 * own create path (`createOperationsFeeRequest`: client and account verified against the
 * mirror, one submission key per actor, Slack capture and audit in the same transaction),
 * so there is no second fee store. It reads the saved row back for the success state.
 */
export async function createReimbursementRequest(identity: Identity, input: ReimbursementSubmitInput): Promise<ReimbursementSubmitResult> {
  let parsed;
  try {
    parsed = parseOperationsFeeRequestForm(intakeForm(input));
  } catch (error) {
    if (error instanceof FeeRequestValidationError) {
      return { ok: false, code: "invalid", field: FIELD_OF_ERROR[error.field] ?? null };
    }
    throw error;
  }
  let id: string;
  try {
    id = await createOperationsFeeRequest(identity, parsed, input.submissionKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (error instanceof FeeRequestValidationError) return { ok: false, code: "invalid", field: null };
    if (message === "client_unavailable" || message === "account_unavailable") return { ok: false, code: "identity", field: null };
    if (message === "submission_conflict") return { ok: false, code: "conflict", field: null };
    if (message === "actor_unavailable") return { ok: false, code: "forbidden", field: null };
    console.error("[acat-reimbursement] create_failed");
    return { ok: false, code: "failed", field: null };
  }
  let saved: Awaited<ReturnType<typeof operationsFeeRequestDetail>> = null;
  try {
    saved = await operationsFeeRequestDetail(identity, id);
  } catch {
    console.error("[acat-reimbursement] readback_failed");
  }
  return {
    ok: true,
    request: {
      id,
      status: saved?.status ?? "PENDING",
      clientName: saved?.clientName ?? null,
      accountLabel: saved?.accounts[0]?.label ?? null,
      feeAmount: saved?.feeAmount ?? parsed.feeAmount,
      feeTypes: saved?.feeTypes ?? parsed.feeTypes,
      submittedAt: saved?.submittedAt ?? new Date().toISOString(),
    },
  };
}
