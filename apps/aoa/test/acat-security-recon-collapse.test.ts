// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: nav.refresh, push: vi.fn() }) }));

import { AcatSecurityReconSection } from "@/components/transfers/AcatSecurityReconSection";


const SUITE = "acat-security-recon-collapse";

type Req = { method: string; path: string; search: string; body: any };
type Out = { status?: number; body: unknown };

const fetchMock = vi.fn();
let handler: (req: Req) => Out | Promise<Out>;
let posts: Req[];
let gets: Req[];

const MAPPING = {
  mappingTransferStatus: "Transferable", mappingTransferNotes: "Move in kind", mappingTransferring: true,
  mappingStatementDate: "2026-09-30", mappingStatementAgeDays: 12, mappingStatementIsStale: false,
  mappingSyncedAt: "2026-10-12T15:04:00.000Z",
};
const NO_MAPPING = {
  mappingTransferStatus: null, mappingTransferNotes: null, mappingTransferring: null, mappingStatementDate: null,
  mappingStatementAgeDays: null, mappingStatementIsStale: null, mappingSyncedAt: null,
};

function pos(id: string, symbol: string, status: string, over: Record<string, unknown> = {}) {
  return {
    id, symbol, description: `${symbol} description`, cusip: null, expectedQty: 100, actualQty: 100, amount: null,
    assetClass: null, status, issue: null, notes: null, mapping: MAPPING, ...over,
  };
}
function counts(total: number, matched: number, issues: number) {
  return { total, matched, issues, reconRate: total ? Math.round((matched / total) * 100) : 0 };
}
function snap(over: Record<string, unknown> = {}) {
  const positions = (over.positions as unknown[] | undefined) ?? [pos("a1", "VTI", "Matched"), pos("a2", "BND", "Mismatch", { actualQty: 90, issue: "Qty Mismatch (-10 shares)" })];
  return {
    acatId: "rec-1", mappingSource: "GCP Project API", apexSource: "Uploaded", lastSynced: "2026-10-12T15:04:00.000Z",
    sourceAccount: {
      id: "src-1", clientName: "Pat Example", holder: "Pat Example", registration: "Individual", custodian: "Fidelity",
      accountNumberLast4: "4321", statementDate: "2026-09-30", isHistorical: false,
    },
    hasStatementAccount: true, positions, counts: counts(positions.length, 1, 1), ...over,
  };
}
const okEnv = (snapshot: unknown, preview?: unknown): Out => ({ body: { ok: true, snapshot, ...(preview ? { preview } : {}) } });
const refusedEnv = (status: number, message: string, snapshot: unknown): Out => ({ body: { ok: false, refused: true, status, message, snapshot } });
const failEnv = (reason: string, retryable = true): Out => ({ status: retryable ? 502 : 422, body: { ok: false, refused: false, reason, retryable } });
const preview = (positions: unknown[], format = "activities") => ({ apexFormat: format, positions, counts: counts(positions.length, 0, positions.length) });

function installFetch() {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://localhost");
    const req: Req = { method: init?.method ?? "GET", path: u.pathname, search: u.search, body: init?.body ? JSON.parse(String(init.body)) : null };
    (req.method === "POST" ? posts : gets).push(req);
    const out = await handler(req);
    return { status: out.status ?? 200, ok: (out.status ?? 200) < 400, json: async () => out.body };
  });
}

