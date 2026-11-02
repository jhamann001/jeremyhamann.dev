// Pure rules for the paperwork section of the ACAT transfer drawer (ticket).
// No server-only import and no I/O, so the client component, the server actions
// and the tests share one source for labels, counts, readiness and the request.
// The recommendation itself comes from the tracker (ticket preparation
// endpoints, reused by ticket); nothing here decides a form, it only checks
// that the operator's choices are complete before a request is built.

import {
  generateTransferFormSchema,
  type GenerateTransferForm,
  type TransferFormFailureReason,
  type TransferFormPreparation,
} from "./transfer-form-contract";

export type PaperworkWorkflow = TransferFormPreparation["workflows"][number];
export type PaperworkPosition = TransferFormPreparation["positions"][number];
export type PaperworkInstruction = "IN_KIND" | "LIQUIDATE";
export type PaperworkFailureReason = TransferFormFailureReason | "off";

export const PAPERWORK_TEMPLATE_LABELS = {
  APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST: "Apex Customer Account Transfer Request",
  EMPOWER_WITHDRAWAL_DIRECT_ROLLOVER_TRANSFER_REQUEST: "Empower Withdrawal / Direct Rollover Transfer Request",
} as const;

export const PAPERWORK_FAILURE_COPY: Record<PaperworkFailureReason, string> = {
  disabled: "Paperwork is not connected in this environment yet.",
  forbidden: "You don't have access to this transfer's paperwork.",
  invalid: "Some paperwork details are invalid. Check your entries and try again.",
  not_found: "This transfer is no longer available. Refresh before continuing.",
  stale: "The transfer changed. Refresh and review the current details before continuing.",
  unavailable: "The request could not be completed. Retry to check the same request.",
  review_required: "More review is required. Refresh to see the current requirements.",
  off: "Paperwork is not available.",
};

export const PAPERWORK_WATCHOUTS_FAILURE = "The custodian watchouts could not be loaded.";
export const PAPERWORK_HISTORY_FAILURE = "The document history could not be loaded.";
export const PAPERWORK_NO_DOCUMENTS = "No documents yet";
export const PAPERWORK_NO_CUSTODIAN = "No custodian playbook matched this transfer.";
export const PAPERWORK_NOT_DOCUMENTED = "Not documented";
export const PAPERWORK_SAVE_FAILED = "The form was generated and saved to the document history, but the download did not start.";

/** Custodian rules and watchouts, as read live from the library. */
export type PaperworkCustodian = {
  id: string;
  name: string;
  reviewStatus: string;
  watchouts: string | null;
  letterOfAcceptance: string | null;
  receivingAccountNumber: string | null;
  medallionRequired: string | null;
  signature: string | null;
  returnMethod: string | null;
  liquidationMethod: string | null;
};

/** The operator's unsaved choices for one packet. Every edit clears `reviewed`. */
export type PaperworkDraft = {
  workflowId: string;
  instruction: "" | PaperworkInstruction | "MIXED";
  positionInstructions: Record<string, PaperworkInstruction | undefined>;
  deliveringTitle: string;
  houseAccount: string;
  houseVerified: boolean;
  letterRequired: boolean;
  reviewed: boolean;
};

export function handlingSummary(workflow: Pick<PaperworkWorkflow, "handling">): string {
  const { mode, options } = workflow.handling;
  if (mode === "FIXED") {
    return options[0] === "LIQUIDATE" ? "Asset handling: Liquidate only" : "Asset handling: In kind only";
  }
  return "Asset handling: Client-directed — in kind or liquidate";
}

export function partialCounts(data: Pick<TransferFormPreparation, "scope" | "positions">) {
  const included = data.positions.filter((position) => position.include === true).length;
  const excluded = data.positions.filter((position) => position.include === false).length;
  const undecided = data.positions.filter((position) => position.include === null).length;
  return { required: data.scope === "PARTIAL", total: data.positions.length, included, excluded, undecided };
}

export function receivingConfirmed(data: Pick<TransferFormPreparation, "confirmation">): boolean {
  return Boolean(data.confirmation?.valid && data.confirmation.id);
}

export function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function includedPositions(data: Pick<TransferFormPreparation, "positions">): PaperworkPosition[] {
  return data.positions.filter((position) => position.include === true);
}

export function supportsMixed(data: Pick<TransferFormPreparation, "scope">, workflow: PaperworkWorkflow | undefined): boolean {
  return data.scope === "PARTIAL" && workflow?.automated === true && workflow.handling.mode === "CLIENT_DIRECTED"
    && workflow.handling.options.includes("IN_KIND") && workflow.handling.options.includes("LIQUIDATE");
}

