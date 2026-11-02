import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const { authSpy, readBook } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  readBook: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn(function () { return { getIdTokenClient: vi.fn() }; }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("REDIRECT"); },
}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/data/acat-workspace", () => ({ readAcatBook: readBook }));
vi.mock("@/components/transfers/AcatUnlinkedDrawer", () => ({ AcatUnlinkedDrawer: () => null }));
vi.mock("@/components/transfers/AcatBookActions", () => ({ AcatRecordEditor: () => null }));

import { openDashboardRecord } from "@/app/(authenticated)/operations/transfer-dashboard/actions";
import {
  AcatTransferDashboard,
  closeRequiresNote,
  filterQualityExceptions,
  qualityView,
  reviewAfterWrite,
  type DashboardInteraction,
} from "@/components/operations/AcatTransferDashboard";
import styles from "@/components/operations/AcatTransferDashboard.module.css";
import type { AcatBookRow } from "@/lib/data/acat-book";
import { boundedRecordId, type AcatDashboard, type QualityException } from "@/lib/data/acat-dashboard";

const SUITE = "acat-transfer-dashboard";
const distribution = { average: 1, median: 2, p75: 3, p90: 4, sampleSize: 5 };

function exception(over: Partial<QualityException> & Pick<QualityException, "record" | "ruleKey">): QualityException {
  return {
    fingerprint: over.fingerprint ?? over.ruleKey,
    title: over.title ?? over.ruleKey,
    detail: over.detail ?? "Supplied detail",
    severity: over.severity ?? "high",
    review: over.review === undefined ? null : over.review,
    ...over,
  };
}

function sample(over: Partial<AcatDashboard> = {}): AcatDashboard {
  const rules = Array.from({ length: 18 }, (_, index) => ({
    ruleKey: `rule-${index + 1}`,
    title: `Rule ${String(index + 1).padStart(2, "0")}`,
    description: `Control ${index + 1}`,
  }));
  return {
    summary: {
      total: 40, Completed: 9, Rejected: 3, Canceled: 2, Purged: 8, active: 25, validFinalized: 14,
      completedRate: 0.5, rejectionRate: 0.25, canceledRate: 0.125,
    },
    workflowTimings: (["ACAT", "MANUAL", "DRS", "UNCLASSIFIED"] as const).map((workflow) => ({
      workflow,
      requestToSubmit: distribution,
      submitToComplete: distribution,
      requestToComplete: distribution,
    })),
    monthlyVolume: [{
      month: "2025-06",
      label: "Jun 2025",
      total: 4,
      workflows: { ACAT: 2, MANUAL: 1, DRS: 1, RESIDUAL: 0, UNCLASSIFIED: 0 },
    }],
    flow: {
      incoming: { totalCount: 2, totalAmount: 100000, requestedCount: 1, requestedAmount: 80000, residualCount: 1, residualAmount: 20000 },
      outgoing: { totalCount: 1, totalAmount: 40000, requestedCount: 1, requestedAmount: 40000, residualCount: 0, residualAmount: 0 },
      netAmount: 123450, requestedNetAmount: 40000, residualNetAmount: 20000,
    },
    topContras: {
      acat: [{ contra: "Fidelity", completed: 2, finalized: 3, rejectionRate: 0.1, medianApexDays: 4, completedAmount: 200000 }],
      manual: [{ contra: "Schwab", completed: 1, finalized: 1, rejectionRate: 0, medianApexDays: null, completedAmount: 50000 }],
    },
    residuals: {
      queue: [{ record: { id: "rec-queue", clientName: "Queue Client", transferringContra: "Fidelity" }, followUpDate: "2026-01-01", daysPastFollowUp: 6 }],
      benchmarks: [{ contra: "Fidelity", sampleSize: 4, medianDays: 10, p75Days: 12, p90Days: 15 }],
    },
    quality: {
      rules,
      exceptions: [
        exception({ record: { id: "rec-ada", clientName: "Daniel Chen", transferringContra: "Fidelity" }, ruleKey: "rule-1", title: "Completed without Apex date" }),
        ...Array.from({ length: 5 }, (_, index) => exception({
          record: { id: `rec-open-${index}`, clientName: `Open Client ${index}`, transferringContra: "Schwab" },
          ruleKey: "rule-3",
        })),
        exception({
          record: { id: "rec-grace", clientName: "Grace Hopper", transferringContra: "Schwab" },
          ruleKey: "rule-2",
          severity: "low",
          review: { status: "CLOSED", resolution: "CORRECTED", note: "fixed", reviewedBy: null, reviewedAt: null },
        }),
      ],
    },
    reconciliation: {
      coverageRate: 0.5, tracked: 2, eligible: 4, matched: 1, matchRate: null, mismatch: 1, pending: 0, notTracked: 2,
    },
    ...over,
  };
}

