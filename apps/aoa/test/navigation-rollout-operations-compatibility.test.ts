import { describe, expect, it } from "vitest";
import { createListHistoryEntries } from "@/lib/navigation/history-entry";
import {
  createListNavigationMemory, currentListDetailHref, safeListDetailHref, safeListHref,
} from "@/lib/navigation/list-memory";
import { safeDetailHref, safeListHref as routeListHref } from "@/lib/navigation/list-routes";
import type { ScopedNavigationStorage } from "@/lib/navigation/session-storage";

const scope = "synthetic-integrated-scope";
const fees = "/operations/fee-requests";
const recon = "/operations/trade-reconciliation";
const position = { firstPage: 1, lastPage: 2, anchorId: "synthetic:row.1", anchorOffset: 5, scrollTop: 200 };

describe("integrated rollout and existing Operations navigation", () => {
  it.each([
    "/households?sort=aum", "/client-portrait?stage=prospect", "/crm?duplicates=potential",
    "/audit-log?view=changes", "/reporting?dataset=deal_pipeline", "/deals?archived=1",
    "/asset-transfer?completed=1", "/households/synthetic?list=tasks&tasksCompleted=1",
    `${fees}?tab=exceptions&status=PENDING`, `${recon}?tab=history&history=monthly`,
  ])("exposes the same bounded route vocabulary through both imports: %s", (href) => {
    expect(safeListHref(href)).not.toBeNull();
    expect(safeListHref(href)).toBe(routeListHref(href));
  });

  it("hydrates new and existing route metadata together without widening detail IDs", () => {
    let saved: unknown = null;
    const storage: ScopedNavigationStorage = {
      read: () => saved, write: (_scope, value) => { saved = value; return true; }, clear: () => { saved = null; },
    };
    const memory = createListNavigationMemory({ storage });
    memory.setScope(scope);
    const request = `${fees}?request=synthetic-request-01`;
    expect(memory.save(scope, `${fees}?tab=exceptions`, position, "a".repeat(32))).toBe(true);
    expect(memory.save(scope, "/crm?duplicates=potential", position, "b".repeat(32))).toBe(true);
    expect(memory.rememberReturn(scope, request, `${fees}?tab=exceptions`, "a".repeat(32))).toBe(true);
    expect(memory.rememberReturn(scope, "/crm/duplicates/synthetic", "/crm?duplicates=potential", "b".repeat(32))).toBe(true);
    const restored = createListNavigationMemory({ storage });
    restored.setScope(scope);
    expect(restored.read(scope, `${fees}?tab=exceptions`, "a".repeat(32))).toMatchObject(position);
    expect(restored.read(scope, "/crm?duplicates=potential", "b".repeat(32))).toMatchObject(position);
    expect(restored.returnHref(scope, request)).toBe(`${fees}?tab=exceptions`);
    expect(restored.returnHref(scope, "/crm/duplicates/synthetic")).toBe("/crm?duplicates=potential");
    expect(restored.save(scope, fees, position, "synthetic:entry")).toBe(false);
    expect(restored.save(scope, fees, position, "x".repeat(129))).toBe(false);
    expect(restored.save(scope, fees, position, "synthetic-entry\n")).toBe(false);
    expect(safeListDetailHref("/households/synthetic\n")).toBeNull();
    expect(safeDetailHref("/crm/synthetic\n")).toBeNull();
    const transient = `${request}&message=workflow-updated#request-synthetic-request-01`;
    expect(currentListDetailHref(transient)).toBe(request);
    expect(safeListDetailHref(transient)).toBeNull();
    expect(safeDetailHref(transient)).toBeNull();
    expect(restored.rememberReturn(scope, transient, `${fees}?tab=exceptions`, "a".repeat(32))).toBe(false);
  });

  it.each(["list-first", "detail-first"] as const)(
    "preserves a query-selected run's older origin with %s effect order",
    (order) => {
      let location = `${recon}?history=monthly&tab=history`;
      let state: Record<string, unknown> = { framework: "preserved" };
      let sequence = 0;
      const history = createListHistoryEntries({
        readState: () => state, replaceState: (next) => { state = next; },
        pathname: () => location.split("?")[0], href: () => location,
        randomToken: () => (++sequence).toString(16).padStart(32, "0"),
      });
      history.setScope(scope);
      const origin = { href: location, entryId: history.getEntryId(scope, location)! };
      const detail = `${recon}?run=synthetic-run`;
      const runList = `${detail}&tab=current`;
      location = runList; state = { framework: "first-run" };
      expect(history.getDetailReturnTarget(scope, detail, origin)).toEqual(origin);
      const firstRunEntry = history.getEntryId(scope, runList)!;
      const firstRunState = { ...state };

      location = `${recon}?history=daily&tab=history`; state = {};
      const newerOrigin = { href: location, entryId: history.getEntryId(scope, location)! };
      location = runList; state = {};
      expect(history.getDetailReturnTarget(scope, detail, newerOrigin)).toEqual(newerOrigin);
      const newerRunEntry = history.getEntryId(scope, runList)!;
      expect(newerRunEntry).not.toBe(firstRunEntry);
      // Native traversal captures the old occurrence before streamed framework
      // props copy the newer occurrence's state onto the mounted route.
      history.recordTraversal(firstRunState, location);
      const readList = () => expect(history.getEntryId(scope, runList, newerRunEntry)).toBe(firstRunEntry);
      const readDetail = () => expect(history.getDetailReturnTarget(scope, detail, newerOrigin)).toEqual(origin);
      if (order === "list-first") { readList(); readDetail(); }
      else { readDetail(); readList(); }
      expect(history.getDetailReturnTarget(scope, `${recon}?run=other-run`, newerOrigin)).toBeNull();
    },
  );
});
