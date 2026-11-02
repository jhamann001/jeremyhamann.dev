import type { Prisma } from "@prisma/client";
import type { ParsedOperationsFeeRequest } from "./fee-request";
import { feeSubmissionDigest } from "./fee-submission";

// One server-owned identity per database. No browser input may select any of
// these values, and no real CRM/account row is created for this canary.
export const OPERATIONS_SLACK_VERIFICATION_REQUEST_ID = "ops195-test-notification-20260926";
export const OPERATIONS_SLACK_VERIFICATION_CLIENT_ID = "DEV-OPS195-NOTIFICATION-TEST";
export const OPERATIONS_SLACK_VERIFICATION_ACCOUNT_ID = "TEST-OPS195-NOTIFICATION";
export const OPERATIONS_SLACK_VERIFICATION_SUBMISSION_KEY = "01951951-2026-4195-8195-202609260001";
export const OPERATIONS_SLACK_VERIFICATION_REASON = "TEST ONLY — no client/billing action";
export const OPERATIONS_SLACK_VERIFICATION_WAIVER_START = "2026-09-01";
export const OPERATIONS_SLACK_VERIFICATION_EVENT_DETAIL = Object.freeze({ verification: "ticket" });

export function operationsSlackVerificationInput(): ParsedOperationsFeeRequest {
  return {
    kind: "SERVICE_GUARANTEE", clientSfId: OPERATIONS_SLACK_VERIFICATION_CLIENT_ID,
    accountIds: [OPERATIONS_SLACK_VERIFICATION_ACCOUNT_ID], feeTypes: [], feeAmount: null,
    waiverStart: OPERATIONS_SLACK_VERIFICATION_WAIVER_START, waiverDurationMonths: 1,
    indefiniteDuration: false, reason: OPERATIONS_SLACK_VERIFICATION_REASON, relevantTicketRefs: [],
  };
}

export const OPERATIONS_SLACK_VERIFICATION_DIGEST = feeSubmissionDigest(operationsSlackVerificationInput());

export type OperationsSlackVerificationRecord = Prisma.OperationsFeeRequestGetPayload<{
  include: { events: true; slack_notification: true };
}>;

function sameDate(left: Date | null, right: Date): boolean {
  return left instanceof Date && Number.isFinite(left.getTime()) && left.getTime() === right.getTime();
}

function exactDetail(value: Prisma.JsonValue): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && value.verification === "ticket";
}

/** Fail closed on a reserved-ID collision, incomplete capture, or altered test.
 * This assertion never accepts a caller-supplied test flag or message prefix. */
export function assertOperationsSlackVerificationRecord(record: OperationsSlackVerificationRecord): void {
  const notification = record.slack_notification;
  const submitted = record.events.filter((event) => event.action === "SUBMITTED");
  const cancelled = record.events.filter((event) => event.action === "CANCELLED");
  const actor = record.submitted_by_email;
  const valid = record.id === OPERATIONS_SLACK_VERIFICATION_REQUEST_ID
    && record.kind === "SERVICE_GUARANTEE" && record.status === "CANCELLED" && record.scope === "CLIENT"
    && record.client_sf_id === OPERATIONS_SLACK_VERIFICATION_CLIENT_ID
    && record.account_ids.length === 1 && record.account_ids[0] === OPERATIONS_SLACK_VERIFICATION_ACCOUNT_ID
    && record.fee_types.length === 0 && record.fee_amount === null
    && sameDate(record.waiver_start, new Date(`${OPERATIONS_SLACK_VERIFICATION_WAIVER_START}T00:00:00.000Z`))
    && record.waiver_duration_months === 1 && record.indefinite_duration === false
    && record.reason === OPERATIONS_SLACK_VERIFICATION_REASON && record.relevant_ticket_refs.length === 0
    && record.submission_key === OPERATIONS_SLACK_VERIFICATION_SUBMISSION_KEY
    && record.submission_digest === OPERATIONS_SLACK_VERIFICATION_DIGEST
    && typeof actor === "string" && actor.trim().length > 0 && actor === actor.trim().toLowerCase()
    && (record.submitted_by_role === "ADMIN" || record.submitted_by_role === "OPERATIONS")
    && record.reviewed_by_email === actor && sameDate(record.reviewed_at, record.created_at)
    && sameDate(record.submitted_at, record.created_at)
    && record.submitted_by_name === null && record.reviewed_by_name === null
    && record.legacy_source === null && record.legacy_source_id === null && record.legacy_source_digest === null
    && record.legacy_household_sf_id === null && record.legacy_client_name === null
    && record.legacy_apex_request_text === null && record.credited_at === null && record.apex_request_id === null
    && record.completed_by_email === null && record.completed_by_name === null && record.completed_at === null
    && record.events.length === 2 && submitted.length === 1 && cancelled.length === 1
    && submitted[0].from_status === null && submitted[0].to_status === "PENDING"
    && cancelled[0].from_status === "PENDING" && cancelled[0].to_status === "CANCELLED"
    && submitted[0].id < cancelled[0].id
    && record.events.every((event) => event.request_id === record.id && event.actor_email === actor
      && event.actor_role === record.submitted_by_role && event.actor_name === null
      && sameDate(event.at, record.created_at) && exactDetail(event.detail))
    && notification !== null && notification.request_id === record.id && notification.event_id === submitted[0].id
    && notification.channel_id === "C00OBJK6X0W" && sameDate(notification.created_at, record.created_at)
    && ["PENDING", "SENDING", "RETRY", "SENT", "FAILED", "UNCERTAIN"].includes(notification.status)
    && Number.isSafeInteger(notification.attempts) && notification.attempts >= 0 && notification.attempts <= 5
    && (notification.status === "SENT"
      ? typeof notification.slack_ts === "string" && /^\d{10,16}\.\d{6}$/.test(notification.slack_ts)
      : notification.slack_ts === null);
  if (!valid) throw new Error("operations_slack_verification_conflict");
}
