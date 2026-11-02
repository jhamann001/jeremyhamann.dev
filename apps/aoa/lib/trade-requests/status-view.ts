import { isTerminalStatus } from "./checklist-view";

// Standalone copy (trade-request client/src/components/RequestModal.tsx, App.tsx), verbatim.
export const STATUS_ACTION_COPY = {
  noteLabel: "Add Note for Audit/Advisor:",
  notePlaceholder: "e.g., Client needs to sign form first...",
  cancel: "Cancel",
  confirm: "Confirm",
  processing: "Processing...",
  actionFailed: "Action failed. Please try again.",
  warningRest: " You can approve anyway — confirm below — or finish the ",
  warningLink: "pre-approval checklist",
  warningEnd: " first.",
} as const;

export const STATUS_NOTE_MAX = 2000;

export type StatusActionKey = "needsInfo" | "liquidation" | "reject" | "approve";
export type StatusActionTone = "caution" | "primary" | "danger" | "ok";

export type StatusActionDef = { key: StatusActionKey; label: string; title: string; status: string; tone: StatusActionTone };

/** The reviewer's actions in the standalone order, with the status each one sets. */
export const STATUS_ACTIONS: readonly StatusActionDef[] = [
  { key: "needsInfo", label: "Needs Info", title: "Return to advisor for more details", status: "Needs Info", tone: "caution" },
  {
    key: "liquidation", label: "Pending Liquidation", title: "Mark as pending existing asset liquidation",
    status: "Pending Current Asset Liquidation", tone: "primary",
  },
  { key: "reject", label: "Reject", title: "Permanently reject — record will be locked", status: "Rejected", tone: "danger" },
  { key: "approve", label: "Approve & Execute", title: "Approve and send to execution", status: "Approved", tone: "ok" },
];

const TARGETS = new Set(STATUS_ACTIONS.map((action) => action.status));
const REVIEWER_ROLES = new Set(["ADMIN", "OPERATIONS"]);

export function isStatusActionTarget(value: unknown): value is string {
  return typeof value === "string" && TARGETS.has(value);
}

/** Reviewers act on a request until it is Approved, Rejected or Completed. */
export function canChangeStatus(role: string, status: string): boolean {
  return REVIEWER_ROLES.has(role) && !isTerminalStatus(status);
}

/** The first sentence of the approve warning; the rest is STATUS_ACTION_COPY.warning*. */
export function uncheckedWarningLead(unchecked: number): string {
  return unchecked === 1 ? "1 checklist item is still unchecked." : `${unchecked} checklist items are still unchecked.`;
}

export function statusUpdateFailedMessage(reason: string): string {
  return `Status update failed: ${reason}`;
}

export type StatusChange = { status: string; note: string; expectedUpdatedAt: string };
export type StatusChangeResult = { ok: true } | { ok: false; message: string };
