import { beforeEach, describe, expect, it, vi } from "vitest";
import { crmReportHref, crmReportProgressivePage, parseCrmReportNavigationRequest, parseCrmReportQuery } from "@/lib/crm/reporting-query";
import type { CrmReportDataset } from "@/lib/crm/reporting-contracts";
const { auth, read } = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/crm-reporting", () => ({ getCrmReportingDatasets: read }));
import { GET } from "@/app/api/navigation/reporting/route";

const snapshot = "a".repeat(32);
const dataset: CrmReportDataset = {
  id: "household_aum", label: "Households & AUM", description: "Synthetic reporting fixture",
  columns: [{ key: "household", label: "Household" }], defaultColumns: ["household"],
  rows: [{ household: "Invented Household" }], rowLinks: [{ household: "/households/001SYNTHETIC" }],
  rowIds: ["household_aum:synthetic"], snapshot,
  metrics: [{ label: "Households", value: 201 }], filters: [], totalRows: 201,
  page: 1, pageSize: 100, pageCount: 3, sort: "aum", direction: "desc", available: true,
  source: "Synthetic source", sourceAsOf: "2026-01-01", sourceAsOfLabel: "As of",
  retrievedAt: "2026-01-02T00:00:00Z", definitions: [], exclusions: [],
};
const request = (query = "") => new Request(`https://example.test/api/navigation/reporting?${query}`);

describe("Reporting progressive query and envelope", () => {
  it("defaults to100 and round-trips deliberate25/50 page sizes with view config", () => {
    expect(parseCrmReportQuery({}).pageSize).toBe(100);
    for (const pageSize of [25, 50, 100]) {
      const query = parseCrmReportQuery({ dataset: "deal_pipeline", pageSize: String(pageSize), columns: "stage,owner", owner: "Invented" });
      const href = crmReportHref(query);
      const parsed = parseCrmReportNavigationRequest(new URLSearchParams(href.split("?")[1]));
      expect(parsed.query).toEqual(query);
    }
  });

  it.each([
    "page=0", "page=2", "page=100001", "page=1&page=2", "pageSize=200", "pageSize=5",
    "snapshot=bad", "dataset=unknown", "direction=up", "sort=owner", "columns=secret", "columnsSubmitted=0",
    "scope=admin", "currentDataset=deal_pipeline", "search=%00", "search=" + "x".repeat(201),
  ])("rejects invalid or ambiguous API query %s", (query) => {
    expect(() => parseCrmReportNavigationRequest(new URLSearchParams(query))).toThrow();
  });

  it("keeps record values and links paired while preserving full result metrics", () => {
    const page = crmReportProgressivePage(dataset);
    expect(page.rows).toEqual([{ id: dataset.rowIds![0], values: dataset.rows[0], links: dataset.rowLinks[0] }]);
    expect(page.total).toBe(201);
    expect(page.meta.metrics).toEqual(dataset.metrics);
    expect(page.meta).not.toHaveProperty("rows");
    expect(page.meta).not.toHaveProperty("rowLinks");
  });
});

describe("Reporting authenticated progressive API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "reporting@example.test" }, navigationScope: "b".repeat(64) });
    read.mockResolvedValue({ ok: true, datasets: [dataset] });
  });

  it("reauthorizes every page and returns private response headers", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("x-aoa-navigation-scope")).toBe("b".repeat(64));
    expect(await response.json()).toEqual(crmReportProgressivePage(dataset));
    read.mockResolvedValue({ ok: true, datasets: [{ ...dataset, page: 2 }] });
    expect((await GET(request(`page=2&snapshot=${snapshot}`))).status).toBe(200);
    expect(auth).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][0]).toEqual({ role: "OPERATIONS", email: "reporting@example.test" });
  });

  it("rejects changed and clamped pages without returning old summaries", async () => {
    const changed = await GET(request(`page=2&snapshot=${"c".repeat(32)}`));
    expect(changed.status).toBe(409);
    expect(await changed.json()).not.toHaveProperty("meta");
    const range = await GET(request(`page=4&snapshot=${snapshot}`));
    expect(range.status).toBe(416);
  });

  it.each([
    ["disabled", 404], ["forbidden", 403], ["missing_context", 403],
  ])("denies %s with private headers", async (reason, status) => {
    read.mockResolvedValue({ ok: false, reason });
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("x-aoa-navigation-scope")).toBe(true);
    expect(await response.json()).not.toHaveProperty("rows");
  });

  it("fails closed for unavailable or unverifiable reports and auth failures", async () => {
    for (const value of [{ ...dataset, available: false }, { ...dataset, snapshot: undefined }, { ...dataset, rowIds: [] }]) {
      read.mockResolvedValue({ ok: true, datasets: [value] });
      const unavailable = await GET(request());
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("cache-control")).toBe("private, no-store");
    }
    auth.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    auth.mockRejectedValue(new Error("sensitive credential"));
    const error = await GET(request());
    expect(error.status).toBe(503);
    expect(error.headers.has("x-aoa-navigation-scope")).toBe(true);
    expect(await error.text()).not.toContain("credential");
  });
});
