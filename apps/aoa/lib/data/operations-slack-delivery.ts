import "server-only";

import { randomUUID } from "node:crypto";
import type { OperationsFeeRequestKind } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import { appWritesPaused } from "@/lib/maintenance";
import { assertOperationsSlackVerificationRecord, OPERATIONS_SLACK_VERIFICATION_REQUEST_ID } from "@/lib/operations/operations-slack-verification";
import { getOperationsSlackDeliveryConfig, operationsSlackCaptureEnabled, sendOperationsSlackNotification } from "@/lib/slack/operations-fee-notifications";

const WORKER = { role: "OPERATIONS", email: "operations-slack-delivery@system" };
const MAX_ATTEMPTS = 5;
export type OperationsSlackClaim = {
  requestId: string;
  kind: OperationsFeeRequestKind;
  claimToken: string;
  attempts: number;
};
type DeliveryResult = Awaited<ReturnType<typeof sendOperationsSlackNotification>>;

/** Claim is committed before any network request. Parallel workers skip it. */
export async function claimOperationsSlackNotification(): Promise<OperationsSlackClaim | null> {
  return withUserScope(WORKER, async (tx) => {
    // One destination-wide in-flight send, including across Cloud Run instances.
    // The short transaction lock serializes the check/claim, not the HTTP call.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('operations-slack:C00OBJK6X0W', 0))`;
    const [blocked] = await tx.$queryRaw<Array<{ blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM app.operations_slack_notification
        WHERE status = 'SENDING'
           OR (status IN ('FAILED', 'UNCERTAIN') AND acknowledged_at IS NULL)
           OR (status = 'RETRY' AND next_attempt_at > now())
           OR (status = 'SENT' AND updated_at > now() - interval '1 second')
      ) AS blocked`;
    if (blocked?.blocked) return null;
    const rows = await tx.$queryRaw<Array<{ request_id: string }>>`
      SELECT request_id FROM app.operations_slack_notification
       WHERE status IN ('PENDING', 'RETRY') AND attempts < ${MAX_ATTEMPTS}
         AND next_attempt_at <= now()
       ORDER BY next_attempt_at, request_id
       LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!rows[0]) return null;
    if (rows[0].request_id === OPERATIONS_SLACK_VERIFICATION_REQUEST_ID) {
      const verification = await tx.operationsFeeRequest.findUniqueOrThrow({
        where: { id: OPERATIONS_SLACK_VERIFICATION_REQUEST_ID },
        include: { events: { take: 3, orderBy: { id: "asc" } }, slack_notification: true },
      });
      assertOperationsSlackVerificationRecord(verification);
    }
    const claimToken = randomUUID();
    const row = await tx.operationsSlackNotification.update({
      where: { request_id: rows[0].request_id },
      data: { status: "SENDING", attempts: { increment: 1 }, claim_token: claimToken, claimed_at: new Date(), last_code: null },
      select: { request_id: true, attempts: true, request: { select: { kind: true } } },
    });
    return { requestId: row.request_id, kind: row.request.kind, claimToken, attempts: row.attempts };
  });
}

async function deliveryNeedsReview(): Promise<boolean> {
  return withUserScope(WORKER, async (tx) => await tx.operationsSlackNotification.count({
    where: { status: { in: ["FAILED", "UNCERTAIN"] }, acknowledged_at: null },
  }) > 0);
}

/** A crashed worker might have sent successfully. Never automatically resend. */
export async function expireOperationsSlackClaims(): Promise<number> {
  return withUserScope(WORKER, async (tx) => tx.$executeRaw`
    UPDATE app.operations_slack_notification
       SET status = 'UNCERTAIN', claim_token = NULL, claimed_at = NULL,
           last_code = 'claim_expired', updated_at = now()
     WHERE request_id IN (
       SELECT request_id FROM app.operations_slack_notification
        WHERE status = 'SENDING' AND claimed_at < now() - interval '5 minutes'
        ORDER BY claimed_at LIMIT 100 FOR UPDATE SKIP LOCKED
     )`);
}

export async function finishOperationsSlackNotification(claim: OperationsSlackClaim, result: DeliveryResult): Promise<boolean> {
  const retry = result.status === "retry" && claim.attempts < MAX_ATTEMPTS;
  const status = result.status === "sent" ? "SENT" : result.status === "uncertain" ? "UNCERTAIN" : retry ? "RETRY" : "FAILED";
  const code = result.status === "sent" ? null : result.status === "retry" && !retry ? "retry_exhausted" : result.code;
  return withUserScope(WORKER, async (tx) => {
    const saved = await tx.operationsSlackNotification.updateMany({
      where: { request_id: claim.requestId, status: "SENDING", claim_token: claim.claimToken },
      data: {
        status, claim_token: null, claimed_at: null, last_code: code,
        slack_ts: result.status === "sent" ? result.ts : null,
        ...(retry && result.status === "retry" ? {
          next_attempt_at: new Date(Date.now() + Math.max(result.retryAfterSeconds, 60 * 2 ** (claim.attempts - 1)) * 1000),
        } : {}),
      },
    });
    return saved.count === 1;
  });
}

export async function runOperationsSlackDelivery() {
  const summary = { processed: 0, sent: 0, retry: 0, failed: 0, uncertain: 0, expired: 0, skipped: false, blocked: false, configurationInvalid: false };
  if (appWritesPaused() || process.env.APP_ENV !== "prod" || !operationsSlackCaptureEnabled()
    || process.env.OPERATIONS_SLACK_DELIVERY_ENABLED !== "true") return { ...summary, skipped: true };
  // An intended activation with missing/bad credentials is not a healthy skip.
  // Fail before claiming work and preserve the queue for configuration repair.
  if (!getOperationsSlackDeliveryConfig()) return { ...summary, blocked: true, configurationInvalid: true };
  summary.expired = await expireOperationsSlackClaims();
  if (await deliveryNeedsReview()) return { ...summary, blocked: true };
  for (let index = 0; index < 5; index++) {
    // Recheck the kill switch before each claim, not only at batch entry.
    const config = getOperationsSlackDeliveryConfig();
    if (appWritesPaused() || !config) break;
    const claim = await claimOperationsSlackNotification();
    if (!claim) break;
    const result = await sendOperationsSlackNotification({ kind: claim.kind, requestId: claim.requestId }, config);
    const saved = await finishOperationsSlackNotification(claim, result);
    if (!saved) throw new Error("operations_slack_claim_lost");
    summary.processed++;
    if (result.status === "retry" && claim.attempts >= MAX_ATTEMPTS) summary.failed++;
    else summary[result.status]++;
    // Rate limits, credential faults and ambiguous outcomes are not helped by
    // immediately sending the rest of this batch with the same credential.
    if (result.status !== "sent") break;
  }
  summary.blocked = await deliveryNeedsReview();
  return summary;
}
