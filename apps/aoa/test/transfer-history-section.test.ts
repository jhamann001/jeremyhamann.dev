// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/app/(authenticated)/acat-tracking/history-actions", () => ({ loadTransferHistory: mocks.load }));

import {
  HistoryPanel,
  TransferHistorySection,
  runHistoryLoad,
  type HistoryState,
} from "@/components/transfers/TransferHistorySection";
import { formatHistoryTime, type HistoryEntry } from "@/lib/data/acat-history-view";

const SUITE = "transfer-history-section";
const noop = () => undefined;
const panel = (state: HistoryState) => renderToStaticMarkup(createElement(HistoryPanel, { state, onRetry: noop }));

const entries: HistoryEntry[] = [
  { id: "h4", action: "update", field: "statementAccountNumber", oldValue: "", newValue: "123456789", performedBy: "ops@example.test", timestamp: "2026-10-13T14:35:00.000Z" },
  { id: "h3", action: "update", field: "status", oldValue: "WaitingForStatement", newValue: "Completed", performedBy: "ops@example.test", timestamp: "2026-10-13T14:32:00.000Z" },
  { id: "h2", action: "update", field: "notes", oldValue: null, newValue: "", performedBy: null, timestamp: "2026-10-12T09:00:00.000Z" },
  { id: "h1", action: "fee-auto-apply", field: null, oldValue: null, newValue: null, performedBy: "System", timestamp: "2026-10-01T09:00:00.000Z" },
];

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("transfer history section (ticket)", () => {
  it("is collapsed until opened and makes no history call while collapsed", () => {
    const html = renderToStaticMarkup(createElement(TransferHistorySection, { recordId: "rec-1" }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("History");
    expect(html).not.toContain("Loading history…");
    expect(html).not.toContain("No recorded changes yet");
    render(createElement(TransferHistorySection, { recordId: "rec-1" }));
    expect(screen.getByRole("button", { name: "History" }).getAttribute("aria-expanded")).toBe("false");
    expect(mocks.load).not.toHaveBeenCalled();
    markCase(SUITE, "is collapsed until opened and makes no history call while collapsed");
  });

  it("shows the loading copy while history loads", () => {
    expect(panel({ kind: "loading" })).toContain("Loading history…");
    markCase(SUITE, "shows the loading copy while history loads");
  });

  it("shows the failure copy with Try again, and never the empty state", () => {
    const html = panel({ kind: "error" });
    expect(html).toContain("History could not be loaded.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("No recorded changes yet");
    markCase(SUITE, "shows the failure copy with Try again, and never the empty state");
  });

  it("shows the empty copy when there are no changes, and never the failure", () => {
    const html = panel({ kind: "ready", entries: [] });
    expect(html).toContain("No recorded changes yet");
    expect(html).not.toContain("History could not be loaded.");
    markCase(SUITE, "shows the empty copy when there are no changes, and never the failure");
  });

  it("renders each change as person, field label, old struck through, arrow, new, and time, newest first", () => {
    const html = panel({ kind: "ready", entries });
    expect(html.indexOf("Statement Account # changed")).toBeLessThan(html.indexOf("Status changed"));
    expect(html.indexOf("Status changed")).toBeLessThan(html.indexOf("Notes changed"));
    expect(html.indexOf("Notes changed")).toBeLessThan(html.indexOf("Fee schedule applied"));
    expect(html).toMatch(/<span class="[^"]*old[^"]*">Waiting for Statement<\/span><span class="[^"]*arrow[^"]*">→<\/span><span class="[^"]*new[^"]*">Completed<\/span>/);
    expect(html).toMatch(/<span class="[^"]*old[^"]*">blank<\/span><span class="[^"]*arrow[^"]*">→<\/span><span class="[^"]*new[^"]*">123456789<\/span>/);
    expect(html).toContain("ops@example.test");
    expect(html).toContain(formatHistoryTime("2026-10-13T14:32:00.000Z"));
    expect(html).toContain('dateTime="2026-10-13T14:32:00.000Z"');
    expect(html).not.toContain("*****");
    markCase(SUITE, "renders each change as person, field label, old struck through, arrow, new, and time, newest first");
  });

  it("shows blank for empty values and System when no email is stored", () => {
    const html = panel({ kind: "ready", entries });
    expect(html).toMatch(/old[^"]*">blank<\/span><span[^>]*>→<\/span><span[^>]*>blank<\/span>/);
    expect(html).toMatch(/person[^"]*">System<\/p>/);
    markCase(SUITE, "shows blank for empty values and System when no email is stored");
  });

  it("offers no edit, delete, restore, or load-more control", () => {
    const html = panel({ kind: "ready", entries });
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/edit|delete|restore|load more|show more/i);
    markCase(SUITE, "offers no edit, delete, restore, or load-more control");
  });

  it("loads then shows the entries, and Try again repeats the failed load", async () => {
    const seen: string[] = [];
    const apply = (s: HistoryState) => seen.push(s.kind);
    mocks.load.mockResolvedValueOnce({ ok: false, reason: "unavailable" }).mockResolvedValueOnce({ ok: true, entries });
    await runHistoryLoad("rec-1", mocks.load, apply, () => true);
    expect(seen).toEqual(["loading", "error"]);
    await runHistoryLoad("rec-1", mocks.load, apply, () => true);
    expect(seen).toEqual(["loading", "error", "loading", "ready"]);
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.load).toHaveBeenNthCalledWith(2, "rec-1");
    markCase(SUITE, "loads then shows the entries, and Try again repeats the failed load");
  });

  it("treats a thrown load as the failure and drops a stale answer", async () => {
    const seen: string[] = [];
    mocks.load.mockRejectedValueOnce(new Error("boom"));
    await runHistoryLoad("rec-1", mocks.load, (s) => seen.push(s.kind), () => true);
    expect(seen).toEqual(["loading", "error"]);
    const stale: string[] = [];
    mocks.load.mockResolvedValueOnce({ ok: true, entries });
    await runHistoryLoad("rec-1", mocks.load, (s) => stale.push(s.kind), () => false);
    expect(stale).toEqual(["loading"]);
    markCase(SUITE, "treats a thrown load as the failure and drops a stale answer");
  });

  it("opening History calls the load once and then shows the entries", async () => {
    mocks.load.mockResolvedValue({ ok: true, entries });
    render(createElement(TransferHistorySection, { recordId: "rec-1" }));
    expect(mocks.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await screen.findByText("Status changed");
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledWith("rec-1");
    expect(screen.getByRole("button", { name: "History" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.queryByText("Status changed")).toBeNull();
    markCase(SUITE, "opening History calls the load once and then shows the entries");
  });

  it("Try again calls the load again and then shows the entries", async () => {
    mocks.load.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ ok: true, entries: [] });
    render(createElement(TransferHistorySection, { recordId: "rec-1" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await screen.findByText("History could not be loaded.");
    expect(screen.queryByText("No recorded changes yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No recorded changes yet");
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.load).toHaveBeenNthCalledWith(2, "rec-1");
    markCase(SUITE, "Try again calls the load again and then shows the entries");
  });

  it("reloads an open section when its version changes and never shows another record's answer", async () => {
    mocks.load.mockResolvedValue({ ok: true, entries: [] });
    const { rerender } = render(createElement(TransferHistorySection, { recordId: "rec-1", version: "v1" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await screen.findByText("No recorded changes yet");
    rerender(createElement(TransferHistorySection, { recordId: "rec-1", version: "v2" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
    await screen.findByText("No recorded changes yet");

    let release: (value: unknown) => void = noop;
    mocks.load.mockReset();
    mocks.load.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    mocks.load.mockResolvedValueOnce({ ok: true, entries: [entries[1]] });
    rerender(createElement(TransferHistorySection, { recordId: "rec-1", version: "v3" }));
    await screen.findByText("Loading history…");
    rerender(createElement(TransferHistorySection, { recordId: "rec-1", version: "v4" }));
    await screen.findByText("Status changed");
    release({ ok: true, entries: [] });
    await Promise.resolve();
    expect(screen.getByText("Status changed")).toBeTruthy();
    expect(screen.queryByText("No recorded changes yet")).toBeNull();
    markCase(SUITE, "reloads an open section when its version changes and never shows another record's answer");
  });

  it("uses only CSS classes that exist in its module, and no neutral chrome outside the AoA tokens", () => {
    const tsx = readFileSync("components/transfers/TransferHistorySection.tsx", "utf8");
    const css = readFileSync("components/transfers/TransferHistorySection.module.css", "utf8");
    const used = new Set([...tsx.matchAll(/styles\.(\w+)/g)].map((m) => m[1]));
    const defined = new Set([...css.matchAll(/\.([A-Za-z][\w]*)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(20);
    for (const name of used) expect(defined.has(name), `missing .${name}`).toBe(true);
    const tokens = [...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    const globals = readFileSync("app/globals.css", "utf8");
    for (const token of new Set(tokens)) expect(globals.includes(`${token}:`), `undefined ${token}`).toBe(true);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    markCase(SUITE, "uses only CSS classes that exist in its module, and no neutral chrome outside the AoA tokens");
  });
});
