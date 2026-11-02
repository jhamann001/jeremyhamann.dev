import type { AcatStatus } from "@/lib/data/acat-status";
import type { CustodianLibrary, CustodianProfile } from "@/lib/data/custodian-library-contract";
import {
  MANUAL_TRANSFER_CATALOG_VERSION,
  MANUAL_TRANSFER_FORM_RULES,
  type ManualFormTemplateKey,
  type ManualTransferFormRule,
} from "./manual-transfer-catalog";

export interface PreparationChoices {
  custodianId?: string;
  workflowId?: string;
}

export interface PreparationContext {
  recordId: string;
  record: Pick<AcatStatus, "direction" | "type" | "accountType" | "transferringContra">;
  library: CustodianLibrary;
}

type CustodianIdentity = Pick<CustodianProfile, "id" | "name">;

export interface TransferPreparation {
  recordId: string;
  /** A reviewable, unsaved plan. No result represents generation readiness. */
  status: "REVIEW_REQUIRED";
  direction: "INCOMING" | "OUTGOING" | "UNKNOWN";
  scope: "FULL" | "PARTIAL" | "UNKNOWN";
  custodianMatch: {
    status: "MATCHED" | "CONFIRMATION_REQUIRED" | "AMBIGUOUS" | "UNKNOWN";
    recordedName: string | null;
    selected: CustodianIdentity | null;
    candidates: CustodianIdentity[];
  };
  candidateWorkflows: readonly ManualTransferFormRule[];
  selectedWorkflow: ManualTransferFormRule | null;
  sourceRequirements: { field: string; label: string; value: string | null }[];
  reviewItems: {
    code: string;
    category: "MISSING_INFORMATION" | "CONFIRMATION" | "UNSUPPORTED";
    message: string;
  }[];
  proposedTasks: { id: string; owner: "CS" | "Operations"; title: string; detail: string }[];
  selectedForm: {
    name: string;
    template: ManualFormTemplateKey;
    /** Support in the existing Tracker, not generation support in this view. */
    support: "TRACKER_AUTOMATED" | "MANUAL_ONLY";
  } | null;
  cautions: string[];
  ruleVersion: string;
  libraryRetrievedAt: string;
  custodianReviewStatus: string | null;
}

export const TRANSFER_PREPARATION_RULE_VERSION =
  `aoa-transfer-preparation-v1 / ${MANUAL_TRANSFER_CATALOG_VERSION}`;

