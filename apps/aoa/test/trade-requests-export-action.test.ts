// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ files: [] as Array<{ content: unknown; type: string; filename: string }> }));
vi.mock("@/components/trade-requests/export/save-file", () => ({
  saveFile: (content: unknown, type: string, filename: string) => saved.files.push({ content, type, filename }),
}));
const pdfBuild = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock("@/components/trade-requests/export/compliance-pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/trade-requests/export/compliance-pdf")>();
  return {
    ...actual,
    buildCompliancePdf: async (...args: Parameters<typeof actual.buildCompliancePdf>) => {
      if (pdfBuild.fail) throw pdfBuild.fail;
      return actual.buildCompliancePdf(...args);
    },
  };
});

import { SessionMessagesProvider, useSessionMessages } from "@/components/trade-requests/bell/session-messages";
import { QueueExportAction } from "@/components/trade-requests/queue/export-action";
import { SYNTHETIC_EXPORTER, syntheticRequest } from "./helpers/export-requests";

// ticket: the Export Compliance Log menu (P2-102 to P2-105) and the session
// messages it writes into TRW-05's store (AC-20, AC-56, AC-57, AC-103, AC-104).

type Reply = { ok: boolean; status?: number; redirected?: boolean; body: unknown } | "network";
let replies: Array<Reply | Promise<Reply>>;
const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => {
  const next = await replies.shift();
  if (!next) return new Promise(() => undefined);
  if (next === "network") throw new TypeError("Failed to fetch");
  return { ok: next.ok, redirected: next.redirected ?? false, status: next.status ?? (next.ok ? 200 : 500), json: async () => next.body };
});

function Messages() {
  const { messages } = useSessionMessages();
  return createElement("ul", { "aria-label": "Session messages" }, messages.map((item) => createElement("li", { key: item.id }, item.message)));
}
const shell = () => render(createElement(SessionMessagesProvider, null,
  createElement(Messages), createElement(QueueExportAction, { exporter: SYNTHETIC_EXPORTER })));
const messages = () => screen.queryAllByRole("listitem").map((item) => item.textContent);
const exportButton = () => screen.getByRole("button", { name: /Export Compliance Log|Preparing Export\.\.\./ });
const payload = (overrides: Record<string, unknown> = {}) => ({
  ok: true, status: 200,
  body: { ok: true, data: { requests: [syntheticRequest()], standingByClient: {}, accountExclusionsByRequestId: {}, messages: [], ...overrides } },
});
async function choose(item: "PDF Report" | "CSV Spreadsheet", { settle = true } = {}) {
  fireEvent.click(exportButton());
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(item) })); });
  if (settle) await waitFor(() => expect((exportButton() as HTMLButtonElement).disabled).toBe(false));
}

