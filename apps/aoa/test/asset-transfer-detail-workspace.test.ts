import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("@/components/transfers/TransferAcatPicker", () => ({ TransferAcatPicker: () => null }));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), transfer: vi.fn(), workspaceOn: { value: true } }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: vi.fn(() => { throw new Error("Unexpected database read"); }) }));
vi.mock("next/navigation", () => ({
  redirect: () => { throw new Error("REDIRECT"); },
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
vi.mock("@/lib/data/transfer-detail", () => ({ getTransfer: mocks.transfer }));
vi.mock("@/app/(authenticated)/asset-transfer/funding-method-actions", () => ({
  getFundingMethodCorrections: vi.fn(async () => []),
  prepareFundingMethodChange: vi.fn(),
  changeFundingMethod: vi.fn(),
  confirmFundingMethodInitiated: vi.fn(),
}));
vi.mock("@/lib/data/decision-cases", () => ({ listDecisionCasesForTransfer: vi.fn(async () => []) }));
vi.mock("@/lib/data/drs-workflow-store", () => ({ getDrsWorkflowTasks: vi.fn(async () => []) }));
vi.mock("@/lib/data/transfers", () => ({ getSlackCloseout: vi.fn(async () => null) }));
vi.mock("@/lib/data/clients", () => ({ getCedarRidgeUserIdForLinkedReads: vi.fn(async () => null) }));
vi.mock("@/lib/data/deals", () => ({ dealsForHousehold: vi.fn(async () => null), getDeal: vi.fn(async () => null) }));
vi.mock("@/lib/data/transfer-asset-map", () => ({
  getAssignedAssetMapDetail: vi.fn(async () => null),
  getPartialAcatPositions: vi.fn(async () => []),
}));
vi.mock("@/lib/data/receiving-account-match", () => ({ getDerivedReceivingAccount: vi.fn(async () => null) }));
vi.mock("@/lib/data/trade-requests", () => ({ readTradeRequestsForUserCached: vi.fn(() => new Promise(() => {})) }));
vi.mock("@/lib/crm/resolve", () => ({ crmIdentityIdForSource: vi.fn(async () => null), crmRouteSource: () => "APP" }));
vi.mock("@/lib/flags", () => ({
  showPlaidLinkedAccountSummariesEnabled: () => false,
  allowPlaidHoldingsPreviewEnabled: () => false,
  assetMapTransferLinkEnabled: () => false,
  checklistStageGateEnabled: () => false,
  initialFundingCheckEnabled: () => false,
  slackCloseoutEnabled: () => false,
  transferArchiveActionEnabled: () => false,
  assetTransferWorkspaceEnabled: () => mocks.workspaceOn.value,
  paperworkRecordsEnabled: () => true,
}));
vi.mock("@/lib/data/transfer-paperwork-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPaperworkRecords: vi.fn(async () => ({
    appAuthorizationRecorded: false, sentPacketRecorded: false, returnedSignatureRecorded: false,
    mailedPaperworkRecorded: false, drsServiceRequestRecorded: false, latestFormReview: null,
    latestStatement: { accepted: true }, latestAccountMatch: null,
  })),
}));
vi.mock("@/lib/data/account-aum", () => ({ apexAccountsForClient: vi.fn(async () => []) }));
vi.mock("@/lib/transfers/receipt", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReceiptRecords: vi.fn(async () => ({ latestSubmission: null, latestTracking: null, receipts: [] })),
}));
vi.mock("@/lib/transfers/follow-up", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFollowUpRecords: vi.fn(async () => ({
    rejections: [], residuals: [], feeReimbursements: [], investmentRequestId: null,
    controlNumbers: [], arrivalPaused: false, resubmissionOpen: false,
  })),
}));
vi.mock("@/lib/transfers/outcomes", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOutcomeRecords: vi.fn(async () => ({ outcomes: [], corrections: [], stageChanges: [], paused: false })),
}));
vi.mock("@/lib/transfers/channels", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChannelRecords: vi.fn(async () => null),
}));
vi.mock("@/components/asset-transfer/intake/StatementAccountSection", () => ({ StatementAccountSection: () => null }));
vi.mock("@/components/asset-transfer/mailing/MailingSection", () => ({ MailingSection: () => null }));
vi.mock("@/lib/data/asset-transfer-workspace", () => ({ getAssetTransferWorkspace: vi.fn(async () => ({ transfers: [], activity: [] })) }));
vi.mock("@/lib/data/partial-acat-workspace-tasks", () => ({ getPartialAcatTasks: vi.fn(async () => []) }));
vi.mock("@/lib/data/transfer-workspace-detail", () => ({
  getWorkspaceDetailRecords: vi.fn(async () => ({
    taskMeta: [{ id: "task-1", status: "Ready", team: "OPERATIONS" }],
    history: [{ id: "1", at: "2026-10-01T12:00:00.000Z", actorRole: "OPERATIONS", action: "transfer.create" }],
  })),
}));