// Only case and whitespace normalization. No aliases, substring or fuzzy match.
function normalized(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

function identity(custodian: CustodianProfile): CustodianIdentity {
  return { id: custodian.id, name: custodian.name };
}

function sourceRequirements(custodian: CustodianProfile | null): TransferPreparation["sourceRequirements"] {
  if (!custodian) return [];
  return [
    { field: "transferType", label: "Documented transfer route", value: custodian.transferType },
    { field: "documentationStatus", label: "Documentation status", value: custodian.documentationStatus },
    { field: "signature", label: "Signature requirements", value: custodian.signature },
    { field: "letterOfAcceptance", label: "Letter of Acceptance", value: custodian.letterOfAcceptance },
    { field: "medallionRequired", label: "Medallion requirements", value: custodian.medallionRequired },
    { field: "liquidationMethod", label: "Liquidation guidance", value: custodian.liquidationMethod },
    { field: "returnMethod", label: "Return method", value: custodian.returnMethod },
    { field: "watchouts", label: "Custodian watchouts", value: custodian.watchouts },
  ];
}

/**
 * Explicitly offered only for a currently VERIFIED, ACAT_API library profile.
 * This is a review candidate, not the Tracker's unknown-custodian fallback.
 */
function standardBrokerageCandidate(custodian: CustodianProfile): ManualTransferFormRule {
  return {
    id: "verified-acat-brokerage",
    custodianName: custodian.name,
    displayName: "Standard brokerage transfer (confirm route)",
    template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
    apexTransferSelection: "BROKERAGE_FIRM_TRANSFER",
    note: "The current library identifies this custodian as ACAT_API. Confirm the record's actual route and the client's instructions before preparing paperwork.",
  };
}

export function resolveTransferPreparation(
  context: PreparationContext,
  choices: PreparationChoices = {},
): TransferPreparation {
  const { record, library } = context;
  const reviewItems: TransferPreparation["reviewItems"] = [];
  const addReview = (
    code: string,
    category: TransferPreparation["reviewItems"][number]["category"],
    message: string,
  ) => reviewItems.push({ code, category, message });

  const directionText = normalized(record.direction);
  const direction = ["incoming", "in"].includes(directionText) ? "INCOMING"
    : ["outgoing", "out"].includes(directionText) ? "OUTGOING" : "UNKNOWN";
  const scopeText = normalized(record.type);
  const scope = ["full account transfer", "full"].includes(scopeText) ? "FULL"
    : ["partial transfer", "partial account transfer", "partial"].includes(scopeText) ? "PARTIAL" : "UNKNOWN";
  if (direction === "UNKNOWN") {
    addReview("VERIFY_DIRECTION", "MISSING_INFORMATION", "Confirm whether this transfer is incoming or outgoing; the recorded direction is missing or unrecognized.");
  } else if (direction === "OUTGOING") {
    addReview("OUTGOING_NOT_SUPPORTED", "UNSUPPORTED", "This catalog covers incoming transfers. Operations must review the outgoing route and paperwork separately.");
  }
  if (scope === "UNKNOWN") {
    addReview("VERIFY_TRANSFER_SCOPE", "MISSING_INFORMATION", "Confirm full or partial transfer scope; the recorded type is missing or unrecognized.");
  }

  const contra = normalized(record.transferringContra);
  const matches = contra ? library.custodians.filter((c) => normalized(c.name) === contra) : [];
  let custodian: CustodianProfile | null = null;
  let matchStatus: TransferPreparation["custodianMatch"]["status"];
  if (choices.custodianId !== undefined) {
    const chosen = library.custodians.filter((c) => c.id === choices.custodianId);
    custodian = chosen.length === 1 ? chosen[0] : null;
    matchStatus = custodian ? "CONFIRMATION_REQUIRED" : "UNKNOWN";
    if (custodian) {
      addReview("CONFIRM_CUSTODIAN_SELECTION", "CONFIRMATION", "Confirm the selected custodian against the current statement. This choice applies only to this unsaved plan.");
    } else {
      addReview("INVALID_CUSTODIAN_SELECTION", "MISSING_INFORMATION", "The chosen custodian is unavailable or ambiguous. Select a current library record and confirm its identity.");
    }
  } else if (matches.length === 1) {
    custodian = matches[0];
    matchStatus = "MATCHED";
  } else if (matches.length > 1) {
    matchStatus = "AMBIGUOUS";
    addReview("AMBIGUOUS_CUSTODIAN", "CONFIRMATION", "Multiple library records have this custodian name. Select the correct record using the current documentation.");
  } else {
    matchStatus = "UNKNOWN";
    addReview("UNKNOWN_CUSTODIAN", "MISSING_INFORMATION", "The recorded custodian has no exact library match. Confirm the firm against the statement and select its library record.");
  }
  if (custodian && custodian.reviewStatus !== "VERIFIED") {
    addReview("VERIFY_CUSTODIAN_PLAYBOOK", "CONFIRMATION", "The current custodian profile is not marked verified. Operations must review its requirements against current documentation.");
  }

  let candidateWorkflows: readonly ManualTransferFormRule[] = [];
  if (custodian && direction === "INCOMING" && scope !== "UNKNOWN") {
    candidateWorkflows = MANUAL_TRANSFER_FORM_RULES.filter((rule) => normalized(rule.custodianName) === normalized(custodian.name));
    if (candidateWorkflows.length === 0 && custodian.reviewStatus === "VERIFIED" && custodian.transferType === "ACAT_API") {
      candidateWorkflows = [standardBrokerageCandidate(custodian)];
    }
    if (candidateWorkflows.length === 0) {
      addReview("NO_SUPPORTED_WORKFLOW", "UNSUPPORTED", "No reviewed form workflow is available for this custodian and route. Operations must confirm the applicable paperwork.");
    }
  }

  let selectedWorkflow: ManualTransferFormRule | null = null;
  if (choices.workflowId !== undefined) {
    selectedWorkflow = candidateWorkflows.find((rule) => rule.id === choices.workflowId) ?? null;
    if (!selectedWorkflow) {
      addReview("INVALID_WORKFLOW_SELECTION", "CONFIRMATION", "The chosen workflow is not available for the current custodian, direction and scope. Review the available routes again.");
    }
  } else if (candidateWorkflows.length === 1) {
    selectedWorkflow = candidateWorkflows[0];
  }
  if (candidateWorkflows.length > 1 && !selectedWorkflow) {
    addReview("SELECT_FORM_WORKFLOW", "CONFIRMATION", "Select the form workflow supported by the current client documentation. The custodian name alone does not determine the route.");
  }

  addReview("VERIFY_SOURCE_ACCOUNT_DETAILS", "MISSING_INFORMATION", "Confirm the exact delivering and receiving account titles and numbers against current documents.");
  addReview("VERIFY_RECORDED_WORKFLOW", "MISSING_INFORMATION", "Confirm the route recorded in Transfer Tracker and verify it against current documentation.");
  addReview("VERIFY_CURRENT_DOCUMENTATION", "CONFIRMATION", "Review the current statement, any holdings changes and the client's instructions. Confirm which conditional custodian requirements apply.");
  if (!normalized(record.accountType)) {
    addReview("VERIFY_ACCOUNT_TYPE", "MISSING_INFORMATION", "Confirm the delivering and receiving account registrations and account types.");
  }
  if (scope === "PARTIAL") {
    addReview("CONFIRM_PARTIAL_POSITIONS", "MISSING_INFORMATION", "Confirm which positions, quantities and cash will transfer and which will remain.");
  }
  const accountType = normalized(record.accountType);
  const joint = /\b(joint|jtwros|tic)\b|\btenants in common\b/.test(accountType);
  const inherited = /\binherited\b/.test(accountType);
  if (joint) {
    addReview("VERIFY_JOINT_SIGNERS", "CONFIRMATION", "Joint account: verify both account holders, receiving registration and the signatures required by the selected form and custodian.");
  }
  if (inherited) {
    addReview("VERIFY_INHERITED_TITLES", "CONFIRMATION", "Inherited account: compare the exact delivering and receiving titles. Operations must determine any additional authorization paperwork; a Letter of Acceptance is a separate requirement.");
  }
  if (selectedWorkflow) {
    if (selectedWorkflow.generationSupport === "MANUAL_ONLY") {
      addReview("MANUAL_FORM_WORKFLOW", "UNSUPPORTED", "This route uses the separate Empower withdrawal/direct rollover form and requires manual preparation. Do not substitute the Apex transfer form.");
    } else if (selectedWorkflow.assetHandling?.mode === "FIXED") {
      addReview("CONFIRM_FIXED_ASSET_INSTRUCTION", "CONFIRMATION", "This form route calls for liquidation. Confirm that it matches the client's instructions and current documentation.");
    } else {
      addReview("CONFIRM_ASSET_INSTRUCTIONS", "MISSING_INFORMATION", "Confirm the client's in-kind or liquidation instructions.");
    }
    if (selectedWorkflow.requiresVerifiedReceivingAccountNumber) {
      addReview("VERIFY_RECEIVING_HOUSE_ACCOUNT", "CONFIRMATION", "Verify the receiving/house account number with Apex MF Ops. A historical library value is not sufficient for form preparation.");
    }
    if (selectedWorkflow.apexSignatureRequirement === "WET_REQUIRED") {
      addReview("CONFIRM_WET_SIGNATURE", "CONFIRMATION", "The selected catalog variant specifies a wet signature. Confirm the current form and custodian instructions and plan the signature step.");
    }
  }

  const proposedTasks: TransferPreparation["proposedTasks"] = [
    { id: "confirm-client-instructions", owner: "CS", title: "Confirm the transfer instructions", detail: scope === "PARTIAL" ? "Confirm the selected positions, quantities, cash and holdings to remain, plus in-kind or liquidation instructions." : "Confirm transfer scope and the client's in-kind or liquidation instructions against the current request." },
    { id: "verify-transfer-details", owner: "Operations", title: "Verify the accounts and transfer route", detail: "Check current statements, exact account titles and numbers, the custodian and carrying firm, and the route recorded in Transfer Tracker." },
  ];
  if (custodian) {
    proposedTasks.push({ id: "review-custodian-requirements", owner: "Operations", title: "Review custodian requirements", detail: "Determine which documented forms, signatures, Letter of Acceptance, medallion and return instructions apply. Confirm fee conditions separately; preserve any unresolved requirements for review." });
  }
  if (joint || inherited) {
    proposedTasks.push({ id: "verify-account-registration", owner: "Operations", title: "Review account registration and signers", detail: "Confirm all account holders and required signers. For inherited accounts, verify exact titles and determine whether separate authorization paperwork is needed." });
  }
  if (selectedWorkflow) {
    proposedTasks.push({ id: "prepare-paperwork", owner: "CS", title: selectedWorkflow.generationSupport === "MANUAL_ONLY" ? "Prepare the manual form after review" : "Prepare the transfer paperwork after review", detail: `${selectedWorkflow.displayName}: resolve the missing information and confirmations first, then prepare the appropriate forms and supporting documents using the existing approved process.` });
    proposedTasks.push({ id: "review-packet", owner: "Operations", title: "Review the completed packet", detail: "Check the paperwork against the verified instructions and current source documents before arranging signatures or submission." });
  }

  const cautions = [
    "This is an unsaved requirements and task plan. It does not generate forms, create tasks, approve instructions or submit a transfer.",
    "Conditional library wording is reproduced as reference information. Letter of Acceptance and Letter of Authorization are distinct documents.",
    "Historical form routing, addresses, DTC values and asset defaults require verification against current client-specific documentation.",
  ];
  if (selectedWorkflow?.note) cautions.push(selectedWorkflow.note);
  if (scope === "PARTIAL" && selectedWorkflow) {
    cautions.push("For a partial transfer, verify the correct form sections and selected positions; a catalog section describing a full transfer or full liquidation does not authorize moving all assets.");
  }
  if (selectedWorkflow?.assetHandling?.mode === "CLIENT_DIRECTED" && selectedWorkflow.assetHandling.watchout) {
    cautions.push(selectedWorkflow.assetHandling.watchout);
  }

  return {
    recordId: context.recordId,
    status: "REVIEW_REQUIRED",
    direction,
    scope,
    custodianMatch: { status: matchStatus, recordedName: record.transferringContra, selected: custodian ? identity(custodian) : null, candidates: matches.map(identity) },
    candidateWorkflows,
    selectedWorkflow,
    sourceRequirements: sourceRequirements(custodian),
    reviewItems,
    proposedTasks,
    selectedForm: selectedWorkflow ? {
      name: selectedWorkflow.template === "EMPOWER_WITHDRAWAL_DIRECT_ROLLOVER_TRANSFER_REQUEST" ? "Empower withdrawal / direct rollover / transfer request" : "Apex Customer Account Transfer Request",
      template: selectedWorkflow.template,
      support: selectedWorkflow.generationSupport === "MANUAL_ONLY" ? "MANUAL_ONLY" : "TRACKER_AUTOMATED",
    } : null,
    cautions,
    ruleVersion: TRANSFER_PREPARATION_RULE_VERSION,
    libraryRetrievedAt: library.retrievedAt,
    custodianReviewStatus: custodian?.reviewStatus ?? null,
  };
}
