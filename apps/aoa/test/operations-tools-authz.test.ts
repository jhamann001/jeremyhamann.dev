import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const { authSpy, requestSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  requestSpy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn(function () {
    return { getIdTokenClient: vi.fn(async () => ({ request: requestSpy })) };
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("REDIRECT"); },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/auth", () => ({ auth: authSpy }));

import { canAccessOperationsTools } from "@/lib/operations/authorization";
import OperationsToolsPage from "@/app/(authenticated)/operations/page";
import TransferDashboardPage from "@/app/(authenticated)/operations/transfer-dashboard/page";

const SUITE = "operations-tools-authz";

describe("Operations Tools authorization", () => {
  it.each(["ADMIN", "OPERATIONS", "OPS", " admin ", "operations"])(
    "permits the normalized firm-wide role %j",
    (role) => expect(canAccessOperationsTools(role)).toBe(true),
  );

  it.each([undefined, null, "", "VIEWER", "ADVISOR", "CLIENT_SERVICE", "INGEST"])(
    "denies %j",
    (role) => expect(canAccessOperationsTools(role)).toBe(false),
  );
});

function session(role: string) {
  authSpy.mockResolvedValue({ user: { role, name: "Synthetic Operator", email: "operator@example.test" } });
}

function flags(over: { tools?: string; epic?: string; show?: string; trade?: string; fees?: string } = {}) {
  vi.stubEnv("APP_ENV", "dev");
  vi.stubEnv("OPERATIONS_TOOLS", over.tools ?? "1");
  vi.stubEnv("OPERATIONS_TRADE_RECONCILIATION", over.trade ?? "1");
  vi.stubEnv("OPERATIONS_FEE_REQUESTS", over.fees ?? "1");
  vi.stubEnv("EPIC_ACAT_TRANSFER_DASHBOARD_TKT314", over.epic ?? "0");
  vi.stubEnv("SHOW_ACAT_TRANSFER_DASHBOARD_TKT314", over.show ?? "0");
}

describe("Operations transfer dashboard gates", () => {
  beforeEach(() => {
    authSpy.mockReset();
    requestSpy.mockReset();
    requestSpy.mockResolvedValue({ status: 404, data: { error: "not_found" } });
    session("ADMIN");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("shows card 03 only when all dashboard gates are on", async () => {
    flags({ epic: "1", show: "1" });
    const enabled = renderToStaticMarkup(await OperationsToolsPage());
    expect(enabled).toContain("03");
    expect(enabled).toContain("Transfer Dashboard");
    expect(enabled).toContain('href="/operations/transfer-dashboard"');
    for (const over of [
      { epic: "0", show: "1" },
      { epic: "1", show: "0" },
      { tools: "0", epic: "1", show: "1" },
    ]) {
      flags(over);
      if (over.tools === "0") {
        await expect(OperationsToolsPage()).rejects.toThrow("NOT_FOUND");
      } else {
        const html = renderToStaticMarkup(await OperationsToolsPage());
        expect(html).not.toContain("Transfer Dashboard");
        expect(html).not.toContain(">03<");
      }
    }
    markCase(SUITE, "shows card 03 only when all dashboard gates are on");
  });

  it("keeps cards 01 and 02 unchanged when dashboard is off", async () => {
    flags();
    const html = renderToStaticMarkup(await OperationsToolsPage());
    expect(html).toContain("01");
    expect(html).toContain("Trade Reconciliation");
    expect(html).toContain("Run the account-aware comparison, isolate breaks, explain valid exceptions, and inspect saved history.");
    expect(html).toContain("Open reconciliation →");
    expect(html).toContain("02");
    expect(html).toContain("Fee Credits");
    expect(html).toContain("Service Guarantees");
    expect(html).toContain("Submit account-linked fee-credit and billing-exception requests to a controlled pending queue.");
    expect(html).toContain("Open request intake →");
    expect(html).not.toContain("Transfer Dashboard");
    expect(html).not.toContain(">03<");
    flags({ epic: "1", show: "1" });
    const enabled = renderToStaticMarkup(await OperationsToolsPage());
    expect(enabled).toContain("Open reconciliation →");
    expect(enabled).toContain("Open request intake →");
    expect(enabled).toContain("Transfer Dashboard");
    markCase(SUITE, "keeps cards 01 and 02 unchanged when dashboard is off");
  });

  it("denies the dashboard page to viewer and flag-off requests", async () => {
    flags({ epic: "1", show: "1" });
    session("VIEWER");
    await expect(TransferDashboardPage()).rejects.toThrow("NOT_FOUND");
    expect(requestSpy).not.toHaveBeenCalled();
    session("ADMIN");
    flags({ epic: "0", show: "1" });
    await expect(TransferDashboardPage()).rejects.toThrow("NOT_FOUND");
    flags({ epic: "1", show: "0" });
    await expect(TransferDashboardPage()).rejects.toThrow("NOT_FOUND");
    expect(requestSpy).not.toHaveBeenCalled();
    authSpy.mockResolvedValue(null);
    flags({ epic: "1", show: "1" });
    await expect(TransferDashboardPage()).rejects.toThrow("REDIRECT");
    session("OPERATIONS");
    flags({ epic: "1", show: "1" });
    const html = renderToStaticMarkup(await TransferDashboardPage());
    expect(html).toContain("Retry");
    expect(html).toContain("Transfer dashboard is unavailable.");
    expect(html).not.toContain("Completed rate");
    expect(requestSpy).toHaveBeenCalledTimes(1);
    markCase(SUITE, "denies the dashboard page to viewer and flag-off requests");
  });

  it("serves the dashboard page when both dashboard flags are on", async () => {
    const distribution = { average: 1, median: 2, p75: 3, p90: 4, sampleSize: 5 };
    requestSpy.mockResolvedValue({
      status: 200,
      data: {
        summary: {
          total: 40, Completed: 9, Rejected: 3, Canceled: 2, Purged: 8, active: 25, validFinalized: 14,
          completedRate: 0.5, rejectionRate: 0.25, canceledRate: 0.125,
        },
        workflowTimings: [{ workflow: "ACAT", requestToSubmit: distribution, submitToComplete: distribution, requestToComplete: distribution }],
        monthlyVolume: [{ month: "2025-06", label: "Jun 2025", total: 4, workflows: { ACAT: 1, MANUAL: 1, DRS: 1, RESIDUAL: 0, UNCLASSIFIED: 1 } }],
        flow: {
          incoming: { totalCount: 2, totalAmount: 10, requestedCount: 1, requestedAmount: 8, residualCount: 1, residualAmount: 2 },
          outgoing: { totalCount: 1, totalAmount: 4, requestedCount: 1, requestedAmount: 4, residualCount: 0, residualAmount: 0 },
          netAmount: 6, requestedNetAmount: 4, residualNetAmount: 2,
        },
        topContras: { acat: [], manual: [] },
        residuals: { queue: [], benchmarks: [] },
        quality: { rules: [{ ruleKey: "rule-1", title: "Synthetic rule", description: "Synthetic control" }], exceptions: [] },
        reconciliation: { coverageRate: 0.5, tracked: 2, eligible: 4, matched: 1, matchRate: null, mismatch: 1, pending: 0, notTracked: 2 },
      },
    });
    session("OPERATIONS");
    flags({ epic: "1", show: "1" });
    const html = renderToStaticMarkup(await TransferDashboardPage());
    expect(html).toContain("Transfer operations");
    expect(html).toContain('aria-label="Dashboard sections"');
    expect(html).toContain("14 finalized · 8 purged");
    expect(html).not.toContain("Transfer dashboard is unavailable.");
    expect(requestSpy).toHaveBeenCalledTimes(1);
    markCase(SUITE, "serves the dashboard page when both dashboard flags are on");
  });
});
