import { describe, expect, it } from "vitest";
import type { OperationsFeeRequestListRow } from "@/lib/data/operations-fee-requests";
import {
  FEE_REQUEST_EXPORT_COLUMNS,
  TRADE_RECONCILIATION_EXPORT_COLUMNS,
  feeRequestExportFilename,
  feeRequestsToCsv,
  tradeReconciliationRunsToCsv,
  type TradeReconciliationRunExport,
} from "@/lib/operations/operations-export-csv";

function request(overrides: Partial<OperationsFeeRequestListRow> = {}): OperationsFeeRequestListRow {
  return {
    id: "synthetic-fee-request-1",
    kind: "FEE_CREDIT",
    status: "CREDITED",
    scope: "CLIENT",
    clientName: "Synthetic Client",
    canonicalClientName: null,
    householdName: "Synthetic Household",
    accounts: [{ id: "opaque-account", label: "Individual · ••••1234", ownerName: "Synthetic Client" }],
    feeTypes: ["Wire", "Transaction"],
    feeAmount: "25.00",
    waiverStart: null,
    waiverDurationMonths: null,
    indefiniteDuration: false,
    submittedBy: "Operator",
    submittedAt: "2026-09-17T16:00:00.000Z",
    reason: "Synthetic context",
    relevantTicketRefs: ["ZD-1", "ZD-2"],
    reviewedBy: "Reviewer",
    reviewedAt: "2026-09-17T17:00:00.000Z",
    creditedAt: "2026-09-18",
    apexRequestId: "APEX-1",
    legacyApexContext: null,
    completedBy: "Operator",
    completedAt: "2026-09-18T15:00:00.000Z",
    legacySource: null,
    legacySourceId: null,
    events: [{
      id: "1",
      action: "CREDITED",
      actorDisplay: "Operator",
      fromStatus: "APPROVED",
      toStatus: "CREDITED",
      note: "Recorded outside AOA",
      at: "2026-09-18T15:00:00.000Z",
    }],
    ...overrides,
  };
}

const run = (overrides: Partial<TradeReconciliationRunExport> = {}): TradeReconciliationRunExport => ({
  id: "synthetic-run-1",
  runDate: "2026-09-17",
  tradeDate: "2026-09-16",
  completedAt: "2026-09-17T20:00:00.000Z",
  apexRecords: 10,
  meridianRecords: 8,
  matched: 8,
  explained: 1,
  unresolved: 1,
  runNote: "Day note",
  ...overrides,
});

describe("operations CSV exports", () => {
  it("exports every fee-credit field the request card shows, and no waiver columns", () => {
    const csv = feeRequestsToCsv([request()]);
    expect(csv.startsWith(FEE_REQUEST_EXPORT_COLUMNS.join(","))).toBe(true);
    expect(csv).toContain("synthetic-fee-request-1,Fee credit,Credited,Client,Synthetic Client,,Synthetic Household,\"Wire, Transaction\",25.00,,,,Individual · ••••1234 · Synthetic Client,Synthetic context,\"ZD-1, ZD-2\",Operator,2026-09-17T16:00:00.000Z,Reviewer,2026-09-17T17:00:00.000Z,2026-09-18,APEX-1,Operator,2026-09-18T15:00:00.000Z,,,,2026-09-18T15:00:00.000Z Credited · Operator — Recorded outside AOA");
    expect(feeRequestExportFilename("credits")).toBe("fee-credits.csv");
  });

  it("exports service guarantees and billing exceptions with waiver dates and leaves credit fields empty", () => {
    const csv = feeRequestsToCsv([request({
      id: "synthetic-guarantee-1",
      kind: "SERVICE_GUARANTEE",
      status: "APPROVED",
      scope: "HOUSEHOLD",
      feeTypes: [],
      feeAmount: null,
      waiverStart: "2026-01",
      waiverDurationMonths: 3,
      indefiniteDuration: false,
      creditedAt: null,
      apexRequestId: null,
      completedBy: null,
      completedAt: null,
      events: [],
    }), request({
      id: "synthetic-exception-1",
      kind: "BILLING_EXCEPTION",
      status: "PENDING",
      feeTypes: [],
      feeAmount: null,
      waiverStart: "2026-03",
      waiverDurationMonths: null,
      indefiniteDuration: true,
      events: [],
      reviewedBy: null,
      reviewedAt: null,
      creditedAt: null,
      apexRequestId: null,
      completedBy: null,
      completedAt: null,
    })]);
    expect(csv).toContain("synthetic-guarantee-1,Service guarantee,Approved,Household");
    expect(csv).toContain("January 2026,April 2026,3 months");
    expect(csv).toContain("synthetic-exception-1,Billing exception,Pending,Client");
    expect(csv).toContain("March 2026,No scheduled restart,Indefinite");
    expect(feeRequestExportFilename("exceptions")).toBe("service-guarantees-and-billing-exceptions.csv");
  });

  it("keeps commas, quotes, and spreadsheet formulas inside one cell", () => {
    const csv = feeRequestsToCsv([request({ reason: '=HYPERLINK("http://example.test")', relevantTicketRefs: ['say "hi"', "second"] })]);
    expect(csv).toContain("\"'=HYPERLINK(\"\"http://example.test\"\")\"");
    expect(csv).toContain("\"say \"\"hi\"\", second\"");
  });

  it("exports one reconciliation row per run, with the history match rate and note", () => {
    const csv = tradeReconciliationRunsToCsv([
      run(),
      run({ id: "synthetic-run-empty", meridianRecords: 0, matched: 0, runNote: "Note, with comma" }),
      run({ id: "synthetic-run-bad", meridianRecords: 2, matched: 4, runNote: "=not a formula" }),
    ]);
    expect(csv.startsWith(TRADE_RECONCILIATION_EXPORT_COLUMNS.join(","))).toBe(true);
    expect(csv).toContain("synthetic-run-1,2026-09-17,2026-09-16,2026-09-17T20:00:00.000Z,10,8,8,1,1,100.00%,Day note");
    expect(csv).toContain("synthetic-run-empty,2026-09-17,2026-09-16,2026-09-17T20:00:00.000Z,10,0,0,1,1,N/A,\"Note, with comma\"");
    expect(csv).toContain("synthetic-run-bad,2026-09-17,2026-09-16,2026-09-17T20:00:00.000Z,10,2,4,1,1,Unavailable,'=not a formula");
    expect(csv).not.toContain("payload");
  });

  it("still returns the header when a tool has no rows", () => {
    expect(feeRequestsToCsv([])).toBe(`${FEE_REQUEST_EXPORT_COLUMNS.join(",")}\r\n`);
    expect(tradeReconciliationRunsToCsv([])).toBe(`${TRADE_RECONCILIATION_EXPORT_COLUMNS.join(",")}\r\n`);
  });
});
