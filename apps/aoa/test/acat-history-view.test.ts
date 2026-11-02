import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";
import { TRANSFER_TRACKER_COLUMNS, resolveAcatBookStatus } from "@/lib/data/acat-book";
import {
  HISTORY_FIELD_LABELS,
  HISTORY_LIMIT,
  HISTORY_TEXT,
  formatHistoryTime,
  historyFieldLabel,
  historyHeadline,
  historyPerson,
  historyStatusName,
  historyValue,
  parseHistoryResponse,
  showsChange,
} from "@/lib/data/acat-history-view";

const SUITE = "acat-history-view";

// The tracker's own wording, copied from tracker `main` (checked 2026-10-13): `ACAT_STATUS_LABELS`
// (`src/lib/types.ts`) and `RecordHistoryTab.tsx`. This table is the oracle.
const TRACKER_STATUS_LABELS: Record<string, string> = {
  WaitingForApex: "Waiting for Apex", PendingAccountOpening: "Pending Account Opening",
  WaitingOnClient: "Waiting on Client", WaitingForStatement: "Waiting for Statement",
  AcatReceived: "ACAT Received", ToCome: "To Come", Submitted: "Submitted",
  PendingReview: "Pending Review", PendingContraResponse: "Pending Contra Response",
  Accepted: "Accepted", PendingSettlement: "Pending Settlement", PendingBookkeeping: "Pending Bookkeeping",
  Matched: "Recon: Matched", Mismatch: "Recon: Mismatch", Pending: "Recon: Pending",
  Completed: "Completed", Rejected: "Rejected", Purged: "Purged", Canceled: "Canceled", Deferred: "Deferred",
};

const entry = (over: Record<string, unknown> = {}) => ({
  id: "h1", action: "update", field: "status", oldValue: "Submitted", newValue: "Completed",
  performedBy: "ops@example.test", timestamp: "2026-10-13T14:32:00.000Z", ...over,
});

