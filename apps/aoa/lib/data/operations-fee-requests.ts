import "server-only";

import { randomUUID } from "node:crypto";

import {
  Prisma,
  type OperationsFeeRequestKind,
  type OperationsFeeRequestScope,
  type OperationsFeeRequestStatus,
} from "@prisma/client";
import { normalizeAppRole } from "@/lib/auth/app-roles";
import {
  OPERATIONS_FEE_REQUEST_CREATE,
  OPERATIONS_FEE_REQUEST_TRANSITION,
  writeAudit,
} from "@/lib/audit";
import { crmIdentityReadsEnabled } from "@/lib/flags";
import type {
  ParsedFeeRequestWorkflowAction,
  ParsedOperationsFeeRequest,
} from "@/lib/operations/fee-request";
import { withUserScope, type Identity } from "@/lib/rls";
import { feeSubmissionDigest, parseFeeSubmissionKey } from "@/lib/operations/fee-submission";
import { captureOperationsSlackNotification } from "./operations-slack-capture";
import type { FeeRequestQuery } from "@/lib/operations/fee-request-query";
import { selectFeeRequestDirectory, type FeeRequestDirectoryMeta } from "./operations-fee-request-directory";

export type OperationsFeeAccountOption = {
  id: string;
  label: string;
  status: string | null;
};

export type OperationsFeeClientOption = {
  clientSfId: string;
  name: string;
  householdName: string | null;
  accounts: OperationsFeeAccountOption[];
};

export type OperationsFeeRequestListRow = {
  id: string;
  kind: OperationsFeeRequestKind;
  status: OperationsFeeRequestStatus;
  scope: OperationsFeeRequestScope;
  clientName: string;
  canonicalClientName: string | null;
  householdName: string | null;
  accounts: Array<{ id: string; label: string; ownerName: string | null }>;
  feeTypes: string[];
  feeAmount: string | null;
  waiverStart: string | null;
  waiverDurationMonths: number | null;
  indefiniteDuration: boolean;
  submittedBy: string;
  submittedAt: string;
  reason: string;
  relevantTicketRefs: string[];
  reviewedBy: string | null;
  reviewedAt: string | null;
  creditedAt: string | null;
  apexRequestId: string | null;
  legacyApexContext: string | null;
  completedBy: string | null;
  completedAt: string | null;
  legacySource: string | null;
  legacySourceId: string | null;
  events: OperationsFeeRequestEventRow[];
};

export type OperationsFeeRequestEventRow = {
  id: string;
  action: string;
  actorDisplay: string;
  fromStatus: OperationsFeeRequestStatus | null;
  toStatus: OperationsFeeRequestStatus | null;
  note: string | null;
  at: string;
};

export type OperationsFeeRequestPageData = {
  requests: OperationsFeeRequestListRow[];
  counts: { pending: number; approved: number; credited: number; closed: number; total: number };
  directory?: FeeRequestDirectoryMeta;
};

export type OperationsFeeRequestDirectory = FeeRequestDirectoryMeta & { rows: OperationsFeeRequestListRow[] };

export async function operationsFeeRequestDirectory(identity: Identity, query: FeeRequestQuery): Promise<OperationsFeeRequestDirectory> {
  const data = await operationsFeeRequestPageData(identity, undefined, query);
  if (!data.directory) throw new Error("fee_request_directory_unavailable");
  return { ...data.directory, rows: data.requests };
}

export async function operationsFeeRequestDetail(identity: Identity, requestId: string): Promise<OperationsFeeRequestListRow | null> {
  const data = await operationsFeeRequestPageData(identity, requestId, undefined, true);
  return data.requests[0] ?? null;
}

type StoredFeeRequest = Prisma.OperationsFeeRequestGetPayload<{ include: { events: true } }>;
type FeeRequestClientLabel = { sf_id: string; name: string; household_name: string | null };
type FeeRequestHouseholdLabel = { sf_id: string; name: string };

