import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/reporting/mailing",
  redirect: (href: string) => { throw new Error(`redirect:${href}`); },
  notFound: () => { throw new Error("not-found"); },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/app/(authenticated)/acat-count-action", () => ({ getLiveAcatCount: vi.fn() }));
vi.mock("@/app/(authenticated)/nav-counts-action", () => ({ getLiveNavCounts: vi.fn() }));
vi.mock("@/lib/data/asset-transfer-workspace", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), getAssetTransferWorkspace: vi.fn(),
}));
vi.mock("@/lib/transfers/mailing", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), getMailingReport: vi.fn(),
}));
vi.mock("@/lib/data/crm-reporting", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), getCrmReportingDatasets: vi.fn(),
}));

import { auth } from "@/auth";
import { getAssetTransferWorkspace } from "@/lib/data/asset-transfer-workspace";
import { getMailingReport } from "@/lib/transfers/mailing";
import { getCrmReportingDatasets } from "@/lib/data/crm-reporting";
import { MAILING_REPORT_SHORTCUT } from "@/lib/reporting/saved-reports";
import { MailingReport } from "@/components/asset-transfer/views/MailingReport";
import { ReportingTabs } from "@/components/reporting/ReportingTabs";
import { SavedReportShortcuts } from "@/components/reporting/SavedReportShortcuts";
import { ReportingViewTools } from "@/components/crm/ReportingViewTools";
import { ReportingWorkbench } from "@/components/crm/ReportingWorkbench";
import { Sidebar } from "@/components/shell/Sidebar";
import MailingReportPage from "@/app/(authenticated)/reporting/mailing/page";
import ReportingPage from "@/app/(authenticated)/reporting/page";
import TransferActivityReportPage from "@/app/(authenticated)/reporting/transfer-activity/page";

const ROLES = ["ADMIN", "OPERATIONS", "CLIENT_SERVICE", "ADVISOR", "VIEWER"];
const NON_CRM_ROLES = ["CLIENT_SERVICE", "ADVISOR", "VIEWER"];

function signIn(role: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id: "synthetic-user", email: "synthetic@example.test", role }, navigationScope: "synthetic-scope" } as never);
}

function findAll(node: ReactNode, match: (element: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, match));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [...(match(element) ? [element] : []), ...findAll(element.props.children as ReactNode, match)];
}

const page = (searchParams: Record<string, string | string[] | undefined> = {}) =>
  MailingReportPage({ searchParams: Promise.resolve(searchParams) });

beforeEach(() => {
  vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "1");
  vi.stubEnv("CRM_REPORTING", "1");
  signIn("OPERATIONS");
  vi.mocked(getMailingReport).mockResolvedValue([]);
  vi.mocked(getAssetTransferWorkspace).mockResolvedValue({ transfers: [], activity: [] });
  vi.mocked(getCrmReportingDatasets).mockResolvedValue({ ok: true, datasets: [{ available: false, page: 1, snapshot: null }] } as never);
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("saved mailing report access", () => {
  it.each(ROLES)("preserves %s's mailing read scope without reading CRM reports", async role => {
    signIn(role);
    const tree = await page();
    const identity = { role, email: "synthetic@example.test" };
    expect(getMailingReport).toHaveBeenCalledWith(identity);
    expect(getAssetTransferWorkspace).toHaveBeenCalledWith(identity);
    expect(getCrmReportingDatasets).not.toHaveBeenCalled();
    const [tabs] = findAll(tree, node => node.type === ReportingTabs);
    expect(tabs.props).toMatchObject({ current: null,
      crm: !NON_CRM_ROLES.includes(role), transferActivity: !NON_CRM_ROLES.includes(role) });
    expect(renderToStaticMarkup(tabs)).not.toContain("/reporting/mailing");
    const [report] = findAll(tree, node => node.type === MailingReport);
    expect(report.props).toMatchObject({ rows: [], transfers: [], scope: "synthetic-scope", listHref: "/reporting/mailing" });
  });

  it.each(ROLES)("flag off refuses %s before any mailing/workspace read", async role => {
    signIn(role);
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "0");
    await expect(page()).rejects.toThrow("not-found");
    expect(getMailingReport).not.toHaveBeenCalled();
    expect(getAssetTransferWorkspace).not.toHaveBeenCalled();
  });

  it("requires authentication before any data read", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    await expect(page()).rejects.toThrow("redirect:/");
    expect(getMailingReport).not.toHaveBeenCalled();
    expect(getAssetTransferWorkspace).not.toHaveBeenCalled();
  });

  it("reuses mailing filters and the canonical scoped return URL", async () => {
    const tree = await page({ q: " Synthetic ", carrier: "FedEx", mailingStatus: "in-transit", mailedFrom: "2026-10-01", mailedThrough: "2026-10-28" });
    const [report] = findAll(tree, node => node.type === MailingReport);
    expect(report.props.filters).toEqual({ query: "Synthetic", from: "2026-10-01", through: "2026-10-28", status: "in-transit", carrier: "FedEx" });
    expect(report.props.listHref).toBe("/reporting/mailing?carrier=FedEx&mailedFrom=2026-10-01&mailedThrough=2026-10-28&mailingStatus=in-transit&q=Synthetic");
  });

  it.each([
    { q: ["one", "two"] }, { dataset: "household_aum" }, { mailedFrom: "2026-02-30" },
    { mailingStatus: "invented" }, { carrier: "invented" }, { q: "x".repeat(257) },
  ])("rejects malformed or unrelated report parameters before reading data: %j", async params => {
    await expect(page(params)).rejects.toThrow("redirect:/reporting/mailing");
    expect(getMailingReport).not.toHaveBeenCalled();
    expect(getAssetTransferWorkspace).not.toHaveBeenCalled();
  });
});

