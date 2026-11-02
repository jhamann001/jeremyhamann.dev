import "server-only";

import { Prisma } from "@prisma/client";
import { crmReconcilerClient } from "@/lib/crm/reconciler-db";
import { crmDuplicateDetectorWritesEnabled } from "@/lib/flags";

type CrmReconciliationBaseCounts = {
  sourcesSeen: number;
  identitiesCreated: number;
  mappingsCreated: number;
  mappingsRefreshed: number;
  exceptionsOpened: number;
  exceptionsReopened: number;
  exceptionsResolved: number;
  duplicateSignalsSeen: number;
};

export type CrmReconciliationCounts = CrmReconciliationBaseCounts & (
  | {
      duplicateMode: "preview";
      duplicateCandidatesWouldOpen: number;
      duplicateCandidatesWouldRefresh: number;
      duplicateCandidatesWouldInactivate: number;
    }
  | {
      duplicateMode: "persisted";
      duplicateCandidatesOpened: number;
      duplicateCandidatesRefreshed: number;
      duplicateCandidatesInactivated: number;
    }
);

type RawCounts = {
  sources_seen: bigint;
  identities_created: bigint;
  mappings_created: bigint;
  mappings_refreshed: bigint;
  exceptions_opened: bigint;
  exceptions_reopened: bigint;
  exceptions_resolved: bigint;
};

type RawParentCounts = {
  sources_seen: bigint;
  identities_created: bigint;
  mappings_created: bigint;
  mappings_refreshed: bigint;
};

type RawDuplicateCounts = {
  signals_seen: bigint;
  candidates_opened: bigint;
  candidates_refreshed: bigint;
  candidates_inactivated: bigint;
};

const EMPTY_DUPLICATE_COUNTS: RawDuplicateCounts = {
  signals_seen: 0n,
  candidates_opened: 0n,
  candidates_refreshed: 0n,
  candidates_inactivated: 0n,
};

type RawCombinedPreviewCounts = RawCounts & {
  duplicate_signals_seen: bigint;
  duplicate_candidates_would_open: bigint;
  duplicate_candidates_would_refresh: bigint;
  duplicate_candidates_would_inactivate: bigint;
};

// Canonical dev's first full reconciliation preview can scan the complete
// approved source snapshot. Keep the transaction bounded below Cloud Run's
// five-minute request ceiling while leaving a full minute for startup and the
// HTTP response path.
export const CRM_RECONCILIATION_TIMEOUT_MS = 240_000;
export const CRM_RECONCILIATION_STATEMENT_HEADROOM_MS = 30_000;
export const CRM_RECONCILIATION_LOCK_TIMEOUT_MS = 5_000;
export const CRM_RECONCILIATION_BUSY_ERROR = "crm_reconciliation_already_running";

