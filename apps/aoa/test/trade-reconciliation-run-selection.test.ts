import { describe, expect, it } from "vitest";
import { tradeDateForRunDate } from "@/lib/operations/trade-reconciliation-run-date";
import { requestedTradeReconciliationRunId } from "@/lib/operations/trade-reconciliation-selection";

describe("Trade Reconciliation explicit run selection", () => {
  const completedRuns = ["cmexample001", "cmexample002"];

  it("does not load a completed run unless the URL explicitly selects one", () => {
    expect(requestedTradeReconciliationRunId(undefined, completedRuns)).toBeUndefined();
    expect(requestedTradeReconciliationRunId("", completedRuns)).toBeUndefined();
  });

  it("loads only a valid completed run and never falls back to the latest", () => {
    expect(requestedTradeReconciliationRunId("cmexample002", completedRuns)).toBe("cmexample002");
    expect(requestedTradeReconciliationRunId("cmnotpresent1", completedRuns)).toBeUndefined();
    expect(requestedTradeReconciliationRunId("../latest", completedRuns)).toBeUndefined();
  });
});

describe("Trade Reconciliation run-date preview", () => {
  const today = "2026-09-03";

  it("shows the prior NYSE trading date for a valid selected run date", () => {
    expect(tradeDateForRunDate("2026-09-03", today)).toBe("2026-09-02");
    expect(tradeDateForRunDate("2026-07-06", today)).toBe("2026-07-02");
  });

  it("stays blank until the user selects a valid, non-future trading day", () => {
    expect(tradeDateForRunDate("", today)).toBeNull();
    expect(tradeDateForRunDate("2026-08-30", today)).toBeNull();
    expect(tradeDateForRunDate("2026-09-04", today)).toBeNull();
    expect(tradeDateForRunDate("not-a-date", today)).toBeNull();
  });
});