async function loadFeeRequestReferenceLabels(tx: Prisma.TransactionClient, requests: ReadonlyArray<Pick<StoredFeeRequest, "account_ids" | "client_sf_id" | "legacy_household_sf_id">>): Promise<{
  requestClients: FeeRequestClientLabel[];
  requestHouseholds: FeeRequestHouseholdLabel[];
  requestAccounts: RawAccountOption[];
}> {
  const accountIds = [...new Set(requests.flatMap((request) => request.account_ids))];
  const requestAccounts = accountIds.length === 0 ? [] : await tx.$queryRaw<RawAccountOption[]>(Prisma.sql`
    SELECT custodian_account_id, apex_account_number, account_type,
           account_status, client_sf_id
      FROM mirror.client_account_aum
     WHERE custodian_account_id IN (${Prisma.join(accountIds)})`);
  const clientKeys = [...new Set([
    ...requests.map((request) => key(request.client_sf_id)),
    ...requestAccounts.map((account) => key(account.client_sf_id)),
  ])];
  const householdKeys = [...new Set(requests
    .map((request) => request.legacy_household_sf_id)
    .filter(Boolean)
    .map((value) => key(value!)))];
  const requestClients = clientKeys.length === 0 ? [] : await tx.$queryRaw<FeeRequestClientLabel[]>(Prisma.sql`
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
     END IN (${Prisma.join(clientKeys)})`);
  const requestHouseholds = householdKeys.length === 0 ? [] : await tx.$queryRaw<FeeRequestHouseholdLabel[]>(Prisma.sql`
    SELECT h.sf_id, h.name
      FROM mirror.household h
     WHERE CASE
       WHEN h.sf_id ~ '^[A-Za-z0-9]{15,18}$' THEN upper(left(h.sf_id, 15))
       ELSE upper(h.sf_id)
     END IN (${Prisma.join(householdKeys)})`);
  return { requestClients, requestHouseholds, requestAccounts };
}

function toFeeRequestListRows(
  requests: readonly StoredFeeRequest[],
  requestClients: readonly FeeRequestClientLabel[],
  requestHouseholds: readonly FeeRequestHouseholdLabel[],
  requestAccounts: readonly RawAccountOption[],
): OperationsFeeRequestListRow[] {
  const clientsById = new Map(requestClients.map((client) => [key(client.sf_id), client]));
  const householdsById = new Map(requestHouseholds.map((household) => [key(household.sf_id), household]));
  const accountsById = new Map(requestAccounts.map((account) => [account.custodian_account_id, account]));
  return requests.map((request) => {
    const client = clientsById.get(key(request.client_sf_id));
    const events: OperationsFeeRequestEventRow[] = request.events.map((event) => {
      const detail = event.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
        ? event.detail as Record<string, unknown>
        : {};
      return {
        id: event.id.toString(),
        action: event.action,
        actorDisplay: event.actor_name ?? event.actor_email ?? "Legacy record",
        fromStatus: event.from_status,
        toStatus: event.to_status,
        note: typeof detail.note === "string" && detail.note.trim() ? detail.note : null,
        at: event.at.toISOString(),
      };
    });
    return {
      id: request.id,
      kind: request.kind,
      status: request.status,
      scope: request.scope,
      clientName: request.legacy_client_name ?? client?.name ?? "Client unavailable",
      canonicalClientName: request.legacy_client_name ? client?.name ?? null : null,
      householdName: request.legacy_household_sf_id
        ? householdsById.get(key(request.legacy_household_sf_id))?.name ?? "Household unavailable"
        : client?.household_name ?? null,
      accounts: request.account_ids.map((id) => {
        const account = accountsById.get(id);
        return {
          id,
          label: account ? maskedAccountLabel(account) : "Account unavailable",
          ownerName: account ? clientsById.get(key(account.client_sf_id))?.name ?? "Owner unavailable" : null,
        };
      }),
      feeTypes: request.fee_types,
      feeAmount: request.fee_amount?.toFixed(2) ?? null,
      waiverStart: request.waiver_start?.toISOString().slice(0, 7) ?? null,
      waiverDurationMonths: request.waiver_duration_months,
      indefiniteDuration: request.indefinite_duration,
      submittedBy: request.submitted_by_name ?? request.submitted_by_email ?? "Legacy Fee Store record",
      submittedAt: request.submitted_at.toISOString(),
      reason: request.reason,
      relevantTicketRefs: request.relevant_ticket_refs,
      reviewedBy: request.reviewed_by_name ?? request.reviewed_by_email,
      reviewedAt: request.reviewed_at?.toISOString() ?? null,
      creditedAt: request.credited_at?.toISOString().slice(0, 10) ?? null,
      apexRequestId: request.apex_request_id,
      legacyApexContext: request.legacy_apex_request_text !== request.apex_request_id
        ? request.legacy_apex_request_text
        : null,
      completedBy: request.completed_by_name ?? request.completed_by_email,
      completedAt: request.completed_at?.toISOString() ?? null,
      legacySource: request.legacy_source ?? null,
      legacySourceId: request.legacy_source_id ?? null,
      events,
    };
  });
}

