import crypto from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  LEGACY_BILLING_SOURCE, LEGACY_FEE_SOURCE, LEGACY_RECON_SOURCE,
  deterministicLegacyId, legacyResolutionMatchesStored, legacySourceIdentityKey, normalizeLegacyDirectoryName,
  resolveLegacyRequest,
  type LegacyDirectoryAccount, type LegacyDirectoryClient, type LegacyParseIssue,
  type LegacyReconciliationDraft, type LegacyRequestDraft, type LegacyReviewedMapping,
  type LegacySource, type ResolvedLegacyRequest,
} from "./legacy-import";

// Operator-only engine. Never imported by a web route. Cloud identity and exact
// approval validation are mandatory callbacks at the transaction entry points.
export type LegacyImportCounts = Record<LegacySource, number>;
export type LegacyImportInput = {
  requests: LegacyRequestDraft[];
  reviewedMappings: LegacyReviewedMapping[];
  reconciliations: LegacyReconciliationDraft[];
  issues: LegacyParseIssue[];
};
export type LegacyImportPreview = {
  requests: ResolvedLegacyRequest[];
  unresolved: LegacyRequestDraft[];
  reconciliations: LegacyReconciliationDraft[];
  parsed: LegacyImportCounts;
  ready: LegacyImportCounts;
  existing: LegacyImportCounts;
  issues: LegacyParseIssue[];
};

async function inspectLegacyImport(
  tx: Prisma.TransactionClient,
  input: LegacyImportInput,
): Promise<LegacyImportPreview> {
  const { requests, reviewedMappings, reconciliations } = input;
  const directory = await loadLegacyImportDirectory(requests, reviewedMappings, tx);
  const mappingByKey = new Map(reviewedMappings.map((row) => [mappingKey(row.source, row.legacyId), row]));
  const requestKeys = new Set(requests.map((row) => mappingKey(row.source, row.legacyId)));
  const issues = [...input.issues];
  for (const reviewed of reviewedMappings) {
    if (!requestKeys.has(mappingKey(reviewed.source, reviewed.legacyId))) {
      issues.push({ source: reviewed.source, legacyId: reviewed.legacyId, field: "mapping", code: "unused_mapping" });
    }
  }
  const resolved: ResolvedLegacyRequest[] = [];
  const unresolved: LegacyRequestDraft[] = [];
  for (const row of requests) {
    const result = resolveLegacyRequest(row, directory, mappingByKey.get(mappingKey(row.source, row.legacyId)));
    if (result.resolved) resolved.push(result.resolved);
    else {
      unresolved.push(row);
      if (result.issue) issues.push(result.issue);
    }
  }
  const state = await existingLegacyImportState(resolved, reconciliations, tx);
  issues.push(...state.issues);
  return {
    requests: resolved, unresolved, reconciliations, issues,
    parsed: {
      [LEGACY_FEE_SOURCE]: requests.filter((r) => r.source === LEGACY_FEE_SOURCE).length,
      [LEGACY_BILLING_SOURCE]: requests.filter((r) => r.source === LEGACY_BILLING_SOURCE).length,
      [LEGACY_RECON_SOURCE]: reconciliations.length,
    },
    ready: {
      [LEGACY_FEE_SOURCE]: resolved.filter((r) => r.source === LEGACY_FEE_SOURCE).length,
      [LEGACY_BILLING_SOURCE]: resolved.filter((r) => r.source === LEGACY_BILLING_SOURCE).length,
      [LEGACY_RECON_SOURCE]: reconciliations.length,
    },
    existing: state.existing,
  };
}

