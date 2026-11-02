import "server-only";
import { FEED_HEALTH, INGEST_ACCOUNT_AUM } from "@/lib/audit";
import { applyAuditReadDatabaseBounds, AUDIT_READ_TRANSACTION_OPTIONS } from "@/lib/data/audit-read-bounds";
import { withUserScope } from "@/lib/rls";
import type { JobEnvironment } from "./contracts";
import type { ApplicationSweepInput, JobApplicationEvidence } from "./application-evidence-types";
import { evaluateAccountAumEvidence, evaluateReviewQueueEvidence, unavailableApplicationEvidence } from "./application-evidence-evaluation";

const WORKER = { role: "OPERATIONS", email: "data-job-collector@system" } as const;

/**
 * Background-only, bounded application metadata reads. No business mutation,
 * mirror row/client payload, ingest privilege, network call or alert delivery.
 * The authenticated collector owns its flag, lease and persistence gates.
 */
export async function collectApplicationEvidence(
  environment: JobEnvironment, now: Date = new Date(),
): Promise<JobApplicationEvidence[]> {
  if (!Number.isFinite(now.getTime())) throw new Error("application_observation_time_invalid");
  if (!["dev", "prod"].includes(environment) || process.env.APP_ENV !== environment) {
    throw new Error("application_environment_mismatch");
  }
  const [aum, sweep] = await Promise.allSettled([
    withUserScope(WORKER, async (tx) => {
      await applyAuditReadDatabaseBounds(tx);
      const [audits, warning] = await Promise.all([
        tx.auditLog.findMany({
          where: { action: INGEST_ACCOUNT_AUM, entityType: "ingest_run" },
          orderBy: [{ at: "desc" }, { id: "desc" }], take: 32,
          select: { at: true, detail: true },
        }),
        tx.auditLog.findFirst({
          where: { action: FEED_HEALTH, entityType: "feed_health", entityId: "account-aum" },
          orderBy: [{ at: "desc" }, { id: "desc" }], select: { at: true, detail: true },
        }),
      ]);
      return evaluateAccountAumEvidence(environment, { audits, warning }, now);
    }, AUDIT_READ_TRANSACTION_OPTIONS),
    withUserScope(WORKER, async (tx) => {
      await applyAuditReadDatabaseBounds(tx);
      const rows = await tx.$queryRaw<ApplicationSweepInput[]>`
        SELECT last_started_at, last_completed_at, last_failure_at, last_failure_source,
          lease_expires_at, trade_complete, crm_complete,
          (trade_cursor IS NOT NULL AND trade_cursor <> '') AS trade_progress,
          (crm_cursor IS NOT NULL AND crm_cursor <> '') AS crm_progress
        FROM app.review_queue_sweep_state WHERE id = 'default' LIMIT 1`;
      return evaluateReviewQueueEvidence(environment, rows[0] ?? null, now);
    }, AUDIT_READ_TRANSACTION_OPTIONS),
  ]);
  return [
    aum.status === "fulfilled" ? aum.value : unavailableApplicationEvidence("ACCOUNT_AUM", environment, now),
    sweep.status === "fulfilled" ? sweep.value : unavailableApplicationEvidence("REVIEW_QUEUE", environment, now),
  ];
}
