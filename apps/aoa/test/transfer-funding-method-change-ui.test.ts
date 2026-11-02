import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TransferBoardClientRow } from "@/lib/data/transfer-board-client";
import { TransferOverviewSummary } from "@/components/transfers/TransferOverviewSummary";
import { TransferCard } from "@/components/transfers/TransferCard";

vi.mock("@/app/(authenticated)/asset-transfer/funding-method-actions", () => ({
  changeFundingMethod: vi.fn(), prepareFundingMethodChange: vi.fn(), confirmFundingMethodInitiated: vi.fn(),
}));
import { FundingMethodHistory } from "@/components/transfers/FundingMethodChange";

const transfer = {
  stage: "FUNDED" as const, funding_type: "WIRE" as const, recorded_funding_type: "ACH" as const,
  funding_plan_complete: true, funding_plan_version: 2,
  transferring_firm: "Synthetic firm", asset_map_custodian: null,
  asset_map_account_type: null, asset_map_account_number: null,
  owner_kind: "OPERATIONS" as const, owner_name: "Synthetic Operator",
  next_step: null, next_step_owner: null, pending_nudge: null,
};

function overview(overrides: Partial<typeof transfer> = {}) {
  return renderToStaticMarkup(createElement(TransferOverviewSummary, {
    transfer: { ...transfer, ...overrides }, receiving: null, nextTask: null, openExceptions: 1, blockingExceptions: 1,
  }));
}

function board(stage: TransferBoardClientRow["stage"]): TransferBoardClientRow {
  const at = new Date("2026-09-20T12:00:00.000Z");
  return {
    id: "ZZTEST-METHOD-UI", source: "APP", client_first_name: "ZZTEST", client_last_name: "Synthetic",
    client_sf_id: null, household_name: null, household_sf_id: null, value: 100,
    stage, stage_entered_at: at, owner_kind: "OPERATIONS", owner_name: null,
    next_step: null, next_step_owner: null, pending_nudge: null, acat_transfer_id: null,
    funding_type: "WIRE", recorded_funding_type: "ACH", funding_method_revision: 1,
    accounts_opened_at_apex: true, funding_plan_complete: true, funding_plan_version: 2,
    funding_plan_approved_at: at, funding_plan_approved_by: "ops@example.invalid",
    funding_initiated: true, cash_in_flight: true, deal_id: null, deal_sf_id: null,
    transferring_firm: null, archived_at: null, archived_by: null, archived_reason: null, sync_flag: null,
    acat_record_id: null, asset_map_folder_id: null, asset_map_custodian: null, asset_map_account_type: null,
    created_by: null, updated_by: null, created_at: at, updated_at: at,
    tasksDone: 1, tasksTotal: 1, nextIncompleteTask: null, daysInStage: 1, bouncing: false,
  };
}

describe("funding method correction presentation", () => {
  it("shows a completed transfer's recorded method separately from its retained approved plan", () => {
    const html = overview();
    expect(html).toContain("Recorded funding method</dt><dd>ACH</dd>");
    expect(html).toContain("Saved plan: Wire · Approved · version 2");
    expect(html).toContain("1 open · 1 blocking");
    expect(html).not.toContain("Est.");
  });

  it("does not fabricate an approval for a historical completed record", () => {
    const html = overview({ funding_plan_version: 0 });
    expect(html).toContain("Recorded funding method</dt><dd>ACH</dd>");
    expect(html).toContain("Saved plan: Wire · Legacy completion — approval needed");
    expect(html).not.toContain("Approved");
  });

  it.each(["DECISION", "IN_TRANSFER"] as const)("shows the saved execution method while %s", (stage) => {
    const html = renderToStaticMarkup(createElement(TransferOverviewSummary, {
      transfer: { ...transfer, stage }, receiving: null, nextTask: null, openExceptions: 0, blockingExceptions: 0,
    }));
    expect(html).toContain("Saved funding method</dt><dd>Wire</dd>");
    expect(html).not.toContain("Recorded funding method");
    expect(html).not.toContain(">ACH<");
  });

  it.each([
    { stage: "FUNDED" as const, expected: "ACH", absent: "Wire" },
    { stage: "IN_TRANSFER" as const, expected: "Wire", absent: "ACH" },
  ])("uses $expected on the $stage board card", ({ stage, expected, absent }) => {
    const html = renderToStaticMarkup(createElement(TransferCard, { row: board(stage) }));
    expect(html).toContain(`>${expected}</span>`);
    expect(html).not.toContain(`>${absent}</span>`);
    expect(html).toContain("1/1 done");
  });

  it("distinguishes factual corrections from new plan approvals in history and escapes narrative text", () => {
    const html = renderToStaticMarkup(createElement(FundingMethodHistory, { entries: [
      { id: "correction", revision: 2, kind: "RECORDED_CORRECTION", previousFundingType: "WIRE", fundingType: "ACH",
        stage: "FUNDED", basePlanVersion: 2, planVersion: 2, reason: "Confirmed <ACH> receipt",
        changedBy: "ops@example.invalid", changedAt: "2026-09-28T12:00:00.000Z" },
      { id: "revision", revision: 1, kind: "PLAN_REVISION", previousFundingType: "DRS", fundingType: "WIRE",
        stage: "IN_TRANSFER", basePlanVersion: 1, planVersion: 2, reason: "Reviewed replacement instructions",
        changedBy: "ops@example.invalid", changedAt: "2026-09-25T12:00:00.000Z" },
    ] }));
    expect(html).toContain("Wire → ACH");
    expect(html).toContain("Recorded correction · original plan version 2 retained");
    expect(html).toContain("Plan approved · version 2");
    expect(html).toContain("Confirmed &lt;ACH&gt; receipt");
    expect(html).toContain('dateTime="2026-09-28T12:00:00.000Z"');
    expect(html).toContain("ops@example.invalid");
  });
});
