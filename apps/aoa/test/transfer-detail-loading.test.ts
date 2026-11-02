import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("@/components/transfers/TransferAcatPicker", () => ({ TransferAcatPicker: () => null }));
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), transfer: vi.fn(), linkedUser: vi.fn(), source: vi.fn(),
  derived: vi.fn(), enabled: vi.fn(), cases: vi.fn(), checklistGate: vi.fn(),
  drsTasks: vi.fn(), slackEnabled: vi.fn(), slack: vi.fn(), fundingMethodHistory: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: vi.fn(() => { throw new Error("Unexpected database read"); }) }));
vi.mock("next/navigation", () => ({
  redirect: () => { throw new Error("REDIRECT"); },
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
vi.mock("@/lib/data/transfer-detail", () => ({ getTransfer: mocks.transfer }));
vi.mock("@/app/(authenticated)/asset-transfer/funding-method-actions", () => ({
  getFundingMethodCorrections: mocks.fundingMethodHistory,
  prepareFundingMethodChange: vi.fn(),
  changeFundingMethod: vi.fn(),
  confirmFundingMethodInitiated: vi.fn(),
}));
vi.mock("@/lib/data/decision-cases", () => ({ listDecisionCasesForTransfer: mocks.cases }));
vi.mock("@/lib/data/drs-workflow-store", () => ({ getDrsWorkflowTasks: mocks.drsTasks }));
vi.mock("@/lib/data/transfers", () => ({ getSlackCloseout: mocks.slack }));
vi.mock("@/lib/data/clients", () => ({ getCedarRidgeUserIdForLinkedReads: mocks.linkedUser }));
vi.mock("@/lib/data/deals", () => ({ dealsForHousehold: vi.fn(), getDeal: vi.fn() }));
vi.mock("@/lib/data/transfer-asset-map", () => ({
  getAssignedAssetMapDetail: vi.fn(async () => null),
  getPartialAcatPositions: vi.fn(async () => []),
}));
vi.mock("@/lib/data/receiving-account-match", () => ({ getDerivedReceivingAccount: mocks.derived }));
vi.mock("@/lib/data/trade-requests", () => ({ readTradeRequestsForUserCached: mocks.source }));
vi.mock("@/lib/crm/resolve", () => ({ crmIdentityIdForSource: vi.fn(async () => null), crmRouteSource: () => "APP" }));
vi.mock("@/lib/flags", () => ({
  assetMapTransferLinkEnabled: () => true,
  checklistStageGateEnabled: mocks.checklistGate,
  initialFundingCheckEnabled: mocks.enabled,
  slackCloseoutEnabled: mocks.slackEnabled,
  transferArchiveActionEnabled: () => false,
  assetTransferWorkspaceEnabled: () => false,
  paperworkRecordsEnabled: () => false,
}));

import TransferDetailPage from "@/app/(authenticated)/asset-transfer/[id]/page";
import { ReceivingAccountsCard } from "@/components/transfers/ReceivingAccountsCard";
import { InitialFundingCoverage } from "@/components/transfers/InitialFundingCoverage";
import { TransferDetailSection } from "@/components/transfers/TransferDetailSection";
import { TransferOverviewSummary } from "@/components/transfers/TransferOverviewSummary";
import { FundingMethodChange } from "@/components/transfers/FundingMethodChange";
import { TransferPlanDraftProvider } from "@/components/transfers/TransferPlanDraftProvider";
import { TransferPlanPositionsCard } from "@/components/transfers/TransferPlanPositionsCard";
import { TransferPlanApprovalFooter } from "@/components/transfers/TransferPlanApprovalFooter";
import { DecisionChecklistCard } from "@/components/transfers/DecisionChecklistCard";
import { FundingPictureCard } from "@/components/transfers/FundingPictureCard";
import { LinkedDecisionCases } from "@/components/transfers/LinkedDecisionCases";
import { TransferChecklist } from "@/components/transfers/TransferChecklist";
import { StageChecklistCard } from "@/components/transfers/StageChecklistCard";
import { TransferToolbar } from "@/components/transfers/TransferToolbar";
import { AcatStatusSection } from "@/components/transfers/AcatStatusSection";
import { AcatLinkCta } from "@/components/transfers/AcatLinkCta";
import { DrsWorkflowCard } from "@/components/transfers/DrsWorkflowCard";
import { GateStepper } from "@/components/transfers/GateStepper";
import { SlackCloseoutCard } from "@/components/transfers/SlackCloseoutCard";
import { DRS_TASKS } from "@/lib/data/drs-workflow";
import type { GateStatus } from "@/lib/data/transfer-basis";

function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === type) return child as ReactElement<Record<string, unknown>>;
    const found = findElement(child.props.children, type);
    if (found) return found;
  }
  return null;
}

