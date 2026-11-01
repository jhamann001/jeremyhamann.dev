import { AcatRecord } from "./types";

export interface DataQualityFocus {
  ruleKey: string;
  title: string;
  detail: string;
  tab: "details" | "fees";
  field: keyof AcatRecord;
  fieldLabel: string;
}

interface FocusableException {
  ruleKey: string;
  title: string;
  detail: string;
}

const RULE_TARGETS: Record<string, Pick<DataQualityFocus, "tab" | "field" | "fieldLabel">> = {
  completed_missing_date: { tab: "details", field: "apexCompletionDate", fieldLabel: "Apex Completion Date" },
  rejected_missing_reason: { tab: "details", field: "rejectionReason", fieldLabel: "Rejection Reason" },
  submission_before_request: { tab: "details", field: "opsSubmissionDateToApex", fieldLabel: "Ops Submission Date to Apex" },
  completion_before_submission: { tab: "details", field: "apexCompletionDate", fieldLabel: "Apex Completion Date" },
  workflow_unclassified: { tab: "details", field: "transferWorkflow", fieldLabel: "Transfer Workflow" },
  missing_dtcc_number: { tab: "details", field: "dtccNumber", fieldLabel: "DTC Number" },
  invalid_dtcc_number: { tab: "details", field: "dtccNumber", fieldLabel: "DTC Number" },
  finalized_placeholder_control: { tab: "details", field: "controlNumber", fieldLabel: "Control Number" },
  manual_control_marker: { tab: "details", field: "controlNumber", fieldLabel: "Control Number" },
  duplicate_control: { tab: "details", field: "controlNumber", fieldLabel: "Control Number" },
  outgoing_positive_value: { tab: "details", field: "statementAmount", fieldLabel: "Statement Amount" },
  invalid_fee_amount: { tab: "fees", field: "feeAmount", fieldLabel: "Fee Amount" },
  fee_amount_format: { tab: "fees", field: "feeAmount", fieldLabel: "Fee Amount" },
  residual_missing_parent: { tab: "details", field: "associatedControlNumber", fieldLabel: "Associated Control Number" },
  residual_has_fee: { tab: "fees", field: "feeCharged", fieldLabel: "Fee Charged" },
  missing_crm_ticket: { tab: "details", field: "crmTicket", fieldLabel: "CRM Ticket" },
  residual_sweep_missing: { tab: "details", field: "residualMonitoringRequired", fieldLabel: "Residual Monitoring" },
};

const DATE_TARGETS: Array<Pick<DataQualityFocus, "field" | "fieldLabel">> = [
  { field: "originalClientRequestDate", fieldLabel: "Original Client Request Date" },
  { field: "opsSubmissionDateToApex", fieldLabel: "Ops Submission Date to Apex" },
  { field: "apexCompletionDate", fieldLabel: "Apex Completion Date" },
  { field: "residualFollowUpDate", fieldLabel: "Residual Follow-Up Date" },
];

export function dataQualityFocusFor(item: FocusableException): DataQualityFocus | undefined {
  let target = RULE_TARGETS[item.ruleKey];
  if (item.ruleKey === "invalid_date") {
    const dateTarget = DATE_TARGETS.find(({ fieldLabel }) => item.detail.startsWith(fieldLabel));
    if (dateTarget) target = { tab: "details", ...dateTarget };
  }
  if (!target) return undefined;
  return { ...item, ...target };
}