/** Every authorized request in one work area. List filters and paging do not apply. */
export async function operationsFeeRequestExportRows(
  identity: Identity,
  area: "credits" | "exceptions",
): Promise<OperationsFeeRequestListRow[]> {
  return withUserScope(identity, async (tx) => {
    const requests = await tx.operationsFeeRequest.findMany({
      where: area === "credits" ? { kind: "FEE_CREDIT" } : { kind: { not: "FEE_CREDIT" } },
      orderBy: [{ submitted_at: "desc" }, { id: "asc" }],
      include: { events: { orderBy: [{ at: "asc" }, { id: "asc" }] } },
    });
    const labels = await loadFeeRequestReferenceLabels(tx, requests);
    return toFeeRequestListRows(requests, labels.requestClients, labels.requestHouseholds, labels.requestAccounts);
  }, { maxWait: 10_000, timeout: 15_000 });
}

export type RawAccountOption = {
  custodian_account_id: string;
  apex_account_number: string | null;
  account_type: string | null;
  account_status: string | null;
  client_sf_id: string;
};

/** Salesforce ids compare on their first 15 characters; anything else compares upper-cased. */
export function key(value: string): string {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{15,18}$/.test(normalized)
    ? normalized.slice(0, 15)
    : normalized;
}

export function maskedAccountLabel(row: RawAccountOption): string {
  const source = row.apex_account_number?.trim() || row.custodian_account_id;
  const suffix = source.slice(-4).padStart(4, "•");
  const type = row.account_type?.trim() || "Account";
  return `${type} · ••••${suffix}`;
}

type RawClientSearchRow = RawAccountOption & {
  sf_id: string;
  name: string;
  household_name: string | null;
};

function buildClientOptions(rows: RawClientSearchRow[]): OperationsFeeClientOption[] {
  const accountsByClient = new Map<string, OperationsFeeAccountOption[]>();
  const clients = new Map<string, OperationsFeeClientOption>();
  for (const account of rows) {
    const clientKey = key(account.client_sf_id);
    if (account.custodian_account_id) {
      const values = accountsByClient.get(clientKey) ?? [];
      values.push({
        id: account.custodian_account_id,
        label: maskedAccountLabel(account),
        status: account.account_status,
      });
      accountsByClient.set(clientKey, values);
    }
    if (!clients.has(clientKey)) {
      clients.set(clientKey, {
        clientSfId: account.sf_id,
        name: account.name,
        householdName: account.household_name,
        accounts: [],
      });
    }
  }
  return [...clients.values()].map((client) => ({
    ...client,
    accounts: accountsByClient.get(key(client.clientSfId)) ?? [],
  }));
}

/**
 * Bounded, on-demand client search for fee-request intake.
 *
 * The previous page load serialized every visible client plus as many as 10,000
 * account rows before React could paint. Searching only after the operator types
 * keeps the initial route small while retaining the same transaction-scoped RLS
 * and canonical-contact suppression.
 */