beforeEach(() => {
  posts = [];
  gets = [];
  nav.refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  installFetch();
  handler = (req) => (req.method === "GET" && req.path.endsWith("/accounts") ? { body: { ok: true, accounts: [], truncated: false } } : okEnv(snap()));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Props = Partial<{ readOnly: boolean; clientName: string; controlNumber: string }>;
function mount(props: Props = {}) {
  return render(createElement(AcatSecurityReconSection, {
    recordId: "rec-1", clientName: "Pat Example", controlNumber: "CTRL-1", accountType: "Traditional IRA", readOnly: false, ...props,
  }));
}
const barText = () => screen.getByText("Reconciliation").closest("div")!.parentElement!.textContent ?? "";
const rowEls = (container: HTMLElement) => [...container.querySelectorAll("tbody tr")] as HTMLElement[];
async function loaded(container: HTMLElement) {
  await waitFor(() => expect(rowEls(container).length).toBeGreaterThan(-1));
  await waitFor(() => expect(screen.queryByText("Loading mapping data...")).toBeNull());
}


const gridToggle = () => screen.getByRole("button", { name: "Position Details" }) as HTMLButtonElement;
const gridBody = () => document.getElementById(gridToggle().getAttribute("aria-controls")!)!;

function captureDownloads() {
  const blobs: Blob[] = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:recon"; }) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  return { blobs };
}

describe("security recon Position Details collapse", () => {
  it("tkt332 refine recon: Position Details starts open with aria-expanded true, the note, and the table visible", async () => {
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    expect(gridToggle().getAttribute("aria-expanded")).toBe("true");
    expect(gridBody().hasAttribute("hidden")).toBe(false);
    expect(within(gridBody()).getByRole("table")).toBeTruthy();
    expect(within(gridBody()).getByText(/come from asset mapping/)).toBeTruthy();
    markCase(SUITE, "tkt332 refine recon: Position Details starts open with aria-expanded true, the note, and the table visible");
  });

  it("tkt332 refine recon: the native button collapses and reopens Position Details and updates aria-expanded", async () => {
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    fireEvent.click(gridToggle());
    expect(gridToggle().getAttribute("aria-expanded")).toBe("false");
    expect(gridBody().hasAttribute("hidden")).toBe(true);
    expect(screen.queryByRole("table")).toBeNull();
    // The note lives inside the hidden body, so it is out of view and out of the accessibility tree.
    expect(gridBody().contains(screen.getByText(/come from asset mapping/))).toBe(true);
    expect(screen.queryByRole("region", { name: "Position details" })).toBeNull();
    fireEvent.click(gridToggle());
    expect(gridToggle().getAttribute("aria-expanded")).toBe("true");
    expect(gridBody().hasAttribute("hidden")).toBe(false);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText(/come from asset mapping/)).toBeTruthy();
    markCase(SUITE, "tkt332 refine recon: the native button collapses and reopens Position Details and updates aria-expanded");
  });

  it("tkt332 refine recon: Download CSV stays in the header and still downloads every position while collapsed", async () => {
    const { blobs } = captureDownloads();
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    fireEvent.click(gridToggle());
    const download = screen.getByRole("button", { name: /Download CSV/ }) as HTMLButtonElement;
    expect(gridBody().contains(download)).toBe(false);
    expect(download.disabled).toBe(false);
    fireEvent.click(download);
    expect(blobs).toHaveLength(1);
    expect((await blobs[0].text()).split("\n")).toHaveLength(3);
    markCase(SUITE, "tkt332 refine recon: Download CSV stays in the header and still downloads every position while collapsed");
  });

  it("tkt332 refine recon: collapsing keeps the rows mounted and every other recon control visible", async () => {
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    fireEvent.click(gridToggle());
    expect(rowEls(container)).toHaveLength(2);
    expect(gridBody().contains(rowEls(container)[0])).toBe(true);
    expect(screen.getByRole("heading", { name: "Security Recon" })).toBeTruthy();
    expect(screen.getByLabelText("Upload Apex output CSV")).toBeTruthy();
    expect(screen.getByLabelText("Upload asset mapping CSV")).toBeTruthy();
    expect(barText()).toContain("2 positions");
    expect(screen.getByText("1 discrepancy detected")).toBeTruthy();
    markCase(SUITE, "tkt332 refine recon: collapsing keeps the rows mounted and every other recon control visible");
  });

  it("tkt332 refine recon: the toggle is a focusable native button of type button inside the heading that controls the body", async () => {
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    const button = gridToggle();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("tabindex")).toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(document.getElementById(button.getAttribute("aria-controls")!)).toBe(gridBody());
    expect(button.closest("h4")).toBeTruthy();
    markCase(SUITE, "tkt332 refine recon: the toggle is a focusable native button of type button inside the heading that controls the body");
  });
});