import TransferDetailPage from "@/app/(authenticated)/asset-transfer/[id]/page";
import { Card, CardBody, CardHeader, Pill } from "@/components/ui";
import { BackToBoardLink } from "@/components/transfers/BackToBoardLink";
import { TransferToolbar } from "@/components/transfers/TransferToolbar";
import { GateStepper } from "@/components/transfers/GateStepper";
import { TemperatureCard } from "@/components/transfers/TemperatureCard";
import { FundingPictureCard } from "@/components/transfers/FundingPictureCard";
import { TransferOverviewSummary } from "@/components/transfers/TransferOverviewSummary";
import { TransferDetailSection } from "@/components/transfers/TransferDetailSection";
import { DecisionChecklistCard } from "@/components/transfers/DecisionChecklistCard";
import { TransferPlanPositionsCard } from "@/components/transfers/TransferPlanPositionsCard";
import { TransferPlanApprovalFooter } from "@/components/transfers/TransferPlanApprovalFooter";
import { StageChecklistCard } from "@/components/transfers/StageChecklistCard";
import { TransferChecklist } from "@/components/transfers/TransferChecklist";
import { ReceivingAccountsCard } from "@/components/transfers/ReceivingAccountsCard";
import { SlackCloseoutCard } from "@/components/transfers/SlackCloseoutCard";
import { AcatStatusSection } from "@/components/transfers/AcatStatusSection";
import { AcatLinkCta } from "@/components/transfers/AcatLinkCta";
import { WorkspaceShell } from "@/components/asset-transfer/workspace/WorkspaceShell";
import { BtnLink, WorkflowSection } from "@/components/asset-transfer/workspace/ui";
import { MailingHistoryPanel } from "@/components/asset-transfer/mailing/MailingHistoryPanel";
import { ReviewDownload } from "@/components/asset-transfer/paperwork/ReviewDownload";
import { getPartialAcatTasks } from "@/lib/data/partial-acat-workspace-tasks";
import { PARTIAL_ACAT_EXECUTION_TASKS } from "@/lib/data/partial-acat-tasks";
import { partialAcatSourceKey } from "@/lib/transfers/partial-acat-queue";
import { TaskPanel } from "@/components/asset-transfer/detail/TaskPanel";
import { EditRecordDialog } from "@/components/asset-transfer/detail/EditRecordDialog";
import { UpdateTransferDialog } from "@/components/asset-transfer/detail/UpdateTransferDialog";
import { EditPlanDialog } from "@/components/asset-transfer/detail/PlanControls";
import { ListBackLink } from "@/components/navigation/ListBackLink";

const OLD_COMPONENTS: Record<string, unknown> = {
  Card, CardBody, CardHeader, Pill, BackToBoardLink, TransferToolbar, GateStepper, TemperatureCard, FundingPictureCard,
  TransferOverviewSummary, TransferDetailSection, DecisionChecklistCard, TransferPlanPositionsCard, TransferPlanApprovalFooter,
  StageChecklistCard, TransferChecklist, ReceivingAccountsCard, SlackCloseoutCard, AcatStatusSection, AcatLinkCta,
};

type Element = ReactElement<Record<string, unknown>>;

function findAll(node: ReactNode, match: (element: Element) => boolean): Element[] {
  const result: Element[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    const element = child as Element;
    if (match(element)) result.push(element);
    result.push(...findAll(child.props.children, match));
  }
  return result;
}

const transfer = {
  id: "synthetic-transfer", client_sf_id: "synthetic-client", stage: "DECISION",
  stage_entered_at: new Date("2026-09-01T12:00:00Z"), value: 100, asset_map_folder_id: null, asset_map_custodian: null,
  asset_map_account_type: "Roth IRA", funding_type: "ACAT_FULL", funding_plan_version: 1, funding_plan_complete: true,
  funding_plan_approved_at: new Date("2026-10-01T12:00:00Z"), owner_kind: "OPERATIONS", owner_name: null,
  next_step: null, next_step_owner: null, pending_nudge: null, transferring_firm: "Synthetic Firm",
  asset_map_account_number: "SYNTHETIC-1234", client_first_name: "TEST", client_last_name: "CLIENT",
  household_name: null, household_sf_id: null, acat_record_id: null, acat_transfer_id: null, deal_id: null,
  archived_at: null, archived_reason: null, archived_by: null, sync_flag: null, drs_method_change_pending: false,
  accounts_opened_at_apex: false, funding_initiated: false, cash_in_flight: false,   funding_plan_approved_by: null, funding_method_revision: 0,
};

async function renderPage(searchParams?: Record<string, string>) {
  mocks.transfer.mockResolvedValue({
    transfer,
    tasks: [{ id: "task-1", transfer_id: transfer.id, stage: "DECISION", title: "Run asset mapper", done: false, sort: 1, completed_at: null, completed_by: null, deal_task_key: null }],
    decisions: [], accounts: [],
  });
  return TransferDetailPage({ params: Promise.resolve({ id: transfer.id }), searchParams: searchParams ? Promise.resolve(searchParams) : undefined });
}

