// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const { openRecord, reviewException, drawerProps, refresh } = vi.hoisted(() => ({
  openRecord: vi.fn(),
  reviewException: vi.fn(),
  drawerProps: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/app/(authenticated)/operations/transfer-dashboard/actions", () => ({
  openDashboardRecord: openRecord,
  reviewDashboardException: reviewException,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock("@/components/transfers/AcatUnlinkedDrawer", async () => {
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return {
    AcatUnlinkedDrawer: (props: { row: { id: string } }) => {
      drawerProps(props);
      return h("div", { role: "dialog", "aria-label": "Transfer drawer" }, `Drawer ${props.row.id}`);
    },
  };
});
vi.mock("@/components/transfers/AcatBookActions", () => ({ AcatRecordEditor: () => null }));

import { AcatTransferDashboard } from "@/components/operations/AcatTransferDashboard";
import type { AcatDashboard, QualityException } from "@/lib/data/acat-dashboard";

const SUITE = "acat-transfer-dashboard-interactions";
const distribution = { average: 1, median: 2, p75: 3, p90: 4, sampleSize: 5 };

function exception(over: Partial<QualityException> & Pick<QualityException, "record" | "ruleKey">): QualityException {
  return {
    fingerprint: over.fingerprint ?? `${over.record.id}-${over.ruleKey}`,
    title: over.title ?? over.ruleKey,
    detail: over.detail ?? "Supplied detail",
    severity: over.severity ?? "high",
    review: over.review === undefined ? null : over.review,
    ...over,
  };
}

function sample(over: Partial<AcatDashboard> = {}): AcatDashboard {
  return {
    summary: {
      total: 40, Completed: 9, Rejected: 3, Canceled: 2, Purged: 8, active: 25, validFinalized: 14,
      completedRate: 0.5, rejectionRate: 0.25, canceledRate: 0.125,
    },
    workflowTimings: [{ workflow: "ACAT", requestToSubmit: distribution, submitToComplete: distribution, requestToComplete: distribution }],
    monthlyVolume: [{ month: "2025-06", label: "Jun 2025", total: 4, workflows: { ACAT: 2, MANUAL: 1, DRS: 1, RESIDUAL: 0, UNCLASSIFIED: 0 } }],
    flow: {
      incoming: { totalCount: 2, totalAmount: 100000, requestedCount: 1, requestedAmount: 80000, residualCount: 1, residualAmount: 20000 },
      outgoing: { totalCount: 1, totalAmount: 40000, requestedCount: 1, requestedAmount: 40000, residualCount: 0, residualAmount: 0 },
      netAmount: 60000, requestedNetAmount: 40000, residualNetAmount: 20000,
    },
    topContras: { acat: [], manual: [] },
    residuals: {
      queue: [{ record: { id: "rec-queue", clientName: "Queue Client", transferringContra: "Fidelity" }, followUpDate: "2026-01-01", daysPastFollowUp: 6 }],
      benchmarks: [{ contra: "Fidelity", sampleSize: 4, medianDays: 10, p75Days: 12, p90Days: 15 }],
    },
    quality: {
      rules: [{ ruleKey: "rule-1", title: "Completed without Apex date", description: "Control 1" }],
      exceptions: [
        exception({ record: { id: "rec-ada", clientName: "Daniel Chen", transferringContra: "Fidelity" }, ruleKey: "rule-1", title: "Completed without Apex date" }),
        ...Array.from({ length: 5 }, (_, index) => exception({
          record: { id: `rec-open-${index}`, clientName: `Open Client ${index}`, transferringContra: "Schwab" },
          ruleKey: "rule-3",
        })),
        exception({
          record: { id: "rec-grace", clientName: "Grace Hopper", transferringContra: "Schwab" },
          ruleKey: "rule-2",
          title: "Duplicate control number",
          severity: "low",
          review: { status: "CLOSED", resolution: "CORRECTED", note: "fixed", reviewedBy: null, reviewedAt: null },
        }),
      ],
    },
    reconciliation: { coverageRate: 0.5, tracked: 2, eligible: 4, matched: 1, matchRate: null, mismatch: 1, pending: 0, notTracked: 2 },
    ...over,
  };
}

function mount(dashboard: AcatDashboard = sample()) {
  return render(createElement(AcatTransferDashboard, { dashboard }));
}

function tab(name: RegExp) {
  return within(screen.getByRole("navigation", { name: "Dashboard sections" })).getByRole("button", { name });
}

