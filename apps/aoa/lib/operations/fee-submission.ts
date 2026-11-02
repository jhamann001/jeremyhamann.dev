import { createHash } from "node:crypto";
import { FeeRequestValidationError, type ParsedOperationsFeeRequest } from "./fee-request";

export function parseFeeSubmissionKey(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new FeeRequestValidationError("submissionKey", "Reload the form before submitting a new request.");
  }
  return value;
}

/** Stored server-side only. Payload changes cannot silently reuse an old key. */
export function feeSubmissionDigest(input: ParsedOperationsFeeRequest): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    kind: input.kind,
    client: input.clientSfId.trim(),
    accounts: [...input.accountIds].sort(),
    feeTypes: [...input.feeTypes].sort(),
    amount: input.feeAmount,
    start: input.waiverStart,
    duration: input.waiverDurationMonths,
    indefinite: input.indefiniteDuration,
    reason: input.reason,
    tickets: [...input.relevantTicketRefs].sort(),
  })).digest("hex");
}
