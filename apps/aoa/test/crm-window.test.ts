import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { buildCrmWindow, crmWindowLimit } from "@/lib/data/crm-window";
import { parseCrmWindowRequest } from "@/lib/navigation/crm-window-query";

const request = { firstPage: 1, pageSize: 100, loaded: 0, snapshot: null };
const rows = Array.from({ length: 205 }, (_, n) => ({ id: `row-${n}`, name: `Invented ${n}`, mappings: [{ displayName: "Invented", mappingState: "ACTIVE" }] }));

describe("CRM loaded-window validation", () => {
  it("advances snapshots while returning only the next chunk and fresh exact metadata", () => {
    const first = buildCrmWindow(request, rows.slice(0, 100), 205, ["filter"], { total: 205 });
    const second = buildCrmWindow({ ...request, loaded: 100, snapshot: first.snapshot }, rows.slice(0, 200), 206, ["filter"], { total: 206 });
    expect(second.rows).toEqual(rows.slice(100, 200));
    expect(second.loaded).toBe(200);
    expect(second.snapshot).not.toBe(first.snapshot);
    expect(second.meta.total).toBe(206);
    expect(second.hasMore).toBe(true);
  });
  it("detects full rendered-label edits, removals, reorders and changed filters in the loaded prefix", () => {
    const first = buildCrmWindow(request, rows.slice(0, 100), 205, ["filter"], {});
    const next = { ...request, loaded: 100, snapshot: first.snapshot };
    const edited = structuredClone(rows.slice(0, 200)); edited[0].mappings[0].displayName = "Changed";
    const reordered = rows.slice(0, 200); [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    for (const changed of [edited, reordered, rows.slice(1, 201), rows.slice(0, 99)]) {
      expect(() => buildCrmWindow(next, changed, 205, ["filter"], {})).toThrow("changed");
    }
    expect(() => buildCrmWindow(next, rows.slice(0, 200), 205, ["other-filter"], {})).toThrow("changed");
    const unseenEdit = structuredClone(rows.slice(0, 200)); unseenEdit[150].name = "Fresh unseen label";
    expect(buildCrmWindow(next, unseenEdit, 205, ["filter"], {}).rows[50].name).toBe("Fresh unseen label");
  });
  it("bounds arbitrary direct callers and retains explicit numbered-window identity", () => {
    expect(crmWindowLimit({ ...request, loaded: 4900, snapshot: "a".repeat(64) })).toBe(5000);
    for (const bad of [{ loaded: 100, snapshot: "a".repeat(32) }, { loaded: 5000, snapshot: "a".repeat(64) }, { loaded: 4950, snapshot: "a".repeat(64) }, { loaded: 5001 }, { loaded: -1 }, { pageSize: 150 }, { pageSize: 9999 }, { firstPage: 0 }, { loaded: 2 }, { snapshot: "a" }]) {
      expect(() => crmWindowLimit({ ...request, ...bad })).toThrow("changed");
    }
    const thirdPage = buildCrmWindow({ ...request, firstPage: 3 }, rows.slice(200), 205, [], {});
    expect(thirdPage).toMatchObject({ firstPage: 3, loaded: 5, hasMore: false });
  });
  it("restores one fresh bounded prefix and resumes normal continuation with the same digest contract", () => {
    const restored = buildCrmWindow({ ...request, restoreRows: 200 }, rows.slice(0, 200), 205, ["filter"], { total: 205 });
    expect(restored).toMatchObject({ rows: rows.slice(0, 200), pageSize: 100, loaded: 200, hasMore: true });
    const next = buildCrmWindow({ ...request, loaded: 200, snapshot: restored.snapshot }, rows, 205, ["filter"], { total: 205 });
    expect(next).toMatchObject({ rows: rows.slice(200), loaded: 205, hasMore: false });
    expect(crmWindowLimit({ ...request, restoreRows: 5000 })).toBe(5000);
    for (const restoreRows of [0, 99, 150, 5001, NaN, Infinity]) {
      expect(() => crmWindowLimit({ ...request, restoreRows })).toThrow("changed");
    }
    expect(() => crmWindowLimit({ ...request, loaded: 100, snapshot: "a".repeat(64), restoreRows: 200 })).toThrow("changed");
    expect(() => crmWindowLimit({ ...request, snapshot: "a".repeat(64), restoreRows: 200 })).toThrow("changed");
    expect(parseCrmWindowRequest(new URLSearchParams("q=abc&restoreRows=200"), false)).toMatchObject({
      window: { ...request, restoreRows: 200 }, filters: { query: "abc" },
    });
  });
  it.each(["restoreRows=0", "restoreRows=150", "restoreRows=5001", "restoreRows=100&restoreRows=200", `restoreRows=200&loaded=100&snapshot=${"a".repeat(64)}`])("rejects invalid restore parameters %s", query => {
    expect(() => parseCrmWindowRequest(new URLSearchParams(query), false)).toThrow();
  });
  it.each(["loaded=1", "loaded=0&snapshot=" + "a".repeat(64), "loaded=5001", "scope=ops", "loaded=1&loaded=2", "q=a&q=b", "type=invalid"])("rejects invalid new-route parameters %s", query => {
    expect(() => parseCrmWindowRequest(new URLSearchParams(query), false)).toThrow();
  });
});
