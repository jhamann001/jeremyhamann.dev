// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: nav.refresh, push: vi.fn() }) }));

import { AcatSecurityReconSection } from "@/components/transfers/AcatSecurityReconSection";
import {
  RECON_BUSY,
  RECON_DOWNLOAD_FAILURE,
  RECON_MAPPING_TOO_LARGE,
  RECON_NOT_CSV,
  RECON_NO_STATEMENT,
  RECON_TEMPLATE_CSV,
  RECON_UNAVAILABLE,
  formatMappingSync,
} from "@/lib/data/acat-security-recon-contract";

const SUITE = "acat-security-recon-section";

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
const csv = (name: string, text = "a,b\n1,2\n") => new File([text], name, { type: "text/csv" });
async function pickApex(file: File) {
  fireEvent.change(screen.getByLabelText("Upload Apex output CSV"), { target: { files: [file] } });
}
async function pickMapping(file: File) {
  fireEvent.change(screen.getByLabelText("Upload asset mapping CSV"), { target: { files: [file] } });
}
async function loaded(container: HTMLElement) {
  await waitFor(() => expect(rowEls(container).length).toBeGreaterThan(-1));
  await waitFor(() => expect(screen.queryByText("Loading mapping data...")).toBeNull());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("security recon section", () => {
  it("tkt334 section: the loaded section shows source, account, last sync, and counts", async () => {
    const { container } = mount();
    expect(screen.getByText("Loading mapping data...")).toBeTruthy();
    await screen.findByText("Connected to GCP statement-pipeline");
    expect(screen.getByRole("heading", { name: "Security Recon" })).toBeTruthy();
    expect(container.textContent).toContain("GCP Project API");
    expect(container.textContent).toContain("Pat Example — Individual");
    expect(container.textContent).toContain("2026-09-30");
    expect(container.textContent).toContain(formatMappingSync("2026-10-12T15:04:00.000Z"));
    expect(container.textContent).toContain("2 positions");
    expect(barText()).toContain("2 positions");
    expect(barText()).toContain("1 matched");
    expect(barText()).toContain("1 issue");
    expect(barText()).toContain("50%");
    expect(gets[0].path).toBe("/api/acat-security-recon/rec-1");
    markCase(SUITE, "tkt334 section: the loaded section shows source, account, last sync, and counts");
  });

  it("tkt334 section: an empty transfer shows an empty grid with no position rows", async () => {
    handler = () => okEnv(snap({ positions: [], counts: counts(0, 0, 0), sourceAccount: null, mappingSource: null, lastSynced: null }));
    const { container } = mount();
    await screen.findByText("Not yet recorded");
    expect(screen.getByText("Position Details")).toBeTruthy();
    expect(container.querySelectorAll("thead th").length).toBe(11);
    expect(rowEls(container)).toHaveLength(0);
    expect(barText()).toContain("0 positions");
    markCase(SUITE, "tkt334 section: an empty transfer shows an empty grid with no position rows");
  });

  it("tkt334 section: a failed first load shows an empty grid and a retryable failure", async () => {
    let calls = 0;
    handler = () => (++calls === 1 ? failEnv("Could not load security reconciliation.") : okEnv(snap()));
    const { container } = mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load security reconciliation.");
    expect(rowEls(container)).toHaveLength(0);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(gets).toHaveLength(2);
    markCase(SUITE, "tkt334 section: a failed first load shows an empty grid and a retryable failure");
  });

  it("tkt334 section: a timed-out load is a retryable failure", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const { container } = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(RECON_UNAVAILABLE);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(rowEls(container)).toHaveLength(0);
    markCase(SUITE, "tkt334 section: a timed-out load is a retryable failure");
  });

  it("tkt334 section: a failed revalidation keeps the last shown grid", async () => {
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    handler = () => failEnv("Could not load security reconciliation.");
    const real = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(real + 6_000);
    fireEvent(window, new Event("focus"));
    spy.mockRestore();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load security reconciliation.");
    expect(rowEls(container)).toHaveLength(2);
    expect(container.textContent).toContain("VTI");
    handler = () => okEnv(snap());
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(rowEls(container)).toHaveLength(2);
    markCase(SUITE, "tkt334 section: a failed revalidation keeps the last shown grid");
  });

  it("tkt334 section: the grid shows eligibility, transferring, freshness, expected, actual, variance, status, issue, and notes", async () => {
    handler = () => okEnv(snap({
      positions: [pos("a2", "BND", "Mismatch", { cusip: "921937835", actualQty: 90, issue: "Qty Mismatch (-10 shares)", notes: "Called custodian" })],
      counts: counts(1, 0, 1),
    }));
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(1));
    const row = rowEls(container)[0];
    const headers = [...container.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(headers.slice(0, 10)).toEqual([
      "Asset / Symbol", "Transfer eligibility", "Transferring?", "Statement freshness", "Expected (DB)", "Actual (Apex)",
      "Variance", "Status", "Issue", "Notes",
    ]);
    const text = row.textContent ?? "";
    expect(text).toContain("BND");
    expect(text).toContain("BND description");
    expect(text).toContain("921937835");
    expect(text).toContain("Transferable");
    expect(text).toContain("Move in kind");
    expect(text).toContain("Yes");
    expect(text).toContain("2026-09-30");
    expect(text).toContain("Reported age: 12 days");
    expect(text).toContain("Not flagged stale");
    expect(text).toContain("Synced");
    expect(row.children[4].textContent).toBe("100");
    expect(row.children[5].textContent).toBe("90");
    expect(row.children[6].textContent).toBe("-10");
    expect(within(row).getByText("Mismatch").getAttribute("data-status")).toBe("Mismatch");
    expect(text).toContain("Qty Mismatch (-10 shares)");
    expect(text).toContain("Called custodian");
    expect(barText()).toContain("1 issue");
    expect(container.textContent).toContain("1 discrepancy detected");
    markCase(SUITE, "tkt334 section: the grid shows eligibility, transferring, freshness, expected, actual, variance, status, issue, and notes");
  });

  it("tkt334 section: the seven statuses show their words and tracker hues, and a saved Unmapped row is Mismatch", async () => {
    const statuses = ["Matched", "Mismatch", "Missing", "Unexpected", "Pending", "Expected", "Info"];
    handler = () => okEnv(snap({ positions: statuses.map((status, i) => pos(`p${i}`, `S${i}`, status)), counts: counts(7, 3, 4) }));
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(7));
    const hues: Record<string, string> = {
      Matched: "emerald", Info: "emerald", Pending: "blue", Expected: "violet", Mismatch: "amber", Missing: "amber", Unexpected: "amber",
    };
    for (const status of statuses) {
      const badge = container.querySelector(`[data-status="${status}"]`) as HTMLElement;
      expect(badge, status).toBeTruthy();
      expect(badge.textContent).toBe(status);
      expect(badge.getAttribute("data-hue")).toBe(hues[status]);
    }
    // The tracker returns a saved Unmapped row as Mismatch; AoA shows that word and the amber hue.
    expect(container.textContent).not.toContain("Unmapped");
    expect(container.querySelector('[data-status="Mismatch"]')!.getAttribute("data-hue")).toBe("amber");
    markCase(SUITE, "tkt334 section: the seven statuses show their words and tracker hues, and a saved Unmapped row is Mismatch");
  });

  it("tkt334 section: refresh shows the new sync time and clears an unsaved Apex preview", async () => {
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    handler = (req) => req.method === "POST" && req.body.kind === "apex"
      ? okEnv(snap(), preview([pos("apex-extra-0", "ZZZ", "Unexpected", { expectedQty: 0 })]))
      : okEnv(snap({ lastSynced: "2026-10-13T18:30:00.000Z", positions: [pos("n1", "NEW", "Matched")], counts: counts(1, 1, 0) }));
    await pickApex(csv("activities.csv"));
    await screen.findByText("activities.csv");
    expect(container.textContent).toContain("ZZZ");
    expect(screen.getByText("Save Recon Results")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sync from GCP" }));
    await screen.findByText("Sync Complete — Asset mapping refreshed from GCP");
    expect(posts[1].body).toEqual({ action: "refresh" });
    expect(container.textContent).toContain(formatMappingSync("2026-10-13T18:30:00.000Z"));
    expect(container.textContent).toContain("NEW");
    expect(container.textContent).not.toContain("ZZZ");
    expect(screen.queryByText("activities.csv")).toBeNull();
    expect(screen.queryByText("Save Recon Results")).toBeNull();
    expect(screen.queryByText(/positions parsed/)).toBeNull();
    expect(nav.refresh).toHaveBeenCalled();
    markCase(SUITE, "tkt334 section: refresh shows the new sync time and clears an unsaved Apex preview");
  });

  it("tkt334 section: a refused refresh opens the account picker and keeps the grid", async () => {
    const message = "Choose the source account registration before syncing. The account number alone cannot identify the correct holdings.";
    handler = (req) => {
      if (req.method === "GET" && req.path.endsWith("/accounts")) return { body: { ok: true, accounts: [], truncated: false } };
      return req.method === "POST" ? refusedEnv(409, message, snap()) : okEnv(snap());
    };
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Sync from GCP" }));
    const picker = await screen.findByRole("region", { name: "Choose mapping account" });
    expect(picker).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(message);
    expect(rowEls(container)).toHaveLength(2);
    expect(screen.queryByText(/Sync Complete/)).toBeNull();
    markCase(SUITE, "tkt334 section: a refused refresh opens the account picker and keeps the grid");
  });

  it("tkt334 section: choosing an account posts its id and shows its positions", async () => {
    const account = (id: string, name: string, count: number) => ({
      id, clientName: "Pat Example", holder: name, custodian: "Fidelity", registration: "Joint", accountNumberLast4: "9876",
      investorNumberLast4: null, statementDate: "2026-09-30", isHistorical: false, positionCount: count,
    });
    handler = (req) => {
      if (req.method === "GET" && req.path.endsWith("/accounts")) return { body: { ok: true, accounts: [account("src-1", "Pat Example", 2), account("src-2", "Pat and Sam Example", 1)], truncated: false } };
      if (req.method === "POST") return okEnv(snap({ positions: [pos("j1", "JNT", "Matched")], counts: counts(1, 1, 0), sourceAccount: { id: "src-2", clientName: "Pat Example", holder: "Pat and Sam Example", registration: "Joint", custodian: "Fidelity", accountNumberLast4: "9876", statementDate: "2026-09-30", isHistorical: false } }));
      return okEnv(snap());
    };
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Change mapping account" }));
    const picker = await screen.findByRole("region", { name: "Choose mapping account" });
    expect((within(picker).getByLabelText("Search mapping accounts") as HTMLInputElement).value).toBe("Example");
    await within(picker).findByText(/Pat and Sam Example — Joint/);
    expect(gets.some((g) => g.path.endsWith("/accounts") && g.search === "?q=Example")).toBe(true);
    const link = within(picker).getByRole("button", { name: "Link and sync" }) as HTMLButtonElement;
    expect(link.disabled).toBe(true);
    fireEvent.click(within(picker).getByRole("radio", { name: /Pat and Sam Example/ }));
    expect(within(picker).getByText(/Sync will replace expected holdings/)).toBeTruthy();
    fireEvent.click(link);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Choose mapping account" })).toBeNull());
    expect(posts[0].body).toEqual({ action: "refresh", sourceAccountId: "src-2" });
    expect(rowEls(container)).toHaveLength(1);
    expect(container.textContent).toContain("JNT");
    expect(container.textContent).toContain("Pat and Sam Example — Joint");
    markCase(SUITE, "tkt334 section: choosing an account posts its id and shows its positions");
  });

  it("tkt334 section: an account with no positions shows an empty grid", async () => {
    handler = (req) => req.method === "POST"
      ? okEnv(snap({ positions: [], counts: counts(0, 0, 0) }))
      : req.path.endsWith("/accounts")
        ? { body: { ok: true, accounts: [{ id: "src-3", clientName: "Pat Example", holder: "Pat Example", custodian: "Fidelity", registration: "Trust", accountNumberLast4: "1111", investorNumberLast4: null, statementDate: null, isHistorical: false, positionCount: 0 }], truncated: false } }
        : okEnv(snap());
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Change mapping account" }));
    const picker = await screen.findByRole("region", { name: "Choose mapping account" });
    fireEvent.click(await within(picker).findByRole("radio"));
    expect(within(picker).getByText(/0 positions · Statement: Not provided/)).toBeTruthy();
    fireEvent.click(within(picker).getByRole("button", { name: "Link and sync" }));
    await waitFor(() => expect(rowEls(container)).toHaveLength(0));
    expect(posts[0].body).toEqual({ action: "refresh", sourceAccountId: "src-3" });
    expect(barText()).toContain("0 positions");
    markCase(SUITE, "tkt334 section: an account with no positions shows an empty grid");
  });

  it("tkt334 section: an Apex file previews in the grid before save", async () => {
    const extra = [pos("apex-extra-0", "ZZZ", "Unexpected", { expectedQty: 0, actualQty: 5, issue: "Not in expected positions", mapping: NO_MAPPING }), pos("a1", "VTI", "Matched")];
    handler = (req) => req.method === "POST" ? okEnv(snap(), preview(extra, "activities")) : okEnv(snap());
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    await pickApex(csv("activities.csv", "Symbol,Qty\nZZZ,5\n"));
    await screen.findByText("2 positions parsed");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ action: "upload", kind: "apex", filename: "activities.csv", text: "Symbol,Qty\nZZZ,5\n" });
    expect(screen.getByText("Activities export")).toBeTruthy();
    expect(screen.getByText("activities.csv")).toBeTruthy();
    expect(container.textContent).toContain("ZZZ");
    expect(rowEls(container)[0].querySelector('[data-status="Unexpected"]')).toBeTruthy();
    expect(barText()).toContain("2 positions");
    expect(barText()).toContain("2 issues");
    expect(screen.getByRole("button", { name: /Save Recon Results/ })).toBeTruthy();
    expect(posts).toHaveLength(1);
    expect(nav.refresh).not.toHaveBeenCalled();
    markCase(SUITE, "tkt334 section: an Apex file previews in the grid before save");
  });

  it("tkt334 section: an unparsable Apex file keeps the saved positions and shows the failure", async () => {
    handler = (req) => req.method === "POST"
      ? refusedEnv(422, "Unrecognized CSV format. Expected an ACAT Output or Activities file.", snap())
      : okEnv(snap());
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    await pickApex(csv("random.csv", "foo,bar\n1,2\n"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Unrecognized CSV format. Expected an ACAT Output or Activities file.");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(rowEls(container)).toHaveLength(2);
    expect(container.textContent).toContain("VTI");
    expect(screen.queryByText("random.csv")).toBeNull();
    expect(screen.queryByRole("button", { name: /Save Recon Results/ })).toBeNull();
    markCase(SUITE, "tkt334 section: an unparsable Apex file keeps the saved positions and shows the failure");
  });

  it("tkt334 section: a mapping file is saved at once and shows the stored positions with no Save button", async () => {
    handler = (req) => req.method === "POST"
      ? okEnv(snap({ mappingSource: "Spreadsheet Upload", positions: [pos("m1", "AAA", "Matched"), pos("m2", "BBB", "Pending")], counts: counts(2, 1, 0) }))
      : okEnv(snap());
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    await pickMapping(csv("mapping.csv", "Account Number,Symbol\n1,AAA\n"));
    await screen.findByText("Mapping Imported — 2 positions saved to this transfer.");
    expect(posts[0].body).toEqual({ action: "upload", kind: "mapping", filename: "mapping.csv", text: "Account Number,Symbol\n1,AAA\n" });
    expect(container.textContent).toContain("Spreadsheet Upload");
    expect(container.textContent).toContain("AAA");
    expect(container.textContent).not.toContain("VTI");
    expect(screen.queryByRole("button", { name: /Save Recon Results/ })).toBeNull();
    expect(nav.refresh).toHaveBeenCalled();
    markCase(SUITE, "tkt334 section: a mapping file is saved at once and shows the stored positions with no Save button");
  });

  it("tkt334 section: a large mapping file or a missing statement account sends nothing", async () => {
    const { container, unmount } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    const big = csv("big.csv");
    Object.defineProperty(big, "size", { value: 3 * 1024 * 1024 });
    await pickMapping(big);
    expect((await screen.findByRole("alert")).textContent).toContain(RECON_MAPPING_TOO_LARGE);
    expect(posts).toHaveLength(0);
    unmount();
    handler = () => okEnv(snap({ hasStatementAccount: false }));
    const second = mount();
    await waitFor(() => expect(rowEls(second.container)).toHaveLength(2));
    await pickMapping(csv("mapping.csv"));
    expect((await screen.findByRole("alert")).textContent).toContain(RECON_NO_STATEMENT);
    expect(posts).toHaveLength(0);
    markCase(SUITE, "tkt334 section: a large mapping file or a missing statement account sends nothing");
  });

  it("tkt334 section: a non-csv drop is refused with the tracker message", async () => {
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    const zone = screen.getByText("Drop Apex CSV here").closest("div")!;
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
    expect((await screen.findByRole("alert")).textContent).toContain(RECON_NOT_CSV);
    expect(posts).toHaveLength(0);
    expect(rowEls(container)).toHaveLength(2);
    markCase(SUITE, "tkt334 section: a non-csv drop is refused with the tracker message");
  });

  it("tkt334 section: save posts the shown rows, the Apex flag, and the overridden ids, then shows stored counts", async () => {
    const shown = [pos("a1", "VTI", "Matched", { cusip: "922908769", amount: 25000, assetClass: "ETF" }), pos("apex-extra-0", "ZZZ", "Unexpected", { expectedQty: 0, actualQty: 5, issue: "Not in expected positions" })];
    handler = (req) => {
      if (req.method === "POST" && req.body.action === "upload") return okEnv(snap(), preview(shown));
      if (req.method === "POST") return okEnv(snap({ positions: [pos("a1", "VTI", "Matched"), pos("a3", "ZZZ", "Mismatch"), pos("a4", "NEW", "Matched")], counts: counts(3, 2, 1) }));
      return okEnv(snap());
    };
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    await pickApex(csv("activities.csv"));
    await screen.findByText("2 positions parsed");
    fireEvent.click(screen.getByRole("button", { name: /Save Recon Results/ }));
    await screen.findByText("Recon Saved — Reconciliation results persisted to database");
    const body = posts[1].body;
    expect(body.action).toBe("save");
    expect(body.apexUploaded).toBe(true);
    expect(body.overriddenIds).toEqual([]);
    expect(body.rows).toEqual([
      { id: "a1", symbol: "VTI", description: "VTI description", cusip: "922908769", actualQty: 100, amount: 25000, assetClass: "ETF", status: "Matched", issue: null, notes: null },
      { id: "apex-extra-0", symbol: "ZZZ", description: "ZZZ description", cusip: null, actualQty: 5, amount: null, assetClass: null, status: "Unexpected", issue: "Not in expected positions", notes: null },
    ]);
    expect(barText()).toContain("3 positions");
    expect(barText()).toContain("2 matched");
    expect(barText()).toContain("1 issue");
    expect(rowEls(container)).toHaveLength(3);
    expect(screen.queryByText("activities.csv")).toBeNull();
    expect(screen.queryByRole("button", { name: /Save Recon Results/ })).toBeNull();
    markCase(SUITE, "tkt334 section: save posts the shown rows, the Apex flag, and the overridden ids, then shows stored counts");
  });

  it("tkt334 section: saving an empty grid sends no rows", async () => {
    handler = (req) => {
      if (req.method === "POST" && req.body.action === "upload") return okEnv(snap(), preview([]));
      if (req.method === "POST") return okEnv(snap({ positions: [], counts: counts(0, 0, 0) }));
      return okEnv(snap());
    };
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    await pickApex(csv("activities.csv"));
    await screen.findByText("0 positions parsed");
    expect(rowEls(container)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Save Recon Results/ }));
    await screen.findByText("Recon Saved — Reconciliation results persisted to database");
    expect(posts[1].body).toEqual({ action: "save", rows: [], apexUploaded: true, overriddenIds: [] });
    expect(rowEls(container)).toHaveLength(0);
    expect(barText()).toContain("0 positions");
    markCase(SUITE, "tkt334 section: saving an empty grid sends no rows");
  });

  it("tkt334 section: a failed save shows the saved grid and a retry that re-sends the same draft", async () => {
    const shown = [pos("apex-extra-0", "ZZZ", "Unexpected", { expectedQty: 0, actualQty: 5 }), pos("apex-extra-1", "YYY", "Unexpected", { expectedQty: 0, actualQty: 7 })];
    let saveAttempts = 0;
    handler = (req) => {
      if (req.method === "POST" && req.body.action === "upload") return okEnv(snap(), preview(shown));
      if (req.method === "POST") return ++saveAttempts === 1 ? failEnv(RECON_UNAVAILABLE) : okEnv(snap({ positions: [pos("a9", "ZZZ", "Mismatch")], counts: counts(1, 0, 1) }));
      return okEnv(snap());
    };
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    await pickApex(csv("activities.csv"));
    await screen.findByText("2 positions parsed");
    fireEvent.click(screen.getByRole("button", { name: /Save Recon Results/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Reconciliation was not saved.");
    expect(rowEls(container)).toHaveLength(2);
    expect(container.textContent).toContain("VTI");
    expect(container.textContent).not.toContain("YYY");
    expect(screen.queryByRole("button", { name: /Save Recon Results/ })).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText("Recon Saved — Reconciliation results persisted to database");
    expect(posts).toHaveLength(3);
    expect(posts[2].body).toEqual(posts[1].body);
    expect(posts[1].body.rows.map((r: { id: string }) => r.id)).toEqual(["apex-extra-0", "apex-extra-1"]);
    expect(container.textContent).toContain("ZZZ");
    expect(screen.queryByRole("alert")).toBeNull();
    markCase(SUITE, "tkt334 section: a failed save shows the saved grid and a retry that re-sends the same draft");
  });

  it("tkt334 section: a refused save adopts the returned stored positions", async () => {
    const shown = [pos("apex-extra-0", "ZZZ", "Unexpected", { expectedQty: 0, actualQty: 5 })];
    handler = (req) => {
      if (req.method === "POST" && req.body.action === "upload") return okEnv(snap(), preview(shown));
      if (req.method === "POST") return refusedEnv(400, "Failed to save", snap({ positions: [pos("a7", "STORED", "Matched")], counts: counts(1, 1, 0) }));
      return okEnv(snap());
    };
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    await pickApex(csv("activities.csv"));
    await screen.findByText("1 positions parsed");
    fireEvent.click(screen.getByRole("button", { name: /Save Recon Results/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Failed to save");
    expect(rowEls(container)).toHaveLength(1);
    expect(container.textContent).toContain("STORED");
    expect(container.textContent).not.toContain("ZZZ");
    expect(barText()).toContain("1 positions");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    markCase(SUITE, "tkt334 section: a refused save adopts the returned stored positions");
  });

  it("tkt334 section: a second save while an upload runs sends nothing, keeps the earlier grid, and offers a retry", async () => {
    const shown = [pos("apex-extra-0", "ZZZ", "Unexpected", { expectedQty: 0, actualQty: 5 })];
    const pending = deferred<Out>();
    handler = (req) => {
      if (req.method === "POST" && req.body.kind === "apex") return okEnv(snap(), preview(shown));
      if (req.method === "POST" && req.body.kind === "mapping") return pending.promise;
      return okEnv(snap());
    };
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    await pickApex(csv("activities.csv"));
    await screen.findByText("1 positions parsed");
    await pickMapping(csv("mapping.csv"));
    await waitFor(() => expect(posts).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /Save Recon Results/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(RECON_BUSY);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(posts).toHaveLength(2);
    expect(container.textContent).toContain("ZZZ");
    expect(rowEls(container)).toHaveLength(1);
    await act(async () => { pending.resolve(okEnv(snap({ positions: [pos("m1", "MAP", "Matched")], counts: counts(1, 1, 0) }))); });
    await waitFor(() => expect(container.textContent).toContain("MAP"));
    markCase(SUITE, "tkt334 section: a second save while an upload runs sends nothing, keeps the earlier grid, and offers a retry");
  });

  it("tkt334 section: a second upload while a save runs sends nothing, keeps the earlier grid, and offers a retry", async () => {
    const shown = [pos("apex-extra-0", "ZZZ", "Unexpected", { expectedQty: 0, actualQty: 5 })];
    const pending = deferred<Out>();
    handler = (req) => {
      if (req.method === "POST" && req.body.action === "upload") return okEnv(snap(), preview(shown));
      if (req.method === "POST" && req.body.action === "save") return pending.promise;
      return okEnv(snap());
    };
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    await pickApex(csv("activities.csv"));
    await screen.findByText("1 positions parsed");
    fireEvent.click(screen.getByRole("button", { name: /Save Recon Results/ }));
    await waitFor(() => expect(posts).toHaveLength(2));
    const zone = screen.getByLabelText("Upload Apex output CSV").parentElement!;
    fireEvent.drop(zone, { dataTransfer: { files: [csv("second.csv")] } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(RECON_BUSY);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(posts).toHaveLength(2);
    expect(container.textContent).toContain("ZZZ");
    await act(async () => { pending.resolve(okEnv(snap({ positions: [pos("s1", "SAVED", "Matched")], counts: counts(1, 1, 0) }))); });
    await waitFor(() => expect(container.textContent).toContain("SAVED"));
    markCase(SUITE, "tkt334 section: a second upload while a save runs sends nothing, keeps the earlier grid, and offers a retry");
  });

  it("tkt334 section: a row override edits quantity, status, issue, and note, marks Manual, and leaves counts until save", async () => {
    handler = (req) => req.method === "POST"
      ? okEnv(snap({ positions: [pos("a1", "VTI", "Mismatch", { actualQty: 95 }), pos("a2", "BND", "Mismatch")], counts: counts(2, 0, 2) }))
      : okEnv(snap());
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    const before = barText();
    fireEvent.click(screen.getByRole("button", { name: "Manually override VTI" }));
    fireEvent.change(screen.getByLabelText("Actual quantity"), { target: { value: "95" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "Mismatch" } });
    fireEvent.change(screen.getByLabelText("Issue"), { target: { value: "Verified short" } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "  Checked PDF  " } });
    expect([...(screen.getByLabelText("Status") as HTMLSelectElement).options].map((o) => o.value)).toEqual(
      ["Matched", "Mismatch", "Missing", "Pending", "Expected", "Unexpected"],
    );
    fireEvent.keyDown(screen.getByLabelText("Notes"), { key: "Enter" });
    const row = rowEls(container)[0];
    expect(within(row).getByText("Manual")).toBeTruthy();
    expect(row.querySelector('[data-status="Mismatch"]')).toBeTruthy();
    expect(row.textContent).toContain("Verified short");
    expect(row.textContent).toContain("Checked PDF");
    expect(row.children[5].textContent).toBe("95");
    expect(barText()).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: /Save Recon Results/ }));
    await screen.findByText("Recon Saved — Reconciliation results persisted to database");
    expect(posts[0].body.apexUploaded).toBe(false);
    expect(posts[0].body.overriddenIds).toEqual(["a1"]);
    expect(posts[0].body.rows[0]).toMatchObject({ id: "a1", actualQty: 95, status: "Mismatch", issue: "Verified short", notes: "Checked PDF" });
    markCase(SUITE, "tkt334 section: a row override edits quantity, status, issue, and note, marks Manual, and leaves counts until save");
  });

  it("tkt334 section: an Info row has no pencil", async () => {
    handler = () => okEnv(snap({ positions: [pos("a1", "VTI", "Matched"), pos("fee-1", "FEE", "Info", { expectedQty: 0, mapping: NO_MAPPING })], counts: counts(2, 2, 0) }));
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Manually override VTI" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Manually override FEE" })).toBeNull();
    markCase(SUITE, "tkt334 section: an Info row has no pencil");
  });

  function captureDownloads() {
    const blobs: Blob[] = [];
    const names: string[] = [];
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:recon"; }) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    return { blobs, names };
  }

  it("tkt334 section: Download CSV contains every position", async () => {
    const { blobs, names } = captureDownloads();
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /Download CSV/ }));
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("text/csv;charset=utf-8");
    const lines = (await blobs[0].text()).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith("Symbol,Description,CUSIP,Expected Qty (DB)")).toBe(true);
    expect(lines[1].startsWith("VTI,VTI description,,100,100,0,Matched")).toBe(true);
    expect(lines[2].startsWith("BND,BND description,,100,90,-10,Mismatch,Qty Mismatch (-10 shares)")).toBe(true);
    expect(names[0]).toMatch(/^acat-CTRL-1-recon-\d{4}-\d{2}-\d{2}\.csv$/);
    markCase(SUITE, "tkt334 section: Download CSV contains every position");
  });

  it("tkt334 section: Download CSV of a 600-row grid contains all 600 rows although only a few are on screen", async () => {
    const many = Array.from({ length: 600 }, (_, i) => pos(`r${i}`, `S${i}`, "Matched"));
    handler = () => okEnv(snap({ positions: many, counts: counts(600, 600, 0) }));
    const { blobs } = captureDownloads();
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(600));
    fireEvent.click(screen.getByRole("button", { name: /Download CSV/ }));
    const lines = (await blobs[0].text()).split("\n");
    expect(lines).toHaveLength(601);
    expect(lines[1].startsWith("S0,")).toBe(true);
    expect(lines[600].startsWith("S599,")).toBe(true);
    markCase(SUITE, "tkt334 section: Download CSV of a 600-row grid contains all 600 rows although only a few are on screen");
  });

  it("tkt334 section: a failed download shows a retry and leaves the grid unchanged", async () => {
    const { blobs } = captureDownloads();
    const create = vi.fn(() => { throw new Error("no blob url"); });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: create });
    const { container } = mount();
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /Download CSV/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(RECON_DOWNLOAD_FAILURE);
    expect(rowEls(container)).toHaveLength(2);
    expect(container.textContent).toContain("VTI");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:ok"; }) });
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(blobs).toHaveLength(1);
    expect(rowEls(container)).toHaveLength(2);
    markCase(SUITE, "tkt334 section: a failed download shows a retry and leaves the grid unchanged");
  });

  it("tkt334 section: read-only shows the data and Download CSV but none of the write controls", async () => {
    const { container } = mount({ readOnly: true });
    await waitFor(() => expect(rowEls(container)).toHaveLength(2));
    expect(container.textContent).toContain("GCP Project API");
    expect(screen.getByRole("button", { name: /Download CSV/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download template/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sync from GCP" })).toBeNull();
    expect(screen.queryByRole("button", { name: /mapping account/ })).toBeNull();
    expect(screen.queryByLabelText("Upload asset mapping CSV")).toBeNull();
    expect(screen.queryByText("Upload CSV")).toBeNull();
    expect(screen.queryByRole("button", { name: /Manually override/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save Recon Results/ })).toBeNull();
    expect((screen.getByLabelText("Upload Apex output CSV") as HTMLInputElement).disabled).toBe(true);
    const zone = screen.getByText("Drop Apex CSV here").closest("div")!;
    fireEvent.drop(zone, { dataTransfer: { files: [csv("activities.csv")] } });
    expect(posts).toHaveLength(0);
    markCase(SUITE, "tkt334 section: read-only shows the data and Download CSV but none of the write controls");
  });

  it("tkt334 section: Download template saves the one-line header", async () => {
    const { blobs, names } = captureDownloads();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Download template/ }));
    expect(await blobs[0].text()).toBe(RECON_TEMPLATE_CSV);
    expect(RECON_TEMPLATE_CSV.trimEnd().split("\n")).toHaveLength(1);
    expect(names[0]).toBe("asset-mapping-upload-template.csv");
    markCase(SUITE, "tkt334 section: Download template saves the one-line header");
  });
});
