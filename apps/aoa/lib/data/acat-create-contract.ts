// Tracker new-transfer contract for the AoA book. Field order, choices, copy,
// and required rules match transfer-tracker NewAcatModal on main.

export const CLIENT_SEARCH_MIN = 2;
export const CLIENT_SEARCH_MAX = 120;
export const CLIENT_SEARCH_LIMIT = 20;
export const CLIENT_SEARCH_DEBOUNCE_MS = 250;
export const MAX_SELECTED_CLIENTS = 10;
export const DISCARD_COPY = "Discard this unfinished transfer? Your entries will be lost.";
export const NO_MATCH_COPY = "No matching clients. Check the spelling or try another name.";
export const HAS_MORE_COPY = "More matches are available. Enter more of the name.";
export const NO_ACCOUNT_COPY = "No account number on file";
export const JOINT_COPY = "All selected people must be verified joint holders of the same Apex account. An account number is required.";
export const DIRECTORY_PAUSE = "Client directory verification is unavailable. Creation is paused.";
export const FEE_NOTICE_TITLE = "Outgoing ACAT fee check required";
export const FEE_NOTICE_BODY = "This record will default to Fee Charged = Yes and appear in Fee to Submit until the Apex charge and automatic reimbursement are documented.";

export const DIRECTION_OPTIONS = ["In", "Out"] as const;
export const WORKFLOW_OPTIONS = [
  ["UNCLASSIFIED", "Unclassified"],
  ["ACAT", "ACAT (API)"],
  ["MANUAL", "Manual"],
  ["DRS", "DRS"],
  ["RESIDUAL", "Residual"],
] as const;
export const TYPE_OPTIONS = ["Full", "Partial", "Residual Credit"] as const;
export const ACCOUNT_TYPE_OPTIONS = [
  "Brokerage / Individual",
  "Joint Account (JTWROS - Rights of Survivorship)",
  "Joint Account (TIC - Tenants in Common)",
  "Community Property Registration",
  "Traditional IRA",
  "Roth IRA",
  "Inherited Traditional IRA (w/ beneficiaries)",
  "Inherited Roth IRA",
  "Other",
] as const;
export const ADVISOR_OPTIONS = ["Rachel", "None"] as const;
export const METHOD_OPTIONS = ["API", "Full Docusign", "Partial Docusign", "Non-ACAT Transfer (Manual)", "N/A"] as const;
export const YES_NO_OPTIONS = ["Yes", "No"] as const;
export const STATUS_OPTIONS: { value: string; label: string }[] = [
  ["WaitingForApex", "Waiting for Apex"],
  ["PendingAccountOpening", "Pending Account Opening"],
  ["WaitingOnClient", "Waiting on Client"],
  ["WaitingForStatement", "Waiting for Statement"],
  ["AcatReceived", "ACAT Received"],
  ["ToCome", "To Come"],
  ["Submitted", "Submitted"],
  ["PendingReview", "Pending Review"],
  ["PendingContraResponse", "Pending Contra Response"],
  ["Accepted", "Accepted"],
  ["PendingSettlement", "Pending Settlement"],
  ["PendingBookkeeping", "Pending Bookkeeping"],
  ["Completed", "Completed"],
  ["Rejected", "Rejected"],
  ["Purged", "Purged"],
  ["Canceled", "Canceled"],
  ["Deferred", "Deferred"],
].map(([value, label]) => ({ value, label }));

export const FIELD_ORDER = [
  "Clients", "Control #", "ACAT Transfer ID", "Direction", "Transfer Workflow", "Type",
  "Account Type", "Status", "Advisor", "Apex Account #", "Statement Account #",
  "Transferring Contra", "DTCC #", "Statement Amount", "Request Method", "CRW EE?",
  "Original Client Request Date", "Ops Submission Date to Apex", "Apex Completion Date",
  "Monitor for a residual sweep", "Residual Follow-Up Date", "CRM Ticket", "Apex Ticket",
  "Additional Resources", "Trade Request ID", "Trade Request Link", "Trade Instructions", "Notes",
] as const;

export type AcatAccountHint = { custodian: string | null; maskedAccountNumber: string | null; relationshipType: string | null };
export type AcatClientResult = { cedarRidgeUserId: string; displayName: string; accountHints: AcatAccountHint[] };
export type AcatSelectedClient = { cedarRidgeUserId: string; displayName?: string };

