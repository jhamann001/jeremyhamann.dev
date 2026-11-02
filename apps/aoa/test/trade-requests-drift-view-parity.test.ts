// @vitest-environment jsdom
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { driftCsv, exclusionsCsv } from "@/lib/trade-requests/drift-view/model";
import type { AccountDriftHistoryRow } from "@/lib/trade-requests/shared-types";

type Captured = Record<string, unknown> & {
  advisorRows: string[][]; advisorRowsWithDataQuality: string[][]; tiles: Array<{ label: string; value: string }>;
  outOnlyRows: string[]; outOnlyTiles: Array<{ label: string; value: string }>; traderOverrideCells: string[];
  driftCsv: { name: string; lines: string[] }; exclusionsCsv: { name: string; lines: string[] };
  households: string[]; overrideReasonOptions: string[];
};
const fixture = JSON.parse(readFileSync("test/fixtures/trade-request-drift-view-parity.json", "utf8")) as {
  api: { history: { days: number; runs: AccountDriftHistoryRow[] }; detail: Record<string, unknown>; allowList: unknown; overlap: unknown };
  inputs: { exclusions: never[] };
  standalone: Captured;
};
const S = fixture.standalone;
const LATEST = fixture.api.history.runs.reduce((m, r) => (r.runDateLocal > m ? r.runDateLocal : m), "");

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, redirected: false, json: async () => body });

let historyBody: unknown;
const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
  const url = new URL(input, "http://127.0.0.1");
  if (url.pathname === "/api/trade-requests/drift/history") return json(200, historyBody);
  if (url.pathname.startsWith("/api/trade-requests/drift/runs/")) {
    return json(200, fixture.api.detail[decodeURIComponent(url.pathname.split("/").pop()!)]);
  }
  if (url.pathname === "/api/trade-requests/drift/allow-list") return json(200, fixture.api.allowList);
  if (url.pathname === "/api/trade-requests/drift/exclusion-overlap") {
    return init?.method === "HEAD" ? json(204, null) : json(200, fixture.api.overlap);
  }
  return json(404, { error: "not_found" });
});

function rowCells(): string[][] {
  return Array.from(document.querySelectorAll("tr[data-drift-row]")).map((tr) =>
    Array.from(tr.querySelectorAll(":scope > td[data-col]")).map((td) => norm(td.textContent)),
  );
}
function tiles() {
  return Array.from(document.querySelectorAll("[data-drift-stat]")).map((t) => ({
    value: norm(t.querySelector("[data-stat-value]")?.textContent),
    label: norm(t.querySelector("[data-stat-label]")?.textContent),
  }));
}
async function mount(canOverride: boolean) {
  render(createElement(DriftView, { canOverride }));
  await waitFor(() => expect(document.querySelectorAll("tr[data-drift-row]").length).toBeGreaterThan(0));
}

beforeEach(() => {
  historyBody = fixture.api.history;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  action.exportDriftExclusions.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Drift view value parity with the standalone view (ticket)", () => {
  it("read-only rows, summary tiles, cost-basis banner, data-quality toggle and footer match", async () => {
    await mount(false);
    expect(rowCells()).toEqual(S.advisorRows);
    expect(tiles()).toEqual(S.tiles);
    expect(norm(document.querySelector("[data-drift-banner]")?.textContent)).toBe(S.banner);
    expect(norm(screen.getByLabelText("Show data-quality accounts").parentElement?.textContent)).toBe(S.dataQualityToggle);
    expect(norm(document.querySelector("[data-drift-footer]")?.textContent)).toBe(S.footer);
    fireEvent.click(screen.getByLabelText("Show data-quality accounts"));
    expect(rowCells()).toEqual(S.advisorRowsWithDataQuality);
    fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "out" } });
    expect(rowCells().map((r) => r[0])).toEqual(S.outOnlyRows);
    expect(tiles()).toEqual(S.outOnlyTiles);
  });

  it("the drift and exclusions CSV files carry the standalone lines", async () => {
    const latest = fixture.api.history.runs.filter((r) => r.runDateLocal === LATEST);
    expect(driftCsv(latest, LATEST)).toEqual({ filename: S.driftCsv.name, lines: S.driftCsv.lines });
    expect(exclusionsCsv(fixture.inputs.exclusions, "2026-10-18").lines).toEqual(S.exclusionsCsv.lines);
  });

  it("override cells, account detail, overlap diagnostic, reasons and household cards match for a reviewer", async () => {
    await mount(true);
    expect(rowCells().map((r) => r[r.length - 1])).toEqual(S.traderOverrideCells);
    const alpha = document.querySelector('tr[data-drift-row="SYNTH00000000000000ALPHA001"]') as HTMLElement;
    expect(norm(alpha.querySelector('td[data-col="account"]')?.textContent)).toBe(S.firstRowTitle);
    fireEvent.click(alpha);
    await screen.findByText("Tax & cost basis");
    expect(norm(document.querySelector("[data-drift-detail]")?.textContent)).toBe(S.alphaDetail);
    fireEvent.click(await screen.findByRole("button", { name: "Check exclusion overlap" }));
    const overlap = await screen.findByRole("dialog", { name: "Exclusion overlap diagnostic" });
    await within(overlap).findByText("Lock classification");
    expect(norm(overlap.textContent)).toBe(S.overlapDialog);
    fireEvent.click(within(overlap).getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Set override" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Set drift status override" });
    expect(Array.from(within(dialog).getByLabelText("Override reason").querySelectorAll("option")).map((o) => o.textContent)).toEqual(S.overrideReasonOptions);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "households" }));
    expect(Array.from(document.querySelectorAll("[data-drift-household]")).map((b) => norm(b.textContent))).toEqual(S.households);
  });

  it("empty and failed history show the standalone messages", async () => {
    historyBody = { days: 30, runs: [] };
    render(createElement(DriftView, { canOverride: false }));
    expect(norm((await screen.findByText(/No drift runs yet/)).textContent)).toBe(S.emptyText);
    cleanup();
    historyBody = { days: "not-a-number" };
    render(createElement(DriftView, { canOverride: false }));
    expect(await screen.findByText(S.errorText as string)).toBeTruthy();
    await act(async () => {});
  });
});
