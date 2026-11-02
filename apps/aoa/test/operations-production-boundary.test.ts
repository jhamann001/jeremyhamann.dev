import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, tradeDataSpy, feeDataSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  tradeDataSpy: vi.fn(),
  feeDataSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/operations/fee-requests",
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("REDIRECT"); },
}));
vi.mock("@/lib/data/trade-reconciliation", () => ({
  tradeReconciliationPageData: tradeDataSpy,
}));
vi.mock("@/lib/data/operations-fee-requests", () => ({
  operationsFeeRequestPageData: feeDataSpy,
  operationsFeeRequestDirectory: feeDataSpy,
  operationsFeeRequestDetail: vi.fn(),
}));
vi.mock("@/app/(authenticated)/operations/trade-reconciliation/actions", () => ({
  runTradeReconciliation: vi.fn(),
  loadTradeReconciliationHistory: vi.fn(),
  saveTradeReconciliationBulkReview: vi.fn(),
  saveTradeReconciliationNote: vi.fn(),
  saveTradeReconciliationReview: vi.fn(),
}));
vi.mock("@/app/(authenticated)/operations/fee-requests/actions", () => ({
  searchOperationsFeeClients: vi.fn(),
  submitOperationsFeeRequest: vi.fn(),
  updateOperationsFeeRequest: vi.fn(),
}));

import OperationsToolsPage from "@/app/(authenticated)/operations/page";
import TradeReconciliationPage from "@/app/(authenticated)/operations/trade-reconciliation/page";
import OperationsFeeRequestsPage from "@/app/(authenticated)/operations/fee-requests/page";
import { TradeReconciliationPrototype } from "@/components/operations";
import { PROTOTYPE_ROWS } from "@/lib/mock/trade-reconciliation";

const pages = [
  () => OperationsToolsPage(),
  () => TradeReconciliationPage({ searchParams: Promise.resolve({}) }),
  () => OperationsFeeRequestsPage({ searchParams: Promise.resolve({}) }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_ENV", "prod");
  vi.stubEnv("OPERATIONS_TOOLS", "1");
  vi.stubEnv("OPERATIONS_TRADE_RECONCILIATION", "1");
  vi.stubEnv("OPERATIONS_FEE_REQUESTS", "1");
  vi.stubEnv("OPERATIONS_PRODUCTION_ENABLED", undefined);
  authSpy.mockResolvedValue({ user: { role: "OPERATIONS", email: "operator@example.test" } });
  tradeDataSpy.mockResolvedValue({
    run: null, history: { daily: [], monthly: [], quarterly: [] }, historyLoaded: false,
  });
  feeDataSpy.mockResolvedValue({
    rows: [], counts: { pending: 0, approved: 0, credited: 0, closed: 0, total: 0 },
    page: 1, pageSize: 100, pageCount: 1, total: 0, snapshot: "a".repeat(32), queryKey: "",
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("Operations production enablement boundary", () => {
  it("denies all production routes before data reads when only dev switches are copied", async () => {
    for (const page of pages) await expect(page()).rejects.toThrow("NOT_FOUND");
    expect(tradeDataSpy).not.toHaveBeenCalled();
    expect(feeDataSpy).not.toHaveBeenCalled();
  });

  it.each(["VIEWER", "ADVISOR", "CLIENT_SERVICE", "unknown"])(
    "still denies %s after production enablement", async (role) => {
      vi.stubEnv("OPERATIONS_PRODUCTION_ENABLED", "1");
      authSpy.mockResolvedValue({ user: { role, email: "operator@example.test" } });
      for (const page of pages) await expect(page()).rejects.toThrow("NOT_FOUND");
      expect(tradeDataSpy).not.toHaveBeenCalled();
      expect(feeDataSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["OPERATIONS", "ADMIN"])(
    "renders empty production history for %s without development records", async (role) => {
      vi.stubEnv("OPERATIONS_PRODUCTION_ENABLED", "1");
      authSpy.mockResolvedValue({ user: { role, email: "operator@example.test" } });
      const html = (await Promise.all(pages.map((page) => page()))).map((page) => renderToStaticMarkup(page)).join("");
      expect(html).toContain("No reconciliation loaded");
      expect(html).toContain("No requests match these filters");
      expect(html).toContain('href="/api/operations/trade-reconciliation/export"');
      expect(html).toContain('href="/api/operations/fee-requests/export?area=credits"');
      expect(html).toContain('href="/api/operations/fee-requests/export?area=exceptions"');
      expect(html).not.toContain("Live development data");
      expect(html).not.toContain("Development workflow");
      expect(html).not.toContain("Development rollout");
      expect(html).not.toContain("sample-equity-order-id-match");
      expect(html).not.toContain("Sample run used");
      expect(html).not.toContain("APX-10842");
      expect(tradeDataSpy).toHaveBeenCalledExactlyOnceWith({ role, email: "operator@example.test" }, undefined);
      expect(feeDataSpy).toHaveBeenCalledExactlyOnceWith({ role, email: "operator@example.test" }, expect.objectContaining({ page: 1, pageSize: 100, filters: expect.objectContaining({ tab: "credits", status: "" }) }));
    },
  );

  it("defaults the reconciliation component to empty data even when no props are provided", () => {
    const html = renderToStaticMarkup(createElement(TradeReconciliationPrototype, {}));
    expect(html).toContain("No reconciliation loaded");
    expect(html).not.toContain("sample-equity-order-id-match");
    expect(html).not.toContain("Sample run used");
    expect(html).not.toContain("APX-10842");
  });

  it("shows saved break notes in the current-run summary", () => {
    const html = renderToStaticMarkup(createElement(TradeReconciliationPrototype, {
      currentRunAvailable: true,
      initialRows: PROTOTYPE_ROWS,
    }));

    expect(html).toContain("Notes");
    expect(html).toContain("Expected Apex-only trade");
    expect(html).toContain("Approved custodian-directed liquidation; no Meridian order was expected.");
  });
});
