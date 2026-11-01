import { z } from "zod";

export const FEE_FIELD_KEYS = [
  "feeCharged",
  "feeAmount",
  "feeMemo",
  "feeRequestSubmitted",
  "feeRequestCompleted",
  "feeApexTicket",
  "feeCreditRequestId",
] as const;

export type FeeField = (typeof FEE_FIELD_KEYS)[number];
export type TransferFee = Record<FeeField, string | null>;

const LOG_STATUSES = ["Pending", "Approved", "Credited", "Denied"] as const;
export type FeeLogStatus = (typeof LOG_STATUSES)[number];

export type FeeLogRow = {
  id: string | null;
  status: FeeLogStatus;
  feeAmount: number;
  feeType: string | null;
  submissionDate: string | null;
};

const feeValue = z.union([z.string(), z.null()]);
const feeFields = z
  .object({
    feeCharged: feeValue.optional(),
    feeAmount: feeValue.optional(),
    feeMemo: feeValue.optional(),
    feeRequestSubmitted: feeValue.optional(),
    feeRequestCompleted: feeValue.optional(),
    feeApexTicket: feeValue.optional(),
    feeCreditRequestId: feeValue.optional(),
  })
  .strict()
  .refine((fields) => Object.keys(fields).length > 0);

export const feeActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), fields: feeFields }).strict(),
  z
    .object({
      action: z.literal("apply"),
      feeRuleIds: z.array(z.string().min(1).max(64)).min(1).max(50),
    })
    .strict(),
  z.object({ action: z.literal("log") }).strict(),
]);

export function feeContractEnabled(): boolean {
  return (
    process.env.EPIC_ACAT_FEE_REIMBURSEMENT === "1" &&
    process.env.ROLLOUT_ACAT_FEE_REIMBURSEMENT === "1"
  );
}

export function parseChargedAmount(feeAmount: string | null | undefined): number {
  return parseFloat((feeAmount ?? "0").replace(/[^0-9.]/g, "")) || 0;
}

export function toHttpFee(source: Partial<TransferFee> | null | undefined): TransferFee {
  const fee = {} as TransferFee;
  for (const key of FEE_FIELD_KEYS) fee[key] = source?.[key] ?? null;
  return fee;
}

type FeeRule = {
  feeType?: string | null;
  amount?: number | null;
  amountText?: string | null;
};

export function selectedRuleFee(rules: FeeRule[]): Pick<TransferFee, "feeAmount" | "feeMemo" | "feeCharged"> {
  const total = rules.reduce((sum, rule) => sum + (rule.amount ?? 0), 0);
  const feeMemo = rules
    .map((rule) => {
      const value = rule.amount != null ? `$${rule.amount.toFixed(2)}` : (rule.amountText ?? "?");
      return `${rule.feeType}: ${value}`;
    })
    .join(" + ");
  return {
    feeAmount: `$${total.toFixed(2)}`,
    feeMemo,
    feeCharged: total > 0 || rules.some((rule) => rule.amount == null) ? "Yes" : "No",
  };
}

export function toFeeLogRow(raw: Record<string, unknown>): FeeLogRow {
  const rawId = raw.id ?? raw.request_id;
  const idText = rawId == null ? "" : String(rawId);
  const status = LOG_STATUSES.includes(raw.status as FeeLogStatus) ? (raw.status as FeeLogStatus) : "Pending";
  return {
    id: idText.trim() ? idText : null,
    status,
    feeAmount: Number(raw.fee_amount ?? 0),
    feeType: raw.fee_type == null ? null : String(raw.fee_type),
    submissionDate: raw.submission_date == null ? null : String(raw.submission_date),
  };
}

export function feeLogRows(body: unknown): FeeLogRow[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : [];
  return rows.map((row) => toFeeLogRow((row ?? {}) as Record<string, unknown>));
}

export function createdFeeId(body: unknown): string {
  const record =
    body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data[0]
      : body && typeof body === "object" && "data" in body
        ? (body as { data?: unknown }).data ?? body
        : body;
  const source = record && typeof record === "object" ? (record as Record<string, unknown>) : {};
  const rawId = source.id ?? source.request_id;
  if (rawId == null || String(rawId).trim() === "") return "";
  return String(rawId);
}
