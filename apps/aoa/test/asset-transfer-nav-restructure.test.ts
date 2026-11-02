import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/asset-transfer/T1",
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error("not-found"); },
}));
vi.mock("@/app/(authenticated)/acat-count-action", () => ({ getLiveAcatCount: vi.fn() }));
vi.mock("@/app/(authenticated)/nav-counts-action", () => ({ getLiveNavCounts: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/data/asset-transfer-workspace", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), getAssetTransferWorkspace: vi.fn(),
}));
vi.mock("@/lib/data/transfer-linked-holdings", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), linkedHoldingsEnabled: vi.fn(() => false),
}));
vi.mock("@/lib/data/decision-cases", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), listDecisionTasks: vi.fn(),
}));
vi.mock("@/lib/data/households", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), getHouseholdPageData: vi.fn(),
}));
vi.mock("@/lib/data/crm-reporting", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), getCrmReportingDatasets: vi.fn(),
}));

import { auth } from "@/auth";
import { getAssetTransferWorkspace } from "@/lib/data/asset-transfer-workspace";
import { listDecisionTasks, type DecisionTaskRow } from "@/lib/data/decision-cases";
import { getHouseholdPageData } from "@/lib/data/households";
import { getCrmReportingDatasets } from "@/lib/data/crm-reporting";
import type { WorkspaceTransfer } from "@/lib/transfers/workspace-queue";
import { Sidebar } from "@/components/shell/Sidebar";
import { TasksWorkspace } from "@/components/tasks/TasksWorkspace";
import { NonTransferTasks } from "@/components/tasks/NonTransferTasks";
import { WorkQueueView } from "@/components/asset-transfer/views/WorkQueueView";
import { WorkspaceShell } from "@/components/asset-transfer/workspace/WorkspaceShell";
import { HouseholdTransfersCard } from "@/components/asset-transfer/views/HouseholdTransfersCard";
import { HouseholdLinkedHoldings } from "@/components/asset-transfer/linked-holdings/HouseholdLinkedHoldings";
import { linkedHoldingsEnabled } from "@/lib/data/transfer-linked-holdings";
import { ReportingTabs } from "@/components/reporting/ReportingTabs";
import { householdHref, viewHref } from "@/components/asset-transfer/views/view-helpers";
import { safeListHref } from "@/lib/navigation/list-routes";
import TasksPage from "@/app/(authenticated)/(workflow)/tasks/page";
import HouseholdDetailPage from "@/app/(authenticated)/households/[id]/page";
import ReportingPage from "@/app/(authenticated)/reporting/page";
import TransferActivityReportPage from "@/app/(authenticated)/reporting/transfer-activity/page";

function transfer(id: string, overrides: Partial<WorkspaceTransfer> = {}): WorkspaceTransfer {
  return {
    id, clientName: `Synthetic ${id}`, clientFirstName: "Synthetic", clientLastName: id, clientSfId: null,
    householdSfId: "HH-SYN-1", householdName: "Synthetic Household", stage: "DECISION", fundingType: "ACAT_FULL",
    transferringFirm: "Synthetic Brokerage", receivingAccount: "Individual", value: 25000, dealId: null, dealName: null, dealRef: "SYN-DEAL-1",
    source: { institution: "Synthetic Brokerage", type: "Individual", last4: "2488" },
    destination: { type: "Individual", last4: "5472", opening: false }, receivingAccounts: [], appAuthorized: true,
    statement: { accepted: true, recordedOn: "2026-09-30" }, outcome: null, rejection: null, receipts: 0,
    tasks: [{ id: `${id}-task`, transferId: id, title: "Approve funding plan", sortOrder: 0, status: "Ready", team: "Operations", assignedTo: null, followUpOn: null }],
    ...overrides,
  };
}

function savedTask(id: string, transferId: string | null): DecisionTaskRow {
  return {
    id, source: transferId ? "ASSET_TRANSFER" : "DECISION", decisionId: transferId ? null : "decision-1", transferId, parentTaskId: null,
    title: transferId ? "Synthetic transfer task" : "Resolve the open decision", ownerTeam: "OPERATIONS", status: "TODO", priority: "NORMAL",
    householdName: "Synthetic Household", category: transferId ? "Asset transfer" : "Unclassified", createdBy: null, createdAt: "2026-10-01T12:00:00.000Z",
  };
}

function signIn(role: string) {
  vi.mocked(auth).mockResolvedValue({ user: { name: "Synthetic User", email: "synthetic@example.test", role }, navigationScope: "s" } as never);
}

function findAll(node: ReactNode, match: (element: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, match));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [...(match(element) ? [element] : []), ...findAll(element.props.children as ReactNode, match)];
}

function sidebarLinks(props: Record<string, unknown>): string[] {
  const html = renderToStaticMarkup(createElement(Sidebar, { role: "OPERATIONS", counts: {}, ...props } as never));
  return [...html.matchAll(/<a\b[^>]*href="(\/[^"]*)"/g)].map(match => match[1]);
}

