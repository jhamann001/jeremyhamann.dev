export const FEE_CREDIT_TYPES = [
  "IRA Maintenance",
  "IRA Termination",
  "ACAT in",
  "ACAT out",
  "Transaction",
  "Wire",
  "Relationship Waiver",
] as const;

export const EXCEPTION_TYPES = [
  { value: "SERVICE_GUARANTEE", label: "Service Guarantee" },
  { value: "BILLING_EXCEPTION", label: "Billing Exception" },
  { value: "LARGE_HOUSEHOLD_EXCEPTION", label: "$10M+ household billing exception" },
] as const;

export type FeeCreditType = (typeof FEE_CREDIT_TYPES)[number];
export type OperationsFeeRequestKind =
  | "FEE_CREDIT"
  | "SERVICE_GUARANTEE"
  | "BILLING_EXCEPTION"
  | "LARGE_HOUSEHOLD_EXCEPTION";

export type ParsedOperationsFeeRequest = {
  kind: OperationsFeeRequestKind;
  clientSfId: string;
  accountIds: string[];
  feeTypes: FeeCreditType[];
  feeAmount: string | null;
  waiverStart: string | null;
  waiverDurationMonths: number | null;
  indefiniteDuration: boolean;
  reason: string;
  relevantTicketRefs: string[];
};

export const FEE_REQUEST_WORKFLOW_ACTIONS = ["APPROVE", "REJECT", "CANCEL", "CREDIT"] as const;
export type FeeRequestWorkflowAction = (typeof FEE_REQUEST_WORKFLOW_ACTIONS)[number];

export type ParsedFeeRequestWorkflowAction = {
  requestId: string;
  action: FeeRequestWorkflowAction;
  note: string;
  creditedDate: string | null;
  apexRequestId: string | null;
};

export class FeeRequestValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "FeeRequestValidationError";
  }
}

function uniqueValues(values: FormDataEntryValue[]): string[] {
  return [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))];
}

function parseAccountIds(form: FormData): string[] {
  const values = uniqueValues(form.getAll("accountIds"));
  if (values.length === 0) {
    throw new FeeRequestValidationError("accountIds", "Choose at least one account.");
  }
  if (values.length > 50 || values.some((value) => value.length > 128 || /[\u0000-\u001f]/.test(value))) {
    throw new FeeRequestValidationError("accountIds", "The selected accounts are invalid.");
  }
  return values;
}

function isSyntheticDevClientId(value: string): boolean {
  if (!value.startsWith("DEV-") || value.length < 5 || value.length > 64) return false;
  const suffix = value.slice(4);
  if (suffix.startsWith("-") || suffix.endsWith("-") || suffix.includes("--")) return false;
  return [...suffix].every((character) => {
    if (character === "-") return true;
    const code = character.charCodeAt(0);
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
  });
}

function parseClientSfId(form: FormData): string {
  const value = String(form.get("clientSfId") ?? "").trim();
  const isSalesforceId = /^[a-zA-Z0-9]{15,18}$/.test(value);
  const isSyntheticDevId = process.env.APP_ENV?.toLowerCase() === "dev"
    && isSyntheticDevClientId(value);
  if (!isSalesforceId && !isSyntheticDevId) {
    throw new FeeRequestValidationError("clientSfId", "Choose a client.");
  }
  return value;
}

function parseMoney(value: FormDataEntryValue | null): string {
  const normalized = String(value ?? "").trim().replaceAll(",", "").replace(/^\$/, "");
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) {
    throw new FeeRequestValidationError("feeAmount", "Enter a positive fee amount with no more than two decimal places.");
  }
  const whole = BigInt(match[1]!);
  const cents = BigInt((match[2] ?? "").padEnd(2, "0"));
  const totalCents = whole * 100n + cents;
  if (totalCents <= 0n || totalCents > 99_999_999_999_999n) {
    throw new FeeRequestValidationError("feeAmount", "Enter a fee amount greater than zero.");
  }
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}