function planControlOrder(node: ReactNode): unknown[] {
  const controls = [DecisionChecklistCard, TransferPlanPositionsCard, TransferPlanApprovalFooter];
  const result: unknown[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (controls.some((control) => control === child.type)) result.push(child.type);
    result.push(...planControlOrder(child.props.children));
  }
  return result;
}

function findSections(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const result: ReactElement<Record<string, unknown>>[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === TransferDetailSection) result.push(child as ReactElement<Record<string, unknown>>);
    result.push(...findSections(child.props.children));
  }
  return result;
}

describe("transfer detail optional initial-funding read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "synthetic@example.test" } });
    mocks.cases.mockResolvedValue([]);
    mocks.fundingMethodHistory.mockResolvedValue([]);
    mocks.checklistGate.mockReturnValue(false);
    mocks.drsTasks.mockResolvedValue([]);
    mocks.slackEnabled.mockReturnValue(false);
    mocks.enabled.mockReturnValue(true);
    mocks.linkedUser.mockResolvedValue("synthetic-linked-user");
    mocks.derived.mockResolvedValue({ registrationType: "Roth IRA", status: "OPEN", apexAccountMasked: "••••1234" });
    mocks.source.mockImplementation(() => new Promise(() => {}));
    mocks.transfer.mockResolvedValue({
      transfer: {
        id: "synthetic-transfer", client_sf_id: "synthetic-client", stage: "DECISION",
        stage_entered_at: new Date("2026-09-01T12:00:00Z"), value: 100,
        asset_map_folder_id: "synthetic-folder", asset_map_custodian: "Synthetic",
        asset_map_account_type: "Roth IRA", funding_type: "ACAT_FULL",
        funding_plan_version: 3, funding_plan_complete: true,
        owner_kind: "OPERATIONS", next_step: null, next_step_owner: null,
        transferring_firm: "Synthetic", asset_map_account_number: "SYNTHETIC-1234",
      },
      tasks: [], decisions: [], accounts: [],
    });
  });

  it("returns local account controls before the external source, with only the indicator suspended", async () => {
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    expect(mocks.source).not.toHaveBeenCalled();
    const accounts = findElement(page, ReceivingAccountsCard)!;
    expect(accounts).not.toBeNull();
    expect(accounts.props.canWrite).toBe(true);
    const boundary = accounts.props.fundingCoverage as ReactElement<{ fallback: ReactNode; children: ReactElement }>;
    expect(boundary.type).toBe(Suspense);
    expect(boundary.props.fallback).toBeNull();
    expect(boundary.props.children.type).toBe(InitialFundingCoverage);
    expect(boundary.props.children.props).toEqual({ cedarRidgeUserId: "synthetic-linked-user", accountLast4: "••••1234" });
    expect(mocks.transfer).toHaveBeenCalledWith({ role: "OPERATIONS", email: "synthetic@example.test" }, "synthetic-transfer");
  });

  it.each([
    ["OPERATIONS", "DECISION", null, true],
    ["ADMIN", "DECISION", null, true],
    ["ADVISOR", "DECISION", null, false],
    ["CLIENT_SERVICE", "DECISION", null, false],
    ["VIEWER", "DECISION", null, false],
    ["OPERATIONS", "IN_TRANSFER", null, false],
    ["OPERATIONS", "FUNDED", null, false],
    ["OPERATIONS", "DECISION", new Date("2026-09-25T12:00:00Z"), false],
  ])("source link controls reflect %s / %s / archive=%s", async (role, stage, archived_at, eligible) => {
    mocks.auth.mockResolvedValue({ user: { role, email: "synthetic@example.test" } });
    const detail = await mocks.transfer();
    mocks.transfer.mockResolvedValue({ ...detail, transfer: { ...detail.transfer, stage, archived_at } });
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    expect(findElement(page, FundingPictureCard)!.props.canLinkAssetMap).toBe(eligible);
  });

  it.each([
    ["OPERATIONS", "DECISION", null, true],
    ["ADMIN", "IN_TRANSFER", null, true],
    ["OPERATIONS", "FUNDED", null, true],
    ["ADVISOR", "DECISION", null, false],
    ["CLIENT_SERVICE", "IN_TRANSFER", null, false],
    ["VIEWER", "FUNDED", null, false],
    ["OPERATIONS", "FUNDED", new Date("2026-09-25T12:00:00Z"), false],
  ])("funding method changes reflect %s / %s / archive=%s", async (role, stage, archived_at, eligible) => {
    mocks.auth.mockResolvedValue({ user: { role, email: "synthetic@example.test" } });
    const detail = await mocks.transfer();
    mocks.transfer.mockResolvedValue({ ...detail, transfer: { ...detail.transfer, stage, archived_at } });
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    const control = findElement(page, TransferOverviewSummary)!.props.fundingMethodControl;
    if (eligible) {
      expect(isValidElement(control)).toBe(true);
      expect((control as ReactElement).type).toBe(FundingMethodChange);
      expect((control as ReactElement<{ stage: string }>).props.stage).toBe(stage);
    } else {
      expect(control).toBeUndefined();
    }
    if (role === "OPERATIONS" || role === "ADMIN") {
      expect(mocks.fundingMethodHistory).toHaveBeenCalledWith("synthetic-transfer");
    } else {
      expect(mocks.fundingMethodHistory).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["OPERATIONS", "IN_TRANSFER", 0, "WIRE", null, true],
    ["ADMIN", "IN_TRANSFER", 0, "ACAT_PARTIAL", null, true],
    ["ADVISOR", "IN_TRANSFER", 0, "WIRE", null, false],
    ["CLIENT_SERVICE", "IN_TRANSFER", 0, "WIRE", null, false],
    ["VIEWER", "IN_TRANSFER", 0, "WIRE", null, false],
    ["OPERATIONS", "IN_TRANSFER", 1, "WIRE", null, false],
    ["OPERATIONS", "FUNDED", 0, "WIRE", null, false],
    ["OPERATIONS", "IN_TRANSFER", 0, "DRS", null, false],
    ["OPERATIONS", "IN_TRANSFER", 0, "WIRE", new Date("2026-09-25T12:00:00Z"), false],
  ])("legacy approval eligibility: %s / %s / version %s / %s / archived %s", async (role, stage, version, funding_type, archived_at, eligible) => {
    mocks.auth.mockResolvedValue({ user: { role, email: "synthetic@example.test" } });
    const detail = await mocks.transfer();
    mocks.transfer.mockResolvedValue({ ...detail, transfer: {
      ...detail.transfer, stage, archived_at, funding_type, funding_plan_version: version,
      funding_plan_complete: false,
    } });
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    const provider = findElement(page, TransferPlanDraftProvider)!;
    expect(provider.props.canEdit).toBe(false);
    expect(provider.props.canApprove).toBe(eligible);
    expect(findElement(page, FundingPictureCard)!.props.canLinkAssetMap).toBe(false);
    if (eligible) {
      expect(provider.props.approvalMode).toBe("LEGACY_IN_TRANSFER_REVIEW");
      const section = findSections(page).find((candidate) => candidate.props.id === "transfer-funding-plan")!;
      expect(section).toBeDefined();
      expect(section.props.initiallyOpen).toBe(true);
      expect(findElement(section.props.children as ReactNode, TransferPlanApprovalFooter)).not.toBeNull();
      expect(findElement(section.props.children as ReactNode, TransferPlanPositionsCard)).not.toBeNull();
    }
  });

  it("keeps unauthenticated and invisible transfers from consulting the external source", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    await expect(TransferDetailPage({ params: Promise.resolve({ id: "unknown" }) })).rejects.toThrow("REDIRECT");
    expect(mocks.transfer).not.toHaveBeenCalled();
    mocks.transfer.mockResolvedValueOnce(null);
    await expect(TransferDetailPage({ params: Promise.resolve({ id: "unknown" }) })).rejects.toThrow("NOT_FOUND");
    expect(mocks.linkedUser).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
  });

  it("does not render a source reader when the check is disabled", async () => {
    mocks.enabled.mockReturnValue(false);
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    expect(findElement(page, ReceivingAccountsCard)!.props.fundingCoverage).toBeNull();
    expect(mocks.source).not.toHaveBeenCalled();
  });

  it("leaves the indicator absent on source failure instead of claiming funding is missing", async () => {
    mocks.source.mockRejectedValue(new Error("synthetic source failure"));
    expect(await InitialFundingCoverage({ cedarRidgeUserId: "synthetic-linked-user", accountLast4: "••••1234" })).toBeNull();
  });

  it("preserves the confirmed result and missing-request affordance after a successful read", async () => {
    mocks.source.mockResolvedValueOnce([{ id: "REQ-SYNTHETIC", tradeType: "Initial Funding", status: "Approved", accounts: [{ accountNumber: "****1234" }] }]);
    const covered = renderToStaticMarkup(await InitialFundingCoverage({ cedarRidgeUserId: "synthetic-linked-user", accountLast4: "••••1234" }));
    expect(covered).toContain("Initial funding · REQ-SYNTHETIC");
    expect(covered).not.toContain("Create funding request");
    mocks.source.mockResolvedValueOnce([]);
    const missing = renderToStaticMarkup(await InitialFundingCoverage({ cedarRidgeUserId: "synthetic-linked-user", accountLast4: "••••1234" }));
    expect(missing).toContain("No initial funding request");
    expect(missing).toContain("Create funding request");
  });

  it("keeps every working control in the same shared draft beneath collapsed sections", async () => {
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    expect(findElement(page, TransferOverviewSummary)).not.toBeNull();
    const provider = findElement(page, TransferPlanDraftProvider)!;
    expect(provider.props.canEdit).toBe(true);
    expect(provider.key).toContain("funding-plan-3");
    for (const component of [FundingPictureCard, DecisionChecklistCard, TransferPlanPositionsCard, TransferPlanApprovalFooter, LinkedDecisionCases, TransferChecklist]) {
      expect(findElement(provider.props.children as ReactNode, component)).not.toBeNull();
    }
    // A saved full ACAT must retain the client position component: changing the
    // draft to partial needs to reveal positions without first saving the rail.
    const funding = findSections(page).find((section) => findElement(section.props.children as ReactNode, DecisionChecklistCard))!;
    expect(planControlOrder(funding.props.children as ReactNode)).toEqual([
      DecisionChecklistCard, TransferPlanPositionsCard, TransferPlanApprovalFooter,
    ]);
    expect(provider.props.initialFundingType).toBe("ACAT_FULL");
    expect(findElement(provider.props.children as ReactNode, TransferPlanPositionsCard)!.props.positions).toEqual([]);
    expect(findSections(page).length).toBeGreaterThanOrEqual(4);
    expect(findSections(page).every((section) => !section.props.initiallyOpen)).toBe(true);
    expect(findElement(page, ReceivingAccountsCard)!.props.canWrite).toBe(true);
  });

  it("shows unresolved exceptions by default while preserving their list and existing owner", async () => {
    const cases = [
      { id: "synthetic-open", status: "OPEN", blocksTransfer: true, ownerTeam: "OPERATIONS", question: "Verify receiving registration" },
      { id: "synthetic-resolved", status: "RESOLVED", blocksTransfer: true, ownerTeam: "CLIENT_SERVICE", question: "Historical exception" },
    ];
    mocks.cases.mockResolvedValue(cases);
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    const exceptions = findSections(page).find((section) => findElement(section.props.children as ReactNode, LinkedDecisionCases));
    expect(exceptions).toBeDefined();
    expect(exceptions!.props.initiallyOpen).toBe(true);
    expect(exceptions!.props.meta).toContain("1 open");
    expect(findElement(page, LinkedDecisionCases)!.props.cases).toBe(cases);
    expect(findElement(page, TransferOverviewSummary)!.props).toMatchObject({ openExceptions: 1, blockingExceptions: 1 });
  });

  it("does not label legacy completion as a versioned funding-plan approval", async () => {
    const detail = await mocks.transfer();
    detail.transfer.funding_plan_complete = true;
    detail.transfer.funding_plan_version = 0;
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    const funding = findSections(page).find((section) => findElement(section.props.children as ReactNode, DecisionChecklistCard));
    expect(funding!.props.meta).toBe("Legacy completion — approval needed");
    expect(findElement(page, TransferOverviewSummary)!.props.transfer).toMatchObject({
      funding_plan_complete: true, funding_plan_version: 0,
    });
    const provider = findElement(page, TransferPlanDraftProvider)!;
    expect(provider.props.approvedVersion).toBe(0);
    expect(provider.props.canEdit).toBe(true);
  });

  it.each([
    { role: "VIEWER", archived: false, write: false, approve: false },
    { role: "OPERATIONS", archived: true, write: false, approve: false },
    { role: "CLIENT_SERVICE", archived: false, write: true, approve: false },
    { role: "OPERATIONS", archived: false, write: true, approve: true },
  ])("preserves $role archive=$archived permissions through presentation wrappers", async ({ role, archived, write, approve }) => {
    mocks.auth.mockResolvedValue({ user: { role, email: "synthetic@example.test" } });
    const detail = await mocks.transfer();
    detail.transfer.archived_at = archived ? new Date("2026-09-01T12:00:00Z") : null;
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    for (const component of [FundingPictureCard, DecisionChecklistCard, TransferChecklist, LinkedDecisionCases, ReceivingAccountsCard, TransferToolbar]) {
      expect(findElement(page, component)!.props.canWrite).toBe(write);
    }
    expect(findElement(page, TransferPlanDraftProvider)!.props.canEdit).toBe(approve);
  });

  it("preserves the stage-checklist feature gate", async () => {
    mocks.checklistGate.mockReturnValue(true);
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    expect(findElement(page, StageChecklistCard)).not.toBeNull();
    expect(findElement(page, TransferChecklist)).toBeNull();
    expect(findElement(page, DecisionChecklistCard)!.props.showReadiness).toBe(false);
  });

  it.each([
    { role: "OPERATIONS", eligible: true },
    { role: "ADMIN", eligible: true },
    { role: "CLIENT_SERVICE", eligible: false },
    { role: "ADVISOR", eligible: false },
    { role: "VIEWER", eligible: false },
  ])("gates both ACAT entry points to the same firm-wide permission for $role", async ({ role, eligible }) => {
    mocks.auth.mockResolvedValue({ user: { role, email: "synthetic@example.test" } });
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    expect(findElement(page, FundingPictureCard)!.props.canLinkAcat).toBe(eligible);
    expect(findElement(page, AcatLinkCta) !== null).toBe(eligible);
  });

  it.each([
    { stage: "FUNDED" },
    { archived_at: new Date("2026-09-24T00:00:00Z") },
    { acat_record_id: "synthetic-record" },
    { acat_transfer_id: "synthetic-uuid" },
  ])("hides both picker entry points when the target cannot be linked: %j", async (overrides) => {
    const detail = await mocks.transfer();
    Object.assign(detail.transfer, overrides);
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    expect(findElement(page, FundingPictureCard)!.props.canLinkAcat).toBe(false);
    expect(findElement(page, AcatLinkCta)).toBeNull();
  });

  it("streams linked live status in the overview outside collapsed working sections", async () => {
    const detail = await mocks.transfer();
    detail.transfer.acat_record_id = "synthetic-record";
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    const compact = findElement(page, AcatStatusSection)!;
    expect(compact).not.toBeNull();
    expect(compact.props).toMatchObject({ acatRecordId: "synthetic-record", summaryOnly: true });
    for (const section of findSections(page)) {
      expect(findElement(section.props.children as ReactNode, AcatStatusSection)).toBeNull();
    }
    expect(mocks.source).not.toHaveBeenCalled();
  });

  it.each([true, false])("replaces DRS generic checklists and Slack closeout with its workflow (checklist flag %s)", async (checklistGate) => {
    const detail = await mocks.transfer();
    detail.transfer.funding_type = "DRS";
    mocks.checklistGate.mockReturnValue(checklistGate);
    mocks.slackEnabled.mockReturnValue(true);
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });

    expect(findElement(page, DrsWorkflowCard)!.props).toMatchObject({
      tasks: [], role: "OPERATIONS", planComplete: true, fundingPlanVersion: 3,
    });
    expect(findSections(page).find((section) => section.props.id === "transfer-drs-workflow")!.props.initiallyOpen).toBe(true);
    expect(findElement(page, TransferChecklist)).toBeNull();
    expect(findElement(page, StageChecklistCard)).toBeNull();
    expect(findElement(page, AcatLinkCta)).toBeNull();
    expect(findElement(page, FundingPictureCard)!.props.canLinkAcat).toBe(false);
    const funding = findSections(page).find((section) => section.props.id === "transfer-funding-plan")!;
    expect(planControlOrder(funding.props.children as ReactNode)).toEqual([
      DecisionChecklistCard, TransferPlanPositionsCard, TransferPlanApprovalFooter,
    ]);
    expect(findElement(page, SlackCloseoutCard)).toBeNull();
    expect(mocks.slack).not.toHaveBeenCalled();
    expect(findElement(page, DecisionChecklistCard)!.props.showReadiness).toBe(false);
    const gates = findElement(page, GateStepper)!.props.gates as GateStatus[];
    expect(gates.find((gate) => gate.state === "now")!.satisfied).toBe(false);
    expect(gates[0].gate).toContain("Initialize or repair DRS task");
  });

  it("shows actual DRS approval and blocking-exception conditions even when every task is done", async () => {
    const detail = await mocks.transfer();
    detail.transfer.funding_type = "DRS";
    detail.transfer.funding_plan_complete = false;
    mocks.drsTasks.mockResolvedValue(DRS_TASKS.map((task) => ({ ...task, status: "DONE" })));
    mocks.cases.mockResolvedValue([{ status: "OPEN", blocksTransfer: true }]);
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    const gates = findElement(page, GateStepper)!.props.gates as GateStatus[];
    expect(gates[0].satisfied).toBe(false);
    expect(gates[0].gate).toContain("Approve the current DRS funding plan");
    expect(gates[0].gate).toContain("blocking exceptions");
  });

  it("keeps DRS reconciliation and client communication visible after funding", async () => {
    const detail = await mocks.transfer();
    detail.transfer.funding_type = "DRS";
    detail.transfer.stage = "FUNDED";
    mocks.drsTasks.mockResolvedValue(DRS_TASKS.map((task) => ({ ...task, status: task.requiredBefore === null ? "TODO" : "DONE" })));
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    expect(findElement(page, DrsWorkflowCard)!.props.stage).toBe("FUNDED");
    const gates = findElement(page, GateStepper)!.props.gates as GateStatus[];
    const current = gates.find((gate) => gate.state === "now")!;
    expect(current.satisfied).toBe(true);
    expect(current.gate).toContain("Apex confirmed the assets moved");
    expect(current.gate).not.toContain("Reconcile received securities");
    expect(current.gate).not.toContain("Notify the client");
    expect(findElement(page, SlackCloseoutCard)).toBeNull();
  });

  it.each([
    { stage: "IN_TRANSFER", reconciliationDone: false, expected: "Record Apex confirmation that the assets moved" },
    { stage: "FUNDED", reconciliationDone: false, expected: "Reconcile received securities and resolve differences" },
    { stage: "FUNDED", reconciliationDone: true, expected: "Notify the client and handle additional client requests" },
  ])("shows the current DRS phase's next task despite missing legacy preparation rows ($stage, reconciliation=$reconciliationDone)", async ({ stage, reconciliationDone, expected }) => {
    const detail = await mocks.transfer();
    detail.transfer.funding_type = "DRS";
    detail.transfer.stage = stage;
    mocks.drsTasks.mockResolvedValue(reconciliationDone
      ? [{ taskKey: "drs-reconciliation", status: "DONE" }]
      : []);

    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });

    expect(findElement(page, TransferOverviewSummary)!.props.nextTask).toBe(expected);
    expect(findElement(page, DrsWorkflowCard)).not.toBeNull();
  });

  it("keeps Client Service ownership controls but reserves DRS stage changes for Operations", async () => {
    const detail = await mocks.transfer();
    detail.transfer.funding_type = "DRS";
    mocks.auth.mockResolvedValue({ user: { role: "CLIENT_SERVICE", email: "synthetic@example.test" } });
    const page = await TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
    expect(findElement(page, TransferToolbar)!.props).toMatchObject({ canWrite: true, canChangeStage: false });
  });
});