function sections(): Array<[string, boolean]> {
  return [...document.querySelectorAll("details")]
    .filter((details) => details.querySelector(":scope > summary h2"))
    .map((details) => [details.querySelector(":scope > summary h2")!.textContent ?? "", details.open]);
}

function toggle(title: string) {
  fireEvent.click(screen.getByRole("heading", { name: title }).closest("summary")!);
}

function cards(): string[] {
  const list = screen.queryByLabelText("Exception results");
  return list ? [...list.querySelectorAll("h3")].map((heading) => heading.nextElementSibling ? `${heading.textContent} closed` : heading.textContent ?? "") : [];
}

function typeSelect() {
  return screen.getByRole("combobox", { name: "Exception type" }) as HTMLSelectElement;
}

describe("ACAT transfer dashboard interactions", () => {
  beforeEach(() => {
    openRecord.mockReset();
    reviewException.mockReset();
    drawerProps.mockReset();
    refresh.mockReset();
  });
  afterEach(() => cleanup());

  it("switches tabs without changing the URL and restores section defaults", () => {
    const href = window.location.href;
    mount();
    expect(tab(/^Overview$/).className).toMatch(/tabActive/);
    toggle("Transfer requests over time");
    expect(sections()).toContainEqual(["Transfer requests over time", true]);
    fireEvent.click(tab(/^Residual monitoring/));
    expect(tab(/^Residual monitoring/).className).toMatch(/tabActive/);
    expect(tab(/^Overview$/).className).toMatch(/tabIdle/);
    expect(screen.queryByText("Cycle time by transfer workflow")).toBeNull();
    expect(screen.getByText("Residual follow-up queue")).toBeTruthy();
    fireEvent.click(tab(/^Overview$/));
    expect(sections()).toEqual([
      ["Cycle time by transfer workflow", true],
      ["Transfer requests over time", false],
      ["Direction and asset flow", false],
      ["Top contras", false],
    ]);
    expect(window.location.href).toBe(href);
    markCase(SUITE, "switches tabs without changing the URL and restores section defaults");
  });

  it("labels tabs with residual and open exception counts", () => {
    mount();
    const labels = within(screen.getByRole("navigation", { name: "Dashboard sections" }))
      .getAllByRole("button").map((button) => button.textContent);
    expect(labels).toEqual(["Overview", "Residual monitoring (1)", "Data quality (6)", "Reconciliation"]);
    cleanup();
    mount(sample({ residuals: { queue: [], benchmarks: [] }, quality: { rules: [], exceptions: [] } }));
    const empty = within(screen.getByRole("navigation", { name: "Dashboard sections" }))
      .getAllByRole("button").map((button) => button.textContent);
    expect(empty).toEqual(["Overview", "Residual monitoring", "Data quality", "Reconciliation"]);
    markCase(SUITE, "labels tabs with residual and open exception counts");
  });

  it("toggles each section from its summary and starts with tracker defaults", () => {
    mount();
    const defaults: Record<string, Array<[string, boolean]>> = {
      "Overview": [
        ["Cycle time by transfer workflow", true],
        ["Transfer requests over time", false],
        ["Direction and asset flow", false],
        ["Top contras", false],
      ],
      "Residual monitoring": [["Residual follow-up queue", true], ["Observed sweep timing by contra", false]],
      "Data quality": [["What the queue checks", false]],
      "Reconciliation": [["How to read reconciliation", true]],
    };
    for (const [name, expected] of Object.entries(defaults)) {
      fireEvent.click(tab(new RegExp(`^${name}`)));
      expect(sections()).toEqual(expected);
      for (const [title, open] of expected) {
        toggle(title);
        expect(sections()).toContainEqual([title, !open]);
        const chevron = screen.getByRole("heading", { name: title }).closest("summary")!.querySelector("svg")!;
        expect(chevron.getAttribute("class")).toContain("lucide-chevron-down");
        toggle(title);
        expect(sections()).toContainEqual([title, open]);
      }
    }
    markCase(SUITE, "toggles each section from its summary and starts with tracker defaults");
  });

  it("keeps several sections open and toggles View monthly data", () => {
    mount();
    toggle("Transfer requests over time");
    toggle("Direction and asset flow");
    toggle("Top contras");
    expect(sections().every(([, open]) => open)).toBe(true);
    const monthly = screen.getByText("View monthly data").closest("details")!;
    expect(monthly.open).toBe(false);
    fireEvent.click(screen.getByText("View monthly data"));
    expect(monthly.open).toBe(true);
    expect(sections().every(([, open]) => open)).toBe(true);
    fireEvent.click(screen.getByText("View monthly data"));
    expect(monthly.open).toBe(false);
    markCase(SUITE, "keeps several sections open and toggles View monthly data");
  });

  it("opens Data quality from the Data quality card", () => {
    mount();
    const card = screen.getByText("unresolved exception instances").closest("button")!;
    expect(card.textContent).toContain("Data quality");
    expect(card.textContent).toContain("6");
    fireEvent.click(card);
    expect(tab(/^Data quality/).className).toMatch(/tabActive/);
    expect(screen.getByText("Exception queue")).toBeTruthy();
    expect(cards()).toHaveLength(6);
    markCase(SUITE, "opens Data quality from the Data quality card");
  });

  it("filters exceptions with the Open Closed All control", () => {
    mount();
    fireEvent.click(tab(/^Data quality/));
    const segment = (name: string) => screen.getByRole("button", { name });
    expect(segment("Open").className).toMatch(/segmentActive/);
    expect(cards()).toHaveLength(6);
    fireEvent.click(segment("Closed"));
    expect(segment("Closed").className).toMatch(/segmentActive/);
    expect(segment("Open").className).toMatch(/segmentIdle/);
    expect(cards()).toEqual(["Duplicate control number closed"]);
    expect(screen.queryByText("Mark in review")).toBeNull();
    expect(screen.getByText("Corrected · fixed")).toBeTruthy();
    fireEvent.click(segment("All"));
    expect(cards()).toHaveLength(7);
    fireEvent.click(segment("Open"));
    expect(cards()).toHaveLength(6);
    markCase(SUITE, "filters exceptions with the Open Closed All control");
  });

  it("selects an exception type and falls back when it disappears", () => {
    mount();
    fireEvent.click(tab(/^Data quality/));
    expect([...typeSelect().options].map((option) => option.textContent)).toEqual([
      "All exception types (6)",
      "Completed without Apex date (1)",
      "rule-3 (5)",
    ]);
    fireEvent.change(typeSelect(), { target: { value: "rule-3" } });
    expect(typeSelect().value).toBe("rule-3");
    expect(cards()).toEqual(Array(5).fill("rule-3"));
    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(typeSelect().value).toBe("ALL");
    expect([...typeSelect().options].map((option) => option.textContent)).toEqual([
      "All exception types (1)",
      "Duplicate control number (1)",
    ]);
    expect(cards()).toEqual(["Duplicate control number closed"]);
    markCase(SUITE, "selects an exception type and falls back when it disappears");
  });

  it("ignores Escape and outside clicks on the exception type select", () => {
    mount();
    fireEvent.click(tab(/^Data quality/));
    fireEvent.change(typeSelect(), { target: { value: "rule-3" } });
    typeSelect().focus();
    fireEvent.keyDown(typeSelect(), { key: "Escape", code: "Escape" });
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(typeSelect().value).toBe("rule-3");
    expect(typeSelect().selectedOptions[0].textContent).toBe("rule-3 (5)");
    expect(cards()).toEqual(Array(5).fill("rule-3"));
    expect(typeSelect().tagName).toBe("SELECT");
    markCase(SUITE, "ignores Escape and outside clicks on the exception type select");
  });

  it("narrows exceptions by client search", () => {
    mount();
    fireEvent.click(tab(/^Data quality/));
    const search = screen.getByRole("searchbox", { name: "Search data quality by client" }) as HTMLInputElement;
    expect(search.placeholder).toBe("Search client name…");
    fireEvent.change(search, { target: { value: "  DANIEL " } });
    expect(cards()).toEqual(["Completed without Apex date"]);
    expect(typeSelect().options[0].textContent).toBe("All exception types (1)");
    fireEvent.change(search, { target: { value: "nobody" } });
    expect(screen.getByText("No exceptions in this view.")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    expect(cards()).toHaveLength(6);
    markCase(SUITE, "narrows exceptions by client search");
  });

  it("disables Close exception until a required note is entered", async () => {
    reviewException.mockResolvedValueOnce({ ok: false, open: true, reason: "A note is required for this resolution" });
    reviewException.mockResolvedValueOnce({ ok: true, review: { status: "CLOSED", resolution: "FALSE_POSITIVE", note: "checked" } });
    mount();
    fireEvent.click(tab(/^Data quality/));
    const card = screen.getByText("Daniel Chen · Supplied detail").closest("div[class]")!.parentElement!.parentElement!.parentElement!;
    const scoped = within(card);
    const close = scoped.getByRole("button", { name: "Close exception" }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    fireEvent.change(scoped.getByRole("combobox"), { target: { value: "FALSE_POSITIVE" } });
    expect(close.disabled).toBe(true);
    const note = scoped.getByPlaceholderText("Note required") as HTMLInputElement;
    fireEvent.change(note, { target: { value: "   " } });
    expect(close.disabled).toBe(true);
    fireEvent.change(note, { target: { value: "checked" } });
    expect(close.disabled).toBe(false);
    await act(async () => { fireEvent.click(close); });
    expect(screen.getByRole("alert").textContent).toBe("A note is required for this resolution");
    expect(cards()).toHaveLength(6);
    await act(async () => { fireEvent.click(close); });
    expect(reviewException).toHaveBeenLastCalledWith({
      acatRecordId: "rec-ada", ruleKey: "rule-1", fingerprint: "rec-ada-rule-1",
      status: "CLOSED", resolution: "FALSE_POSITIVE", note: "checked",
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(cards()).toHaveLength(5);
    expect(tab(/^Data quality/).textContent).toBe("Data quality (5)");
    markCase(SUITE, "disables Close exception until a required note is entered");
  });

  it("opens the transfer drawer in place from a residual row and Fix in transfer", async () => {
    const row = { id: "rec-queue", notes: "n", tradeInstructions: "t", textLoadError: null };
    openRecord.mockResolvedValueOnce({ ok: true, row, transferId: "transfer-1", editsEnabled: false, dayToDay: true });
    mount();
    fireEvent.click(tab(/^Residual monitoring/));
    toggle("Observed sweep timing by contra");
    await act(async () => { fireEvent.click(screen.getByText("Queue Client").closest("button")!); });
    expect(openRecord).toHaveBeenCalledWith("rec-queue");
    expect(screen.getByRole("dialog", { name: "Transfer drawer" }).textContent).toBe("Drawer rec-queue");
    const readOnly = drawerProps.mock.lastCall![0];
    expect(readOnly).toMatchObject({ row, transferId: "transfer-1", readOnly: true, dayToDayText: { notes: "n", tradeInstructions: "t", loadError: null } });
    expect(readOnly.editor).toBeUndefined();
    expect(screen.getByText("Transfer operations")).toBeTruthy();
    await act(async () => { readOnly.onClose(); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tab(/^Residual monitoring/).className).toMatch(/tabActive/);
    expect(sections()).toContainEqual(["Observed sweep timing by contra", true]);

    const adaRow = { id: "rec-ada", notes: null, tradeInstructions: null, textLoadError: null };
    openRecord.mockResolvedValueOnce({ ok: true, row: adaRow, transferId: null, editsEnabled: true, dayToDay: false });
    fireEvent.click(tab(/^Data quality/));
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Fix in transfer" })[0]); });
    expect(openRecord).toHaveBeenLastCalledWith("rec-ada");
    const editor = drawerProps.mock.lastCall![0];
    expect(editor).toMatchObject({ row: adaRow, transferId: null });
    expect(editor.readOnly).toBeUndefined();
    expect(editor.editor).toBeTruthy();
    await act(async () => { editor.onLinked("transfer-9"); });
    expect(drawerProps.mock.lastCall![0].transferId).toBe("transfer-9");
    await act(async () => { drawerProps.mock.lastCall![0].onUnlinked(); });
    expect(drawerProps.mock.lastCall![0].transferId).toBeNull();
    await act(async () => { drawerProps.mock.lastCall![0].onClose(); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Exception queue")).toBeTruthy();
    markCase(SUITE, "opens the transfer drawer in place from a residual row and Fix in transfer");
  });

  it("keeps the dashboard mounted with retry when the drawer cannot load", async () => {
    openRecord.mockResolvedValueOnce({ ok: false, retry: true, reason: "unavailable" });
    mount();
    fireEvent.click(tab(/^Residual monitoring/));
    await act(async () => { fireEvent.click(screen.getByText("Queue Client").closest("button")!); });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Could not open this transfer. Retry");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Transfer operations")).toBeTruthy();
    expect(tab(/^Residual monitoring/).className).toMatch(/tabActive/);
    const row = { id: "rec-queue", notes: null, tradeInstructions: null, textLoadError: null };
    openRecord.mockResolvedValueOnce({ ok: true, row, transferId: null, editsEnabled: false, dayToDay: false });
    await act(async () => { fireEvent.click(within(alert).getByRole("button", { name: "Retry" })); });
    expect(openRecord).toHaveBeenCalledTimes(2);
    expect(openRecord).toHaveBeenLastCalledWith("rec-queue");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Transfer drawer" })).toBeTruthy();
    markCase(SUITE, "keeps the dashboard mounted with retry when the drawer cannot load");
  });
});
