import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";
import {
  ADVISOR_STATUS_LABELS,
  ADVISOR_TERMINAL_STATUSES,
  advisorStatusLabel,
  filterAdvisorTransfers,
  formatAdvisorDate,
  formatAdvisorValue,
  isAdvisorTerminal,
  type AdvisorTransferRow,
} from "@/lib/transfers/advisor-transfer-status";

const SUITE = "advisor-transfer-status";

function row(over: Partial<AdvisorTransferRow> & Pick<AdvisorTransferRow, "id">): AdvisorTransferRow {
  return {
    clientName: "Client",
    status: "Submitted",
    direction: null,
    type: null,
    accountType: null,
    transferringContra: null,
    wealthAdvisor: null,
    additionalResources: null,
    originalClientRequestDate: null,
    opsSubmissionDateToApex: null,
    apexCompletionDate: null,
    acatDate: "2026-04-01",
    statementAmount: null,
    custodian: null,
    ...over,
  };
}

describe("advisor transfer status helpers", () => {
  it("labels every tracker status exactly as the tracker does", () => {
    // Pinned from tracker 25555c2 src/lib/types.ts ACAT_STATUS_LABELS.
    expect(ADVISOR_STATUS_LABELS).toEqual({
      WaitingForApex: "Waiting for Apex",
      PendingAccountOpening: "Pending Account Opening",
      WaitingOnClient: "Waiting on Client",
      WaitingForStatement: "Waiting for Statement",
      AcatReceived: "ACAT Received",
      ToCome: "To Come",
      Submitted: "Submitted",
      PendingReview: "Pending Review",
      PendingContraResponse: "Pending Contra Response",
      Accepted: "Accepted",
      PendingSettlement: "Pending Settlement",
      PendingBookkeeping: "Pending Bookkeeping",
      Matched: "Recon: Matched",
      Mismatch: "Recon: Mismatch",
      Pending: "Recon: Pending",
      Completed: "Completed",
      Rejected: "Rejected",
      Purged: "Purged",
      Canceled: "Canceled",
      Deferred: "Deferred",
    });
    expect(advisorStatusLabel("WaitingForStatement")).toBe("Waiting for Statement");
    expect(advisorStatusLabel("SomethingNew")).toBe("SomethingNew");
    expect(advisorStatusLabel("constructor")).toBe("constructor");
    markCase(SUITE, "labels every tracker status exactly as the tracker does");
  });

  it("treats Completed Rejected Purged Canceled and Deferred as terminal", () => {
    expect([...ADVISOR_TERMINAL_STATUSES].sort()).toEqual(["Canceled", "Completed", "Deferred", "Purged", "Rejected"]);
    for (const status of ["Completed", "Rejected", "Purged", "Canceled", "Deferred"]) {
      expect(isAdvisorTerminal(status)).toBe(true);
    }
    for (const status of ["Submitted", "PendingSettlement", "Matched", "SomethingNew"]) {
      expect(isAdvisorTerminal(status)).toBe(false);
    }
    markCase(SUITE, "treats Completed Rejected Purged Canceled and Deferred as terminal");
  });

  it("filters Active All Completed and searches client contra and advisor together", () => {
    const rows = [
      row({ id: "a", clientName: "Daniel Chen", status: "Submitted", transferringContra: "Fidelity", wealthAdvisor: "Rachel", acatDate: "2026-01-02" }),
      row({ id: "b", clientName: "Grace Hopper", status: "Completed", transferringContra: "Schwab", wealthAdvisor: "Reynold", acatDate: "2026-03-05" }),
      row({ id: "c", clientName: "Kofi Ashby", status: "PendingReview", transferringContra: "Schwab", wealthAdvisor: null, acatDate: "2026-02-10" }),
    ];
    const ids = (query: string, set: "active" | "completed" | "all") => filterAdvisorTransfers(rows, query, set).map((r) => r.id);
    expect(ids("", "active")).toEqual(["c", "a"]);
    expect(ids("", "completed")).toEqual(["b"]);
    expect(ids("", "all")).toEqual(["b", "c", "a"]);
    expect(ids("  DANIEL ", "all")).toEqual(["a"]);
    expect(ids("schwab", "all")).toEqual(["b", "c"]);
    expect(ids("reynold", "all")).toEqual(["b"]);
    expect(ids("schwab", "active")).toEqual(["c"]);
    expect(ids("schwab", "completed")).toEqual(["b"]);
    expect(ids("nothing matches", "all")).toEqual([]);
    expect(ids("null", "all")).toEqual([]);
    markCase(SUITE, "filters Active All Completed and searches client contra and advisor together");
  });

  it("formats dates and values like the tracker advisor list", () => {
    expect(formatAdvisorDate("2026-04-01")).toBe("04-01-2026");
    expect(formatAdvisorDate("2025-06-27 00:00:00")).toBe("06-27-2025");
    expect(formatAdvisorDate("2025-06-27T10:11:12Z")).toBe("06-27-2025");
    expect(formatAdvisorDate("4/7/2026")).toBe("04-07-2026");
    expect(formatAdvisorDate("04-07-2026")).toBe("04-07-2026");
    expect(formatAdvisorDate("March 5, 2026")).toBe("03-05-2026");
    expect(formatAdvisorDate(new Date("2026-04-09T00:00:00Z"))).toBe("04-09-2026");
    expect(formatAdvisorDate("2026-02-30")).toBe("");
    expect(formatAdvisorDate("not a date")).toBe("");
    expect(formatAdvisorDate(null)).toBe("");
    expect(formatAdvisorValue(123456789)).toBe("$1,234,567.89");
    expect(formatAdvisorValue(5)).toBe("$0.05");
    expect(formatAdvisorValue(-250000)).toBe("-$2,500.00");
    markCase(SUITE, "formats dates and values like the tracker advisor list");
  });
});