function parseWaiverStart(form: FormData): string {
  const value = String(form.get("waiverStart") ?? "").trim();
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  if (!match || year < 2020 || year > 2100 || month < 1 || month > 12) {
    throw new FeeRequestValidationError("waiverStart", "Choose a valid waiver start month and year.");
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-01`;
}

function parseTicketRefs(form: FormData): string[] {
  const raw = String(form.get("relevantTicketRefs") ?? "");
  const values = [...new Set(raw.split(/[\n,]/).map((value) => value.trim()).filter(Boolean))];
  if (values.length > 50 || values.some((value) => value.length > 80 || /[\u0000-\u001f]/.test(value))) {
    throw new FeeRequestValidationError("relevantTicketRefs", "Use at most 50 ticket references, each 80 characters or fewer.");
  }
  return values;
}

export function parseFeeRequestWorkflowForm(form: FormData): ParsedFeeRequestWorkflowAction {
  const requestId = String(form.get("requestId") ?? "").trim();
  if (requestId.length < 16 || requestId.length > 64 || /[^a-zA-Z0-9_-]/.test(requestId)) {
    throw new FeeRequestValidationError("requestId", "The request is invalid.");
  }
  const action = String(form.get("workflowAction") ?? "") as FeeRequestWorkflowAction;
  if (!FEE_REQUEST_WORKFLOW_ACTIONS.includes(action)) {
    throw new FeeRequestValidationError("workflowAction", "Choose a valid workflow action.");
  }
  const note = String(form.get("workflowNote") ?? "").trim();
  if (note.length > 1000) {
    throw new FeeRequestValidationError("workflowNote", "Keep the workflow note to 1,000 characters or fewer.");
  }
  if ((action === "REJECT" || action === "CANCEL") && !note) {
    throw new FeeRequestValidationError("workflowNote", "Add a reason before rejecting or cancelling this request.");
  }

  if (action !== "CREDIT") {
    return { requestId, action, note, creditedDate: null, apexRequestId: null };
  }

  const creditedDate = String(form.get("creditedDate") ?? "").trim();
  const parsedDate = new Date(`${creditedDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(creditedDate)
      || Number.isNaN(parsedDate.getTime())
      || parsedDate.toISOString().slice(0, 10) !== creditedDate) {
    throw new FeeRequestValidationError("creditedDate", "Choose a valid credited date.");
  }
  const apexRequestId = String(form.get("apexRequestId") ?? "").trim();
  if (!apexRequestId || apexRequestId.length > 80 || /[\u0000-\u001f]/.test(apexRequestId)) {
    throw new FeeRequestValidationError("apexRequestId", "Enter a valid Apex request ID.");
  }
  return { requestId, action, note, creditedDate, apexRequestId };
}

export function parseOperationsFeeRequestForm(form: FormData): ParsedOperationsFeeRequest {
  const kind = String(form.get("requestKind") ?? "") as OperationsFeeRequestKind;
  const clientSfId = parseClientSfId(form);
  const accountIds = parseAccountIds(form);
  const reason = String(form.get("reason") ?? "").trim();
  if (reason.length > 2000) {
    throw new FeeRequestValidationError("reason", "Keep the reason to 2,000 characters or fewer.");
  }

  if (kind === "FEE_CREDIT") {
    const allowed = new Set<string>(FEE_CREDIT_TYPES);
    const feeTypes = uniqueValues(form.getAll("feeTypes"));
    if (feeTypes.length === 0 || feeTypes.some((value) => !allowed.has(value))) {
      throw new FeeRequestValidationError("feeTypes", "Choose at least one valid fee type.");
    }
    return {
      kind,
      clientSfId,
      accountIds,
      feeTypes: feeTypes as FeeCreditType[],
      feeAmount: parseMoney(form.get("feeAmount")),
      waiverStart: null,
      waiverDurationMonths: null,
      indefiniteDuration: false,
      reason,
      relevantTicketRefs: parseTicketRefs(form),
    };
  }

  if (!EXCEPTION_TYPES.some((option) => option.value === kind)) {
    throw new FeeRequestValidationError("requestKind", "Choose a valid request type.");
  }
  if (!reason) {
    throw new FeeRequestValidationError("reason", "Explain why the exception is needed.");
  }
  const indefiniteDuration = form.get("indefiniteDuration") === "on";
  const durationValue = String(form.get("waiverDurationMonths") ?? "").trim();
  const waiverDurationMonths = indefiniteDuration ? null : Number(durationValue);
  if (!indefiniteDuration && (!Number.isInteger(waiverDurationMonths) || (waiverDurationMonths ?? 0) < 1 || (waiverDurationMonths ?? 0) > 120)) {
    throw new FeeRequestValidationError("waiverDurationMonths", "Enter a duration from 1 to 120 months, or choose indefinite.");
  }
  return {
    kind,
    clientSfId,
    accountIds,
    feeTypes: [],
    feeAmount: null,
    waiverStart: parseWaiverStart(form),
    waiverDurationMonths,
    indefiniteDuration,
    reason,
    relevantTicketRefs: parseTicketRefs(form),
  };
}
