import { describe, expect, it, vi } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const draftSpy = vi.hoisted(() => vi.fn());
vi.mock("@/components/transfers/TransferPlanDraftProvider", () => ({ useTransferPlanDraft: draftSpy }));
vi.mock("@/app/(authenticated)/asset-transfer/actions", () => ({
  setCashInFlight: vi.fn(), setChecklistFlag: vi.fn(),
}));
import { DecisionChecklistCard } from "@/components/transfers/DecisionChecklistCard";
import { TransferPlanApprovalFooter } from "@/components/transfers/TransferPlanApprovalFooter";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("transfer funding-plan draft UI", () => {
  it("keeps rail and position clicks out of the legacy immediate-write actions", () => {
    const controls = [
      read("components/transfers/FundingTypeControl.tsx"),
      read("components/transfers/BasisDecisionTable.tsx"),
      read("components/transfers/PartialAcatPositionsTable.tsx"),
    ];
    for (const control of controls) {
      expect(control).not.toContain(
        '@/app/(authenticated)/asset-transfer/actions',
      );
    }
  });

  it("renders one approval action alongside the existing funding status and explains unsaved changes", () => {
    draftSpy.mockReturnValue({
      fundingType: "ACAT_PARTIAL", dirty: true, planComplete: false, approvedVersion: 0,
      approvedAt: null, approvedBy: null, canEdit: true, canApprove: true, approvalMode: "PREPARATION", pending: false, errors: [],
    });
    const html = renderToStaticMarkup(createElement(Fragment, null,
      createElement(DecisionChecklistCard, {
        transferId: "synthetic", accountsOpenedAtApex: false, fundingInitiated: false,
        cashInFlight: false, canWrite: true, showReadiness: false,
      }),
      createElement(TransferPlanApprovalFooter),
    ));
    expect(html).toContain("Funding plan approval");
    expect(html.match(/>Approve funding plan<\/button>/g)).toHaveLength(1);
    expect(html.match(/id="funding_plan_note"/g)).toHaveLength(1);
    expect(html).toContain('role="status"');
    expect(html).toContain("Unsaved plan changes");
    expect(html).toMatch(/funding type.*securit/i);
  });

  it("hides the entire approval footer for viewers even if draft or error state is present", () => {
    draftSpy.mockReturnValue({
      fundingType: "ACAT_PARTIAL", dirty: true, planComplete: false, approvedVersion: 0,
      approvedAt: null, approvedBy: null, canEdit: false, canApprove: false, approvalMode: "PREPARATION", pending: false,
      errors: [{ field: "funding_type", message: "Synthetic error" }],
    });
    expect(renderToStaticMarkup(createElement(TransferPlanApprovalFooter))).toBe("");
  });

  it("offers legacy approval independently of editing and explains the Preparation boundary", () => {
    draftSpy.mockReturnValue({
      fundingType: "ACAT_PARTIAL", dirty: false, planComplete: false, approvedVersion: 0,
      approvedAt: null, approvedBy: null, canEdit: false, canApprove: true,
      approvalMode: "LEGACY_IN_TRANSFER_REVIEW", pending: false, errors: [],
    });
    const html = renderToStaticMarkup(createElement(TransferPlanApprovalFooter));
    expect(html).toMatch(/<button/);
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(html).toContain("Preparation");
    expect(html).not.toContain("Unsaved plan changes");
  });

  it("renders the revised-plan control without an unsaved warning after approval", () => {
    draftSpy.mockReturnValue({
      fundingType: "ACAT_PARTIAL", dirty: false, planComplete: true, approvedVersion: 2,
      approvedAt: "2026-09-24T12:00:00Z", approvedBy: "synthetic@example.test",
      canEdit: true, canApprove: true, approvalMode: "PREPARATION", pending: false, errors: [],
    });
    const html = renderToStaticMarkup(createElement(TransferPlanApprovalFooter));
    expect(html).toContain("Approve revised plan");
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain("Unsaved plan changes");
    expect(html).toContain('<div role="status" aria-live="polite"></div>');
  });

  it.each([
    { label: "invalidated saved revision", planComplete: false, approvedVersion: 5 },
    { label: "unapproved version zero", planComplete: false, approvedVersion: 0 },
    { label: "legacy completion", planComplete: true, approvedVersion: 0 },
  ])("allows explicit approval of a clean $label without an unrelated edit", ({ planComplete, approvedVersion }) => {
    draftSpy.mockReturnValue({
      fundingType: "ACAT_PARTIAL", dirty: false, planComplete, approvedVersion,
      approvedAt: null, approvedBy: null, canEdit: true, canApprove: true, approvalMode: "PREPARATION", pending: false, errors: [],
    });
    const html = renderToStaticMarkup(createElement(TransferPlanApprovalFooter));
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(html).toContain("Approval required");
    expect(html).toContain("You do not need to change them to approve.");
    expect(html).not.toContain("Unsaved plan changes");
    expect(html.includes("no versioned approval")).toBe(planComplete);
  });

  it.each([
    { label: "pending approval", pending: true, fundingType: "ACAT_PARTIAL" },
    { label: "missing funding type", pending: false, fundingType: null },
  ])("keeps $label disabled even when approval is required", ({ pending, fundingType }) => {
    draftSpy.mockReturnValue({
      fundingType, dirty: false, planComplete: false, approvedVersion: 5,
      approvedAt: null, approvedBy: null, canEdit: true, canApprove: true, approvalMode: "PREPARATION", pending, errors: [],
    });
    const html = renderToStaticMarkup(createElement(TransferPlanApprovalFooter));
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it.each([true, false])("describes the previous revision as active only while its approval remains valid (%s)", (planComplete) => {
    draftSpy.mockReturnValue({
      fundingType: "MANUAL", dirty: true, planComplete, approvedVersion: 5,
      approvedAt: null, approvedBy: null, canEdit: true, canApprove: true, approvalMode: "PREPARATION", pending: false, errors: [],
    });
    const html = renderToStaticMarkup(createElement(DecisionChecklistCard, {
      transferId: "synthetic", accountsOpenedAtApex: false, fundingInitiated: false,
      cashInFlight: false, canWrite: false, showReadiness: false,
    }));
    expect(html).toContain("Draft changes are not saved");
    expect(html.includes("version 5 remains active")).toBe(planComplete);
  });

  it("keeps DRS approval controls and hides generic cash/ACAT readiness for a DRS draft", () => {
    draftSpy.mockReturnValue({
      fundingType: "DRS", dirty: true, planComplete: false, approvedVersion: 0,
      approvedAt: null, approvedBy: null, canEdit: true, canApprove: true, approvalMode: "PREPARATION", pending: false, errors: [],
    });
    const html = renderToStaticMarkup(createElement(Fragment, null,
      createElement(DecisionChecklistCard, {
        transferId: "synthetic", accountsOpenedAtApex: false, fundingInitiated: false,
        cashInFlight: false, canWrite: true, showReadiness: true,
      }),
      createElement(TransferPlanApprovalFooter),
    ));
    expect(html.match(/>Approve funding plan<\/button>/g)).toHaveLength(1);
    expect(html).toContain("Funding plan approval");
    expect(html).not.toContain("Cash in flight");
    expect(html).not.toContain("Funding initiated");
    expect(html).not.toContain("Accounts opened at Apex");
  });
});