export async function searchOperationsFeeClientOptions(
  identity: Identity,
  rawQuery: string,
): Promise<OperationsFeeClientOption[]> {
  const query = rawQuery.trim().slice(0, 80);
  if (query.length < 2) return [];
  const pattern = `%${query}%`;
  const canonicalReads = crmIdentityReadsEnabled();
  return withUserScope(identity, async (tx) => {
    const rows = await tx.$queryRaw<RawClientSearchRow[]>`
      WITH matching_client_name AS MATERIALIZED (
        SELECT c.sf_id,
               c.household_id,
               trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name
         FROM mirror.client c
         WHERE (c.household_id IS NULL OR left(c.sf_id, 15) <> left(c.household_id, 15))
           AND trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) ILIKE ${pattern}
         ORDER BY name, c.sf_id
         LIMIT 40
      ), matching_household AS MATERIALIZED (
        SELECT household.sf_id
          FROM mirror.household household
         WHERE household.name ILIKE ${pattern}
         ORDER BY household.name, household.sf_id
         LIMIT 40
      ), matching_client_household AS MATERIALIZED (
        SELECT c.sf_id,
               c.household_id,
               trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name
          FROM matching_household household
          JOIN mirror.client c
            ON c.household_id = household.sf_id
            OR (
              c.household_id ~ '^[A-Za-z0-9]{15,18}$'
              AND household.sf_id ~ '^[A-Za-z0-9]{15,18}$'
              AND left(c.household_id, 15) = left(household.sf_id, 15)
            )
         WHERE c.household_id IS NULL OR left(c.sf_id, 15) <> left(c.household_id, 15)
         ORDER BY name, c.sf_id
         LIMIT 40
      ), matching_client AS MATERIALIZED (
        SELECT candidate.sf_id, candidate.household_id, candidate.name
          FROM (
            SELECT * FROM matching_client_name
            UNION
            SELECT * FROM matching_client_household
          ) candidate
         ORDER BY candidate.name, candidate.sf_id
         LIMIT 40
      ), canonical_contact_overlay AS MATERIALIZED (
        SELECT overlay.source_key, overlay.canonical_source_key
          FROM app.resolve_crm_canonical_contact_overlays(
            CASE WHEN ${canonicalReads}
              THEN ARRAY(SELECT sf_id FROM matching_client)
              ELSE ARRAY[]::text[]
            END
          ) overlay
      ), visible_client AS MATERIALIZED (
        SELECT candidate.*
          FROM matching_client candidate
          LEFT JOIN canonical_contact_overlay contact_overlay
            ON contact_overlay.source_key = candidate.sf_id
            OR (
              contact_overlay.source_key ~ '^[A-Za-z0-9]{15,18}$'
              AND candidate.sf_id ~ '^[A-Za-z0-9]{15,18}$'
              AND left(contact_overlay.source_key, 15) = left(candidate.sf_id, 15)
            )
         WHERE contact_overlay.source_key IS NULL
         ORDER BY candidate.name, candidate.sf_id
         LIMIT 20
      ), canonical_household_overlay AS MATERIALIZED (
        SELECT overlay.source_key, overlay.canonical_source_key
          FROM app.resolve_crm_canonical_household_overlays(
            CASE WHEN ${canonicalReads}
              THEN ARRAY(
                SELECT DISTINCT household_id
                  FROM visible_client
                 WHERE household_id IS NOT NULL
              )
              ELSE ARRAY[]::text[]
            END
          ) overlay
      )
      SELECT client.sf_id,
             client.sf_id AS client_sf_id,
             client.name,
             household.name AS household_name,
             account.custodian_account_id,
             account.apex_account_number,
             account.account_type,
             account.account_status
        FROM visible_client client
        LEFT JOIN canonical_household_overlay household_overlay
          ON household_overlay.source_key = client.household_id
        LEFT JOIN mirror.household household
          ON household.sf_id = COALESCE(household_overlay.canonical_source_key, client.household_id)
          OR (
            household.sf_id ~ '^[A-Za-z0-9]{15,18}$'
            AND COALESCE(household_overlay.canonical_source_key, client.household_id) ~ '^[A-Za-z0-9]{15,18}$'
            AND left(household.sf_id, 15) = left(
              COALESCE(household_overlay.canonical_source_key, client.household_id),
              15
            )
          )
        LEFT JOIN mirror.client_account_aum account
          ON (
            account.client_sf_id = client.sf_id
            OR (
              account.client_sf_id ~ '^[A-Za-z0-9]{15,18}$'
              AND client.sf_id ~ '^[A-Za-z0-9]{15,18}$'
              AND left(account.client_sf_id, 15) = left(client.sf_id, 15)
            )
          )
         AND account.source_present
       ORDER BY client.name, client.sf_id,
                account.account_type NULLS LAST,
                account.apex_account_number NULLS LAST`;
    return buildClientOptions(rows);
  }, { maxWait: 10_000, timeout: 15_000 });
}

