import { describe, expect, it } from "vitest";
import {
  STATUS_ACTIONS, STATUS_ACTION_COPY, canChangeStatus, isStatusActionTarget, statusUpdateFailedMessage, uncheckedWarningLead,
} from "@/lib/trade-requests/status-view";

// ticket: the reviewer status action catalog and copy (AC-43, AC-13, AC-88,
// AC-101, AC-102, AC-105). Synthetic values only.

describe("status action catalog (ticket)", () => {
  it("lists the standalone actions in order with their tooltips and target statuses (AC-43)", () => {
    expect(STATUS_ACTIONS.map(({ label, title, status }) => [label, title, status])).toEqual([
      ["Needs Info", "Return to advisor for more details", "Needs Info"],
      ["Pending Liquidation", "Mark as pending existing asset liquidation", "Pending Current Asset Liquidation"],
      ["Reject", "Permanently reject — record will be locked", "Rejected"],
      ["Approve & Execute", "Approve and send to execution", "Approved"],
    ]);
  });

  it("accepts only the four target statuses", () => {
    for (const action of STATUS_ACTIONS) expect(isStatusActionTarget(action.status)).toBe(true);
    for (const value of ["Pending Review", "Completed", "approved", "", null, 3]) expect(isStatusActionTarget(value)).toBe(false);
  });

  it("gives actions to ADMIN and OPERATIONS until a request is decided (AC-43, AC-13)", () => {
    for (const role of ["ADMIN", "OPERATIONS"]) {
      for (const status of ["Pending Review", "Needs Info", "Pending Current Asset Liquidation"]) expect(canChangeStatus(role, status)).toBe(true);
      for (const status of ["Approved", "Rejected", "Completed"]) expect(canChangeStatus(role, status)).toBe(false);
    }
    for (const role of ["ADVISOR", "CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY", ""]) expect(canChangeStatus(role, "Pending Review")).toBe(false);
  });

  it("words the approve warning for one and for several items (AC-88)", () => {
    expect(uncheckedWarningLead(1)).toBe("1 checklist item is still unchecked.");
    expect(uncheckedWarningLead(7)).toBe("7 checklist items are still unchecked.");
    expect(`${uncheckedWarningLead(3)}${STATUS_ACTION_COPY.warningRest}${STATUS_ACTION_COPY.warningLink}${STATUS_ACTION_COPY.warningEnd}`)
      .toBe("3 checklist items are still unchecked. You can approve anyway — confirm below — or finish the pre-approval checklist first.");
  });

  it("uses the standalone failure copy (AC-101, AC-102, AC-105)", () => {
    expect(STATUS_ACTION_COPY.actionFailed).toBe("Action failed. Please try again.");
    expect(statusUpdateFailedMessage("Request was modified by another user. Please refresh and try again."))
      .toBe("Status update failed: Request was modified by another user. Please refresh and try again.");
    expect(STATUS_ACTION_COPY.noteLabel).toBe("Add Note for Audit/Advisor:");
    expect(STATUS_ACTION_COPY.notePlaceholder).toBe("e.g., Client needs to sign form first...");
  });
});