describe("field history view (ticket)", () => {
  it("copy matches the tracker", () => {
    expect(HISTORY_TEXT.loading).toBe("Loading history…");
    expect(HISTORY_TEXT.empty).toBe("No recorded changes yet");
    expect(HISTORY_TEXT.failure).toBe("History could not be loaded.");
    expect(HISTORY_TEXT.retry).toBe("Try again");
    expect(HISTORY_TEXT.blank).toBe("blank");
    expect(HISTORY_TEXT.system).toBe("System");
    expect(HISTORY_LIMIT).toBe(100);
    markCase(SUITE, "copy matches the tracker");
  });

  it("field labels are the tracker's and agree with the book's column labels", () => {
    expect(Object.keys(HISTORY_FIELD_LABELS)).toHaveLength(55);
    for (const [key, label] of Object.entries(HISTORY_FIELD_LABELS)) {
      expect(TRANSFER_TRACKER_COLUMNS.find((c) => c.id === key)?.label).toBe(label);
      expect(historyFieldLabel(key)).toBe(label);
    }
    expect(historyFieldLabel("statementAccountNumber")).toBe("Statement Account #");
    expect(historyFieldLabel("someNewField")).toBe("some New Field");
    expect(historyFieldLabel("constructor")).toBe("constructor");
    expect(historyFieldLabel(null)).toBe("Record");
    markCase(SUITE, "field labels are the tracker's and agree with the book's column labels");
  });

  it("status values use the book's status names, which equal the tracker's for all 20 tracker statuses", () => {
    for (const [raw, name] of Object.entries(TRACKER_STATUS_LABELS)) {
      expect(historyStatusName(raw)).toBe(name);
      expect(historyValue("status", raw)).toBe(name);
    }
    expect(Object.keys(TRACKER_STATUS_LABELS)).toHaveLength(20);
    expect(resolveAcatBookStatus("WaitingForStatement").label).toBe("Waiting for Statement");
    expect(historyValue("status", "SomeFutureStatus")).toBe(resolveAcatBookStatus("SomeFutureStatus").label);
    expect(historyValue("status", "SomeFutureStatus")).toBe("Some Future Status");
    expect(historyValue("clientName", "Completed")).toBe("Completed");
    markCase(SUITE, "status values use the book's status names, which equal the tracker's for all 20 tracker statuses");
  });

  it("empty values read blank, account numbers stay raw, and the residual flag reads Yes or No", () => {
    expect(historyValue("notes", null)).toBe("blank");
    expect(historyValue("notes", "")).toBe("blank");
    expect(historyValue("status", "")).toBe("blank");
    expect(historyValue("residualMonitoringRequired", "true")).toBe("Yes");
    expect(historyValue("residualMonitoringRequired", "false")).toBe("No");
    expect(historyValue("feeAmount", "$25.00")).toBe("$25.00");
    expect(historyValue("statementAccountNumber", "123456789")).toBe("123456789");
    expect(historyValue("apexAccountId", "5AB12345")).toBe("5AB12345");
    expect(historyValue("dtccNumber", "0226")).toBe("0226");
    markCase(SUITE, "empty values read blank, account numbers stay raw, and the residual flag reads Yes or No");
  });

  it("headlines match the tracker for every action", () => {
    expect(historyHeadline({ action: "update", field: "feeAmount" })).toBe("Fee Amount changed");
    expect(historyHeadline({ action: "update", field: null })).toBe("update");
    expect(historyHeadline({ action: "DELETE", field: null })).toBe("Record deleted");
    expect(historyHeadline({ action: "RESTORE", field: null })).toBe("Record restored");
    expect(historyHeadline({ action: "fee-auto-apply", field: null })).toBe("Fee schedule applied");
    expect(historyHeadline({ action: "recon-auto-complete", field: null })).toBe("Security recon completed");
    expect(historyHeadline({ action: "recon-auto-uncomplete", field: null })).toBe("Security recon reopened");
    expect(historyHeadline({ action: "manual-form-generated", field: null })).toBe("Transfer form generated");
    expect(historyHeadline({ action: "some_new-action", field: null })).toBe("some new action");
    expect(showsChange({ action: "update", field: "status" })).toBe(true);
    expect(showsChange({ action: "update", field: null })).toBe(false);
    expect(showsChange({ action: "DELETE", field: "status" })).toBe(false);
    markCase(SUITE, "headlines match the tracker for every action");
  });

  it("the person is the stored email, or System when none is stored", () => {
    expect(historyPerson("ops@example.test")).toBe("ops@example.test");
    expect(historyPerson(null)).toBe("System");
    expect(historyPerson("")).toBe("System");
    markCase(SUITE, "the person is the stored email, or System when none is stored");
  });

  it("the time reads like Oct 13, 2026, 10:32 AM", () => {
    expect(formatHistoryTime("2026-10-13T14:32:00.000Z", "America/New_York")).toBe("Oct 13, 2026, 10:32 AM");
    expect(formatHistoryTime("2026-01-05T21:05:00.000Z", "America/New_York")).toBe("Jan 5, 2026, 4:05 PM");
    expect(formatHistoryTime("2026-10-13T14:32:00.000Z")).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M$/);
    markCase(SUITE, "the time reads like Oct 13, 2026, 10:32 AM");
  });

  it("an empty array is the empty state, and every other answer is a failure", () => {
    expect(parseHistoryResponse(200, [])).toEqual({ ok: true, entries: [] });
    for (const status of [null, 401, 404, 429, 500]) {
      expect(parseHistoryResponse(status, [entry()])).toEqual({ ok: false, reason: "unavailable" });
    }
    expect(parseHistoryResponse(200, { error: "x" })).toEqual({ ok: false, reason: "unavailable" });
    expect(parseHistoryResponse(200, null)).toEqual({ ok: false, reason: "unavailable" });
    expect(parseHistoryResponse(200, [entry({ timestamp: 5 })])).toEqual({ ok: false, reason: "unavailable" });
    expect(parseHistoryResponse(200, [entry({ oldValue: 5 })])).toEqual({ ok: false, reason: "unavailable" });
    expect(parseHistoryResponse(200, [null])).toEqual({ ok: false, reason: "unavailable" });
    markCase(SUITE, "an empty array is the empty state, and every other answer is a failure");
  });

  it("keeps the tracker's order and its cap of 100, with no paging", () => {
    const rows = Array.from({ length: 130 }, (_, i) => entry({ id: `h${i}` }));
    const result = parseHistoryResponse(200, rows);
    expect(result.ok && result.entries.map((e) => e.id)).toEqual(rows.slice(0, 100).map((e) => e.id));
    const two = parseHistoryResponse(200, [entry({ id: "newer", timestamp: "2026-10-13T14:32:00.000Z" }), entry({ id: "older", timestamp: "2026-10-01T09:00:00.000Z" })]);
    expect(two.ok && two.entries.map((e) => e.id)).toEqual(["newer", "older"]);
    markCase(SUITE, "keeps the tracker's order and its cap of 100, with no paging");
  });

  it('omits actions named "read", as the tracker does', () => {
    const result = parseHistoryResponse(200, [entry({ id: "keep" }), entry({ id: "drop", action: "read", field: null }), entry({ id: "keep2", action: "DELETE", field: null })]);
    expect(result.ok && result.entries.map((e) => e.id)).toEqual(["keep", "keep2"]);
    markCase(SUITE, 'omits actions named "read", as the tracker does');
  });
});
