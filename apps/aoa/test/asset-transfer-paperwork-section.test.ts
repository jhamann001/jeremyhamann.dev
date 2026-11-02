import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markCase } from "./acat-book-flywheel";

vi.mock("server-only", () => ({}));
vi.mock("@/components/transfers/TransferAcatPicker", () => ({ TransferAcatPicker: () => null }));
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), transfer: vi.fn(), linkedUser: vi.fn(), source: vi.fn(),
  derived: vi.fn(), cases: vi.fn(), drsTasks: vi.fn(), slack: vi.fn(), fundingMethodHistory: vi.fn(),
  paperwork: vi.fn(), accounts: vi.fn(), statement: vi.fn(), match: vi.fn(),
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
vi.mock("@/lib/data/partial-acat-workspace-tasks", () => ({ getPartialAcatTasks: vi.fn(async () => []) }));
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
  showPlaidLinkedAccountSummariesEnabled: () => false,
  allowPlaidHoldingsPreviewEnabled: () => false,
  assetMapTransferLinkEnabled: () => true,
  checklistStageGateEnabled: () => false,
  initialFundingCheckEnabled: () => false,
  slackCloseoutEnabled: () => false,
  transferArchiveActionEnabled: () => false,
  assetTransferWorkspaceEnabled: () => true,
  paperworkRecordsEnabled: () => true,
}));
vi.mock("@/lib/data/transfer-paperwork-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPaperworkRecords: mocks.paperwork,
}));
vi.mock("@/lib/data/account-aum", () => ({ apexAccountsForClient: mocks.accounts }));
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
vi.mock("@/lib/transfers/intake-gates", () => ({ statementBlocks: mocks.statement, accountMatchBlocks: mocks.match }));
vi.mock("@/components/asset-transfer/intake/StatementAccountSection", () => ({ StatementAccountSection: () => null }));
vi.mock("@/lib/data/asset-transfer-workspace", () => ({ getAssetTransferWorkspace: vi.fn(async () => ({ transfers: [], activity: [] })) }));
vi.mock("@/lib/data/transfer-connections", () => ({
  getTransferConnections: vi.fn(async (_identity: unknown, transfer: { client_first_name: string; client_last_name: string; household_name: string | null }) => ({
    client: { name: `${transfer.client_first_name} ${transfer.client_last_name}`, householdName: transfer.household_name, source: "recorded" },
    directoryClient: null, custodian: null, roster: [],
    feeRequests: { state: "unavailable" }, tradeRequests: { state: "unavailable" }, receiving: [], trackerControlNumber: null,
  })),
}));
vi.mock("@/lib/data/transfer-workspace-detail", () => ({ getWorkspaceDetailRecords: vi.fn(async () => ({ taskMeta: [], history: [] })) }));

import TransferDetailPage from "@/app/(authenticated)/asset-transfer/[id]/page";
import { ReviewDownload, type ReviewDownloadProps } from "@/components/asset-transfer/paperwork/ReviewDownload";
import { MANUAL_TRANSFER_FORM_RULES } from "@/lib/transfers/manual-transfer-catalog";

const SUITE = "asset-transfer-paperwork-section";
const SESSION = { role: "OPERATIONS", email: "synthetic@example.test" };