export type AcatDirectoryStatus = {
  writeEligible: boolean;
  pendingAccountPolicy: string;
  health: string;
  enabled: boolean;
};

export type AcatCreateDraft = {
  selected: AcatSelectedClient[];
  controlNumber: string;
  associatedControlNumber: string;
  acatTransferId: string;
  direction: string;
  transferWorkflow: string;
  type: string;
  accountType: string;
  status: string;
  wealthAdvisor: string;
  apexAccountId: string;
  statementAccountNumber: string;
  transferringContra: string;
  dtccNumber: string;
  statementAmount: string;
  methodRequested: string[];
  crwEe: string;
  originalClientRequestDate: string;
  opsSubmissionDateToApex: string;
  apexCompletionDate: string;
  residualMonitoringRequired: boolean;
  residualFollowUpDate: string;
  crmTicket: string;
  apexTicket: string;
  additionalResources: string;
  tradeRequestId: string;
  tradeRequestUrl: string;
  tradeInstructions: string;
  notes: string;
  rejectionReason: string;
};

export function emptyCreateDraft(): AcatCreateDraft {
  return {
    selected: [],
    controlNumber: "", associatedControlNumber: "", acatTransferId: "", direction: "",
    transferWorkflow: "UNCLASSIFIED", type: "", accountType: "", status: "AcatReceived",
    wealthAdvisor: "", apexAccountId: "", statementAccountNumber: "", transferringContra: "",
    dtccNumber: "", statementAmount: "", methodRequested: [], crwEe: "",
    originalClientRequestDate: "", opsSubmissionDateToApex: "", apexCompletionDate: "",
    residualMonitoringRequired: false, residualFollowUpDate: "", crmTicket: "",
    apexTicket: "", additionalResources: "", tradeRequestId: "", tradeRequestUrl: "",
    tradeInstructions: "", notes: "", rejectionReason: "",
  };
}

