import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/asset-transfer",
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/data/asset-transfer-workspace", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), getAssetTransferWorkspace: vi.fn(),
}));
vi.mock("@/lib/transfers/mailing", async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), getMailingReport: vi.fn() }));
vi.mock("@/lib/data/transfer-directory", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), getTransferDirectory: vi.fn(),
}));
vi.mock("@/components/transfers/ProgressiveTransferBoard", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), ProgressiveTransferBoard: () => createElement("div", { "data-board-stub": "" }),
}));
vi.mock("@/app/(authenticated)/asset-transfer/actions", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), createTransfer: vi.fn(),
}));

import { auth } from "@/auth";
import { activeRejection, getAssetTransferWorkspace, lastFour } from "@/lib/data/asset-transfer-workspace";
import { getMailingReport, type MailingReportRow } from "@/lib/transfers/mailing";
import { getTransferDirectory } from "@/lib/data/transfer-directory";
import { parseTransferBoardQuery } from "@/lib/navigation/transfer-query";
import { filterTransfers, transferLifecycle, type WorkspaceTransfer } from "@/lib/transfers/workspace-queue";
import AssetTransferPage from "@/app/(authenticated)/asset-transfer/page";
import { TransfersView } from "@/components/asset-transfer/views/TransfersView";
import { WorkQueueView } from "@/components/asset-transfer/views/WorkQueueView";
import { ActivityView } from "@/components/asset-transfer/views/ActivityView";
import { filterMailings, MailingReport } from "@/components/asset-transfer/views/MailingReport";

function transfer(id: string, overrides: Partial<WorkspaceTransfer> = {}): WorkspaceTransfer {
  return {
    id, clientName: `Synthetic ${id}`, clientFirstName: "Synthetic", clientLastName: id, clientSfId: null,
    householdSfId: "HH-SYN-1", householdName: "Synthetic Household", stage: "DECISION", fundingType: "ACAT_FULL",
    transferringFirm: "Synthetic Brokerage", receivingAccount: "Individual", value: 25000, dealId: null, dealName: null, dealRef: "SYN-DEAL-1",
    source: { institution: "Synthetic Brokerage", type: "Individual", last4: "6027" },
    destination: { type: "Individual", last4: "5472", opening: false }, receivingAccounts: [], appAuthorized: true,
    statement: { accepted: true, recordedOn: "2026-09-30" }, outcome: null, rejection: null, receipts: 0,
    tasks: [{ id: `${id}-task`, transferId: id, title: "Approve funding plan", sortOrder: 0, status: "Ready", team: "Operations", assignedTo: null, followUpOn: null }],
    ...overrides,
  };
}

const MAILING: MailingReportRow = {
  id: "mail-1", transferId: "T1", href: "/asset-transfer/T1", recordedAt: "2026-10-14", client: "Synthetic T1",
  sourceAccount: "Synthetic Brokerage · Individual · ••6027", receivingAccount: "Individual", reason: "Signature needed",
  contents: "Transfer form", journey: "Cedar Ridge to the client to CedarRidge", postage: "$9.10", status: "In transit to CedarRidge",
  legs: [
    { number: 1, label: "Cedar Ridge → the client", from: "CedarRidge", to: "the client", carrier: "FedEx", trackingNumber: "SYN-TRACK-1", mailedOn: "2026-10-14", receivedOn: "2026-10-16" },
    { number: 2, label: "the client → CedarRidge", from: "the client", to: "CedarRidge", carrier: "USPS", trackingNumber: null, mailedOn: "2026-10-18", receivedOn: null },
  ],
};

const links = { scope: "", listHref: "/asset-transfer" };
const VIEW_SOURCES = resolve(process.cwd(), "components/asset-transfer/views");

function setup() {
  vi.mocked(auth).mockResolvedValue({ user: { name: "Riley Ops", email: "riley@example.test", role: "OPERATIONS" }, navigationScope: "s" } as never);
  vi.mocked(getAssetTransferWorkspace).mockResolvedValue({
    transfers: [transfer("T1"), transfer("T2", { stage: "FUNDED", outcome: "Deferred" })],
    activity: [{ id: "1", at: "2026-10-14T13:10:00.000Z", actor: "OPERATIONS", action: "transfer.funding_plan_approve", transferId: "T1" }],
  });
  vi.mocked(getMailingReport).mockResolvedValue([MAILING]);
  vi.mocked(getTransferDirectory).mockResolvedValue({ page: 1, pageCount: 1, snapshot: "snap" } as never);
}

