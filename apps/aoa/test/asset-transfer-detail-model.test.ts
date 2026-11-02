import { describe, expect, it } from "vitest";
import {
  fundingBarInstructions, historyEvents, instructionSummary, lastFour, mappingRows, outcomeSummary, parseFromView,
  planApprovalLabel, sectionOpen, sectionStatus, taskCounts, taskSection, trackerStatus, trackerTone, trackingDate,
  workflowGuide, type DetailFacts, type DetailTask,
} from "@/components/asset-transfer/detail/detail-model";

const facts = (overrides: Partial<DetailFacts> = {}): DetailFacts => ({
  stage: "DECISION", fundingType: "ACAT_FULL", route: "Full ACAT · signed paperwork · Apex API", outcome: "active",
  statementAccepted: true, accountMatchOk: true, planApproved: false, sentPacket: false, returnedSignature: false,
  appAuthorization: false, submitted: false, rejection: null, openFollowUpTasks: 0, historyCount: 0, ...overrides,
});

const task = (status: DetailTask["status"]): DetailTask => ({
  id: status, kind: "checklist", title: "Synthetic", status, owner: "Operations", section: "paperwork",
  done: status === "Completed", completedAt: null, completedBy: null, assignedTo: null, followUpOn: null,
});

describe("transfer detail model", () => {
  it("parses the back-link view and defaults to transfers", () => {
    expect(parseFromView("queue")).toBe("queue");
    expect(parseFromView(["mailing", "queue"])).toBe("mailing");
    expect(parseFromView("nope")).toBe("transfers");
    expect(parseFromView(undefined)).toBe("transfers");
  });

  it("guides each step in mockup order", () => {
    expect(workflowGuide(facts({ statementAccepted: false })).id).toBe("intake");
    expect(workflowGuide(facts({ fundingType: null, route: null })).id).toBe("mapping");
    expect(workflowGuide(facts()).title).toBe("Approve the current funding plan before generating paperwork");
    expect(workflowGuide(facts({ planApproved: true })).title).toBe("Prepare and follow the required paperwork");
    expect(workflowGuide(facts({ planApproved: true, returnedSignature: true })).title).toBe("Log the ACAT submission");
    expect(workflowGuide(facts({ submitted: true })).id).toBe("paperwork");
    expect(workflowGuide(facts({ submitted: true, rejection: "open" })).id).toBe("transfer-progress");
    expect(workflowGuide(facts({ stage: "FUNDED" })).id).toBe("related-work");
    expect(workflowGuide(facts({ outcome: "deferred" })).title).toBe("Transfer paused · resume when ready");
    expect(workflowGuide(facts({
      route: "Full ACAT · app authorization · Apex API", planApproved: true,
    })).title).toBe("Record the client’s app authorization");
  });

  it("opens only the guide's section and labels section badges", () => {
    const guide = workflowGuide(facts());
    expect(sectionOpen(guide, "mapping")).toBe(true);
    expect(sectionOpen(guide, "intake")).toBe(false);
    expect(sectionStatus(facts({ accountMatchOk: false }), "intake")).toEqual(["blocked", "Needs attention"]);
    expect(sectionStatus(facts(), "mapping")).toEqual(["waiting", "Ops approval needed"]);
    expect(sectionStatus(facts({ fundingType: null }), "mapping")).toEqual(["waiting", "Mapping needed"]);
    expect(sectionStatus(facts({ stage: "FUNDED" }), "paperwork")).toEqual(["completed", "Assets arrived"]);
    expect(sectionStatus(facts({ sentPacket: true }), "paperwork")).toEqual(["waiting", "Waiting for signature"]);
    expect(sectionStatus(facts({ openFollowUpTasks: 2 }), "followups")).toEqual(["waiting", "2 open tasks"]);
    expect(sectionStatus(facts({ historyCount: 1 }), "history")).toEqual(["neutral", "1 recorded event"]);
  });

  it("labels plan approval and instructions", () => {
    expect(planApprovalLabel(facts({ statementAccepted: false }))).toEqual({ text: "Needs attention", attention: true });
    expect(planApprovalLabel(facts({ planApproved: true })).text).toBe("Ops approved");
    const holdings = [
      { symbol: "AAA", description: "Synthetic A", marketValue: 10, decision: "BRING_IN" as const },
      { symbol: "BBB", description: "Synthetic B", marketValue: 5, decision: "LEAVE_GIFT" as const },
    ];
    expect(fundingBarInstructions("ACAT_FULL", holdings)).toBe("Entire account as held");
    expect(fundingBarInstructions("ACAT_PARTIAL", holdings)).toBe("In kind: AAA · Stays at source: BBB");
    expect(instructionSummary("ACAT_PARTIAL", holdings)).toBe("Transfer in kind: AAA · Leave behind: BBB");
    const rows = mappingRows("ACAT_PARTIAL", holdings);
    expect(rows.map(row => [row.symbol, row.included, row.movement])).toEqual([["AAA", true, "All shares"], ["BBB", false, "Stays at source"]]);
    expect(mappingRows("ACAT_FULL", holdings).every(row => row.included)).toBe(true);
  });

  it("derives the tracker pill", () => {
    const input = { stage: "IN_TRANSFER" as const, outcome: "active" as const, outcomeLabel: "Active", trackingStage: "In transit" };
    expect(trackerStatus({ ...input, acatStatus: null })).toBe("In transit");
    expect(trackerStatus({ ...input, acatStatus: "Pending Review" })).toBe("Pending Review");
    expect(trackerStatus({ ...input, stage: "DECISION", acatStatus: null })).toBe("Decision");
    expect(trackerStatus({ ...input, outcome: "deferred", outcomeLabel: "Deferred", acatStatus: null })).toBe("Deferred");
    expect(trackerTone("Rejected", "IN_TRANSFER", "active")).toBe("attention");
    expect(trackerTone("Funded", "FUNDED", "active")).toBe("completed");
    expect(trackerTone("Pending Review", "IN_TRANSFER", "active")).toBe("waiting");
    expect(trackerTone("Decision", "DECISION", "active")).toBe("neutral");
    expect(trackerTone("In transit", "IN_TRANSFER", "active")).toBe("progress");
  });

  it("summarizes the latest unresumed outcome", () => {
    expect(outcomeSummary([]).status).toBe("active");
    const deferred = outcomeSummary([
      { outcome: "Deferred", reason: "Synthetic reason", followUpOn: "2026-11-01", resumed: false, recordedAt: "2026-10-02T00:00:00Z" },
      { outcome: "Deferred", reason: null, followUpOn: null, resumed: true, recordedAt: "2026-09-02T00:00:00Z" },
    ]);
    expect(deferred).toMatchObject({ status: "deferred", reason: "Synthetic reason", followUpOn: "2026-11-01" });
    expect(deferred.previous).toHaveLength(1);
    expect(outcomeSummary([{ outcome: "Deferred", reason: null, followUpOn: null, resumed: true, recordedAt: "2026-09-02T00:00:00Z" }]).status).toBe("active");
  });

  it("routes tasks to sections and counts buckets", () => {
    expect(taskSection("Confirm account numbers")).toBe("intake");
    expect(taskSection("Run asset mapper")).toBe("mapping");
    expect(taskSection("Record cost basis received")).toBe("related-work");
    expect(taskSection("Log the ACAT submission")).toBe("paperwork");
    expect(taskCounts([task("Ready"), task("Ready"), task("Completed")])).toEqual({ Ready: 2, Waiting: 0, Completed: 1 });
  });

  it("merges history newest first without duplicate stage rows", () => {
    const events = historyEvents({
      audit: [
        { id: "1", at: "2026-10-01T00:00:00Z", actorRole: "OPERATIONS", action: "transfer.create" },
        { id: "2", at: "2026-10-03T00:00:00Z", actorRole: "OPERATIONS", action: "transfer.stage_change" },
      ],
      stageChanges: [{ recordedAt: "2026-10-03T00:00:00Z", previousStage: "DECISION", newStage: "IN_TRANSFER" }],
      corrections: [{ recordedAt: "2026-10-02T00:00:00Z", correction: "Synthetic correction" }],
      outcomes: [],
    });
    expect(events.map(event => event.text)).toEqual([
      "Funding stage changed from Decision to In transfer.",
      "Synthetic correction",
      "Created the transfer record.",
    ]);
  });

  it("formats dates and masks account numbers", () => {
    expect(trackingDate("2026-10-06")).toBe("Oct 6, 2026");
    expect(trackingDate(null)).toBe("");
    expect(lastFour("SYN-12-3456")).toBe("3456");
    expect(lastFour(null)).toBeNull();
  });
});