beforeEach(() => {
  replies = [];
  saved.files = [];
  pdfBuild.fail = null;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Export Compliance Log menu (P2-102 to P2-105)", () => {
  it("opens a menu of the PDF report and the CSV spreadsheet, closing on Escape and outside clicks", () => {
    shell();
    const button = exportButton();
    expect(button.textContent).toContain("Export Compliance Log");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "PDF ReportFormatted for compliance review", "CSV SpreadsheetFor data analysis & archival",
    ]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(button);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is keyboard operable: first item focused on open, arrows and Home/End move, Escape returns to the button", () => {
    shell();
    const button = exportButton();
    button.focus();
    fireEvent.click(button);
    const [pdf, csv] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(pdf);
    const menu = screen.getByRole("menu");
    expect(button.getAttribute("aria-controls")).toBe(menu.id);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(csv);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(pdf);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(csv);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(pdf);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(csv);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("while running the button is disabled and reads Preparing Export..., then returns", async () => {
    let release!: (reply: Reply) => void;
    replies = [new Promise<Reply>((resolve) => { release = resolve; })];
    shell();
    await choose("CSV Spreadsheet", { settle: false });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(exportButton().textContent).toBe("Preparing Export...");
    expect((exportButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(exportButton());
    expect(screen.queryByRole("menu")).toBeNull();
    await act(async () => { release(payload()); });
    await waitFor(() => expect(exportButton().textContent).toContain("Export Compliance Log"));
    expect((exportButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("export run (AC-19, AC-112, AC-141)", () => {
  it("reads the export route only, then downloads the CSV", async () => {
    replies = [payload()];
    shell();
    await choose("CSV Spreadsheet");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/trade-requests/export");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "same-origin" });
    expect(saved.files).toHaveLength(1);
    expect(saved.files[0].type).toBe("text/csv;charset=utf-8;");
    expect(saved.files[0].filename).toMatch(/^Compliance_Export_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(String(saved.files[0].content).split("\n")[0]).toMatch(/^# Report Exported By: Riley Ops \(ops@example\.invalid\) \| Exported At: .+ \| Record Count: 1$/);
    expect(messages()).toEqual([]);
  });

  it("downloads the Compliance Export Report PDF", async () => {
    replies = [payload()];
    shell();
    await choose("PDF Report");
    expect(saved.files).toHaveLength(1);
    expect(saved.files[0].type).toBe("application/pdf");
    expect(saved.files[0].filename).toMatch(/^Compliance_Report_\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(saved.files[0].content).toBeInstanceOf(Uint8Array);
  });
});

describe("export session messages (AC-20, AC-55, AC-56, AC-57, AC-103, AC-104)", () => {
  it("writes the read's warnings in order (shown newest first) and still downloads the file", async () => {
    replies = [payload({ messages: [
      "Export capped at 5,000 requests. The file may be incomplete — contact ops for a full report if needed.",
      "Standing exclusions unavailable for export: Network Error",
      "Some exported accounts could not be resolved to current account IDs (2). Account-level exclusions may be partial.",
    ] })];
    shell();
    await choose("CSV Spreadsheet");
    expect(saved.files).toHaveLength(1);
    expect(messages()).toEqual([
      "Some exported accounts could not be resolved to current account IDs (2). Account-level exclusions may be partial.",
      "Standing exclusions unavailable for export: Network Error",
      "Export capped at 5,000 requests. The file may be incomplete — contact ops for a full report if needed.",
    ]);
  });

  it.each<[string, Reply, string]>([
    ["the read's failure text", { ok: true, body: { ok: false, outcome: "failed", message: "timeout of 30000ms exceeded" } }, "Export failed: timeout of 30000ms exceeded"],
    ["not set up", { ok: true, body: { ok: false, outcome: "not_set_up", message: "Your account is not set up for Trade Requests — contact Operations." } },
      "Export failed: Your account is not set up for Trade Requests — contact Operations."],
    ["a signed-out session", { ok: false, status: 401, body: { error: "unauthorized" } }, "Export failed: Your session has ended. Sign in again to continue."],
    ["a failed hop", { ok: false, status: 502, body: null }, "Export failed: An unexpected error occurred"],
    ["no response", "network", "Export failed: An unexpected error occurred"],
    ["an unreadable reply", { ok: true, body: { ok: true, data: { requests: [{ id: "REQ-1" }] } } }, "Export failed: An unexpected error occurred"],
  ])("a failed export on %s writes the failure message and no file", async (_name, reply, expected) => {
    replies = [reply];
    shell();
    await choose("PDF Report");
    expect(messages()).toEqual([expected]);
    expect(saved.files).toEqual([]);
  });

  it("a failure while building the file writes the default reason after the warnings, never the script error", async () => {
    pdfBuild.fail = new TypeError("Cannot read properties of undefined (reading 'replace')");
    replies = [payload({ messages: ["Account exclusions unavailable for export: Too many account IDs"] })];
    shell();
    await choose("PDF Report");
    expect(messages()).toEqual(["Export failed: An unexpected error occurred", "Account exclusions unavailable for export: Too many account IDs"]);
    expect(messages().join(" ")).not.toContain("Cannot read properties");
    expect(saved.files).toEqual([]);
  });
});
