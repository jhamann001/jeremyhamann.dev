import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { appendWindowRows, fetchWindowPage, rebuildWindowPage, parseWindowPageParams, type WindowPage } from "@/lib/navigation/window-page";
import { WindowListControls } from "@/components/navigation/WindowListControls";

const scope = "a".repeat(64);
const oldSnapshot = "b".repeat(64);
const snapshot = "c".repeat(64);
const rows = Array.from({ length: 100 }, (_, index) => ({ id: `synthetic-${index + 1}` }));
const initial: WindowPage<{ id: string }, object> = {
  rows, firstPage: 1, pageSize: 100, loaded: 100, snapshot, hasMore: true, meta: {},
};
const response = (value: unknown, status = 200, responseScope: string | null = scope) => Response.json(value, {
  status, headers: responseScope === null ? {} : { "X-AOA-Navigation-Scope": responseScope },
});
const fetchPage = (fetcher: typeof fetch, loaded = 0, prior: string | null = null, endpoint = "/api/navigation/audit/rows") =>
  fetchWindowPage(endpoint, 1, 100, loaded, prior, new AbortController().signal, scope, "id", fetcher);

describe("bounded window request contract", () => {
  it("starts a fresh, uncached window without a prior snapshot", () => {
    expect(parseWindowPageParams(new URLSearchParams())).toEqual({ firstPage: 1, pageSize: 100, loaded: 0, snapshot: null });
    expect(parseWindowPageParams(new URLSearchParams(`page=51&pageSize=200&loaded=200&snapshot=${snapshot}`)))
      .toEqual({ firstPage: 51, pageSize: 200, loaded: 200, snapshot });
    expect(parseWindowPageParams(new URLSearchParams("page=26&pageSize=200&restoreRows=5000")))
      .toEqual({ firstPage: 26, pageSize: 200, loaded: 0, snapshot: null, restoreRows: 5000 });
  });
  it.each(["page=0", "page=01", "page=1000001", "page=1&page=2", "loaded=-1", "loaded=5001", "loaded=0&loaded=0",
    `loaded=101&snapshot=${snapshot}`, `loaded=5000&snapshot=${snapshot}`, `pageSize=200&loaded=4900&snapshot=${snapshot}`,
    `loaded=100&snapshot=${"a".repeat(32)}`,
    "pageSize=99", "pageSize=150", "pageSize=201", "pageSize=1e2", "loaded=100", `snapshot=${snapshot}`, `loaded=100&snapshot=${snapshot}&snapshot=${snapshot}`,
    "restoreRows=0", "restoreRows=99", "restoreRows=101", "restoreRows=5001", "restoreRows=1e3", "restoreRows=100&restoreRows=100",
    "pageSize=200&restoreRows=100", "pageSize=200&restoreRows=300", `loaded=100&snapshot=${snapshot}&restoreRows=5000`])
    ("rejects ambiguous or unbound metadata: %s", query => {
      expect(() => parseWindowPageParams(new URLSearchParams(query))).toThrow();
    });
  it.each(["/api/navigation/audit/rows", "/api/navigation/crm/window", "/api/navigation/crm-duplicates/window"])
    ("reads only an allowlisted window endpoint: %s", async endpoint => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(initial));
      expect(await fetchPage(fetcher, 0, null, `${endpoint}?q=synthetic`)).toEqual(initial);
      const [url, options] = fetcher.mock.calls[0];
      expect(String(url)).toContain("q=synthetic");
      expect(String(url)).toContain("loaded=0");
      expect(String(url)).not.toContain("restoreRows");
      expect(options).toMatchObject({ cache: "no-store", credentials: "same-origin", redirect: "error" });
    });
  it.each(["https://outside.test/api/navigation/audit/rows", "//outside.test/api/navigation/crm/window", "/api/navigation/clients",
    "/api/navigation/audit/rows#fragment", "/api/navigation/audit/rows/extra"])("rejects unsupported transport target %s", async endpoint => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(fetchPage(fetcher, 0, null, endpoint)).rejects.toMatchObject({ kind: "changed" });
      expect(fetcher).not.toHaveBeenCalled();
    });
});

