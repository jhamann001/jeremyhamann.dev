import "server-only";

import { Prisma } from "@prisma/client";
import { crmReconcilerClient } from "@/lib/crm/reconciler-db";

export const CRM_RELATIONSHIP_DERIVATIONS = [
  "CRM_CONTACT_HOUSEHOLD",
  "AOA_DEAL_HOUSEHOLD",
  "AOA_TRANSFER_HOUSEHOLD",
] as const;

export type CrmRelationshipDerivation =
  (typeof CRM_RELATIONSHIP_DERIVATIONS)[number];

export type CrmRelationshipSnapshotCompleteness = {
  contact: boolean;
  deal: boolean;
  transfer: boolean;
};

export type CrmRelationshipSnapshotCounts = {
  derivation: CrmRelationshipDerivation;
  snapshotComplete: boolean;
  candidates: number;
  created: number;
  refreshed: number;
  reactivated: number;
  inactivated: number;
  missingEndpoint: number;
  ambiguousEndpoint: number;
  rejectedType: number;
};

type RawCounts = {
  derivation_code: CrmRelationshipDerivation;
  snapshot_complete: boolean;
  candidates: bigint;
  created: bigint;
  refreshed: bigint;
  reactivated: bigint;
  inactivated: bigint;
  missing_endpoint: bigint;
  ambiguous_endpoint: bigint;
  rejected_type: bigint;
};

export const CRM_RELATIONSHIP_RECONCILIATION_TIMEOUT_MS = 240_000;
export const CRM_RELATIONSHIP_STATEMENT_HEADROOM_MS = 30_000;
export const CRM_RELATIONSHIP_LOCK_TIMEOUT_MS = 5_000;

export async function runCrmRelationshipSnapshot(
  runId: string,
  dryRun: boolean,
  completeness: CrmRelationshipSnapshotCompleteness,
  transactionTimeoutMs = CRM_RELATIONSHIP_RECONCILIATION_TIMEOUT_MS,
): Promise<CrmRelationshipSnapshotCounts[]> {
  const client = crmReconcilerClient();
  const rows = await client.$transaction(
    async (tx) => {
      // Prisma's transaction deadline alone cannot cancel a running SQL
      // statement. Match the identity reconciler's database-side bounds while
      // retaining the snapshot function's existing locking and atomicity.
      const statementTimeoutMs = Math.max(
        1_000,
        transactionTimeoutMs - CRM_RELATIONSHIP_STATEMENT_HEADROOM_MS,
      );
      await tx.$executeRaw`SELECT set_config(
        'statement_timeout', ${String(statementTimeoutMs)}, true
      )`;
      await tx.$executeRaw`SELECT set_config(
        'lock_timeout', ${String(CRM_RELATIONSHIP_LOCK_TIMEOUT_MS)}, true
      )`;
      return dryRun
        ? tx.$queryRaw<RawCounts[]>(Prisma.sql`
          SELECT * FROM app.preview_crm_relationship_snapshot(
            ${runId}, ${completeness.contact}, ${completeness.deal},
            ${completeness.transfer}
          )
        `)
        : tx.$queryRaw<RawCounts[]>(Prisma.sql`
          SELECT * FROM app.reconcile_crm_relationship_snapshot(
            ${runId}, ${completeness.contact}, ${completeness.deal},
            ${completeness.transfer}
          )
        `);
    },
    { timeout: transactionTimeoutMs, maxWait: 15_000 },
  );

  if (rows.length !== CRM_RELATIONSHIP_DERIVATIONS.length) {
    throw new Error("crm_relationship_reconciliation_incomplete_result");
  }

  const seen = new Set(rows.map((row) => row.derivation_code));
  if (CRM_RELATIONSHIP_DERIVATIONS.some((derivation) => !seen.has(derivation))) {
    throw new Error("crm_relationship_reconciliation_incomplete_result");
  }

  return rows.map((row) => ({
    derivation: row.derivation_code,
    snapshotComplete: row.snapshot_complete,
    candidates: Number(row.candidates),
    created: Number(row.created),
    refreshed: Number(row.refreshed),
    reactivated: Number(row.reactivated),
    inactivated: Number(row.inactivated),
    missingEndpoint: Number(row.missing_endpoint),
    ambiguousEndpoint: Number(row.ambiguous_endpoint),
    rejectedType: Number(row.rejected_type),
  }));
}