export async function operationsFeeRequestPageData(
  identity: Identity,
  selectedRequestId?: string,
  directoryQuery?: FeeRequestQuery,
  detailOnly = false,
): Promise<OperationsFeeRequestPageData> {
  if (selectedRequestId !== undefined && (
    typeof selectedRequestId !== "string"
    || selectedRequestId.length < 16
    || selectedRequestId.length > 64
    || /[^A-Za-z0-9_-]/.test(selectedRequestId)
  )) throw new Error("invalid_operations_request_id");
  // Keep initial navigation bounded: request history only needs labels for the
  // latest 100 rows plus at most one explicitly linked request. Intake choices
  // are searched on demand instead of loading the entire firm before first paint.
  const { requestClients, requestHouseholds, requestAccounts, requests, statusCounts, directory } = await withUserScope(
    identity,
    async (tx) => {
      const selection = directoryQuery ? await selectFeeRequestDirectory(tx, directoryQuery) : null;
      const requests = selection ? selection.requests : detailOnly ? [] : await tx.operationsFeeRequest.findMany({
        orderBy: { submitted_at: "desc" },
        take: 100,
        include: { events: { orderBy: { at: "asc" } } },
      });
      // Never widen the history query to find an older notification link. The
      // exact lookup stays inside the same authenticated transaction/RLS scope.
      if (selectedRequestId) {
        const recentIndex = requests.findIndex((request) => request.id === selectedRequestId);
        const selected = recentIndex >= 0
          ? requests.splice(recentIndex, 1)[0]
          : await tx.operationsFeeRequest.findUnique({
            where: { id: selectedRequestId },
            include: { events: { orderBy: { at: "asc" } } },
          });
        if (selected) requests.unshift(selected);
      }
      const statusCounts = selection || detailOnly ? [] : await tx.operationsFeeRequest.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      const labels = await loadFeeRequestReferenceLabels(tx, requests);
      return { ...labels, requests, statusCounts, directory: selection?.meta };
    },
    { maxWait: 10_000, timeout: 15_000 },
  );
  const rows = toFeeRequestListRows(requests, requestClients, requestHouseholds, requestAccounts);
  return {
    requests: rows,
    ...(directory ? { directory } : {}),
    counts: directory?.counts ?? {
      pending: statusCounts.find((row) => row.status === "PENDING")?._count._all ?? 0,
      approved: statusCounts.find((row) => row.status === "APPROVED")?._count._all ?? 0,
      credited: statusCounts.find((row) => row.status === "CREDITED")?._count._all ?? 0,
      closed: statusCounts
        .filter((row) => row.status === "REJECTED" || row.status === "CANCELLED")
        .reduce((total, row) => total + row._count._all, 0),
      total: statusCounts.reduce((total, row) => total + row._count._all, 0),
    },
  };
}

function transitionFor(
  request: { kind: OperationsFeeRequestKind; status: OperationsFeeRequestStatus },
  action: ParsedFeeRequestWorkflowAction["action"],
): OperationsFeeRequestStatus | null {
  if (request.status === "PENDING" && action === "APPROVE") return "APPROVED";
  if (request.status === "PENDING" && action === "REJECT") return "REJECTED";
  if ((request.status === "PENDING" || request.status === "APPROVED") && action === "CANCEL") return "CANCELLED";
  if (request.status === "APPROVED" && request.kind === "FEE_CREDIT" && action === "CREDIT") return "CREDITED";
  return null;
}

function eventAction(action: ParsedFeeRequestWorkflowAction["action"]): string {
  if (action === "APPROVE") return "APPROVED";
  if (action === "REJECT") return "REJECTED";
  if (action === "CREDIT") return "CREDITED";
  return "CANCELLED";
}

export type FeeRequestWorkflowResult = "updated" | "conflict" | "invalid";

export async function transitionOperationsFeeRequest(
  identity: Identity,
  input: ParsedFeeRequestWorkflowAction,
): Promise<FeeRequestWorkflowResult> {
  const role = normalizeAppRole(identity.role);
  const email = identity.email?.trim().toLowerCase();
  if (!email || (role !== "ADMIN" && role !== "OPERATIONS")) return "invalid";

  return withUserScope({ role, email }, async (tx) => {
    const current = await tx.operationsFeeRequest.findUnique({
      where: { id: input.requestId },
      select: { id: true, kind: true, status: true },
    });
    if (!current) return "invalid";
    const nextStatus = transitionFor(current, input.action);
    if (!nextStatus) return "invalid";

    const now = new Date();
    const update = await tx.operationsFeeRequest.updateMany({
      where: { id: current.id, status: current.status },
      data: current.status === "PENDING"
        ? {
            status: nextStatus,
            reviewed_by_email: email,
            reviewed_at: now,
          }
        : input.action === "CREDIT"
          ? {
              status: nextStatus,
              credited_at: new Date(`${input.creditedDate}T00:00:00.000Z`),
              apex_request_id: input.apexRequestId,
              completed_by_email: email,
              completed_at: now,
            }
          : { status: nextStatus },
    });
    if (update.count !== 1) return "conflict";

    const action = eventAction(input.action);
    const eventDetail: Prisma.InputJsonObject = input.note ? { note: input.note } : {};
    await tx.operationsFeeRequestEvent.create({
      data: {
        request_id: current.id,
        action,
        actor_email: email,
        actor_role: role,
        from_status: current.status,
        to_status: nextStatus,
        detail: eventDetail,
      },
    });
    await writeAudit(tx, { role, email }, {
      action: OPERATIONS_FEE_REQUEST_TRANSITION,
      entityType: "operations_fee_request",
      entityId: current.id,
      detail: {
        action,
        fromStatus: current.status,
        toStatus: nextStatus,
        notePresent: Boolean(input.note),
        creditedDatePresent: Boolean(input.creditedDate),
        apexRequestPresent: Boolean(input.apexRequestId),
      },
    });
    return "updated";
  });
}