function transferLink(props: Record<string, unknown>): string {
  const html = renderToStaticMarkup(createElement(Sidebar, { role: "OPERATIONS", counts: {}, ...props } as never));
  return html.match(/<a\b[^>]*href="\/asset-transfer"[^>]*>/)?.[0] ?? "";
}

async function resolveAsync(element: ReactElement<Record<string, unknown>>): Promise<ReactElement<Record<string, unknown>>> {
  return (element.type as (props: unknown) => Promise<ReactElement<Record<string, unknown>>>)(element.props);
}

beforeEach(() => {
  signIn("OPERATIONS");
  vi.mocked(getAssetTransferWorkspace).mockResolvedValue({ transfers: [transfer("T1")], activity: [] });
  vi.mocked(listDecisionTasks).mockResolvedValue([savedTask("saved-1", "T1"), savedTask("saved-2", null)]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("side navigation", () => {
  it("flag off keeps today's entries and exact-path highlighting", () => {
    const off = sidebarLinks({});
    expect(off).toEqual(expect.arrayContaining(["/households", "/asset-transfer", "/tasks"]));
    expect(off).not.toContain("/decision-center");
    expect(off).not.toContain("/reporting");
    expect(sidebarLinks({ crmReporting: true })).toContain("/reporting");
    expect(transferLink({})).not.toMatch(/active/);
  });

  it("flag on lists Reporting for mailing readers and highlights the transfer tab on detail pages", () => {
    const on = sidebarLinks({ assetTransferWorkspace: true });
    expect(on).toEqual(expect.arrayContaining(["/asset-transfer", "/tasks", "/reporting"]));
    expect(on).not.toContain("/decision-center");
    expect(sidebarLinks({ assetTransferWorkspace: true, role: "CLIENT_SERVICE" })).toContain("/reporting");
    expect(sidebarLinks({ crmReporting: true, role: "CLIENT_SERVICE" })).not.toContain("/reporting");
    expect(transferLink({ assetTransferWorkspace: true })).toMatch(/active/);
  });
});

describe("workspace routes", () => {
  it("send each moved view to its AOA home", () => {
    expect(viewHref({ view: "queue", team: "Operations" })).toBe("/tasks?team=Operations");
    expect(viewHref({ view: "activity" })).toBe("/reporting/transfer-activity");
    expect(viewHref({ view: "transfers", q: "Synthetic" })).toBe("/asset-transfer?q=Synthetic");
    expect(viewHref({ view: "mailing" })).toBe("/reporting/mailing");
    expect(viewHref({ view: "mailing", q: "Synthetic", carrier: "FedEx", mailedFrom: "2026-10-01" }))
      .toBe("/reporting/mailing?carrier=FedEx&mailedFrom=2026-10-01&q=Synthetic");
    expect(householdHref("household:HH-SYN-1")).toBe("/households/HH-SYN-1");
    expect(householdHref("transfer:T1")).toBe("/households");
    expect(safeListHref("/tasks?followUp=due&team=Operations")).toBe("/tasks?followUp=due&team=Operations");
    expect(safeListHref("/tasks?owner=OPERATIONS")).toBeNull();
    expect(safeListHref("/reporting/transfer-activity?q=Synthetic")).toBe("/reporting/transfer-activity?q=Synthetic");
    expect(safeListHref("/reporting/mailing?carrier=FedEx&q=Synthetic&mailedFrom=2026-10-01&mailedThrough=2026-10-31&mailingStatus=in-transit"))
      .toBe("/reporting/mailing?carrier=FedEx&mailedFrom=2026-10-01&mailedThrough=2026-10-31&mailingStatus=in-transit&q=Synthetic");
    expect(safeListHref("/reporting/mailing?returnTo=https://example.test")).toBeNull();
    expect(safeListHref("/reporting/mailing?q=one&q=two")).toBeNull();
    expect(safeListHref("/reporting/mailing?view=mailing")).toBeNull();
  });
});

describe("Tasks tab", () => {
  it("flag off renders today's Tasks workspace from saved tasks", async () => {
    const page = await TasksPage({ searchParams: Promise.resolve({}) }) as ReactElement<Record<string, unknown>>;
    expect(page.type).toBe(TasksWorkspace);
    expect((page.props.durableTasks as DecisionTaskRow[]).map(task => task.id)).toEqual(["saved-1", "saved-2"]);
    expect(getAssetTransferWorkspace).not.toHaveBeenCalled();
  });

  it("flag on renders the asset transfer work queue and keeps saved tasks with no transfer", async () => {
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "1");
    const page = await resolveAsync(await TasksPage({ searchParams: Promise.resolve({ followUp: "due", team: "Operations" }) }) as ReactElement<Record<string, unknown>>);
    expect(page.type).toBe(WorkspaceShell);
    const [queue] = findAll(page, node => node.type === WorkQueueView);
    expect(queue.props).toMatchObject({ followUp: "due", team: "Operations", listHref: "/tasks?followUp=due&team=Operations" });
    const [other] = findAll(page, node => node.type === NonTransferTasks);
    expect((other.props.tasks as DecisionTaskRow[]).map(task => task.id)).toEqual(["saved-2"]);
    expect(findAll(page, node => node.type === TasksWorkspace)).toHaveLength(0);
  });

  it("flag on omits the other-tasks section when every saved task belongs to a transfer", async () => {
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "1");
    vi.mocked(listDecisionTasks).mockResolvedValue([savedTask("saved-1", "T1")]);
    const page = await resolveAsync(await TasksPage({ searchParams: Promise.resolve({}) }) as ReactElement<Record<string, unknown>>);
    expect(findAll(page, node => node.type === NonTransferTasks)).toHaveLength(0);
  });

  it("flag on drops unknown queue parameters", async () => {
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "1");
    await expect(TasksPage({ searchParams: Promise.resolve({ owner: "OPERATIONS" }) }).then(page => resolveAsync(page as ReactElement<Record<string, unknown>>)))
      .rejects.toThrow("redirect:/tasks");
  });
});

