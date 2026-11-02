import { describe, expect, it, vi } from "vitest";
import { parseReconciliationHistoryQuery, reconciliationHref, reconciliationNavigation } from "@/lib/operations/reconciliation-history-query";
import { appendReconciliationHistory, fetchReconciliationHistory } from "@/lib/navigation/reconciliation-history-pages";

const scope = "a".repeat(64);
const row = (id = "syntheticrun000001") => ({ period: "2026-09-17", runId: id, matched: 10, explained: 2, unresolved: 1, rate: "76.92%" });
const page = { rows: [row()], view: "daily", total: 1, page: 1, pageSize: 100, pageCount: 1, snapshot: "b".repeat(32) };
const response = (body: unknown = page, status = 200, responseScope: string | null = scope) => new Response(JSON.stringify(body), {
  status, headers: responseScope === null ? {} : { "X-AOA-Navigation-Scope": responseScope },
});

describe("Reconciliation history paging contracts", () => {
  it("keeps the default route blank and history selection explicit", () => {
    expect(reconciliationNavigation(new URLSearchParams())).toEqual({ tab: "current", history: "daily" });
    expect(reconciliationHref({ tab: "history", history: "monthly" })).toBe("/operations/trade-reconciliation?tab=history&history=monthly");
  });
  it.each(["page=0", "page=2", "page=1000001", "page=1&page=2", "pageSize=10000", "view=all", "snapshot=invalid", "email=other@example.test"])("rejects unbounded or ambiguous query %s", (query) => {
    expect(() => parseReconciliationHistoryQuery(new URLSearchParams(query))).toThrow();
  });
  it("accepts an explicit subsequent page only with the content snapshot", () => {
    expect(parseReconciliationHistoryQuery(new URLSearchParams(`view=quarterly&page=3&snapshot=${page.snapshot}`))).toEqual({ view: "quarterly", page: 3, snapshot: page.snapshot });
  });
  it("rejects duplicate appends rather than hiding missing rows", () => {
    expect(() => appendReconciliationHistory([row()], [row()], "daily")).toThrow("changed");
    expect(appendReconciliationHistory([row()], [row("syntheticrun000002")], "daily")).toHaveLength(2);
  });
  it("reads saved history through a no-store same-origin request", async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    await expect(fetchReconciliationHistory("daily", 1, null, new AbortController().signal, scope, fetcher)).resolves.toEqual(page);
    expect(fetcher).toHaveBeenCalledWith("/api/operations/trade-reconciliation/history?view=daily&page=1", expect.objectContaining({ cache: "no-store", credentials: "same-origin", redirect: "error" }));
  });
  it.each(["N/A", "Unavailable", "100.00%", "99.99%"])("accepts explicit directional rate %s", async (rate) => {
    const body = { ...page, rows: [{ ...row(), rate }] };
    await expect(fetchReconciliationHistory("daily", 1, null, new AbortController().signal, scope, vi.fn().mockResolvedValue(response(body)))).resolves.toEqual(body);
  });
  it.each(["100.01%", "NaN%", "-1.00%"])("rejects invalid rate %s", async (rate) => {
    const body = { ...page, rows: [{ ...row(), rate }] };
    await expect(fetchReconciliationHistory("daily", 1, null, new AbortController().signal, scope, vi.fn().mockResolvedValue(response(body)))).rejects.toThrow();
  });
  it.each([null, "c".repeat(64), "invalid"])("rejects missing or switched login scope before rows (%s)", async (responseScope) => {
    await expect(fetchReconciliationHistory("daily", 1, null, new AbortController().signal, scope, vi.fn().mockResolvedValue(response(page, 200, responseScope)))).rejects.toThrow("unauthorized");
  });
  it.each([401, 403, 409, 416, 503])("classifies API status %s", async (status) => {
    await expect(fetchReconciliationHistory("daily", 1, null, new AbortController().signal, scope, vi.fn().mockResolvedValue(response({}, status)))).rejects.toThrow([401, 403].includes(status) ? "unauthorized" : [409, 416].includes(status) ? "changed" : "unavailable");
  });
  it("rejects a short page that claims more rows", async () => {
    await expect(fetchReconciliationHistory("daily", 1, null, new AbortController().signal, scope, vi.fn().mockResolvedValue(response({ ...page, total: 50 })))).rejects.toThrow("changed");
  });
});