export async function runCrmIdentityReconciliation(
  runId: string,
  dryRun: boolean,
  transactionTimeoutMs = CRM_RECONCILIATION_TIMEOUT_MS,
): Promise<CrmReconciliationCounts> {
  const client = crmReconcilerClient();
  const result = await client.$transaction(
    async (tx) => {
      // Scheduled, post-commit, and manual callers can arrive together. The
      // SQL functions retain their transaction-scoped advisory lock as the
      // final serialization guard, but this non-blocking probe prevents a
      // second HTTP request from waiting behind a full sweep until Cloud Run
      // returns 504. The lock is re-entrant within this transaction.
      const [guard] = await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended('app.crm.identity.reconcile.v1', 0)
        ) AS acquired
      `);
      if (!guard?.acquired) throw new Error(CRM_RECONCILIATION_BUSY_ERROR);

      // Prisma's interactive transaction timeout cannot cancel a PostgreSQL
      // statement that is still running. Give the database its own, shorter
      // bounds so locks and expensive sweeps release before the HTTP request
      // ceiling and cannot keep ordinary app reads waiting indefinitely.
      const statementTimeoutMs = Math.max(
        1_000,
        transactionTimeoutMs - CRM_RECONCILIATION_STATEMENT_HEADROOM_MS,
      );
      await tx.$executeRaw`SELECT set_config(
        'statement_timeout', ${String(statementTimeoutMs)}, true
      )`;
      await tx.$executeRaw`SELECT set_config(
        'lock_timeout', ${String(CRM_RECONCILIATION_LOCK_TIMEOUT_MS)}, true
      )`;

      if (dryRun) {
        const previewRows = await tx.$queryRaw<RawCombinedPreviewCounts[]>(Prisma.sql`
          SELECT * FROM app.preview_crm_identity_duplicate_reconciliation(${runId})
        `);
        const contactDuplicateRows = await tx.$queryRaw<RawDuplicateCounts[]>(Prisma.sql`
          SELECT * FROM app.preview_crm_contact_duplicate_candidates()
        `);
        return {
          preview: previewRows[0],
          contactDuplicates: contactDuplicateRows?.[0] ?? EMPTY_DUPLICATE_COUNTS,
        };
      }

      // Parent keys land in mirror first. The dedicated reconciler—not ingest—
      // mints/reuses their typed identities and width aliases, then the existing
      // eight-domain sweep can resolve child exceptions in the same transaction.
      const parentRows = await tx.$queryRaw<RawParentCounts[]>(Prisma.sql`
        SELECT * FROM app.reconcile_crm_parent_source(false)
      `);
      const rows = await tx.$queryRaw<RawCounts[]>(Prisma.sql`
        SELECT * FROM app.reconcile_crm_identity_snapshot(${runId}, false)
      `);
      const persistDuplicateCandidates = crmDuplicateDetectorWritesEnabled();
      const duplicateRows = persistDuplicateCandidates
        ? await tx.$queryRaw<RawDuplicateCounts[]>(Prisma.sql`
            SELECT * FROM app.reconcile_crm_duplicate_candidates()
          `)
        : await tx.$queryRaw<RawDuplicateCounts[]>(Prisma.sql`
            SELECT * FROM app.preview_crm_duplicate_candidates()
          `);
      const contactDuplicateRows = persistDuplicateCandidates
        ? await tx.$queryRaw<RawDuplicateCounts[]>(Prisma.sql`
            SELECT * FROM app.reconcile_crm_contact_duplicate_candidates()
          `)
        : await tx.$queryRaw<RawDuplicateCounts[]>(Prisma.sql`
            SELECT * FROM app.preview_crm_contact_duplicate_candidates()
          `);
      return {
        parent: parentRows[0],
        base: rows[0],
        duplicates: duplicateRows[0],
        contactDuplicates: contactDuplicateRows?.[0] ?? EMPTY_DUPLICATE_COUNTS,
        duplicateMode: persistDuplicateCandidates ? "persisted" as const : "preview" as const,
      };
    },
    { timeout: transactionTimeoutMs, maxWait: 15_000 },
  );

  if ("preview" in result) {
    if (!result.preview) throw new Error("crm_reconciliation_no_result");
    const contact = result.contactDuplicates;
    return {
      sourcesSeen: Number(result.preview.sources_seen),
      identitiesCreated: Number(result.preview.identities_created),
      mappingsCreated: Number(result.preview.mappings_created),
      mappingsRefreshed: Number(result.preview.mappings_refreshed),
      exceptionsOpened: Number(result.preview.exceptions_opened),
      exceptionsReopened: Number(result.preview.exceptions_reopened),
      exceptionsResolved: Number(result.preview.exceptions_resolved),
      duplicateSignalsSeen: Number(
        result.preview.duplicate_signals_seen + (contact?.signals_seen ?? 0n),
      ),
      duplicateMode: "preview",
      duplicateCandidatesWouldOpen: Number(
        result.preview.duplicate_candidates_would_open + (contact?.candidates_opened ?? 0n),
      ),
      duplicateCandidatesWouldRefresh: Number(
        result.preview.duplicate_candidates_would_refresh + (contact?.candidates_refreshed ?? 0n),
      ),
      duplicateCandidatesWouldInactivate: Number(
        result.preview.duplicate_candidates_would_inactivate + (contact?.candidates_inactivated ?? 0n),
      ),
    };
  }

  if (!result.parent || !result.base || !result.duplicates || !result.contactDuplicates) {
    throw new Error("crm_reconciliation_no_result");
  }

  const base = {
    sourcesSeen: Number(result.parent.sources_seen + result.base.sources_seen),
    identitiesCreated: Number(
      result.parent.identities_created + result.base.identities_created,
    ),
    mappingsCreated: Number(
      result.parent.mappings_created + result.base.mappings_created,
    ),
    mappingsRefreshed: Number(
      result.parent.mappings_refreshed + result.base.mappings_refreshed,
    ),
    exceptionsOpened: Number(result.base.exceptions_opened),
    exceptionsReopened: Number(result.base.exceptions_reopened),
    exceptionsResolved: Number(result.base.exceptions_resolved),
    duplicateSignalsSeen: Number(
      result.duplicates.signals_seen + result.contactDuplicates.signals_seen,
    ),
  };
  return result.duplicateMode === "persisted"
    ? {
        ...base,
        duplicateMode: "persisted",
        duplicateCandidatesOpened: Number(
          result.duplicates.candidates_opened + result.contactDuplicates.candidates_opened,
        ),
        duplicateCandidatesRefreshed: Number(
          result.duplicates.candidates_refreshed + result.contactDuplicates.candidates_refreshed,
        ),
        duplicateCandidatesInactivated: Number(
          result.duplicates.candidates_inactivated + result.contactDuplicates.candidates_inactivated,
        ),
      }
    : {
        ...base,
        duplicateMode: "preview",
        duplicateCandidatesWouldOpen: Number(
          result.duplicates.candidates_opened + result.contactDuplicates.candidates_opened,
        ),
        duplicateCandidatesWouldRefresh: Number(
          result.duplicates.candidates_refreshed + result.contactDuplicates.candidates_refreshed,
        ),
        duplicateCandidatesWouldInactivate: Number(
          result.duplicates.candidates_inactivated + result.contactDuplicates.candidates_inactivated,
        ),
      };
}