function findAll(node: ReactNode, match: (element: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  const result: ReactElement<Record<string, unknown>>[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    const element = child as ReactElement<Record<string, unknown>>;
    if (match(element)) result.push(element);
    result.push(...findAll(child.props.children, match));
  }
  return result;
}

const baseTransfer = {
  id: "synthetic-transfer", client_sf_id: "synthetic-client", stage: "DECISION",
  stage_entered_at: new Date("2026-09-01T12:00:00Z"), value: 100,
  asset_map_folder_id: "synthetic-folder", asset_map_custodian: "Synthetic",
  asset_map_account_type: "Roth IRA", funding_type: "ACAT_FULL",
  funding_plan_version: 3, funding_plan_complete: true,
  funding_plan_approved_at: new Date("2026-10-01T12:00:00Z") as Date | null,
  owner_kind: "OPERATIONS", next_step: null, next_step_owner: null,
  transferring_firm: "Synthetic", asset_map_account_number: "SYNTHETIC-1234",
  client_first_name: "TEST", client_last_name: "CLIENT",
};

const records = (overrides: Record<string, unknown> = {}) => ({
  appAuthorizationRecorded: false,
  sentPacketRecorded: false,
  returnedSignatureRecorded: false,
  mailedPaperworkRecorded: false,
  drsServiceRequestRecorded: false,
  latestFormReview: null,
  latestStatement: { accepted: true },
  latestAccountMatch: null,
  ...overrides,
});

const review = (reviewed: boolean) => ({
  reviewed,
  receiving_form_title: "TEST RECEIVING",
  source_form_title: "TEST SOURCE",
  title_owners_confirmed: null,
  apex_account_id: "synthetic-account",
  form_id: "apex-acat-generic",
});

async function renderPage(transfer: Record<string, unknown> = {}) {
  mocks.transfer.mockResolvedValue({ transfer: { ...baseTransfer, ...transfer }, tasks: [], decisions: [], accounts: [] });
  return TransferDetailPage({ params: Promise.resolve({ id: "synthetic-transfer" }) });
}

async function reviewDownload(transfer: Record<string, unknown> = {}) {
  const page = await renderPage(transfer);
  const [element] = findAll(page, (node) => node.type === ReviewDownload);
  expect(element).toBeDefined();
  const props = element.props as unknown as ReviewDownloadProps;
  return { props, markup: renderToStaticMarkup(createElement(ReviewDownload, props)) };
}

describe("asset transfer paperwork section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: SESSION });
    mocks.cases.mockResolvedValue([]);
    mocks.fundingMethodHistory.mockResolvedValue([]);
    mocks.drsTasks.mockResolvedValue([]);
    mocks.linkedUser.mockResolvedValue("synthetic-linked-user");
    mocks.derived.mockResolvedValue({ registrationType: "Roth IRA", status: "OPEN", apexAccountMasked: "••••1234" });
    mocks.source.mockImplementation(() => new Promise(() => {}));
    mocks.paperwork.mockResolvedValue(records());
    mocks.accounts.mockResolvedValue([{
      custodianAccountId: "synthetic-account", apexAccountNumber: "SYNTHETIC0001",
      accountType: "Roth IRA", accountStatus: "OPEN",
    }]);
    mocks.statement.mockReturnValue(false);
    mocks.match.mockReturnValue(false);
  });

  it("route-figure-flag-on", async () => {
    mocks.paperwork.mockResolvedValue(records({ appAuthorizationRecorded: false }));
    const page = await renderPage();
    const [planPath] = findAll(page, (node) => node.props.className === "transfer-plan-path");
    expect(findAll(planPath.props.children as ReactNode, (node) => node.type === "strong" &&
      node.props.children === "Full ACAT · signed paperwork · Apex API")).toHaveLength(1);
    expect(findAll(page, (node) => node.type === "span" && node.props.children === "Route")).toHaveLength(0);
    expect(mocks.paperwork).toHaveBeenCalledWith(expect.objectContaining(SESSION), "synthetic-transfer");
    markCase(SUITE, "route-figure-flag-on");
  });

  it("generate-unavailable-download-gated", async () => {
    mocks.paperwork.mockResolvedValue(records({ latestFormReview: review(true) }));
    let view = await reviewDownload({ funding_plan_approved_at: null });
    expect(view.props.canGenerate).toBe(false);
    expect(view.props.canDownload).toBe(false);
    expect(view.markup).toContain("Generate paperwork is unavailable");
    expect(view.markup).not.toContain(">Generate paperwork<");
    expect(view.markup).not.toContain("View current paperwork");

    mocks.statement.mockReturnValue(true);
    view = await reviewDownload();
    expect(view.props.canGenerate).toBe(false);
    expect(view.props.canDownload).toBe(false);

    mocks.statement.mockReturnValue(false);
    mocks.paperwork.mockResolvedValue(records({ latestFormReview: review(false) }));
    view = await reviewDownload();
    expect(view.props.canGenerate).toBe(true);
    expect(view.props.canDownload).toBe(false);
    expect(view.markup).not.toContain("View current paperwork");

    mocks.paperwork.mockResolvedValue(records({ latestFormReview: review(true) }));
    view = await reviewDownload();
    expect(view.props.canDownload).toBe(true);
    expect(view.markup).toContain("View current paperwork");
    markCase(SUITE, "generate-unavailable-download-gated");
  });

  it("manual-no-invented-form", async () => {
    let view = await reviewDownload({ funding_type: "MANUAL", transferring_firm: "Synthetic Firm Not In Catalog" });
    expect(view.props.manualForms).toEqual([]);
    expect(view.markup).toContain("No reviewed form workflow is available for this custodian and route.");
    for (const rule of MANUAL_TRANSFER_FORM_RULES) expect(view.markup).not.toContain(`<li>${rule.displayName}</li>`);

    view = await reviewDownload({ funding_type: "MANUAL", transferring_firm: "Victory Funds" });
    expect(view.props.manualForms).toEqual([]);

    view = await reviewDownload({ funding_type: "MANUAL", transferring_firm: "Victory Funds", delivering_custodian_id: "custodian-victory" });
    expect(view.props.manualForms.map((rule) => rule.id)).toEqual(["victory-funds"]);
    markCase(SUITE, "manual-no-invented-form");
  });
});
