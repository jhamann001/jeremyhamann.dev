import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  fetchTradeReconciliationSources,
  TradeReconciliationSourceError,
} from "@/lib/operations/trade-reconciliation-source";

const APEX_COLUMNS = [
  "activity_id", "process_date", "account_id", "asset_type", "symbol", "side",
  "quantity", "net_amount", "gross_amount", "client_order_id", "activity_time",
];
const MERIDIAN_COLUMNS = [
  "rebalancer_order_id", "apex_account_id", "asset_type", "symbol", "quantity",
  "notional_amount", "side", "initiated_timestamp", "client_basket_id", "apex_basket_id",
];

function exportedRows(columns: string[], rows: unknown[][], total = rows.length): Record<string, unknown>[] {
  return rows.map((row) => ({
    ...Object.fromEntries(columns.map((name, index) => [name, row[index]])),
    source_row_count: total,
  }));
}

function sourceExport(source: "apex" | "meridian", count: number, total = count) {
  const rows = Array.from({ length: count }, (_, index) => source === "apex"
    ? [
      `activity-${index}`, "2026-09-16", `account-${index}`, "EQUITY", "VTI", "BUY",
      1, 100, 100, `order-${index}`, "2026-09-16T15:00:00",
    ]
    : [
      `order-${index}`, `account-${index}`, "EQUITY", "VTI", 1, 100, "BUY",
      "2026-09-16T14:59:00", `client-basket-${index}`, `apex-basket-${index}`,
    ]);
  return exportedRows(source === "apex" ? APEX_COLUMNS : MERIDIAN_COLUMNS, rows, total);
}

const response = (payload: unknown) => ({ ok: true, json: async () => payload }) as Response;

function queryFromRequest(options: RequestInit) {
  const body = JSON.parse(String(options.body));
  expect(body.format_rows).toBe(false);
  expect(typeof body.query).toBe("string");
  return JSON.parse(body.query);
}

// The preview endpoint discards supplied constraints and applies its own 2,000
// row cap. Export returns object rows, with no status or truncation metadata.
function syntheticWarehouse(url: unknown, options: RequestInit, counts: { apex: number; meridian: number }) {
  const body = JSON.parse(String(options.body));
  const preview = String(url).endsWith("/api/dataset");
  const query = preview ? body : queryFromRequest(options);
  const source = query.native.query.includes("apex.apex_daily_activities") ? "apex" : "meridian";
  const total = counts[source];
  if (preview) {
    const rows = sourceExport(source, Math.min(total, 2_000), total);
    return response({ status: "completed", row_count: rows.length, data: {
      cols: Object.keys(rows[0] ?? {}).map((name) => ({ name })),
      rows: rows.map(Object.values),
      ...(rows.length === 2_000 ? { rows_truncated: 2_000 } : {}),
    } });
  }
  expect(String(url)).toBe("https://warehouse.example/api/dataset/json");
  const limit = Number(query.native.query.match(/\nLIMIT (\d+)$/)?.[1]);
  expect(limit).toBe(10_001);
  expect(query.native.query).toContain("COUNT(*) OVER () AS source_row_count");
  return response(sourceExport(source, Math.min(total, limit), total));
}

