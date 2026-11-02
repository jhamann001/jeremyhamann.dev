import "server-only";
import { writeAudit, OPERATIONS_FEE_REQUEST_CREATE, OPERATIONS_FEE_REQUEST_TRANSITION } from "@/lib/audit";
import { appWritesPaused } from "@/lib/maintenance";
import { withUserScope, type Identity } from "@/lib/rls";
import { getOperationsSlackDeliveryConfig, operationsSlackCaptureEnabled } from "@/lib/slack/operations-fee-notifications";
import {
  assertOperationsSlackVerificationRecord,
  OPERATIONS_SLACK_VERIFICATION_REQUEST_ID as ID,
  OPERATIONS_SLACK_VERIFICATION_CLIENT_ID as CLIENT,
  OPERATIONS_SLACK_VERIFICATION_ACCOUNT_ID as ACCOUNT,
  OPERATIONS_SLACK_VERIFICATION_SUBMISSION_KEY as SUBMISSION_KEY,
  OPERATIONS_SLACK_VERIFICATION_DIGEST as DIGEST,
  OPERATIONS_SLACK_VERIFICATION_REASON as REASON,
  OPERATIONS_SLACK_VERIFICATION_WAIVER_START as WAIVER_START,
  OPERATIONS_SLACK_VERIFICATION_EVENT_DETAIL as EVENT_DETAIL,
} from "@/lib/operations/operations-slack-verification";
import { captureOperationsSlackNotification } from "./operations-slack-capture";

function requireEnabled(): void {
  if (appWritesPaused() || !operationsSlackCaptureEnabled()
    || (process.env.APP_ENV !== "dev" && process.env.APP_ENV !== "prod")
    || (process.env.APP_ENV === "prod" && !getOperationsSlackDeliveryConfig())) {
    throw new Error("operations_slack_verification_disabled");
  }
}

/** Explicit single-use capture only. The ordinary scheduler is the sole sender.
 * No mirror row, financial action, worker identity, retry or acknowledgement. */
export async function createOperationsSlackVerification(identity: Identity): Promise<typeof ID> {
  if ((identity.role !== "ADMIN" && identity.role !== "OPERATIONS") || !identity.email?.trim()) {
    throw new Error("operations_slack_verification_forbidden");
  }
  requireEnabled();
  const actor = { role: identity.role, email: identity.email.trim().toLowerCase() };
  return withUserScope<typeof ID>(actor, async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true),
      set_config('lock_timeout', '1000', true), set_config('jit', 'off', true)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('operations-slack:C00OBJK6X0W', 0))`;
    requireEnabled();
    const existing = await tx.operationsFeeRequest.findUnique({
      where: { id: ID }, include: { events: { take: 3, orderBy: { id: "asc" } }, slack_notification: true },
    });
    if (existing) {
      assertOperationsSlackVerificationRecord(existing);
      return ID;
    }
    const [queue] = await tx.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (
      SELECT 1 FROM app.operations_slack_notification
      WHERE request_id <> ${ID} AND (
        status IN ('PENDING', 'RETRY', 'SENDING')
        OR (status IN ('FAILED', 'UNCERTAIN') AND acknowledged_at IS NULL)
      )
    ) AS blocked`;
    if (!queue || queue.blocked) throw new Error("operations_slack_verification_queue_blocked");
    const [collision] = await tx.$queryRaw<Array<{ present: boolean }>>`SELECT (
      EXISTS (SELECT 1 FROM mirror.client WHERE sf_id = ${CLIENT})
      OR EXISTS (SELECT 1 FROM mirror.client_account_aum WHERE custodian_account_id = ${ACCOUNT})
      OR EXISTS (SELECT 1 FROM app.operations_fee_request
        WHERE client_sf_id = ${CLIENT} OR ${ACCOUNT} = ANY(account_ids) OR submission_key = ${SUBMISSION_KEY})
    ) AS present`;
    if (!collision || collision.present) throw new Error("operations_slack_verification_conflict");
    // Database defaults supply the precise transaction clock required by live
    // capture RLS. A JS Date would lose sub-millisecond precision here.
    await tx.$executeRaw`INSERT INTO app.operations_fee_request (
      id, kind, status, client_sf_id, account_ids, fee_types, fee_amount,
      waiver_start, waiver_duration_months, indefinite_duration, reason,
      relevant_ticket_refs, submitted_by_email, submitted_by_role,
      submission_key, submission_digest, updated_at
    ) VALUES (${ID}, 'SERVICE_GUARANTEE', 'PENDING', ${CLIENT}, ARRAY[${ACCOUNT}]::text[], ARRAY[]::text[], NULL,
      ${WAIVER_START}::date, 1, false, ${REASON}, ARRAY[]::text[], ${actor.email}, ${actor.role},
      ${SUBMISSION_KEY}, ${DIGEST}, transaction_timestamp())`;
    const [submitted] = await tx.$queryRaw<Array<{ id: bigint }>>`INSERT INTO app.operations_fee_request_event (
      request_id, action, actor_email, actor_role, from_status, to_status, detail
    ) VALUES (${ID}, 'SUBMITTED', ${actor.email}, ${actor.role}, NULL, 'PENDING', ${JSON.stringify(EVENT_DETAIL)}::jsonb)
    RETURNING id`;
    if (!submitted || !await captureOperationsSlackNotification(tx, ID, submitted.id)) {
      throw new Error("operations_slack_verification_disabled");
    }
    const cancelled = await tx.$executeRaw`UPDATE app.operations_fee_request SET
      status = 'CANCELLED', reviewed_by_email = ${actor.email}, reviewed_at = transaction_timestamp(),
      updated_at = transaction_timestamp() WHERE id = ${ID} AND status = 'PENDING'`;
    if (cancelled !== 1) throw new Error("operations_slack_verification_conflict");
    await tx.$executeRaw`INSERT INTO app.operations_fee_request_event (
      request_id, action, actor_email, actor_role, from_status, to_status, detail
    ) VALUES (${ID}, 'CANCELLED', ${actor.email}, ${actor.role}, 'PENDING', 'CANCELLED', ${JSON.stringify(EVENT_DETAIL)}::jsonb)`;
    await writeAudit(tx, actor, {
      action: OPERATIONS_FEE_REQUEST_CREATE, entityType: "operations_fee_request", entityId: ID,
      detail: { verification: "ticket", synthetic: true, captured: true },
    });
    await writeAudit(tx, actor, {
      action: OPERATIONS_FEE_REQUEST_TRANSITION, entityType: "operations_fee_request", entityId: ID,
      detail: { verification: "ticket", synthetic: true, fromStatus: "PENDING", toStatus: "CANCELLED" },
    });
    const result = await tx.operationsFeeRequest.findUniqueOrThrow({
      where: { id: ID }, include: { events: { take: 3, orderBy: { id: "asc" } }, slack_notification: true },
    });
    assertOperationsSlackVerificationRecord(result);
    return ID;
  }, { maxWait: 2_000, timeout: 8_000 });
}