export function parseStatementCents(input: string): number | null {
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export function signedStatementCents(cents: number, direction: string): number {
  return direction.trim().toLowerCase() === "out" ? -Math.abs(cents) : cents;
}

export function followUpOneWeek(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isStaleSearch(requestId: number, latestId: number): boolean {
  return requestId !== latestId;
}

export function clientSearchKey(key: string, highlight: number, count: number): { highlight: number; close: boolean; select: boolean } {
  switch (key) {
    case "ArrowDown": return { highlight: Math.min(highlight + 1, count - 1), close: false, select: false };
    case "ArrowUp": return { highlight: Math.max(highlight - 1, 0), close: false, select: false };
    case "Enter": return { highlight, close: false, select: highlight >= 0 && highlight < count };
    case "Escape": return { highlight, close: true, select: false };
    default: return { highlight, close: false, select: false };
  }
}

export function textEditKey(key: string, isTextarea: boolean): "newline" | "commit" | "cancel" | "none" {
  if (key === "Enter") return isTextarea ? "newline" : "commit";
  if (key === "Escape") return "cancel";
  return "none";
}

export function confirmClose(dirty: boolean, accepted: boolean): "close" | "stay" {
  return !dirty || accepted ? "close" : "stay";
}

export function canAddClient(count: number): boolean {
  return count < MAX_SELECTED_CLIENTS;
}

export function filterContras(names: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return names;
  return names.filter((name) => name.toLowerCase().includes(q));
}

export function suggestDtcc(
  contras: { name: string; dtcNumber: string | null }[],
  contra: string,
  manuallyEdited: boolean,
): string | null {
  const wanted = contra.trim().toLowerCase();
  if (manuallyEdited || wanted === "") return null;
  const numbers = contras
    .filter((c) => c.name.trim().toLowerCase() === wanted)
    .map((c) => (c.dtcNumber ?? "").trim())
    .filter((n) => /^\d{1,4}$/.test(n));
  return numbers.length === 1 ? numbers[0].padStart(4, "0") : null;
}

export function residualControlShown(draft: Pick<AcatCreateDraft, "type" | "direction">): boolean {
  return (draft.type === "Full" && draft.direction === "In")
    || (draft.direction === "Out" && draft.type !== "Residual Credit");
}

export function feeNoticeShown(draft: Pick<AcatCreateDraft, "type" | "direction">): boolean {
  return draft.direction === "Out" && draft.type === "Full";
}

export function missingRequired(draft: AcatCreateDraft, directory: AcatDirectoryStatus | null): string[] {
  const missing: string[] = [];
  if (!directory) missing.push("Client directory status");
  else if (directory.writeEligible !== true) missing.push("Client directory verification");
  if (draft.selected.length === 0) missing.push("Client selection");
  if (draft.direction.trim() === "") missing.push("Direction");
  if (draft.transferWorkflow === "UNCLASSIFIED") missing.push("Transfer Workflow");
  const pendingAllowed = draft.selected.length === 1
    && directory?.pendingAccountPolicy === "PENDING_ACCOUNT_OPENING_ONLY"
    && draft.status === "PendingAccountOpening";
  if (draft.apexAccountId.trim() === "" && !pendingAllowed) missing.push("Apex Account #");
  if (draft.status === "Rejected" && draft.rejectionReason.trim() === "") missing.push("Rejection Reason");
  return missing;
}

export type AcatCreateSection = "core" | "accounts" | "dates" | "tickets" | "other";

const SECTION_OF_MISSING: Record<string, AcatCreateSection> = {
  "Client selection": "core",
  "Client directory status": "core",
  "Client directory verification": "core",
  Direction: "core",
  "Transfer Workflow": "core",
  "Apex Account #": "accounts",
  "Rejection Reason": "other",
};

export function sectionIncomplete(missing: string[]): Set<AcatCreateSection> {
  return new Set(missing.map((name) => SECTION_OF_MISSING[name]).filter(Boolean));
}

const OPTIONAL_TEXT = [
  "controlNumber", "acatTransferId", "direction", "type", "accountType", "wealthAdvisor",
  "statementAccountNumber", "transferringContra", "dtccNumber", "crwEe",
  "originalClientRequestDate", "opsSubmissionDateToApex", "apexCompletionDate",
  "crmTicket", "apexTicket", "additionalResources", "tradeRequestId", "tradeRequestUrl",
  "tradeInstructions", "notes",
] as const;

export type AcatCreateBody = Record<string, string | number | boolean | string[]>;

export function buildAcatCreateBody(
  draft: AcatCreateDraft,
  directory: AcatDirectoryStatus | null,
  today: string = new Date().toISOString().slice(0, 10),
): { ok: true; body: AcatCreateBody } | { ok: false; reason: string } {
  const missing = missingRequired(draft, directory);
  if (missing.length > 0) return { ok: false, reason: `Still needed: ${missing.join(", ")}` };
  const statementText = draft.statementAmount.trim();
  const cents = statementText === "" ? null : parseStatementCents(statementText);
  if (statementText !== "" && cents === null) return { ok: false, reason: "Invalid Statement Amount" };

  const body: AcatCreateBody = {
    cedarRidgeUserIds: draft.selected.slice(0, MAX_SELECTED_CLIENTS).map((c) => c.cedarRidgeUserId),
  };
  for (const key of OPTIONAL_TEXT) {
    const value = draft[key].trim();
    if (value !== "") body[key] = value;
  }
  const methods = draft.methodRequested.map((m) => m.trim()).filter(Boolean);
  if (methods.length > 0) body.methodRequested = methods.join(", ");
  body.status = draft.status || "AcatReceived";
  body.transferWorkflow = draft.transferWorkflow;
  body.apexAccountId = draft.apexAccountId.trim();
  body.residualMonitoringRequired = draft.residualMonitoringRequired;
  if (cents !== null) body.statementAmount = cents;
  if (draft.residualMonitoringRequired && draft.residualFollowUpDate.trim() !== "") {
    body.residualFollowUpDate = draft.residualFollowUpDate.trim();
  }
  if (draft.type === "Residual Credit" && draft.associatedControlNumber.trim() !== "") {
    body.associatedControlNumber = draft.associatedControlNumber.trim();
  }
  if (draft.status === "Rejected") body.rejectionReason = draft.rejectionReason.trim();
  body.crmDealId = draft.crmTicket.trim() || draft.acatTransferId.trim() || "";
  body.acatDate = draft.originalClientRequestDate.trim() || today;
  return { ok: true, body };
}
