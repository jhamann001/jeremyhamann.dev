import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { persistSpy, fetchSpy, revalidateSpy } = vi.hoisted(() => ({
  persistSpy: vi.fn(), fetchSpy: vi.fn(), revalidateSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { role: "OPERATIONS", email: "ops@example.com" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: (href: string) => { throw new Error(`redirect:${href}`); } }));
vi.mock("@/lib/flags", () => ({ operationsTradeReconciliationPreviewEnabled: () => true }));
vi.mock("@/lib/data/trade-reconciliation", () => ({
  persistCompletedTradeReconciliation: persistSpy,
  appendTradeReconciliationBulkReview: vi.fn(),
  appendTradeReconciliationNote: vi.fn(),
  appendTradeReconciliationReview: vi.fn(),
  tradeReconciliationHistory: vi.fn(),
}));
vi.mock("@/lib/market-calendar", () => ({
  isTradingDay: () => true, previousTradingDay: () => "2026-09-16", toDateStr: () => "2026-09-17",
}));
vi.mock("@/lib/warehouse/client", () => ({
  WAREHOUSE_REQUEST_TIMEOUT_MS: 15_000,
  readWarehouseEnv: () => ({ baseUrl: "https://warehouse.example", apiKey: "synthetic-test-key" }),
}));

// Exercise the actual source reader through the server action. The database
// writer and external HTTP transport are mocked, so no run or source is changed.
import { runTradeReconciliation } from "@/app/(authenticated)/operations/trade-reconciliation/actions";

function sourcePayload(apex: boolean, count: number, total = count): Record<string, unknown>[] {
  const columns = apex
    ? ["activity_id", "process_date", "account_id", "asset_type", "symbol", "side", "quantity", "net_amount", "gross_amount", "client_order_id", "activity_time"]
    : ["rebalancer_order_id", "apex_account_id", "asset_type", "symbol", "quantity", "notional_amount", "side", "initiated_timestamp", "client_basket_id", "apex_basket_id"];
  const rows = Array.from({ length: count }, (_, index) => apex
    ? [`activity-${index}`, "2026-09-16", `account-${index}`, "EQUITY", "VTI", "BUY", 1, 100, 100, `order-${index}`, null]
    : [`order-${index}`, `account-${index}`, "EQUITY", "VTI", 1, 100, "BUY", "2026-09-16T15:00:00", null, null]);
  return rows.map((row) => ({
    ...Object.fromEntries(columns.map((name, index) => [name, row[index]])),
    source_row_count: total,
  }));
}

function runForm() {
  const form = new FormData();
  form.set("runDate", "2026-09-17");
  return form;
}

describe("Trade Reconciliation rejects incomplete sources before persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "error").mockImplementation(() => {});
    persistSpy.mockResolvedValue("cm-complete-run");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each([
    { failingSource: "apex", count: 2_000, total: 3_395, message: "source-truncated" },
    { failingSource: "meridian", count: 2_000, total: 3_391, message: "source-truncated" },
    { failingSource: "apex", count: 10_001, total: 10_001, message: "source-limit-exceeded" },
    { failingSource: "meridian", count: 10_001, total: 10_001, message: "source-limit-exceeded" },
    { failingSource: "apex", count: 2_000, total: 10_001, message: "source-limit-exceeded" },
    { failingSource: "meridian", count: 2_000, total: 10_001, message: "source-limit-exceeded" },
  ])("does not save when $failingSource is $message", async ({ failingSource, count, total, message }) => {
    fetchSpy.mockImplementation(async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(JSON.parse(String(options.body)).query);
      const apex = body.native.query.includes("apex.apex_daily_activities");
      const failing = (apex ? "apex" : "meridian") === failingSource;
      return { ok: true, json: async () => sourcePayload(apex, failing ? count : 1, failing ? total : 1) };
    });

    await expect(runTradeReconciliation(runForm()))
      .rejects.toThrow(`redirect:/operations/trade-reconciliation?date=2026-09-17&message=${message}`);
    expect(persistSpy).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it.each(["apex", "meridian"] as const)("does not save when %s is missing a row count", async (failingSource) => {
    fetchSpy.mockImplementation(async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(JSON.parse(String(options.body)).query);
      const apex = body.native.query.includes("apex.apex_daily_activities");
      const rows = sourcePayload(apex, 2);
      if ((apex ? "apex" : "meridian") === failingSource) delete rows[1].source_row_count;
      return { ok: true, json: async () => rows };
    });
    await expect(runTradeReconciliation(runForm()))
      .rejects.toThrow("redirect:/operations/trade-reconciliation?date=2026-09-17&message=run-failed");
    expect(persistSpy).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("passes complete 3,395/3,391 exports to the writer with the prior trading date", async () => {
    fetchSpy.mockImplementation(async (url: unknown, options: RequestInit) => {
      expect(String(url)).toBe("https://warehouse.example/api/dataset/json");
      const request = JSON.parse(String(options.body));
      expect(request.format_rows).toBe(false);
      const body = JSON.parse(request.query);
      expect(body).not.toHaveProperty("constraints");
      expect(body.parameters[0].value).toBe("2026-09-16");
      const apex = body.native.query.includes("apex.apex_daily_activities");
      return { ok: true, json: async () => sourcePayload(apex, apex ? 3_395 : 3_391) };
    });

    await expect(runTradeReconciliation(runForm()))
      .rejects.toThrow("redirect:/operations/trade-reconciliation?run=cm-complete-run&message=run-complete");
    expect(persistSpy).toHaveBeenCalledTimes(1);
    const [identity, dates, sources] = persistSpy.mock.calls[0]!;
    expect(identity).toEqual({ role: "OPERATIONS", email: "ops@example.com" });
    expect(dates).toEqual({ runDate: "2026-09-17", tradeDate: "2026-09-16" });
    expect(sources.apex).toHaveLength(3_395);
    expect(sources.meridian).toHaveLength(3_391);
    expect(sources.apex[0]).not.toHaveProperty("source_row_count");
    expect(sources.meridian[0]).not.toHaveProperty("source_row_count");
    expect(revalidateSpy).toHaveBeenCalledWith("/operations/trade-reconciliation");
  });
});
