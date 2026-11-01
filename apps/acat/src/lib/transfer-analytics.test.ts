import { describe, expect, it } from "vitest";
import { AcatRecord } from "./types";
import {
  businessDaysBetween,
  contraPerformance,
  dashboardDataQualityExceptions,
  dataQualityExceptions,
  finalizedSummary,
  flowSummary,
  monthlyTransferVolume,
  reconCoverage,
  residualBenchmarks,
  residualFollowUpBenchmark,
  workflowFor,
  workflowTimings,
} from "./transfer-analytics";

function record(overrides: Partial<AcatRecord> = {}): AcatRecord {
  return {
    id: "r1",
    clientName: "Client",
    apexAccountId: "A1",
    status: "Completed",
    lastUpdated: "2026-01-01",
    crmDealId: "",
    custodianId: "",
    custodianName: "",
    acatDate: "2026-01-01",
    slackAlerted: false,
    mappingSource: "GCP Project API",
    apexSource: "Pending Upload",
    assets: [],
    ...overrides,
  };
}

describe("transfer analytics", () => {
  it("keeps workflow exclusive and does not infer paperwork from DocuSign", () => {
    expect(workflowFor(record({ type: "Residual Credit", transferWorkflow: "ACAT" }))).toBe("RESIDUAL");
    expect(workflowFor(record({ transferWorkflow: "DRS" }))).toBe("DRS");
    expect(workflowFor(record({ methodRequested: "API, Full Docusign" }))).toBe("ACAT");
    expect(workflowFor(record({ methodRequested: "Full Docusign" }))).toBe("UNCLASSIFIED");
  });

  it("reports finalized rates without purged records in the denominator", () => {
    const summary = finalizedSummary([
      record(),
      record({ id: "r2", status: "Rejected" }),
      record({ id: "r3", status: "Canceled" }),
      record({ id: "r4", status: "Purged" }),
    ]);
    expect(summary.validFinalized).toBe(3);
    expect(summary.completedRate).toBeCloseTo(1 / 3);
  });

  it("computes the three timing stages per workflow", () => {
    const timings = workflowTimings([
      record({
        transferWorkflow: "ACAT",
        originalClientRequestDate: "2026-01-01",
        opsSubmissionDateToApex: "2026-01-03",
        apexCompletionDate: "2026-01-08",
      }),
    ]);
    const acat = timings.find((item) => item.workflow === "ACAT")!;
    expect(acat.requestToSubmit.median).toBe(1);
    expect(acat.submitToComplete.median).toBe(4);
    expect(acat.requestToComplete.median).toBe(5);
  });

  it("excludes weekends and ACATS processing holidays from business-day timing", () => {
    expect(businessDaysBetween("2026-04-02", "2026-04-06")).toBe(1);
    expect(businessDaysBetween("2026-07-02", "2026-07-06")).toBe(1);
    expect(businessDaysBetween("2026-08-07", "2026-08-10")).toBe(1);
    expect(businessDaysBetween("2026-08-10", "2026-08-10")).toBe(0);
    expect(businessDaysBetween("2026-08-10", "2026-08-07")).toBe(-1);
    expect(businessDaysBetween("2021-12-30", "2021-12-31")).toBe(0);
  });

  it("excludes residual movements from monthly transfer requests", () => {
    const rows = monthlyTransferVolume(
      [
        record({ originalClientRequestDate: "2025-06-02", transferWorkflow: "ACAT" }),
        record({ id: "r2", originalClientRequestDate: "2025-06-03", type: "Residual Credit" }),
      ],
      "2025-06",
      new Date("2025-06-30T00:00:00Z")
    );
    expect(rows[0].total).toBe(1);
  });

  it("starts monthly volume at the first month with a request, never before June 2025", () => {
    const now = new Date("2026-03-15T00:00:00Z");
    const later = monthlyTransferVolume(
      [
        record({ originalClientRequestDate: "2026-01-12", transferWorkflow: "ACAT" }),
        record({ id: "r2", originalClientRequestDate: "2025-11-03", type: "Residual Credit" }),
        record({ id: "r3", originalClientRequestDate: "2026-02-02", transferWorkflow: "MANUAL" }),
      ],
      undefined,
      now
    );
    expect(later.map((row) => row.month)).toEqual(["2026-01", "2026-02", "2026-03"]);

    const backfilled = monthlyTransferVolume(
      [record({ originalClientRequestDate: "2024-12-02", transferWorkflow: "ACAT" }), record({ id: "r2", originalClientRequestDate: "2025-06-16" })],
      undefined,
      new Date("2025-10-01T00:00:00Z")
    );
    expect(backfilled[0]).toMatchObject({ month: "2025-06", total: 1 });
    expect(monthlyTransferVolume([], undefined, new Date("2025-07-01T00:00:00Z")).map((row) => row.month)).toEqual(["2025-06", "2025-07"]);
  });

  it("tracks DRS as its own monthly workflow", () => {
    const rows = monthlyTransferVolume(
      [record({ originalClientRequestDate: "2025-06-02", transferWorkflow: "DRS" })],
      "2025-06",
      new Date("2025-06-30T00:00:00Z")
    );
    expect(rows[0].total).toBe(1);
    expect(rows[0].workflows.DRS).toBe(1);
  });

  it("includes legacy timestamp strings in monthly volume and cycle time", () => {
    const legacy = record({
      transferWorkflow: "ACAT",
      originalClientRequestDate: "June 2, 2025",
      opsSubmissionDateToApex: "June 3, 2025",
      apexCompletionDate: "June 8, 2025",
    });

    const volume = monthlyTransferVolume([legacy], "2025-06", new Date("2025-06-30T00:00:00Z"));
    expect(volume[0]).toMatchObject({ total: 1, workflows: { ACAT: 1 } });

    const timing = workflowTimings([legacy]).find((item) => item.workflow === "ACAT")!;
    expect(timing.requestToSubmit).toMatchObject({ median: 1, sampleSize: 1 });
    expect(timing.submitToComplete).toMatchObject({ median: 3, sampleSize: 1 });
    expect(timing.requestToComplete).toMatchObject({ median: 4, sampleSize: 1 });
  });

  it("separates client-requested flow from residual movements by direction", () => {
    const summary = flowSummary([
      record({ direction: "Out", type: "Full", statementAmount: -100_00 }),
      record({ id: "partial", direction: "Out", type: "Partial", statementAmount: -50_00 }),
      record({ id: "residual", direction: "Out", type: "Residual Credit", statementAmount: -5_00 }),
      record({ id: "incoming", direction: "In", type: "Full", statementAmount: 200_00 }),
    ]);

    expect(summary.outgoing).toMatchObject({
      totalCount: 3,
      totalAmount: 155_00,
      requestedCount: 2,
      requestedAmount: 150_00,
      residualCount: 1,
      residualAmount: 5_00,
    });
    expect(summary.incoming).toMatchObject({ requestedCount: 1, residualCount: 0 });
    expect(summary.netAmount).toBe(45_00);
    expect(summary.requestedNetAmount).toBe(50_00);
    expect(summary.residualNetAmount).toBe(-5_00);
  });

  it("calculates contra performance separately for ACAT and Manual workflows", () => {
    const records = [
      record({ id: "acat-complete", transferWorkflow: "ACAT", transferringContra: "Fidelity", statementAmount: 100_00, opsSubmissionDateToApex: "2026-01-01", apexCompletionDate: "2026-01-03" }),
      record({ id: "acat-rejected", transferWorkflow: "ACAT", transferringContra: "Fidelity", status: "Rejected" }),
      record({ id: "manual-complete", transferWorkflow: "MANUAL", transferringContra: "Fidelity", statementAmount: 500_00, opsSubmissionDateToApex: "2026-01-01", apexCompletionDate: "2026-04-01" }),
      record({ id: "residual", transferWorkflow: "RESIDUAL", type: "Residual Credit", transferringContra: "Fidelity", statementAmount: 20_00 }),
    ];

    expect(contraPerformance(records, "ACAT")[0]).toMatchObject({ completed: 1, finalized: 2, rejectionRate: 0.5, medianApexDays: 1, completedAmount: 100_00 });
    expect(contraPerformance(records, "MANUAL")[0]).toMatchObject({ completed: 1, finalized: 1, rejectionRate: 0, medianApexDays: 62, completedAmount: 500_00 });
  });

  it("links residual lag through associated control numbers", () => {
    const rows = residualBenchmarks([
      record({ controlNumber: "C1", transferringContra: "Fidelity", apexCompletionDate: "2026-01-01" }),
      record({ id: "res", type: "Residual Credit", associatedControlNumber: "C1", apexCompletionDate: "2026-01-14" }),
    ]);
    expect(rows[0]).toMatchObject({ contra: "Fidelity", medianDays: 13, sampleSize: 1 });
  });

  it("uses contra P75 only after the minimum sample, then falls back globally", () => {
    const records: AcatRecord[] = [];
    for (let index = 0; index < 10; index++) {
      records.push(record({ id: `p${index}`, controlNumber: `C${index}`, transferringContra: "Fidelity", apexCompletionDate: "2026-01-01" }));
      records.push(record({ id: `r${index}`, type: "Residual Credit", associatedControlNumber: `C${index}`, apexCompletionDate: `2026-01-${String(index + 2).padStart(2, "0")}` }));
    }
    expect(residualFollowUpBenchmark(records, "Fidelity")).toMatchObject({ source: "contra", sampleSize: 10 });
    expect(residualFollowUpBenchmark(records, "Small Contra").source).toBe("global");
  });

  it("treats missing recon as not tracked instead of mismatch", () => {
    const coverage = reconCoverage([record({ assets: [], apexSource: "Pending Upload" })]);
    expect(coverage).toMatchObject({ eligible: 1, tracked: 0, notTracked: 1, mismatch: 0 });
  });

  it("builds actionable data-quality queues", () => {
    const issues = dataQualityExceptions([
      record({ apexCompletionDate: undefined, transferWorkflow: "ACAT" }),
      record({ id: "r2", status: "Rejected", rejectionReason: "", transferWorkflow: "MANUAL" }),
    ]);
    expect(issues.map((item) => item.ruleKey)).toEqual(
      expect.arrayContaining(["completed_missing_date", "rejected_missing_reason"])
    );
  });

  it("flags missing CRM tickets for completed full, partial, and non-residual ACAT Outs", () => {
    const issues = dataQualityExceptions([
      record({ id: "full", status: "Completed", type: "Full", direction: "In", crmTicket: "" }),
      record({ id: "partial", status: "Completed", type: "Partial", direction: "In", crmTicket: "" }),
      record({ id: "out", status: "Completed", type: undefined, direction: "Out", crmTicket: "" }),
      record({ id: "residual", status: "Completed", type: "Residual Credit", direction: "Out", crmTicket: "" }),
      record({ id: "ticketed", status: "Completed", type: "Full", crmTicket: "CRM-123" }),
    ]);

    expect(
      issues
        .filter((item) => item.ruleKey === "missing_crm_ticket")
        .map((item) => item.record.id)
    ).toEqual(["full", "partial", "out"]);
  });

  it("does not flag missing CRM tickets until a transfer is completed", () => {
    const issues = dataQualityExceptions([
      record({ id: "not-started", status: "ToCome", type: "Full", crmTicket: "" }),
      record({ id: "active", status: "Submitted", type: "Partial", crmTicket: "" }),
      record({ id: "rejected", status: "Rejected", type: "Full", crmTicket: "", rejectionReason: "Client declined" }),
      record({ id: "purged", status: "Purged", type: "Partial", crmTicket: "" }),
      record({ id: "canceled", status: "Canceled", direction: "Out", crmTicket: "" }),
      record({ id: "deferred", status: "Deferred", type: "Full", crmTicket: "" }),
      record({ id: "completed", status: "Completed", type: "Full", crmTicket: "" }),
    ]);

    expect(
      issues
        .filter((item) => item.ruleKey === "missing_crm_ticket")
        .map((item) => item.record.id)
    ).toEqual(["completed"]);
  });

  it("allows a To Come control while pending but flags it after finalization", () => {
    const issues = dataQualityExceptions([
      record({ id: "pending", status: "PendingContraResponse", controlNumber: "To Come", transferWorkflow: "ACAT" }),
      record({ id: "rejected", status: "Rejected", controlNumber: " to come ", rejectionReason: "Client canceled", transferWorkflow: "ACAT" }),
    ]);

    const placeholderIssues = issues.filter((item) => item.ruleKey === "finalized_placeholder_control");
    expect(placeholderIssues.map((item) => item.record.id)).toEqual(["rejected"]);
    expect(issues.filter((item) => item.ruleKey === "duplicate_control")).toHaveLength(0);
  });

  it("still flags duplicate real control numbers", () => {
    const issues = dataQualityExceptions([
      record({ id: "a", controlNumber: "C123", apexCompletionDate: "2026-01-02", transferWorkflow: "ACAT" }),
      record({ id: "b", controlNumber: "C123", apexCompletionDate: "2026-01-03", transferWorkflow: "ACAT" }),
    ]);

    expect(issues.filter((item) => item.ruleKey === "duplicate_control")).toHaveLength(2);
  });

  it("routes Manual control-number markers to their own cleanup rule", () => {
    const issues = dataQualityExceptions([
      record({ id: "manual-a", controlNumber: "Manual", apexCompletionDate: "2026-01-02", transferWorkflow: "MANUAL" }),
      record({ id: "manual-b", controlNumber: " manual ", apexCompletionDate: "2026-01-03", transferWorkflow: "MANUAL" }),
    ]);

    expect(issues.filter((item) => item.ruleKey === "duplicate_control")).toHaveLength(0);
    expect(issues.filter((item) => item.ruleKey === "finalized_placeholder_control")).toHaveLength(0);
    expect(issues.filter((item) => item.ruleKey === "manual_control_marker")).toHaveLength(2);
  });

  it("allows multiple request methods because they preserve intake history", () => {
    const issues = dataQualityExceptions([
      record({ id: "multiple", methodRequested: "API, Full Docusign", transferWorkflow: "ACAT" }),
      record({ id: "single", methodRequested: "Full Docusign", transferWorkflow: "MANUAL" }),
    ]);

    expect(issues.filter((item) => item.ruleKey === "multiple_request_methods")).toHaveLength(0);
  });

  it("flags missing ACAT DTC data without applying the rule to Manual workflows", () => {
    const issues = dataQualityExceptions([
      record({ id: "acat", status: "Submitted", transferringContra: "Fidelity", dtccNumber: undefined, transferWorkflow: "ACAT" }),
      record({ id: "manual", status: "Submitted", transferringContra: "Fidelity", dtccNumber: undefined, transferWorkflow: "MANUAL" }),
    ]);
    expect(issues.filter((item) => item.ruleKey === "missing_dtcc_number").map((item) => item.record.id)).toEqual(["acat"]);
  });

  it("flags historical fee formatting and invalid dates", () => {
    const issues = dataQualityExceptions([
      record({
        transferWorkflow: "MANUAL",
        feeAmount: "50",
        originalClientRequestDate: "not-a-date",
        apexCompletionDate: "2026-01-02",
      }),
    ]);
    expect(issues.map((item) => item.ruleKey)).toEqual(expect.arrayContaining(["fee_amount_format", "invalid_date"]));
  });

  it("dashboardDataQualityExceptions combines residual follow-up with base controls", () => {
    const issues = dashboardDataQualityExceptions(
      [
        record({
          id: "monitored",
          status: "Completed",
          controlNumber: "CTRL-1",
          crmTicket: "P-1",
          transferWorkflow: "ACAT",
          apexCompletionDate: "",
          residualMonitoringRequired: true,
          residualFollowUpDate: "2026-01-01",
        }),
      ],
      new Date("2026-01-03T00:00:00Z"),
    );
    expect(issues.map((item) => item.ruleKey).sort()).toEqual([
      "completed_missing_date",
      "residual_sweep_missing",
    ]);
  });
});