/** The instruction that applies: the fixed option, or the operator's choice. */
export function effectiveInstruction(workflow: PaperworkWorkflow | undefined, draft: Pick<PaperworkDraft, "instruction">) {
  if (!workflow) return "" as const;
  return workflow.handling.mode === "FIXED" ? workflow.handling.options[0] : draft.instruction;
}

function handlingComplete(data: TransferFormPreparation, workflow: PaperworkWorkflow, draft: PaperworkDraft): boolean {
  const instruction = effectiveInstruction(workflow, draft);
  if (!instruction) return false;
  if (instruction !== "MIXED") return workflow.handling.options.includes(instruction);
  if (!supportsMixed(data, workflow)) return false;
  const included = includedPositions(data);
  const chosen = included.map((position) => draft.positionInstructions[position.id]);
  return included.length >= 2 && chosen.every((value) => value === "IN_KIND" || value === "LIQUIDATE")
    && chosen.includes("IN_KIND") && chosen.includes("LIQUIDATE");
}

export function titlesDiffer(data: TransferFormPreparation, deliveringTitle: string): boolean {
  return data.inheritedTitleReview && data.confirmation !== null
    && normalizeTitle(deliveringTitle) !== normalizeTitle(data.confirmation.title);
}

/** The first missing step, in the order an operator should take them. */
export function paperworkReadiness(data: TransferFormPreparation, draft: PaperworkDraft): { ready: boolean; reason: string } {
  const stop = (reason: string) => ({ ready: false, reason });
  const blocker = data.blockers.find((item) => item.code !== "receiving_confirmation");
  if (blocker) return stop(blocker.message);
  if (!receivingConfirmed(data)) return stop("Confirm and save the receiving account title first.");
  if (data.direction !== "INCOMING") return stop("Automatic form preparation supports incoming transfers only.");
  if (data.scope === "UNKNOWN") return stop("Confirm the transfer scope in Transfer Tracker, then refresh.");
  const counts = partialCounts(data);
  if (counts.required && counts.undecided > 0) {
    return stop(`Decide whether to include ${counts.undecided} undecided holding${counts.undecided === 1 ? "" : "s"} in Transfer Tracker, then refresh.`);
  }
  if (counts.required && counts.included === 0) return stop("Select at least one holding in Transfer Tracker, then refresh.");
  const workflow = data.workflows.find((item) => item.id === draft.workflowId);
  if (!workflow) return stop("Choose a form workflow.");
  if (!workflow.automated) return stop("This form route needs manual preparation in Transfer Tracker.");
  if (!handlingComplete(data, workflow, draft)) return stop("Choose how the assets should transfer.");
  if (workflow.requiresReceivingAccountNumber && !(draft.houseAccount.trim() && draft.houseVerified)) {
    return stop("Verify the receiving / house account number with Apex MF Ops.");
  }
  if (!draft.deliveringTitle.trim()) return stop("Enter the exact delivering account title.");
  if (titlesDiffer(data, draft.deliveringTitle) && !draft.letterRequired) {
    return stop("Confirm the separate Letter of Authorization for the different account titles.");
  }
  if (!draft.reviewed) return stop("Check the final review confirmation to download the form.");
  return { ready: true, reason: "" };
}

/** The request the tracker generates from; `null` until the packet is ready. */
export function buildPaperworkRequest(data: TransferFormPreparation, draft: PaperworkDraft, operationId: string): GenerateTransferForm | null {
  if (!paperworkReadiness(data, draft).ready) return null;
  const workflow = data.workflows.find((item) => item.id === draft.workflowId);
  const instruction = effectiveInstruction(workflow, draft);
  if (!workflow || !instruction || !data.confirmation?.id) return null;
  const parsed = generateTransferFormSchema.safeParse({
    expectedRevision: data.sourceRevision,
    confirmationId: data.confirmation.id,
    operationId,
    workflowId: workflow.id,
    assetInstruction: instruction,
    deliveringTitle: draft.deliveringTitle.trim(),
    deliveringTitleConfirmed: true,
    accountsReviewed: true,
    instructionsReviewed: true,
    letterOfAuthorizationRequired: draft.letterRequired,
    ...(instruction === "MIXED"
      ? {
        positionInstructions: includedPositions(data).map((position) => ({
          positionId: position.id, assetInstruction: draft.positionInstructions[position.id],
        })),
      }
      : {}),
    ...(workflow.requiresReceivingAccountNumber
      ? { receivingAccountNumber: draft.houseAccount.trim(), receivingAccountNumberVerified: true }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}
