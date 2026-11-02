import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { safeListHref, safeDetailHref } from "@/lib/navigation/list-routes";
import { createListNavigationMemory } from "@/lib/navigation/list-memory";
import { fetchProgressivePage, appendProgressiveRows } from "@/lib/navigation/progressive-page";
import { ProgressiveListControls } from "@/components/navigation/ProgressiveListControls";

const scope = "a".repeat(64);
const page = { rows: [{ id: "synthetic:1" }], page: 1, pageSize: 100, total: 1, pageCount: 1, snapshot: "b".repeat(32), meta: {} };
const position = { firstPage: 1, lastPage: 2, anchorId: "synthetic:1", anchorOffset: -12, scrollTop: 120, expandedIds: ["synthetic:1"] };

describe("shared navigation boundaries", () => {
  it.each(["/client-portrait?q=Invented+Person", "/crm?duplicates=potential", "/audit-log?view=changes&table=deal", "/deals?stage=WON"])("accepts scoped list metadata for %s", href => {
    expect(safeListHref(href)).not.toBeNull();
  });
  it.each(["/crm/../login", "//outside.test/crm", "/crm?returnTo=/admin", "/audit-log?actor=one&actor=two", "/client-portrait?q=%00"])("rejects unrelated/ambiguous href %s", href => {
    expect(safeListHref(href)).toBeNull();
  });
  it("keeps independent Audit view state, expires it and never retains row payloads", () => {
    let now = 100;
    const memory = createListNavigationMemory({ now: () => now, ttlMs: 100 });
    memory.setScope(scope);
    const source = { ...position, rows: [{ private: "record" }] };
    memory.save(scope, "/audit-log?action=synthetic", source);
    memory.save(scope, "/audit-log?view=changes&table=deal", { ...position, lastPage: 3 });
    expect(memory.latest(scope, "/audit-log", { view: "" })?.href).toBe("/audit-log?action=synthetic");
    expect(memory.latest(scope, "/audit-log", { view: "changes" })?.lastPage).toBe(3);
    expect(memory.latest(scope, "/audit-log", { view: "changes" })).not.toHaveProperty("rows");
    expect(memory.rememberReturn(scope, "/deals/synthetic", "/audit-log?view=changes&table=deal")).toBe(true);
    expect(memory.returnHref(scope, "/deals/synthetic")).toBe("/audit-log?table=deal&view=changes");
    expect(safeDetailHref("/deals/synthetic?secret=x")).toBeNull();
    now = 200;
    expect(memory.latest(scope, "/audit-log", { view: "changes" })).toBeNull();
  });
  it("does not silently deduplicate overlapping pages or accept unsafe row anchors", () => {
    expect(() => appendProgressiveRows(page.rows, page.rows, "id")).toThrow("changed");
    expect(() => appendProgressiveRows([], [{ id: "<private>" }], "id")).toThrow("changed");
  });
  it("checks scope before decoding a successful response", async () => {
    const json = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ "X-AOA-Navigation-Scope": "c".repeat(64) }), json });
    await expect(fetchProgressivePage("/api/navigation/clients", 1, 100, null, new AbortController().signal, scope, "id", fetcher)).rejects.toMatchObject({ kind: "unauthorized" });
    expect(json).not.toHaveBeenCalled();
  });
  it("validates the envelope and requests private same-origin reads", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(page, { headers: { "X-AOA-Navigation-Scope": scope } }));
    expect(await fetchProgressivePage("/api/navigation/clients?q=Synthetic", 1, 100, null, new AbortController().signal, scope, "id", fetcher)).toEqual(page);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "same-origin", redirect: "error" });
  });
});

describe("truthful progressive state labels", () => {
  const render = (loadState: "idle" | "restoring" | "error" | "changed", rows = page.rows) => renderToStaticMarkup(createElement(ProgressiveListControls, {
    label: "Clients", href: "/client-portrait", state: { page: { ...page, rows }, loadState, ready: true,
      lastPage: 1, canLoadMore: false, notice: "", sentinelRef: { current: null }, loadMore() {}, retry() {} },
  }));
  it("does not invent a range during restoration or a cleared stale sequence", () => {
    expect(render("restoring", [])).toContain("Restoring your place");
    expect(render("restoring", [])).not.toContain("Showing");
    expect(render("changed", [])).not.toContain("Showing");
  });
  it("distinguishes a cleared restore failure from an append failure", () => {
    expect(render("error", [])).toContain("could not be restored");
    expect(render("error", [])).not.toContain("current rows are still here");
    expect(render("error")).toContain("current rows are still here");
  });
});