describe("Trade Reconciliation fixed warehouse export", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("WAREHOUSE_URL", "https://warehouse.example");
    vi.stubEnv("WAREHOUSE_API_KEY", "synthetic-test-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockReset();
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("exports only the two fixed, bounded native queries with a bound date and raw formatting", async () => {
    fetchMock
      .mockResolvedValueOnce(response(exportedRows(APEX_COLUMNS, [[
        "a-1", "2026-09-01", "acct-1", "EQUITY", "VTI", "BUY", 10,
        1000, 1000, "o-1", "2026-09-01T15:00:00",
      ]])))
      .mockResolvedValueOnce(response(exportedRows(MERIDIAN_COLUMNS, [[
        "o-1", "acct-1", "EQUITY", "VTI", 10, null, "BUY",
        "2026-09-01T14:59:00", "cb-1", "ab-1",
      ]])));

    const result = await fetchTradeReconciliationSources("2026-09-01");
    expect(result.apex).toHaveLength(1);
    expect(result.meridian).toHaveLength(1);
    expect(result.apex[0]).not.toHaveProperty("source_row_count");
    expect(result.meridian[0]).not.toHaveProperty("source_row_count");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(String(url)).toBe("https://warehouse.example/api/dataset/json");
      expect(options.redirect).toBe("error");
      expect(options.cache).toBe("no-store");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const body = queryFromRequest(options);
      expect(body.database).toBe(4);
      expect(body.type).toBe("native");
      expect(body).not.toHaveProperty("constraints");
      expect(body.parameters).toEqual([{
        type: "date/single",
        target: ["variable", ["template-tag", "business_date"]],
        value: "2026-09-01",
      }]);
      expect(body.native.query).toContain("{{business_date}}");
      expect(body.native.query).not.toContain("2026-09-01");
      expect(body.native.query).toContain("COUNT(*) OVER () AS source_row_count");
      expect(body.native.query).toMatch(/\nLIMIT 10001$/);
      if (body.native.query.includes("apex.apex_daily_activities")) {
        expect(body.native.query).toContain("WHERE type = 'TRADE'");
        expect(body.native.query).toContain("account_id <> '01SYNTH85BR7BT1ZPYKBDZAC9C'");
        expect(body.native.query).toContain("CAST(process_date AS date) = {{business_date}}");
        expect(body.native.query).toContain("ORDER BY account_id, client_order_id, activity_id");
        expect(body.native.query).not.toContain("sub_type = 'ALLOCATION'");
      } else {
        expect(body.native.query).toContain("CAST(initiated_timestamp AS date) = {{business_date}}");
        expect(body.native.query).toContain("ORDER BY apex_account_id, rebalancer_order_id");
      }
    }
  });

  it.each([0, 1, 2_000, 2_501, 10_000])("accepts a complete %i-row export without preview metadata", async (count) => {
    fetchMock.mockImplementation(async (url: unknown, options: RequestInit) =>
      syntheticWarehouse(url, options, { apex: count, meridian: count }));
    const result = await fetchTradeReconciliationSources("2026-09-16");
    expect(result.apex).toHaveLength(count);
    expect(result.meridian).toHaveLength(count);
    if (count) {
      expect(result.apex.at(-1)?.activityId).toBe(`activity-${count - 1}`);
      expect(result.meridian.at(-1)?.rebalancerOrderId).toBe(`order-${count - 1}`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retrieves 3,395/3,391 rows even when the preview ignores caller constraints", async () => {
    const counts = { apex: 3_395, meridian: 3_391 };
    const preview = await syntheticWarehouse("https://warehouse.example/api/dataset", { body: JSON.stringify({
      native: { query: "SELECT * FROM apex.apex_daily_activities" },
      constraints: { "max-results": 10_001, "max-results-bare-rows": 10_001 },
    }) }, counts).json();
    expect(preview.row_count).toBe(2_000);
    expect(preview.data.rows_truncated).toBe(2_000);
    fetchMock.mockImplementation(async (url: unknown, options: RequestInit) => syntheticWarehouse(url, options, counts));
    const result = await fetchTradeReconciliationSources("2026-09-16");
    expect(result.apex).toHaveLength(3_395);
    expect(result.meridian).toHaveLength(3_391);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["apex", "meridian"] as const)("rejects an over-bound %s source", async (source) => {
    fetchMock.mockImplementation(async (url: unknown, options: RequestInit) =>
      syntheticWarehouse(url, options, { apex: 1, meridian: 1, [source]: 10_001 }));
    await expect(fetchTradeReconciliationSources("2026-09-16"))
      .rejects.toMatchObject({ reason: "source_limit_exceeded" });
  });

  it.each(["apex", "meridian"] as const)("rejects a silently truncated %s export without rows_truncated metadata", async (source) => {
    fetchMock.mockImplementation(async (_url: unknown, options: RequestInit) => {
      const query = queryFromRequest(options);
      const current = query.native.query.includes("apex.apex_daily_activities") ? "apex" : "meridian";
      return response(sourceExport(current, current === source ? 2_000 : 1, current === source ? 3_395 : 1));
    });
    await expect(fetchTradeReconciliationSources("2026-09-16"))
      .rejects.toMatchObject({ reason: "source_truncated" });
  });

  it("rejects a declared over-bound total even if the export returned fewer rows", async () => {
    fetchMock.mockResolvedValueOnce(response(sourceExport("apex", 1, 10_001)))
      .mockResolvedValueOnce(response([]));
    await expect(fetchTradeReconciliationSources("2026-09-16"))
      .rejects.toMatchObject({ reason: "source_limit_exceeded" });
  });

  it("checks the total on every row, not just the first", async () => {
    const rows = sourceExport("apex", 2);
    rows[1].source_row_count = 3;
    fetchMock.mockResolvedValueOnce(response(rows)).mockResolvedValueOnce(response([]));
    await expect(fetchTradeReconciliationSources("2026-09-16"))
      .rejects.toMatchObject({ reason: "source_truncated" });
  });

  it.each([
    undefined, null, false, true, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    "", "0", "01", "1.0", "1e0", " 1", "1 ", "+1", "-1", "9007199254740992", {}, [],
  ].map((count) => [count]))("rejects missing or malformed source count %j", async (count) => {
    const rows = sourceExport("apex", 1);
    rows[0].source_row_count = count;
    fetchMock.mockResolvedValueOnce(response(rows)).mockResolvedValueOnce(response([]));
    await expect(fetchTradeReconciliationSources("2026-09-16"))
      .rejects.toMatchObject({ reason: "invalid_source" });
  });

  it("accepts canonical bigint count strings", async () => {
    const rows = sourceExport("apex", 2);
    rows.forEach((row) => { row.source_row_count = "2"; });
    fetchMock.mockResolvedValueOnce(response(rows)).mockResolvedValueOnce(response([]));
    expect((await fetchTradeReconciliationSources("2026-09-16")).apex).toHaveLength(2);
  });

  it.each([null, {}, "invalid", { status: "completed", data: { rows: [] } }, [null], [[]], ["row"]].map((payload) => [payload]))
    ("rejects non-export or malformed payload %j", async (payload) => {
      fetchMock.mockResolvedValueOnce(response(payload)).mockResolvedValueOnce(response([]));
      await expect(fetchTradeReconciliationSources("2026-09-16"))
        .rejects.toMatchObject({ reason: "invalid_source" });
    });

  it("rejects malformed dates before contacting Warehouse", async () => {
    await expect(fetchTradeReconciliationSources("2026-09-01' OR 1=1"))
      .rejects.toBeInstanceOf(TradeReconciliationSourceError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid trade fields after validating completeness", async () => {
    fetchMock.mockResolvedValueOnce(response([{ source_row_count: 1, process_date: "2026-09-16" }]))
      .mockResolvedValueOnce(response([]));
    await expect(fetchTradeReconciliationSources("2026-09-16"))
      .rejects.toMatchObject({ reason: "invalid_source" });
  });

  it.each([403, 500])("rejects export HTTP %i without falling back to preview", async (status) => {
    fetchMock.mockResolvedValueOnce({ ok: false, status }).mockResolvedValueOnce(response([]));
    await expect(fetchTradeReconciliationSources("2026-09-16"))
      .rejects.toMatchObject({ reason: "warehouse_error" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid JSON without falling back to preview", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error("synthetic invalid JSON"); } })
      .mockResolvedValueOnce(response([]));
    await expect(fetchTradeReconciliationSources("2026-09-16"))
      .rejects.toMatchObject({ reason: "invalid_source" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects transport failures without exposing the underlying error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("synthetic-secret-only")).mockResolvedValueOnce(response([]));
    await expect(fetchTradeReconciliationSources("2026-09-16"))
      .rejects.toMatchObject({ reason: "warehouse_error", message: "warehouse_error" });
    expect(console.error).toHaveBeenCalledWith("[trade-reconciliation] apex_fetch_failed");
  });

  it("accepts dollar-based mutual-fund buys without a share quantity", async () => {
    fetchMock
      .mockResolvedValueOnce(response(exportedRows(APEX_COLUMNS, [[
        "apex-mf-1", "2026-08-31", "acct-1", "MUTUAL_FUND", "SWVXX", "BUY", null,
        1500, 1500, "order-mf-1", "2026-08-31T16:00:00",
      ]])))
      .mockResolvedValueOnce(response(exportedRows(MERIDIAN_COLUMNS, [[
        "order-mf-1", "acct-1", "MUTUAL_FUND", "SWVXX", null, 1500, "BUY",
        "2026-08-31T15:59:00", "cb-mf-1", "ab-mf-1",
      ]])));
    const result = await fetchTradeReconciliationSources("2026-08-31");
    expect(result.apex[0]?.quantity).toBeNull();
    expect(result.meridian[0]?.quantity).toBeNull();
    expect(result.meridian[0]?.notionalAmount).toBe(1500);
  });
});