export async function previewLegacyImport(
  owner: PrismaClient,
  input: LegacyImportInput,
  verifyTarget: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<LegacyImportPreview> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await verifyTarget(tx);
    return inspectLegacyImport(tx, input);
  }, { maxWait: 15_000, timeout: 120_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function applyLegacyImport(
  owner: PrismaClient,
  input: LegacyImportInput,
  verifyTarget: (tx: Prisma.TransactionClient) => Promise<void>,
  verifyApprovedPlan: (preview: LegacyImportPreview) => Promise<void>,
  verifyExecutionBeforeMutation?: () => Promise<void>,
): Promise<{ inserted: LegacyImportCounts; existing: LegacyImportCounts }> {
  return owner.$transaction(async (tx) => {
    await verifyTarget(tx);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'legacy-operations-import-v1'})::bigint)::text AS locked`;
    const preview = await inspectLegacyImport(tx, input);
    if (preview.issues.length) throw new Error("blocking_issues_present");
    await verifyApprovedPlan(preview);
    const notificationsBefore = await tx.operationsSlackNotification.count();
    await insertLegacyImportRows(tx, preview.requests, input.reviewedMappings, input.reconciliations, verifyExecutionBeforeMutation);
    const notificationsAfter = await tx.operationsSlackNotification.count();
    if (notificationsAfter !== notificationsBefore) throw new Error("import_notification_invariant_failed");
    const after = await existingLegacyImportState(preview.requests, input.reconciliations, tx);
    if (after.issues.length || Object.keys(preview.ready).some((key) =>
      after.existing[key as LegacySource] !== preview.ready[key as LegacySource])) {
      throw new Error("import_reconciliation_failed");
    }
    return {
      inserted: {
        [LEGACY_FEE_SOURCE]: after.existing[LEGACY_FEE_SOURCE] - preview.existing[LEGACY_FEE_SOURCE],
        [LEGACY_BILLING_SOURCE]: after.existing[LEGACY_BILLING_SOURCE] - preview.existing[LEGACY_BILLING_SOURCE],
        [LEGACY_RECON_SOURCE]: after.existing[LEGACY_RECON_SOURCE] - preview.existing[LEGACY_RECON_SOURCE],
      },
      existing: preview.existing,
    };
  }, { maxWait: 15_000, timeout: 120_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

type DirectoryRow = {
  sf_id: string;
  canonical_sf_id: string;
  household_sf_id: string | null;
  canonical_household_sf_id: string | null;
  name: string;
  cedar_ridge_user_id: string | null;
  custodian_account_id: string | null;
  apex_account_number: string | null;
};

function mappingKey(source: string, legacyId: string): string {
  return `${source}:${legacyId}`;
}

/** SQL counterpart of legacySourceIdentityKey; identifiers are fixed fragments,
 * never supplied CSV text. Preserve opaque IDs before assigning account owners. */
function sourceIdentitySql(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`upper(CASE WHEN btrim(${value}) ~ '^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$'
    THEN left(btrim(${value}), 15) ELSE btrim(${value}) END)`;
}

export async function loadLegacyImportDirectory(
  requests: LegacyRequestDraft[],
  reviewedMappings: LegacyReviewedMapping[],
  database: Prisma.TransactionClient,
): Promise<{ clients: LegacyDirectoryClient[]; accounts: LegacyDirectoryAccount[] }> {
  const names = [...new Set(requests.map((row) => normalizeLegacyDirectoryName(row.clientName)))];
  const bridgeIds = [...new Set(requests.map((row) => row.bridgeCedarRidgeUserId).filter(Boolean) as string[])];
  const reviewedIds = [...new Set(reviewedMappings.map((row) => row.clientSfId))];
  const reviewedHouseholdIds = [...new Set(reviewedMappings
    .map((row) => row.householdSfId)
    .filter(Boolean) as string[])];
  const sourceAccountNumbers = [...new Set(requests.flatMap((row) => row.sourceAccountNumbers))];
  const reviewedAccountIds = [...new Set(reviewedMappings.flatMap((row) => row.accountIds))];
  if (names.length === 0 && bridgeIds.length === 0 && reviewedIds.length === 0 && reviewedHouseholdIds.length === 0 && sourceAccountNumbers.length === 0 && reviewedAccountIds.length === 0) {
    return { clients: [], accounts: [] };
  }

  const nameCondition = names.length > 0
    ? Prisma.sql`lower(regexp_replace(btrim(normalize(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''), NFKC)), '\\s+', ' ', 'g')) IN (${Prisma.join(names)})`
    : Prisma.sql`FALSE`;
  const bridgeCondition = bridgeIds.length > 0
    ? Prisma.sql`c.cedar_ridge_user_id IN (${Prisma.join(bridgeIds)})`
    : Prisma.sql`FALSE`;
  const reviewedCondition = reviewedIds.length > 0
    ? Prisma.sql`${sourceIdentitySql(Prisma.sql`c.sf_id`)} IN (${Prisma.join(reviewedIds.map(legacySourceIdentityKey))})`
    : Prisma.sql`FALSE`;
  const reviewedHouseholdCondition = reviewedHouseholdIds.length > 0
    ? Prisma.sql`${sourceIdentitySql(Prisma.sql`app.resolve_crm_canonical_household_source_key(c.household_id)`)} IN (${Prisma.join(reviewedHouseholdIds.map(legacySourceIdentityKey))})`
    : Prisma.sql`FALSE`;
  const sourceAccountCondition = sourceAccountNumbers.length > 0
    ? Prisma.sql`(btrim(a.apex_account_number) IN (${Prisma.join(sourceAccountNumbers)}) OR btrim(a.custodian_account_id) IN (${Prisma.join(sourceAccountNumbers)}))`
    : Prisma.sql`FALSE`;
  const reviewedAccountCondition = reviewedAccountIds.length > 0
    ? Prisma.sql`btrim(a.custodian_account_id) IN (${Prisma.join(reviewedAccountIds)})`
    : Prisma.sql`FALSE`;

  const rows = await database.$queryRaw<DirectoryRow[]>(Prisma.sql`
    WITH candidates AS MATERIALIZED (
      SELECT c.sf_id,
             app.resolve_crm_canonical_contact_source_key(c.sf_id) AS canonical_sf_id,
             c.household_id AS household_sf_id,
             app.resolve_crm_canonical_household_source_key(c.household_id) AS canonical_household_sf_id,
             trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name,
             c.cedar_ridge_user_id,
             a.custodian_account_id,
             a.apex_account_number
        FROM mirror.client c
        LEFT JOIN mirror.client_account_aum a
          ON ${sourceIdentitySql(Prisma.sql`a.client_sf_id`)} = ${sourceIdentitySql(Prisma.sql`c.sf_id`)}
       WHERE ${nameCondition} OR ${bridgeCondition} OR ${reviewedCondition} OR ${reviewedHouseholdCondition}
          OR ${sourceAccountCondition} OR ${reviewedAccountCondition}
    )
    SELECT c.sf_id,
           c.canonical_sf_id,
           c.household_sf_id,
           c.canonical_household_sf_id,
           c.name,
           c.cedar_ridge_user_id,
           c.custodian_account_id,
           c.apex_account_number
      FROM candidates c
     ORDER BY c.sf_id, c.custodian_account_id`);

  const clients = new Map<string, LegacyDirectoryClient>();
  const accounts = new Map<string, LegacyDirectoryAccount>();
  for (const row of rows) {
    clients.set(row.sf_id, {
      sfId: row.sf_id,
      canonicalSfId: row.canonical_sf_id,
      householdSfId: row.household_sf_id,
      canonicalHouseholdSfId: row.canonical_household_sf_id,
      name: row.name,
      cedarRidgeUserId: row.cedar_ridge_user_id,
    });
    if (row.custodian_account_id) {
      accounts.set(`${row.sf_id}:${row.custodian_account_id}`, {
        id: row.custodian_account_id,
        clientSfId: row.sf_id,
        apexAccountNumber: row.apex_account_number,
      });
    }
  }
  return { clients: [...clients.values()], accounts: [...accounts.values()] };
}

export async function existingLegacyImportState(
  requests: ResolvedLegacyRequest[],
  reconciliations: LegacyReconciliationDraft[],
  database: Prisma.TransactionClient,
): Promise<{ existing: Record<LegacySource, number>; issues: LegacyParseIssue[] }> {
  const existing: Record<LegacySource, number> = {
    [LEGACY_FEE_SOURCE]: 0,
    [LEGACY_BILLING_SOURCE]: 0,
    [LEGACY_RECON_SOURCE]: 0,
  };
  const issues: LegacyParseIssue[] = [];
  for (const row of requests) {
    const found = await database.operationsFeeRequest.findFirst({
      where: { legacy_source: row.source, legacy_source_id: row.legacyId },
      select: {
        legacy_source_digest: true,
        scope: true,
        client_sf_id: true,
        legacy_household_sf_id: true,
        legacy_client_name: true,
        account_ids: true,
      },
    });
    if (!found) continue;
    existing[row.source] += 1;
    if (found.legacy_source_digest !== row.sourceDigest) {
      issues.push({ source: row.source, legacyId: row.legacyId, field: "source_digest", code: "existing_record_drift" });
    } else if (!legacyResolutionMatchesStored(row, {
      scope: found.scope,
      clientSfId: found.client_sf_id,
      householdSfId: found.legacy_household_sf_id,
      legacyClientName: found.legacy_client_name,
      accountIds: found.account_ids,
    })) {
      issues.push({ source: row.source, legacyId: row.legacyId, field: "mapping", code: "existing_mapping_drift" });
    }
  }
  for (const row of reconciliations) {
    const found = await database.tradeReconciliationRun.findFirst({
      where: { legacy_source: row.source, legacy_source_id: row.legacyId },
      select: { source_digest: true },
    });
    if (!found) continue;
    existing[row.source] += 1;
    if (found.source_digest !== row.sourceDigest) {
      issues.push({ source: row.source, legacyId: row.legacyId, field: "source_digest", code: "existing_record_drift" });
    }
  }
  return { existing, issues };
}


async function insertLegacyImportRows(
  tx: Prisma.TransactionClient,
  requests: ResolvedLegacyRequest[],
  reviewedMappings: LegacyReviewedMapping[],
  reconciliations: LegacyReconciliationDraft[],
  verifyExecutionBeforeMutation?: () => Promise<void>,
): Promise<void> {
    const currentDirectory = await loadLegacyImportDirectory(requests, reviewedMappings, tx);
    const reviewedByKey = new Map(reviewedMappings.map((mapping) => [
      mappingKey(mapping.source, mapping.legacyId),
      mapping,
    ]));
    const revalidated = requests.map((request) => {
      const result = resolveLegacyRequest(
        request,
        currentDirectory,
        reviewedByKey.get(mappingKey(request.source, request.legacyId)),
      );
      if (result.issue || !result.resolved) {
        console.error(result.issue
          ? `apply_revalidation_issue=${result.issue.source}:${result.issue.legacyId}:${result.issue.field}:${result.issue.code}`
          : `apply_revalidation_issue=${request.source}:${request.legacyId}:mapping:unresolved`);
        throw new Error("apply_revalidation_failed");
      }
      if (!legacyResolutionMatchesStored(request, {
        scope: result.resolved.scope,
        clientSfId: result.resolved.clientSfId,
        householdSfId: result.resolved.householdSfId,
        legacyClientName: result.resolved.clientName,
        accountIds: result.resolved.accountIds,
      })) {
        console.error(`apply_resolution_changed=${request.source}:${request.legacyId}`);
        throw new Error("apply_resolution_changed");
      }
      return result.resolved;
    });
    // A cloud approval can expire or be revoked while waiting for the lock or
    // resolving mappings. Check after those reads and before the first insert.
    await verifyExecutionBeforeMutation?.();
    for (const row of revalidated) {
      const existing = await tx.operationsFeeRequest.findFirst({
        where: { legacy_source: row.source, legacy_source_id: row.legacyId },
        select: {
          legacy_source_digest: true,
          scope: true,
          client_sf_id: true,
          legacy_household_sf_id: true,
          legacy_client_name: true,
          account_ids: true,
        },
      });
      if (existing) {
        if (existing.legacy_source_digest !== row.sourceDigest) throw new Error("existing_record_drift");
        if (!legacyResolutionMatchesStored(row, {
          scope: existing.scope,
          clientSfId: existing.client_sf_id,
          householdSfId: existing.legacy_household_sf_id,
          legacyClientName: existing.legacy_client_name,
          accountIds: existing.account_ids,
        })) throw new Error("existing_mapping_drift");
        continue;
      }
      const id = deterministicLegacyId(row.source, row.legacyId);
      await tx.operationsFeeRequest.create({
        data: {
          id,
          kind: row.kind,
          status: row.status,
          scope: row.scope,
          client_sf_id: row.clientSfId,
          legacy_household_sf_id: row.householdSfId,
          legacy_client_name: row.clientName,
          account_ids: row.accountIds,
          fee_types: row.feeTypes,
          fee_amount: row.feeAmount,
          waiver_start: row.waiverStart ? new Date(`${row.waiverStart}T00:00:00.000Z`) : null,
          waiver_duration_months: row.waiverDurationMonths,
          indefinite_duration: row.indefiniteDuration,
          reason: row.reason,
          relevant_ticket_refs: row.relevantTicketRefs,
          submitted_by_email: null,
          submitted_by_name: row.submittedByName,
          submitted_by_role: row.submittedByRole,
          submitted_at: new Date(row.submittedAt),
          reviewed_by_email: null,
          reviewed_by_name: row.reviewedByName,
          reviewed_at: row.reviewedAt ? new Date(row.reviewedAt) : null,
          credited_at: row.creditedAt ? new Date(`${row.creditedAt}T00:00:00.000Z`) : null,
          apex_request_id: row.apexRequestId,
          legacy_apex_request_text: row.legacyApexRequestText,
          completed_by_email: null,
          completed_by_name: null,
          completed_at: row.completedAt ? new Date(row.completedAt) : null,
          legacy_source: row.source,
          legacy_source_id: row.legacyId,
          legacy_source_digest: row.sourceDigest,
          created_at: new Date(row.createdAt),
          updated_at: new Date(row.reviewedAt ?? row.completedAt ?? row.submittedAt),
        },
      });
      // The legacy owner has INSERT-only access to these immutable events.
      // createMany avoids RETURNING, which would also require SELECT under RLS.
      await tx.operationsFeeRequestEvent.createMany({
        data: {
          request_id: id,
          action: "LEGACY_IMPORTED",
          actor_email: null,
          actor_name: row.submittedByName ?? "Legacy Fee Store import",
          actor_role: row.submittedByRole,
          from_status: null,
          to_status: row.status,
          detail: { source: row.source, legacyId: row.legacyId },
          at: new Date(row.reviewedAt ?? row.completedAt ?? row.submittedAt),
        },
      });
    }

    for (const row of reconciliations) {
      const existing = await tx.tradeReconciliationRun.findFirst({
        where: { legacy_source: row.source, legacy_source_id: row.legacyId },
        select: { source_digest: true },
      });
      if (existing) {
        if (existing.source_digest !== row.sourceDigest) throw new Error("existing_record_drift");
        continue;
      }
      const id = deterministicLegacyId(row.source, row.legacyId);
      await tx.tradeReconciliationRun.create({
        data: {
          id,
          run_date: new Date(`${row.runDate}T00:00:00.000Z`),
          business_date: new Date(`${row.tradeDate}T00:00:00.000Z`),
          algorithm_version: "legacy-summary-v1",
          source_scope_version: "legacy-run-summary-v1",
          source_digest: row.sourceDigest,
          source_commit_sha: "legacy-import",
          apex_record_count: row.apexRecordCount,
          meridian_record_count: row.meridianRecordCount,
          raw_match_count: row.rawMatchCount,
          exception_count: row.exceptionCount,
          raw_match_rate: row.rawMatchRate,
          payload: [],
          completed_by: null,
          completed_at: new Date(row.completedAt),
          legacy_source: row.source,
          legacy_source_id: row.legacyId,
          legacy_unmatched_apex: row.unmatchedApex,
          legacy_unmatched_alpha: row.unmatchedMeridian,
          legacy_match_rate: row.legacyMatchRate,
        },
      });
      if (row.runNote) {
        await tx.tradeReconciliationNoteEvent.createMany({
          data: {
            id: `legacy_note_${crypto.createHash("sha256").update(`${row.source}:${row.legacyId}`).digest("hex").slice(0, 24)}`,
            run_id: id,
            note: row.runNote,
            author_email: null,
            created_at: new Date(row.completedAt),
          },
        });
      }
    }

}