describe("Reporting entry and saved report shortcuts", () => {
  it.each(NON_CRM_ROLES)("lets %s enter Reporting for mailing while keeping CRM and activity restricted", async role => {
    signIn(role);
    await expect(ReportingPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/reporting/mailing");
    await expect(TransferActivityReportPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("not-found");
    expect(getCrmReportingDatasets).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(createElement(Sidebar, { role, counts: {}, crmReporting: true, assetTransferWorkspace: true }));
    expect(html).toContain('href="/reporting"');
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "0");
    await expect(ReportingPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("not-found");
    const disabledHtml = renderToStaticMarkup(createElement(Sidebar, { role, counts: {}, crmReporting: true }));
    expect(disabledHtml).not.toContain('href="/reporting"');
  });

  it.each(["ADMIN", "OPERATIONS"])("keeps %s's existing CRM-off landing and offers the saved mailing report there", async role => {
    signIn(role);
    vi.stubEnv("CRM_REPORTING", "0");
    await expect(ReportingPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/reporting/transfer-activity");
    const tree = await TransferActivityReportPage({ searchParams: Promise.resolve({}) });
    const [shortcuts] = findAll(tree, node => node.type === SavedReportShortcuts);
    expect(renderToStaticMarkup(shortcuts)).toContain('href="/reporting/mailing"');
    expect(renderToStaticMarkup(shortcuts)).toContain("Saved reports");
  });

  it("adds the built-in saved report to CRM shortcuts only while the workspace is enabled", async () => {
    const tree = await ReportingPage({ searchParams: Promise.resolve({}) });
    const [workbench] = findAll(tree, node => node.type === ReportingWorkbench);
    expect(workbench.props.savedReports).toEqual([MAILING_REPORT_SHORTCUT]);
    const tools = { currentHref: "/reporting", saveHref: "/reporting", dataset: "household_aum" as const, storageScope: "synthetic" };
    const html = renderToStaticMarkup(createElement(ReportingViewTools, { ...tools, savedReports: [MAILING_REPORT_SHORTCUT] }));
    expect(html).toContain("Saved reports");
    expect(html).toContain('href="/reporting/mailing"');
    expect(html).toContain("My saved views");
    expect(html).toContain("Save this view");
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "0");
    const off = await ReportingPage({ searchParams: Promise.resolve({}) });
    const [disabledWorkbench] = findAll(off, node => node.type === ReportingWorkbench);
    expect(disabledWorkbench.props.savedReports).toEqual([]);
    expect(renderToStaticMarkup(createElement(ReportingViewTools, tools))).not.toContain("/reporting/mailing");
  });
});
