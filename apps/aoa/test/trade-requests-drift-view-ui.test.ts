// @vitest-environment jsdom
import { createElement } from "react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ usePathname: () => "/trade-requests/drift" }));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: unknown; prefetch?: boolean }) =>
    createElement("a", { href, ...rest }, children as never),
}));
const action = vi.hoisted(() => ({ exportDriftExclusions: vi.fn() }));
vi.mock("@/app/(authenticated)/trade-requests/drift/actions", () => action);

import { DriftView } from "@/components/trade-requests/drift/DriftView";
import { DRIFT_COPY } from "@/lib/trade-requests/drift-view/api";

const fixture = JSON.parse(readFileSync("test/fixtures/trade-request-drift-view-parity.json", "utf8"));
const LATEST: string = fixture.api.history.runs.reduce((m: string, r: { runDateLocal: string }) => (r.runDateLocal > m ? r.runDateLocal : m), "");
const LIVE_ROUTES = /^\/api\/trade-requests\/drift\/(history|allow-list|exclusion-overlap|runs\/[^/]+|overrides\/[^/]+)$/;

type Call = { path: string; method: string; body: unknown };
let calls: Call[];
let historyReply: { status: number; body: unknown };
let overlapHead: number;
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, redirected: false, json: async () => body });
const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
  const url = new URL(input, "http://127.0.0.1");
  const method = init?.method ?? "GET";
  calls.push({ path: url.pathname, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (url.pathname === "/api/trade-requests/drift/history") return json(historyReply.status, historyReply.body);
  if (url.pathname.startsWith("/api/trade-requests/drift/runs/")) return json(200, fixture.api.detail[LATEST]);
  if (url.pathname === "/api/trade-requests/drift/allow-list") return json(200, fixture.api.allowList);
  if (url.pathname === "/api/trade-requests/drift/exclusion-overlap") return json(method === "HEAD" ? overlapHead : 200, null);
  if (url.pathname.startsWith("/api/trade-requests/drift/overrides/")) {
    return method === "DELETE"
      ? json(200, { accountId: "x", cleared: true })
      : json(200, { accountId: "x", override: { reason: "intentional_cash", note: "", expiresOn: null, setByName: "Riley Ops", setAt: "2026-10-18T12:00:00.000Z" } });
  }
  return json(404, { error: "not_found" });
});
const downloads: string[] = [];

async function mount(canOverride: boolean) {
  render(createElement(DriftView, { canOverride }));
  await waitFor(() => expect(document.querySelectorAll("tr[data-drift-row]").length).toBeGreaterThan(0));
}
const row = (id: string) => document.querySelector(`tr[data-drift-row="${id}"]`) as HTMLElement;

beforeEach(() => {
  calls = [];
  historyReply = { status: 200, body: fixture.api.history };
  overlapHead = 404;
  downloads.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn(() => "blob:synthetic") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.getAttribute("download") ?? "");
  });
  action.exportDriftExclusions.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Drift screen behaviour (ticket)", () => {
  it("an ADVISOR sees override badges but no save, accept, edit or clear control", async () => {
    await mount(false);
    expect(within(row("SYNTH00000000000000ALPHA002")).getByText(/Asset location/)).toBeTruthy();
    for (const name of ["Set override", "Accept", "Set…", "Edit", "Clear override"]) {
      expect(screen.queryAllByRole("button", { name })).toHaveLength(0);
    }
  });

  it("a reviewer saves, accepts and clears overrides through the override route and reloads the results", async () => {
    await mount(true);
    fireEvent.click(within(row("SYNTH0000000000000CHARLIE01")).getByRole("button", { name: "Set override" }));
    const dialog = await screen.findByRole("dialog", { name: "Set drift status override" });
    fireEvent.change(within(dialog).getByLabelText("Override reason"), { target: { value: "intentional_cash" } });
    fireEvent.change(within(dialog).getByLabelText("Override note"), { target: { value: "Synthetic cash hold" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toContainEqual({ path: "/api/trade-requests/drift/overrides/SYNTH0000000000000CHARLIE01", method: "PUT", body: { reason: "intentional_cash", note: "Synthetic cash hold", expiresOn: null } });
    fireEvent.click(within(row("SYNTH00000000000000ALPHA001")).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(calls).toContainEqual({
      path: "/api/trade-requests/drift/overrides/SYNTH00000000000000ALPHA001", method: "PUT",
      body: { reason: "tax_constraint", note: "Auto-suggested: embedded gain $60K (7% of account)." },
    }));
    fireEvent.click(within(row("SYNTH00000000000000ALPHA002")).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Clear override" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/trade-requests/drift/overrides/SYNTH00000000000000ALPHA002", method: "DELETE", body: undefined }));
    expect(calls.filter((c) => c.path === "/api/trade-requests/drift/history").length).toBeGreaterThanOrEqual(4);
  });

  it("reads only the live drift routes and no Drift source names a shadow result", async () => {
    await mount(true);
    fireEvent.click(row("SYNTH00000000000000ALPHA001"));
    await screen.findByText("Tax & cost basis");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.path).toMatch(LIVE_ROUTES);
    const sources = [
      ...readdirSync("components/trade-requests/drift").filter((f) => f.endsWith(".tsx")).map((f) => join("components/trade-requests/drift", f)),
      ...readdirSync("lib/trade-requests/drift-view").map((f) => join("lib/trade-requests/drift-view", f)),
      "app/(authenticated)/trade-requests/drift/page.tsx",
      "app/(authenticated)/trade-requests/drift/actions.ts",
    ];
    expect(sources.length).toBe(10);
    for (const file of sources) expect(readFileSync(file, "utf8")).not.toMatch(/shadow/i);
  });

  it("an ended session replaces the screen; a refused route shows the unavailable message", async () => {
    historyReply = { status: 401, body: { error: "unauthorized" } };
    render(createElement(DriftView, { canOverride: true }));
    expect(await screen.findByTestId("trade-requests-session-ended")).toBeTruthy();
    expect(document.querySelectorAll("tr[data-drift-row]")).toHaveLength(0);
    cleanup();
    historyReply = { status: 404, body: { error: "not_found" } };
    render(createElement(DriftView, { canOverride: true }));
    expect(await screen.findByText(DRIFT_COPY.unavailable)).toBeTruthy();
    expect(document.querySelectorAll("tr[data-drift-row]")).toHaveLength(0);
  });

  it("exports the run and the standing exclusions, shows the allow list, and hides the overlap check while it is off", async () => {
    await mount(false);
    expect(screen.queryByRole("button", { name: "Check exclusion overlap" })).toBeNull();
    expect(screen.getByText("Allow list (0)")).toBeTruthy();
    expect(screen.getByText(DRIFT_COPY.allowListEmpty)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(downloads).toEqual([`drift_${LATEST}.csv`]);
    action.exportDriftExclusions.mockResolvedValueOnce({ ok: false, message: "Synthetic export failure" });
    fireEvent.click(screen.getByRole("button", { name: "Export exclusions" }));
    expect(await screen.findByText("Synthetic export failure")).toBeTruthy();
    action.exportDriftExclusions.mockResolvedValueOnce({ ok: true, rows: fixture.inputs.exclusions });
    fireEvent.click(screen.getByRole("button", { name: "Export exclusions" }));
    await waitFor(() => expect(downloads).toHaveLength(2));
    expect(downloads[1]).toMatch(/^exclusions_\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