describe("asset transfer detail workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceOn.value = true;
    mocks.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "synthetic@example.test", name: "Synthetic Ops" } });
  });

  it("flag on renders the mockup composition and none of the old detail components", async () => {
    const page = await renderPage({ from: "queue" });
    for (const [name, component] of Object.entries(OLD_COMPONENTS)) {
      expect(findAll(page, node => node.type === component), name).toHaveLength(0);
    }
    const [shell] = findAll(page, node => node.type === WorkspaceShell);
    expect(shell.props.label).toBe("Transfer");
    expect(shell.props.tabs).toBeUndefined();
    expect(findAll(page, node => node.type === BtnLink && node.props.href === "/tasks")).toHaveLength(1);
    expect(findAll(page, node => node.type === MailingHistoryPanel).map(node => node.props.transferId)).toEqual([transfer.id]);
    expect(findAll(page, node => node.type === WorkflowSection).map(node => node.props.id)).toEqual(["intake", "mapping", "paperwork", "history"]);
    expect(findAll(page, node => node.type === WorkflowSection && node.props.open === true).map(node => node.props.id)).toEqual(["intake"]);
    for (const component of [TaskPanel, EditRecordDialog, UpdateTransferDialog, EditPlanDialog, ReviewDownload]) {
      expect(findAll(page, node => node.type === component)).toHaveLength(1);
    }
    const [tasks] = findAll(page, node => node.type === TaskPanel);
    expect(tasks.props.tasks).toEqual([expect.objectContaining({ title: "Run asset mapper", owner: "Operations", section: "mapping", status: "Ready" })]);
    expect(findAll(page, node => node.props.className === "transfer-identity")).toHaveLength(1);
    expect(findAll(page, node => node.props.className === "workflow-guide")).toHaveLength(1);
    expect(findAll(page, node => typeof node.props.className === "string" && /\bstyles?\b|module/.test(node.props.className))).toHaveLength(0);
  });

  it("flag off renders the existing detail unchanged", async () => {
    mocks.workspaceOn.value = false;
    const page = await renderPage();
    expect(findAll(page, node => node.type === WorkspaceShell)).toHaveLength(0);
    expect(findAll(page, node => node.type === TaskPanel)).toHaveLength(0);
    expect(getPartialAcatTasks).not.toHaveBeenCalled();
    expect(findAll(page, node => node.type === BackToBoardLink)).toHaveLength(1);
    expect(findAll(page, node => node.type === GateStepper)).toHaveLength(1);
    expect(findAll(page, node => node.type === TransferDetailSection).length).toBeGreaterThan(0);
  });

  it("returns a mailing-origin transfer to its scoped Reporting filters with a canonical bookmark fallback", async () => {
    mocks.auth.mockResolvedValue({ user: { role: "CLIENT_SERVICE", email: "synthetic@example.test" }, navigationScope: "synthetic-navigation-scope" });
    const page = await renderPage({ from: "mailing" });
    const [back] = findAll(page, node => node.type === ListBackLink);
    expect(back.props).toMatchObject({
      scope: "synthetic-navigation-scope", detailHref: `/asset-transfer/${transfer.id}`,
      fallback: "/reporting/mailing", className: "btn quiet",
    });
    expect(findAll(page, node => node.type === BtnLink && node.props.href === "/asset-transfer?view=mailing")).toHaveLength(0);
  });

  it("flag on shows the transfer's standard partial ACAT tasks beside its checklist", async () => {
    const track = PARTIAL_ACAT_EXECUTION_TASKS[2];
    transfer.funding_type = "ACAT_PARTIAL";
    vi.mocked(getPartialAcatTasks).mockResolvedValue([{
      id: "partial-track", transferId: transfer.id, title: track.title, sortOrder: track.sort, status: "TODO",
      ownerTeam: track.owner, taskKey: track.key, sourceKey: partialAcatSourceKey(transfer.id, track.key),
      priority: "NORMAL", completedAt: null, completedBy: null, updatedAt: "2026-10-01T12:00:00.000Z",
    }]);
    try {
      const page = await renderPage();
      const [tasks] = findAll(page, node => node.type === TaskPanel);
      expect(tasks.props.tasks).toEqual([
        expect.objectContaining({ title: "Run asset mapper", kind: "checklist" }),
        expect.objectContaining({
          id: "partial-track", kind: "partial-acat", title: track.title, status: "Ready", owner: "Operations",
          assignedTo: null, followUpOn: null,
          partialAcat: expect.objectContaining({ status: "TODO", fundingPlanVersion: 1, fundingMethodRevision: 0 }),
        }),
      ]);
    } finally {
      transfer.funding_type = "ACAT_FULL";
    }
  });

  it("flag-on detail modules import no old detail UI", () => {
    const dir = join(process.cwd(), "components/asset-transfer/detail");
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), "utf8");
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map(match => match[1]);
      for (const path of imports) {
        expect(path === "@/components/ui" || path.endsWith(".module.css"), `${file} imports ${path}`).toBe(false);
        if (path.startsWith("@/components/transfers/")) expect(path, `${file} imports ${path}`).toBe("@/components/transfers/transfer-form");
      }
    }
  });
});