describe("Household tab", () => {
  beforeEach(() => {
    vi.mocked(getHouseholdPageData).mockResolvedValue({
      canonicalRouteId: "HH-SYN-1", sourceSfIds: ["HH-SYN-1"],
      household: { sf_id: "HH-SYN-1", name: "Synthetic Household", household_kind: "CLIENT", status: "Client", employeeStatus: null,
        canonicalSourceCount: 1, aum: 0, aumPending: false, members: [], deals: [], dealSummary: null, advisorName: "Synthetic Advisor", lead_advisor_email: null },
    } as never);
  });

  async function renderHousehold() {
    return HouseholdDetailPage({ params: Promise.resolve({ id: "HH-SYN-1" }), searchParams: Promise.resolve({}) }) as Promise<ReactElement<Record<string, unknown>>>;
  }

  it("flag off has no Transfers card", async () => {
    expect(findAll(await renderHousehold(), node => node.type === HouseholdTransfersCard)).toHaveLength(0);
  });

  it("flag on adds the household's Transfers card", async () => {
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "1");
    const [card] = findAll(await renderHousehold(), node => node.type === HouseholdTransfersCard);
    expect(card.props).toMatchObject({ sourceSfIds: ["HH-SYN-1"], householdId: "HH-SYN-1" });
    const html = renderToStaticMarkup(await resolveAsync(card));
    expect(getAssetTransferWorkspace).toHaveBeenCalledWith(expect.anything(), { householdSfIds: ["HH-SYN-1"] });
    expect(html).toContain("Transfers</h2>");
    expect(html).toContain('data-transfer-id="T1"');
    expect(html).toContain('href="/asset-transfer/T1?from=household"');
  });

  it("carries the linked holdings section only when its flags are on", async () => {
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "1");
    const [card] = findAll(await renderHousehold(), node => node.type === HouseholdTransfersCard);
    expect(findAll(await resolveAsync(card), node => node.type === HouseholdLinkedHoldings)).toHaveLength(0);
    vi.mocked(linkedHoldingsEnabled).mockReturnValue(true);
    const tree = await resolveAsync(card);
    const [linked] = findAll(tree, node => node.type === HouseholdLinkedHoldings);
    expect((linked.props.transfers as WorkspaceTransfer[]).map(transfer => transfer.id)).toEqual(["T1"]);
  });
});

describe("Reporting tab", () => {
  beforeEach(() => {
    vi.mocked(getCrmReportingDatasets).mockResolvedValue({ ok: true, datasets: [{ available: false, page: 1, snapshot: null }] } as never);
  });

  async function renderActivity(role: string) {
    signIn(role);
    return TransferActivityReportPage({ searchParams: Promise.resolve({}) });
  }

  it("flag off leaves Reporting as today and has no transfer activity report", async () => {
    await expect(ReportingPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("not-found");
    vi.stubEnv("CRM_REPORTING", "1");
    const page = await ReportingPage({ searchParams: Promise.resolve({}) });
    const [tabs] = findAll(page, node => node.type === ReportingTabs);
    expect(tabs.props.transferActivity).toBe(false);
    expect(renderToStaticMarkup(tabs)).toBe("");
    await expect(renderActivity("OPERATIONS")).rejects.toThrow("not-found");
  });

  it("flag on adds the transfer activity report for audit roles only", async () => {
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "1");
    await expect(ReportingPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/reporting/transfer-activity");
    const html = renderToStaticMarkup(await renderActivity("OPERATIONS"));
    expect(html).toContain("Transfer activity</h1>");
    expect(html).toContain('action="/reporting/transfer-activity"');
    for (const role of ["CLIENT_SERVICE", "ADVISOR", "VIEWER"]) await expect(renderActivity(role)).rejects.toThrow("not-found");
  });
});