describe("bounded window response validation", () => {
  it("uses the advanced prefix snapshot and returns only the next chunk", async () => {
    const next = { ...initial, loaded: 200 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(next));
    expect(await fetchPage(fetcher, 100, oldSnapshot)).toEqual(next);
    expect(String(fetcher.mock.calls[0][0])).toContain(`loaded=100&snapshot=${oldSnapshot}`);
  });
  it("allows a final short chunk or an empty initial population without inventing a total", async () => {
    for (const final of [{ ...initial, rows: rows.slice(0, 3), loaded: 3, hasMore: false },
      { ...initial, rows: [], loaded: 0, hasMore: false }]) {
      expect(await fetchPage(vi.fn<typeof fetch>().mockResolvedValue(response(final)))).toEqual(final);
    }
  });
  it.each([
    { firstPage: 2 }, { pageSize: 200 }, { loaded: 99 }, { loaded: 5001 }, { hasMore: "true" },
    { rows: rows.slice(0, 99) }, { rows: [...rows, { id: "extra" }], loaded: 101 },
    { rows: rows.map(() => ({ id: "duplicate" })) }, { snapshot: "not-a-digest" }, { snapshot: "a".repeat(32) }, { meta: null }, { meta: [] },
  ])("fails closed for an invalid chunk envelope %j", async change => {
    await expect(fetchPage(vi.fn<typeof fetch>().mockResolvedValue(response({ ...initial, ...change })))).rejects.toMatchObject({ kind: "changed" });
  });
  it("rejects a nonadvancing fingerprint after appending records", async () => {
    await expect(fetchPage(vi.fn<typeof fetch>().mockResolvedValue(response({ ...initial, loaded: 200, snapshot: oldSnapshot })), 100, oldSnapshot))
      .rejects.toMatchObject({ kind: "changed" });
  });
  it("validates scope before inspecting a successful payload", async () => {
    const json = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ "X-AOA-Navigation-Scope": oldSnapshot }), json });
    await expect(fetchPage(fetcher)).rejects.toMatchObject({ kind: "unauthorized" });
    expect(json).not.toHaveBeenCalled();
  });
  it.each([[401, "unauthorized"], [403, "unauthorized"], [404, "unauthorized"], [409, "changed"], [416, "changed"], [503, "unavailable"]])
    ("classifies HTTP %s without exposing its body", async (status, kind) => {
      await expect(fetchPage(vi.fn<typeof fetch>().mockResolvedValue(response({ private: "not rendered" }, status as number))))
        .rejects.toMatchObject({ kind });
    });
  it("cannot append duplicates across chunks", () => {
    expect(() => appendWindowRows(rows, [{ id: rows[0].id }], "id")).toThrow("changed");
    expect(appendWindowRows(rows, [{ id: "next" }], "id")).toHaveLength(101);
  });
  it("does not dispatch an already-aborted read", async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(fetchWindowPage("/api/navigation/crm/window", 1, 100, 0, null, controller.signal, scope, "id", fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("truthful window navigation and restoration", () => {
  it("rebuilds remembered pages in one fresh bounded read with no prior snapshot", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      const query = new URL(String(input), "https://synthetic.test").searchParams;
      expect(query.get("loaded")).toBe("0"); expect(query.get("snapshot")).toBeNull();
      expect(query.get("restoreRows")).toBe("300");
      return response({ ...initial, rows: Array.from({ length: 300 }, (_, i) => ({ id: `row-${i}` })), loaded: 300 });
    });
    const rebuilt = await rebuildWindowPage("/api/navigation/crm/window", 1, 100, 3, new AbortController().signal, scope, "id", fetcher);
    expect(rebuilt.loaded).toBe(300); expect(rebuilt.rows).toHaveLength(300);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("stops restoration at the current end or fixed window cap", async () => {
    const ended = vi.fn<typeof fetch>().mockResolvedValue(response({ ...initial, hasMore: false }));
    expect((await rebuildWindowPage("/api/navigation/audit/rows", 1, 100, 50, new AbortController().signal, scope, "id", ended)).loaded).toBe(100);
    expect(ended).toHaveBeenCalledTimes(1);
    const full = vi.fn<typeof fetch>().mockImplementation(async input => {
      const query = new URL(String(input), "https://synthetic.test").searchParams;
      expect(query.get("loaded")).toBe("0"); expect(query.get("snapshot")).toBeNull();
      expect(query.get("restoreRows")).toBe("5000");
      return response({ ...initial, rows: Array.from({ length: 5000 }, (_, i) => ({ id: `row-${i}` })), loaded: 5000 });
    });
    const capped = await rebuildWindowPage("/api/navigation/audit/rows", 1, 100, 100, new AbortController().signal, scope, "id", full);
    expect(capped.loaded).toBe(5000); expect(capped.hasMore).toBe(true); expect(full).toHaveBeenCalledTimes(1);
  });
  it("preserves a 200-row numbered window when restoring once at the cap", async () => {
    const result = { ...initial, firstPage: 26, pageSize: 200, loaded: 5000,
      rows: Array.from({ length: 5000 }, (_, i) => ({ id: `row-${i}` })) };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(result));
    expect(await rebuildWindowPage("/api/navigation/crm/window", 26, 200, 30, new AbortController().signal, scope, "id", fetcher)).toEqual(result);
    const query = new URL(String(fetcher.mock.calls[0][0]), "https://synthetic.test").searchParams;
    expect(query.get("page")).toBe("26"); expect(query.get("pageSize")).toBe("200");
    expect(query.get("restoreRows")).toBe("5000"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("accepts a shortened current population, but not an incomplete nonterminal restore", async () => {
    const terminal = { ...initial, rows: Array.from({ length: 205 }, (_, i) => ({ id: `row-${i}` })), loaded: 205, hasMore: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(terminal));
    expect(await rebuildWindowPage("/api/navigation/crm/window", 1, 100, 3, new AbortController().signal, scope, "id", fetcher)).toEqual(terminal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(rebuildWindowPage("/api/navigation/crm/window", 1, 100, 3, new AbortController().signal, scope, "id",
      vi.fn<typeof fetch>().mockResolvedValue(response({ ...terminal, hasMore: true })))).rejects.toMatchObject({ kind: "changed" });
  });
  it("rejects duplicate IDs anywhere in the freshly restored window", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ...initial, rows: [...rows, ...rows], loaded: 200 }));
    await expect(rebuildWindowPage("/api/navigation/crm/window", 1, 100, 2, new AbortController().signal, scope, "id", fetcher))
      .rejects.toMatchObject({ kind: "changed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([[401, "unauthorized"], [403, "unauthorized"], [409, "changed"]])("does not return or retry a failed restore (HTTP %s)", async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, status as number));
    await expect(rebuildWindowPage("/api/navigation/crm/window", 1, 100, 3, new AbortController().signal, scope, "id", fetcher))
      .rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects restored rows under a different authorization scope before reading them", async () => {
    const json = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ "X-AOA-Navigation-Scope": oldSnapshot }), json });
    await expect(rebuildWindowPage("/api/navigation/crm/window", 1, 100, 50, new AbortController().signal, scope, "id", fetcher))
      .rejects.toMatchObject({ kind: "unauthorized" });
    expect(json).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  function render(options: { page?: WindowPage<{ id: string }, object>; state?: "idle" | "restoring" | "changed" | "error";
    total?: number; totalState?: "loading" | "available" | "unavailable" | "not_requested" } = {}) {
    const page = options.page ?? initial;
    return renderToStaticMarkup(createElement(WindowListControls, {
      label: "Field changes", href: "/audit-log?view=changes", total: options.total, totalState: options.totalState,
      state: { page, lastPage: 1, loadState: options.state ?? "idle", ready: true, notice: "",
        canLoadMore: page.hasMore && page.loaded < 5000, sentinelRef: { current: null }, loadMore() {}, retry() {} },
    }));
  }
  it("renders loaded rows independently of unavailable totals", () => {
    expect(render()).toContain("Total loading");
    expect(render({ totalState: "unavailable" })).toContain("Total unavailable");
    expect(render()).not.toContain("of 0");
    expect(render({ total: 205 })).toContain("205");
  });
  it("does not imply a missing total is loading when this view requests none", () => {
    const markup = render({ totalState: "not_requested" });
    expect(markup).toContain("Showing");
    expect(markup).not.toMatch(/Total loading|Total unavailable|of 0/);
    expect(render()).toContain("Total loading"); // Other consumers keep their existing default.
  });
  it("does not show a stale range or total while rebuilding or invalidated", () => {
    for (const state of ["restoring", "changed"] as const) {
      const markup = render({ state, total: 205 });
      expect(markup).not.toContain("Showing"); expect(markup).not.toContain("205");
    }
  });
  it("uses an exact next numbered window at the cap, not a false end of results", () => {
    const markup = render({ page: { ...initial, firstPage: 51, loaded: 5000,
      rows: Array.from({ length: 5000 }, (_, i) => ({ id: `row-${i}` })) } });
    expect(markup).toContain("page=101"); expect(markup).toContain("Continue to the next results window");
    expect(markup).not.toContain("End of results");
    const larger = render({ page: { ...initial, firstPage: 26, pageSize: 200, loaded: 5000,
      rows: Array.from({ length: 5000 }, (_, i) => ({ id: `row-${i}` })) } });
    // The public SSR route uses100rows, so both windows advance to offset10000.
    expect(larger).toContain("page=101");
  });
  it("offers an actual first-page link when a numbered window is now empty", () => {
    const markup = render({ page: { ...initial, firstPage: 51, loaded: 0, rows: [], hasMore: false } });
    expect(markup).toContain("Return to the first results");
    expect(markup).toContain('href="/audit-log?view=changes"');
    expect(markup).not.toContain("page=51");
  });
  it("separately preserves fresh bounded restoration and metadata-only navigation", () => {
    const source = readFileSync("components/navigation/useWindowList.ts", "utf8");
    expect(source).toContain("rebuildWindowPage<Row, Meta>(endpoint, entry.firstPage");
    expect(source).not.toContain("Promise.all");
    expect(source).toContain("getBrowserListNavigationMemory()?.clear(scope)");
    expect(source).toContain("getBrowserListNavigationMemory()?.forget(scope, href");
    expect(source).toContain("scopeChanged");
    expect(source).not.toContain("localStorage");
  });
});
