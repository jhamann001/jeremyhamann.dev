import "server-only";
import { z } from "zod";
import { readAcatMachine, writeAcatBookRecord } from "./acat-status";
import {
  FEE_FIELD_KEYS,
  FEE_LOG_STATUSES,
  normalizeFailureCode,
  type FeeActionResult,
  type FeeFailureCode,
  type FeeField,
  type TransferFee,
} from "./acat-fee-view";

// Server-only adapter over the tracker's fee route (ticket, merged at
// transfer-tracker 00babb7): GET and POST /api/machine/acats/by-record/{id}/fees.
// Bodies are parsed against the contract; a failure body's `error` string is
// reduced to a known code and never forwarded. Only static markers and a
// status are logged: never a body, a token, or a URL.

const LOG_TAG = "acat-fee";

const feeValue = z.string().nullable();
const feeSchema = z.object({
  feeCharged: feeValue, feeAmount: feeValue, feeMemo: feeValue, feeRequestSubmitted: feeValue,
  feeRequestCompleted: feeValue, feeApexTicket: feeValue, feeCreditRequestId: feeValue,
});
const logRowSchema = z.object({
  id: z.string().nullable(),
  status: z.enum(FEE_LOG_STATUSES),
  feeAmount: z.number(),
  feeType: z.string().nullable(),
  submissionDate: z.string().nullable(),
});
const logSchema = z.array(logRowSchema);

const successSchema = z.object({ fee: feeSchema, log: logSchema.nullable() });
const failureSchema = z.object({
  error: z.string(),
  fee: feeSchema.nullable().optional(),
  log: logSchema.nullable().optional(),
});

function path(recordId: string): string {
  return `/api/machine/acats/by-record/${encodeURIComponent(recordId)}/fees`;
}

function toFee(fee: z.infer<typeof feeSchema>): TransferFee {
  const out = {} as TransferFee;
  for (const key of FEE_FIELD_KEYS) out[key as FeeField] = fee[key as FeeField];
  return out;
}

/**
 * The tracker answers 503 `log_not_configured` or 502 `log_unavailable` (with the stored fee) when its
 * reimbursement log cannot be read. Reimbursements now live in Operations Tools (ticket), so the log is
 * not part of this contract: a fee that was read is a good read, the tracker log is ignored, and the
 * expected answer is not logged as an error.
 */
function logOnlyFailure(res: { status: number | null; data: unknown }): FeeActionResult | null {
  if (res.status !== 502 && res.status !== 503) return null;
  const failure = failureSchema.safeParse(res.data);
  if (!failure.success || !failure.data.fee) return null;
  const expected = res.status === 503 ? "log_not_configured" : "log_unavailable";
  return failure.data.error === expected ? { ok: true, fee: toFee(failure.data.fee), log: null } : null;
}

function interpret(res: { status: number | null; data: unknown }, marker: string): FeeActionResult {
  const logOnly = logOnlyFailure(res);
  if (logOnly) return logOnly;
  if (res.status === null || res.status < 200 || res.status >= 300) {
    console.error(`[${LOG_TAG}] ${marker}=${res.status ?? "none"}`);
  }
  if (res.status === null) return { ok: false, code: "transport", fee: null, log: null };
  if (res.status >= 200 && res.status < 300) {
    const parsed = successSchema.safeParse(res.data);
    if (!parsed.success) {
      console.error(`[${LOG_TAG}] ${marker}_body_invalid`);
      return { ok: false, code: "transport", fee: null, log: null };
    }
    return { ok: true, fee: toFee(parsed.data.fee), log: parsed.data.log };
  }
  const failure = failureSchema.safeParse(res.data);
  const byStatus: Record<number, FeeFailureCode> = { 401: "unauthorized", 404: "not_found", 429: "rate_limited" };
  const code: FeeFailureCode = failure.success
    ? normalizeFailureCode(failure.data.error)
    : (byStatus[res.status] ?? "transport");
  return {
    ok: false,
    code,
    fee: failure.success && failure.data.fee ? toFee(failure.data.fee) : null,
    log: failure.success && failure.data.log ? failure.data.log : null,
  };
}

export async function readTransferFee(recordId: string): Promise<FeeActionResult> {
  return interpret(await readAcatMachine(path(recordId)), "read_status");
}

export async function postTransferFee(recordId: string, body: unknown): Promise<FeeActionResult> {
  return interpret(await writeAcatBookRecord("POST", path(recordId), body), "write_status");
}