async function renderPage(params: Record<string, string>): Promise<string> {
  const element = await AssetTransferPage({ searchParams: Promise.resolve(params) }) as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function" && element.type.name === "AssetTransferWorkspace") {
    const tree = await (element.type as (props: unknown) => Promise<ReactElement>)(element.props);
    return renderToStaticMarkup(tree);
  }
  return renderToStaticMarkup(element);
}

describe("asset transfer workspace views", () => {
  beforeEach(setup);
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it("flag on renders Transfers inside the AOA chrome without a redundant subnav or mailing tab", async () => {
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "1");
    for (const params of [{ view: "transfers" }, {}] as Record<string, string>[]) {
      const html = await renderPage(params);
      expect(html).toContain('class="atw atw-page"');
      expect(html).toContain("workspace-page-heading");
      expect(html).toContain('data-workspace-view="transfers"');
      expect(html).not.toContain('<nav class="workspace-tabs"');
      expect(html).not.toContain("Mailing report");
      expect(html).not.toContain("workspace-nav");
      expect(html).not.toContain("data-board-stub");
      expect(html).not.toContain("One stateful surface");
    }
    expect(getMailingReport).not.toHaveBeenCalled();
  });

  it("redirects bookmarked mailing reports to Reporting with every mailing filter intact before reading data", async () => {
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "1");
    await expect(renderPage({ view: "mailing" })).rejects.toThrow("redirect:/reporting/mailing");
    await expect(renderPage({ view: "mailing", q: "Synthetic client", carrier: "FedEx", mailingStatus: "in-transit",
      mailedFrom: "2026-10-01", mailedThrough: "2026-10-31", stage: "DECISION" })).rejects.toThrow(
      "redirect:/reporting/mailing?carrier=FedEx&mailedFrom=2026-10-01&mailedThrough=2026-10-31&mailingStatus=in-transit&q=Synthetic+client",
    );
    expect(getMailingReport).not.toHaveBeenCalled();
    expect(getAssetTransferWorkspace).not.toHaveBeenCalled();
  });

  it("flag on sends the moved views to their AOA tabs", async () => {
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "1");
    await expect(renderPage({ view: "queue", team: "Operations" })).rejects.toThrow("redirect:/tasks?team=Operations");
    await expect(renderPage({ view: "activity", q: "Synthetic" })).rejects.toThrow("redirect:/reporting/transfer-activity?q=Synthetic");
    await expect(renderPage({ view: "household", household: "household:HH-SYN-1" })).rejects.toThrow("redirect:/households/HH-SYN-1");
    await expect(renderPage({ view: "household" })).rejects.toThrow("redirect:/households");
  });

  it("flag off keeps the lifecycle board", async () => {
    vi.stubEnv("ASSET_TRANSFER_WORKSPACE", "");
    const html = await renderPage({});
    expect(html).toContain("Asset Transfer</h1>");
    expect(html).toContain("data-board-stub");
    expect(html).not.toContain('class="atw"');
    expect(getAssetTransferWorkspace).not.toHaveBeenCalled();
  });

  it("views use the mockup stylesheet only", () => {
    for (const file of readdirSync(VIEW_SOURCES)) {
      const source = readFileSync(resolve(VIEW_SOURCES, file), "utf8");
      expect(source, file).not.toMatch(/\.module\.css|from "@\/components\/ui"/);
    }
  });

  it("transfers view filters by outcome and keeps its query keys", () => {
    const rows = [transfer("T1"), transfer("T2", { outcome: "Deferred" }), transfer("T3", { outcome: "Canceled" })];
    expect(filterTransfers(rows, { query: "", stage: null, outcome: "deferred" }).map(row => row.id)).toEqual(["T2"]);
    expect(filterTransfers(rows, { query: "", stage: null, outcome: "stopped" }).map(row => row.id)).toEqual(["T3"]);
    expect(transferLifecycle({ outcome: "Client declined" })).toBe("stopped");
    const html = renderToStaticMarkup(createElement(TransfersView, { transfers: rows, query: "Synthetic", stage: "DECISION", outcome: "active", ...links }));
    expect(html).toContain('action="/asset-transfer"');
    expect(html).not.toContain('name="view"');
    for (const name of ['name="q"', 'name="stage"', 'name="outcome"']) expect(html).toContain(name);
    expect(html).toContain("1 transfers shown · 0 funded");
    expect(html).toContain('href="/asset-transfer/T1?from=transfers"');
    const empty = renderToStaticMarkup(createElement(TransfersView, { transfers: rows, query: "no-match", stage: null, outcome: null, ...links }));
    expect(empty).toContain("No transfers match these filters.");
  });

  it("queue tabs and layout buttons keep every other query key", () => {
    const html = renderToStaticMarkup(createElement(WorkQueueView, {
      transfers: [transfer("T1")], query: "Synthetic", taskStatus: "Waiting", team: "Operations", stage: "DECISION", followUp: "due", today: "2026-10-23", layout: "flat",
      household: "household:HH-SYN-1", householdName: "Synthetic Household", ...links,
    }));
    const form = (id: string) => html.match(new RegExp(`<form id="${id}"[^>]*>(.*?)</form>`))?.[1] ?? "";
    const hidden = (markup: string) => [...markup.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(match => `${match[1]}=${match[2]}`).sort();
    expect(hidden(form("queue-status"))).toEqual(["followUp=due", "household=household:HH-SYN-1", "layout=flat", "q=Synthetic", "stage=DECISION", "team=Operations"]);
    expect(hidden(form("queue-layout"))).toEqual(["followUp=due", "household=household:HH-SYN-1", "q=Synthetic", "stage=DECISION", "taskStatus=Waiting", "team=Operations"]);
    expect(hidden(form("queue-filters"))).toEqual(["household=household:HH-SYN-1", "layout=flat", "taskStatus=Waiting"]);
    expect(html).toContain('<form id="queue-filters" action="/tasks" method="get">');
    expect(html).toMatch(/<button type="submit" form="queue-status" value="Waiting" data-filter="waiting" aria-pressed="true" name="taskStatus">/);
    expect(html).toMatch(/<button type="submit" form="queue-layout" value="flat" aria-pressed="true" name="layout">Flat list/);
    for (const name of ['form="queue-filters" class="search" type="search"', 'form="queue-filters" name="team"', 'form="queue-filters" name="stage"', 'form="queue-filters" name="followUp"']) {
      expect(html).toContain(name);
    }
    expect(html).toContain("Asset transfer work queue · Synthetic Household");
    expect(html).toContain("Tasks</h1>");
    expect(html).toContain("No waiting tasks match these filters.");
  });

  it("queue by deal groups movements under their client", () => {
    const html = renderToStaticMarkup(createElement(WorkQueueView, {
      transfers: [transfer("T1"), transfer("T2", { clientName: "Synthetic T1" })], query: "", taskStatus: null, team: null, stage: null, followUp: null, today: "2026-10-23", layout: null,
      household: "", householdName: null, ...links,
    }));
    expect(html).toContain("client-deals");
    expect(html).toContain("2 deals with ready tasks");
    expect(html).toContain("Matching tasks: 1 ready · 0 waiting · 0 completed");
    expect(html).toContain('href="/asset-transfer/T1?from=queue"');
  });

  it("activity empty state", () => {
    const html = renderToStaticMarkup(createElement(ActivityView, { transfers: [transfer("T1")], activity: [], query: "", ...links }));
    expect(html).toContain("0 recorded events");
    expect(html).toContain("No recorded activity matches this search.");
  });

  it("mailing report shows one row per leg and filters by search and recorded date", () => {
    const html = renderToStaticMarkup(createElement(MailingReport, { rows: [MAILING], transfers: [transfer("T1")], filters: { query: "", from: "", through: "" } }));
    expect(html).toContain('action="/reporting/mailing"');
    expect(html).toContain('href="/reporting/mailing"');
    expect(html).not.toContain('name="view"');
    for (const text of ["FedEx &amp; manual mailers", "Cedar Ridge → the client", "the client → CedarRidge", "$9.10", "SYN-DEAL-1",
      "SYN-TRACK-1", "In transit to CedarRidge", 'name="mailingStatus"', 'name="carrier"', "In transit</span><strong>1</strong>",
      "Download CSV", 'name="mailedFrom"', 'name="mailedThrough"', 'href="/asset-transfer/T1?from=mailing"']) {
      expect(html).toContain(text);
    }
    expect(filterMailings([MAILING], { query: "signature", from: "2026-10-14", through: "2026-10-14" })).toHaveLength(1);
    expect(filterMailings([MAILING], { query: "", from: "2026-10-15", through: "" })).toHaveLength(0);
    expect(filterMailings([MAILING], { query: "syn-track-1", from: "", through: "" })).toHaveLength(1);
    expect(filterMailings([MAILING], { query: "", from: "", through: "", status: "in-transit" })).toHaveLength(1);
    expect(filterMailings([MAILING], { query: "", from: "", through: "", status: "not-mailed" })).toHaveLength(0);
    expect(filterMailings([MAILING], { query: "", from: "", through: "", carrier: "USPS" })).toHaveLength(1);
    expect(filterMailings([MAILING], { query: "", from: "", through: "", carrier: "DHL" })).toHaveLength(0);
    const undated = { ...MAILING, legs: MAILING.legs.map(leg => ({ ...leg, mailedOn: null, receivedOn: null })) };
    expect(filterMailings([undated], { query: "", from: "2026-10-14", through: "2026-10-14" })).toHaveLength(1);
    const empty = renderToStaticMarkup(createElement(MailingReport, { rows: [], transfers: [], filters: { query: "", from: "", through: "" } }));
    expect(empty).toContain("No mailings match these filters.");
  });

  it("exports only the displayed mailings and keeps the full journey in each CSV record", () => {
    const html = renderToStaticMarkup(createElement(MailingReport, {
      rows: [MAILING, { ...MAILING, id: "other", client: "Other Client", legs: MAILING.legs.map(leg => ({ ...leg, carrier: "DHL" })) }],
      transfers: [transfer("T1")], filters: { query: "", from: "", through: "", carrier: "FedEx" },
    }));
    const encoded = html.match(/href="data:text\/csv;charset=utf-8,([^"]+)"/)?.[1];
    expect(encoded).toBeTruthy();
    const csv = decodeURIComponent(encoded!);
    expect(csv).toContain("Synthetic T1");
    expect(csv).toContain("SYN-TRACK-1");
    expect(csv).toContain("FedEx | USPS");
    expect(csv).not.toContain("Other Client");
    expect(html).toContain('download="FedEx-manual-mailers.csv"');
  });

  it("query parser accepts the outcome and mailing-date keys", () => {
    const parsed = parseTransferBoardQuery(new URLSearchParams("view=transfers&outcome=stopped&mailedFrom=2026-10-01&mailedThrough=2026-10-31"));
    expect(parsed.outcome).toBe("stopped");
    expect(parsed.mailed).toEqual({ from: "2026-10-01", through: "2026-10-31", status: null, carrier: null });
    const filtered = parseTransferBoardQuery(new URLSearchParams("view=mailing&mailingStatus=in-transit&carrier=FedEx"));
    expect(filtered.mailed).toMatchObject({ status: "in-transit", carrier: "FedEx" });
    expect(() => parseTransferBoardQuery(new URLSearchParams("carrier=Pigeon"))).toThrow("invalid_transfer_query");
    expect(() => parseTransferBoardQuery(new URLSearchParams("mailingStatus=lost"))).toThrow("invalid_transfer_query");
    expect(() => parseTransferBoardQuery(new URLSearchParams("outcome=archived"))).toThrow("invalid_transfer_query");
    expect(() => parseTransferBoardQuery(new URLSearchParams("mailedFrom=2026-02-30"))).toThrow("invalid_transfer_query");
  });

  it("loader helpers mask numbers and close a rejection once resubmitted", () => {
    expect(lastFour("NSB-55016027")).toBe("6027");
    expect(lastFour(null)).toBeNull();
    const row = { transfer_id: "T1", follow_up_owner: "Client Service", response: null, awaiting_operations_review: false, created_at: new Date("2026-10-01") };
    expect(activeRejection(row, undefined)).toEqual({ owner: "Client Service", status: "open" });
    expect(activeRejection({ ...row, response: "Fixed", awaiting_operations_review: true }, undefined)?.status).toBe("returned");
    expect(activeRejection({ ...row, response: "Fixed" }, undefined)?.status).toBe("resolved");
    expect(activeRejection({ ...row, response: "Fixed" }, new Date("2026-10-02"))).toBeNull();
  });
});