function renderDashboard(dashboard: AcatDashboard, interaction?: DashboardInteraction): string {
  return renderToStaticMarkup(createElement(AcatTransferDashboard, { dashboard, interaction }));
}

function enable() {
  vi.stubEnv("APP_ENV", "dev");
  vi.stubEnv("OPERATIONS_TOOLS", "1");
  vi.stubEnv("EPIC_ACAT_TRANSFER_DASHBOARD_TKT314", "1");
  vi.stubEnv("SHOW_ACAT_TRANSFER_DASHBOARD_TKT314", "1");
}

describe("ACAT transfer dashboard", () => {
  beforeEach(() => {
    authSpy.mockReset();
    readBook.mockReset();
    enable();
    authSpy.mockResolvedValue({ user: { role: "OPERATIONS", email: "operator@example.test" } });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the five summary counts and four dashboard sections", () => {
    const dashboard = sample();
    const html = renderDashboard(dashboard);
    expect(html).toContain("Transfer operations");
    expect(html).toContain("Operational outcomes, cycle time, residual sweeps, and reconciliation coverage");
    expect(html).toMatch(/Updated \d{2}-\d{2}-\d{4}/);
    expect(html).toContain("All transfers");
    expect(html).toContain(">40<");
    expect(html).toContain("14 finalized · 8 purged");
    expect(html).toContain(">9<");
    expect(html).toContain("50.0% of valid finalized");
    expect(html).toContain(">3<");
    expect(html).toContain("25.0% of valid finalized");
    expect(html).toContain(">25<");
    expect(html).toContain("2 canceled · 12.5%");
    expect(html).toMatch(/<button type="button" class="[^"]*">.*Data quality<\/p><p class="[^"]*">6<\/p>/);
    expect(html).toContain("unresolved exception instances");
    expect(html).toContain('aria-label="Dashboard sections"');
    for (const tab of ["Overview", "Residual monitoring (1)", "Data quality (6)", "Reconciliation"]) {
      expect(html).toMatch(new RegExp(`<button type="button" class="[^"]*">${tab.replace(/[()]/g, "\\$&")}</button>`));
    }
    expect(html).toContain("Cycle time by transfer workflow");
    expect(html).toContain("Client request → Apex");
    expect(html).toContain("Apex → complete");
    expect(html).toContain("Request → complete");
    expect(html).toContain("ACAT (API)");
    expect(html).toContain("2.0d");
    expect(html).toContain("n=5");
    expect(html).toContain("Jun 2025");
    expect(html).toContain('role="img"');
    expect(html).toContain("Monthly transfer requests by workflow");
    expect(html).toContain("Jun 2025: 4 requests; ACAT (API) 2, Manual 1, DRS 1, Unclassified 0");
    expect(html).toContain("View monthly data");
    expect(html).toContain("Net completed flow");
    expect(html).toContain("$1K");
    expect(html).toContain("$2K");
    expect(html).toContain("$400");
    expect(html).not.toContain("$1,234.50");
    expect(html).toContain("Top ACAT / API contras");
    expect(html).toContain("Median submit → complete");
    expect(html).not.toContain("Residual follow-up queue");
    const quality = renderDashboard(dashboard, { tab: "quality" });
    expect(quality).toContain(`${dashboard.quality.rules.length} automated controls; multiple request methods are allowed`);
    for (const rule of dashboard.quality.rules) expect(quality).toContain(rule.title);
    expect(quality).toContain("Fix in transfer");
    expect(quality).toContain("Mark in review");
    expect(quality).toContain("All exception types (6)");
    expect(renderDashboard(dashboard, { tab: "recon" })).toContain("Match rate —");
    const residuals = renderDashboard(dashboard, { tab: "residuals" });
    expect(residuals).toContain("Queue Client");
    expect(residuals).toContain("Fidelity · 6d past follow-up · 01-01-2026");
    expect(residuals).not.toContain("No monitored transfers currently need residual follow-up.");
    const empty = sample({
      residuals: { queue: [], benchmarks: [] },
      quality: { rules: dashboard.quality.rules, exceptions: [] },
    });
    const emptyResiduals = renderDashboard(empty, { tab: "residuals" });
    expect(emptyResiduals).toContain("No monitored transfers currently need residual follow-up.");
    expect(emptyResiduals).toContain("No linked residual history is available yet.");
    expect(renderDashboard(empty, { tab: "quality" })).toContain("No exceptions in this view.");
    markCase(SUITE, "renders the five summary counts and four dashboard sections");
  });

  it("preserves semantic and workflow hues", () => {
    const css = fs.readFileSync("components/operations/AcatTransferDashboard.module.css", "utf8");
    const [light, dark] = css.split(":global(html.dark) .root");
    for (const hex of ["#2d8a5e", "#eaf5ef", "#a17e2e", "#b83c3c", "#fbecec", "#eec7c7", "#3b6fa0"]) expect(light).toContain(hex);
    for (const hex of ["#5fc08a", "rgba(95, 192, 138, 0.12)", "#d4b15c", "#e07070", "rgba(224, 112, 112, 0.14)", "rgba(224, 112, 112, 0.32)", "#6fa3d3"]) {
      expect(dark).toContain(hex);
    }
    for (const token of ["var(--panel)", "var(--bg)", "var(--line)", "var(--ink)", "var(--muted)", "var(--input-bg)", "var(--font-sans)"]) {
      expect(css).toContain(token);
    }
    expect(css).not.toContain("var(--green)");
    expect(css).not.toContain("var(--font-serif)");
    const html = renderDashboard(sample());
    for (const color of ["#7c3aed", "#0d9488", "#d97706", "#6b7280"]) expect(html).toContain(`background-color:${color}`);
    expect(html).toContain("repeating-linear-gradient");
    expect(html).toContain(styles.tone_success);
    expect(html).toContain(styles.tone_danger);
    expect(html).toContain(styles.tone_warning);
    markCase(SUITE, "preserves semantic and workflow hues");
  });

  it("filters data-quality exceptions without changing source data", () => {
    const rows = [
      exception({ record: { id: "rec-ada", clientName: "Daniel Chen", transferringContra: "Fidelity" }, ruleKey: "rule-1" }),
      exception({ record: { id: "rec-other", clientName: "Other Client", transferringContra: "Schwab" }, ruleKey: "rule-1" }),
      exception({
        record: { id: "rec-grace", clientName: "Grace Hopper", transferringContra: "Schwab" },
        ruleKey: "rule-2",
        review: { status: "CLOSED", resolution: "CORRECTED", note: "fixed", reviewedBy: null, reviewedAt: null },
      }),
      exception({
        record: { id: "rec-review", clientName: "Daniel Review", transferringContra: null },
        ruleKey: "rule-1",
        review: { status: "IN_REVIEW", resolution: null, note: null, reviewedBy: null, reviewedAt: null },
      }),
    ];
    const snapshot = JSON.parse(JSON.stringify(rows));
    const filtered = filterQualityExceptions(rows, { status: "open", ruleKey: "rule-1", clientQuery: "DANIEL" });
    expect(rows).toEqual(snapshot);
    expect(filtered.map((row) => row.record.id)).toEqual(["rec-ada", "rec-review"]);
    expect(filterQualityExceptions(rows, { status: "closed", ruleKey: "", clientQuery: "" }).map((row) => row.record.id)).toEqual(["rec-grace"]);
    expect(filterQualityExceptions(rows, { status: "all", ruleKey: "rule-2", clientQuery: "grace" }).map((row) => row.record.id)).toEqual(["rec-grace"]);
    const view = qualityView(rows, { status: "UNRESOLVED", ruleKey: "rule-2", clientQuery: "" });
    expect(view.options).toEqual([{ ruleKey: "rule-1", title: "rule-1", count: 3 }]);
    expect(view.effectiveRule).toBe("ALL");
    expect(view.visible.map((row) => row.record.id)).toEqual(["rec-ada", "rec-other", "rec-review"]);
    expect(rows).toEqual(snapshot);
    markCase(SUITE, "filters data-quality exceptions without changing source data");
  });

  it("disables required-note close and preserves an open row after rejection", () => {
    expect(closeRequiresNote("FALSE_POSITIVE", " ")).toBe(true);
    expect(closeRequiresNote("ACKNOWLEDGED_UNRESOLVED", "")).toBe(true);
    expect(closeRequiresNote("CORRECTED", "")).toBe(false);
    const reason = "note: A note is required for this resolution";
    expect(reviewAfterWrite({ ok: false, reason })).toEqual({ open: true, reason });
    const dashboard = sample();
    const html = renderDashboard(dashboard, { tab: "quality", reviewError: reason });
    expect(html).toContain('role="alert"');
    expect(html).toContain(reason);
    expect(html).toContain("Daniel Chen");
    expect(html).toContain("Transfer operations");
    expect(html).toMatch(/<button type="button" class="[^"]*">Close exception<\/button>/);
    const pending = renderDashboard({
      ...dashboard,
      quality: {
        rules: dashboard.quality.rules,
        exceptions: [exception({
          record: { id: "rec-pending", clientName: "Pending Client", transferringContra: null },
          ruleKey: "rule-1",
          review: { status: "IN_REVIEW", resolution: "FALSE_POSITIVE", note: null, reviewedBy: null, reviewedAt: null },
        })],
      },
    }, { tab: "quality" });
    expect(pending).toMatch(/<button type="button" disabled="" class="[^"]*">Close exception<\/button>/);
    expect(pending).toContain('placeholder="Note required"');
    const inReview = renderDashboard({
      ...dashboard,
      quality: {
        rules: dashboard.quality.rules,
        exceptions: [exception({
          record: { id: "rec-review", clientName: "Review Client", transferringContra: null },
          ruleKey: "rule-1",
          review: { status: "IN_REVIEW", resolution: "FALSE_POSITIVE", note: "saved note", reviewedBy: null, reviewedAt: null },
        })],
      },
    }, { tab: "quality" });
    expect(inReview).toContain('value="saved note"');
    expect(inReview).toMatch(/<option value="FALSE_POSITIVE" selected="">False positive<\/option>/);
    const closed = renderDashboard({
      ...dashboard,
      quality: {
        rules: dashboard.quality.rules,
        exceptions: [exception({
          record: { id: "rec-closed", clientName: "Closed Client", transferringContra: null },
          ruleKey: "rule-1",
          review: { status: "CLOSED", resolution: "FALSE_POSITIVE", note: "saved note", reviewedBy: null, reviewedAt: null },
        })],
      },
    }, { tab: "quality", qualityFilter: "ALL" });
    expect(closed).toContain("False positive · saved note");
    expect(closed).toContain(">Closed</span>");
    expect(closed).not.toContain("Mark in review");
    expect(closed).not.toContain(">Close exception<");
    markCase(SUITE, "disables required-note close and preserves an open row after rejection");
  });

  it("keeps the dashboard mounted with retry when drill-in fails", async () => {
    readBook.mockRejectedValueOnce(new Error("tracker down"));
    expect(await openDashboardRecord("rec-queue")).toEqual({ ok: false, retry: true, reason: "unavailable" });
    readBook.mockResolvedValueOnce({ rows: [], linkedTransferIds: {}, linkedByRecordId: {}, removedRows: null });
    expect(await openDashboardRecord("rec-queue")).toEqual({ ok: false, retry: true, reason: "not_found" });
    readBook.mockClear();
    expect(await openDashboardRecord("bad id")).toEqual({ ok: false, retry: true, reason: "invalid" });
    authSpy.mockResolvedValue({ user: { role: "OPS", email: "ops@example.test" } });
    expect(await openDashboardRecord("rec-queue")).toEqual({ ok: false, retry: true, reason: "unauthorized" });
    authSpy.mockResolvedValue({ user: { role: "VIEWER", email: "viewer@example.test" } });
    expect(await openDashboardRecord("rec-queue")).toEqual({ ok: false, retry: true, reason: "unauthorized" });
    expect(readBook).not.toHaveBeenCalled();
    const html = renderDashboard(sample(), { tab: "residuals" });
    expect(html).toContain("Transfer operations");
    expect(html).toContain('aria-label="Dashboard sections"');
    expect(html).toContain("Queue Client");
    markCase(SUITE, "keeps the dashboard mounted with retry when drill-in fails");
  });

  it("links a queue row to the existing ACAT detail drawer", async () => {
    expect(boundedRecordId("rec-queue")).toBe("rec-queue");
    expect(boundedRecordId("bad id")).toBeNull();
    expect(boundedRecordId(["rec-queue"])).toBeNull();
    expect(boundedRecordId("")).toBeNull();
    const row = { id: "rec-queue", acatTransferId: "live-record", notes: null, tradeInstructions: null, textLoadError: null } as unknown as AcatBookRow;
    readBook.mockResolvedValueOnce({ rows: [row], linkedTransferIds: { "live-record": "transfer-1" }, linkedByRecordId: {}, removedRows: null });
    expect(await openDashboardRecord("rec-queue")).toEqual({ ok: true, row, transferId: "transfer-1", editsEnabled: false, dayToDay: false });
    expect(readBook).toHaveBeenCalledWith({ role: "OPERATIONS", email: "operator@example.test" });
    readBook.mockResolvedValueOnce({ rows: [row], linkedTransferIds: { "live-record": "transfer-1" }, linkedByRecordId: { "rec-queue": "transfer-2" }, removedRows: null });
    expect(await openDashboardRecord("rec-queue")).toMatchObject({ ok: true, transferId: "transfer-2" });
    vi.stubEnv("SHOW_ACAT_BOOK_DAY_TO_DAY_ACTIONS_TKT302", "1");
    vi.stubEnv("EPIC_ACAT_BOOK_DAY_TO_DAY_ACTIONS_TKT302", "1");
    readBook.mockResolvedValueOnce({ rows: [row], linkedTransferIds: {}, linkedByRecordId: {}, removedRows: null });
    expect(await openDashboardRecord("rec-queue")).toMatchObject({ ok: true, transferId: null, dayToDay: true });
    const html = renderDashboard(sample(), { tab: "residuals" });
    expect(html).toContain("Queue Client");
    expect(html).not.toContain('href="/acat-tracking?record=');
    markCase(SUITE, "links a queue row to the existing ACAT detail drawer");
  });
});