export async function createOperationsFeeRequest(
  identity: Identity,
  input: ParsedOperationsFeeRequest,
  submissionKey: string = randomUUID(),
): Promise<string> {
  const role = normalizeAppRole(identity.role);
  const email = identity.email?.trim().toLowerCase();
  if (!email || (role !== "ADMIN" && role !== "OPERATIONS")) throw new Error("actor_unavailable");
  const stableKey = parseFeeSubmissionKey(submissionKey);
  const digest = feeSubmissionDigest(input);
  return withUserScope({ role, email }, async (tx) => {
    // Serialize only identical actor/key pairs. A unique constraint remains the
    // final guard; no transaction or Slack network call is blindly retried.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${email}:${stableKey}`}, 0))`;
    const previous = await tx.operationsFeeRequest.findUnique({
      where: { submitted_by_email_submission_key: { submitted_by_email: email, submission_key: stableKey } },
      select: { id: true, submission_digest: true },
    });
    if (previous) {
      if (previous.submission_digest !== digest) throw new Error("submission_conflict");
      return previous.id;
    }
    const clientKey = key(input.clientSfId);
    const clients = await tx.$queryRaw<Array<{ sf_id: string }>>`
      SELECT sf_id
        FROM mirror.client
       WHERE CASE
         WHEN sf_id ~ '^[A-Za-z0-9]{15,18}$' THEN upper(left(sf_id, 15))
         ELSE upper(sf_id)
       END = ${clientKey}
         AND (household_id IS NULL OR left(sf_id, 15) <> left(household_id, 15))
       LIMIT 1`;
    const clientSfId = clients[0]?.sf_id;
    if (!clientSfId) throw new Error("client_unavailable");

    const accountRows = await tx.$queryRaw<Array<{ custodian_account_id: string }>>(Prisma.sql`
      SELECT custodian_account_id
        FROM mirror.client_account_aum
       WHERE CASE
         WHEN client_sf_id ~ '^[A-Za-z0-9]{15,18}$' THEN upper(left(client_sf_id, 15))
         ELSE upper(client_sf_id)
       END = ${key(clientSfId)}
         AND source_present
         AND custodian_account_id IN (${Prisma.join(input.accountIds)})`);
    const authorizedAccountIds = new Set(accountRows.map((row) => row.custodian_account_id));
    if (authorizedAccountIds.size !== input.accountIds.length) throw new Error("account_unavailable");

    const request = await tx.operationsFeeRequest.create({
      data: {
        kind: input.kind,
        status: "PENDING",
        client_sf_id: clientSfId,
        account_ids: input.accountIds,
        fee_types: input.feeTypes,
        fee_amount: input.feeAmount,
        waiver_start: input.waiverStart ? new Date(`${input.waiverStart}T00:00:00.000Z`) : null,
        waiver_duration_months: input.waiverDurationMonths,
        indefinite_duration: input.indefiniteDuration,
        reason: input.reason,
        relevant_ticket_refs: input.relevantTicketRefs,
        submitted_by_email: email,
        submitted_by_role: role,
        submission_key: stableKey,
        submission_digest: digest,
      },
    });
    const detail = {
      kind: input.kind,
      accountCount: input.accountIds.length,
      feeTypeCount: input.feeTypes.length,
      amountPresent: input.feeAmount !== null,
      ticketReferenceCount: input.relevantTicketRefs.length,
      indefiniteDuration: input.indefiniteDuration,
    };
    const submittedEvent = await tx.operationsFeeRequestEvent.create({
      data: {
        request_id: request.id,
        action: "SUBMITTED",
        actor_email: email,
        actor_role: role,
        from_status: null,
        to_status: "PENDING",
        detail,
      },
    });
    await captureOperationsSlackNotification(tx, request.id, submittedEvent.id);
    await writeAudit(tx, { role, email }, {
      action: OPERATIONS_FEE_REQUEST_CREATE,
      entityType: "operations_fee_request",
      entityId: request.id,
      detail,
    });
    return request.id;
  });
}
