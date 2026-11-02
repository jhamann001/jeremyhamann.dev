import { describe, expect, it, vi } from "vitest";
import { importThenReload } from "@/components/asset-mapping/workspace/on-demand-import";
import { initialWorkspaceState, workspaceReducer, type WorkspaceState } from "@/components/asset-mapping/workspace/workspace-model";
import { performConfirm, performEdit, type EditActions, type EditDeps } from "@/components/asset-mapping/workspace/edits/run-edit";
import { performScan, type DocumentsDeps } from "@/components/asset-mapping/workspace/documents/run-documents";
import type { AssetMapHouseholdView, AssetMapHouseholdLiveExtras, AssetMapRunSummary } from "@/lib/data/asset-map";

const household = (id: string, clientName: string) => ({ id, clientName, accounts: [] }) as unknown as AssetMapHouseholdView;
const extras = (note: string) => ({ rolloverNotes: { a1: note }, docResults: [], review: null }) as unknown as AssetMapHouseholdLiveExtras;
const run = (id: string, clientName = "Synthetic Client") => ({ id, clientName }) as unknown as AssetMapRunSummary;

function openOn(id: string): WorkspaceState {
  let s = workspaceReducer(initialWorkspaceState(id), { type: "listLoaded", runs: [run("r-new"), run(id)] });
  s = workspaceReducer(s, { type: "householdLoading" });
  s = workspaceReducer(s, { type: "householdLoaded", household: household(id, "Before") });
  s = workspaceReducer(s, { type: "liveExtrasLoaded", extras: extras("before") });
  s = workspaceReducer(s, { type: "toggleAccount", id: "a1" });
  return workspaceReducer(s, { type: "setView", view: "client-service" });
}

describe("importThenReload (ticket)", () => {
  it("runs the import, then reloads (WO-AC-5, WO-AC-6)", async () => {
    const order: string[] = [];
    const ok = await importThenReload({
      runImport: async () => { order.push("import"); return { ok: true }; },
      reload: async () => { order.push("reload"); },
    });
    expect(ok).toBe(true);
    expect(order).toEqual(["import", "reload"]);
  });

  it.each([
    ["fails", async () => ({ ok: false })],
    ["throws", async () => { throw new Error("synthetic"); }],
  ])("reloads nothing when the import %s, so the current data stays (WO-AC-11)", async (_label, runImport) => {
    const reload = vi.fn(async () => {});
    expect(await importThenReload({ runImport, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("in-place refresh in the workspace reducer (ticket)", () => {
  it("replaces the open household and keeps the run, view, and collapsed rows (WO-AC-9, WO-AC-10)", () => {
    const before = openOn("r-old");
    const after = workspaceReducer(before, { type: "householdRefreshed", id: "r-old", household: household("r-old", "After"), extras: extras("after") });
    expect(after.household?.clientName).toBe("After");
    expect(after.liveExtras?.rolloverNotes.a1).toBe("after");
    expect(after.selectedId).toBe("r-old");
    expect(after.householdStatus).toBe("loaded");
    expect(after.view).toBe("client-service");
    expect(after.collapsedAccounts).toEqual(["a1"]);
  });

  it("keeps the current extras when the refreshed extras did not load", () => {
    const after = workspaceReducer(openOn("r-old"), { type: "householdRefreshed", id: "r-old", household: household("r-old", "After"), extras: null });
    expect(after.liveExtras?.rolloverNotes.a1).toBe("before");
  });

  it("ignores a refresh for a run the user has since left (WO-AC-10)", () => {
    const moved = workspaceReducer(openOn("r-old"), { type: "selectRun", id: "r-new" });
    expect(workspaceReducer(moved, { type: "householdRefreshed", id: "r-old", household: household("r-old", "After"), extras: null })).toBe(moved);
  });

  it("a list refresh adds the newer run without loading or moving the selection (WO-AC-10)", () => {
    const before = openOn("r-old");
    const after = workspaceReducer(before, { type: "listRefreshed", runs: [run("r-newest"), run("r-new"), run("r-old")] });
    expect(after.listStatus).toBe("loaded");
    expect(after.selectedId).toBe("r-old");
    expect(after.household).toBe(before.household);
    expect(after.runs.map((r) => r.id)).toEqual(["r-newest", "r-new", "r-old"]);
  });
});

function editDeps(actions: Partial<EditActions>, onAccountTypeSaved?: () => void) {
  const events: string[] = [];
  const deps: EditDeps = {
    actions: actions as EditActions,
    dispatch: (a) => events.push(a.type),
    nextSeq: () => 1,
    schedule: () => {},
    onAccountTypeSaved: onAccountTypeSaved && (() => { events.push("onAccountTypeSaved"); onAccountTypeSaved(); }),
  };
  return { deps, events };
}

describe("save-triggered import (ticket)", () => {
  it("calls back only after a confirmed account-type save (WO-AC-6)", async () => {
    const saved = vi.fn();
    const { deps, events } = editDeps({ saveAccountType: async () => ({ ok: true, data: { accountType: "IRA", accountTypeOther: null } }) }, saved);
    await performConfirm({ kind: "accountType", accountId: "a1", from: "Individual", accountType: "IRA", accountTypeOther: null } as never, deps);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(events.slice(-2)).toEqual(["accountTypeSaved", "onAccountTypeSaved"]);
  });

  it("does not call back when the save fails or for other edits", async () => {
    const saved = vi.fn();
    const failed = editDeps({ saveAccountType: async () => ({ ok: false, reason: "unavailable" }) }, saved);
    await performEdit({ kind: "accountType", accountId: "a1", accountType: "IRA", accountTypeOther: null }, failed.deps);
    const status = editDeps({ saveStatus: async () => ({ ok: true, data: { status: "ACAT" } }) } as Partial<EditActions>, saved);
    await performEdit({ kind: "positionStatus", positionId: "p1", status: "ACAT" } as never, status.deps);
    expect(saved).not.toHaveBeenCalled();
  });

  it("a save with no callback (flag off) behaves as before (WO-AC-7)", async () => {
    const { deps, events } = editDeps({ saveAccountType: async () => ({ ok: true, data: { accountType: "IRA", accountTypeOther: null } }) });
    await performEdit({ kind: "accountType", accountId: "a1", accountType: "IRA", accountTypeOther: null }, deps);
    expect(events).toEqual(["pending", "accountTypeSaved"]);
  });
});

describe("scan-triggered import ordering (ticket)", () => {
  function docDeps(scan: DocumentsDeps["client"]["scan"]): DocumentsDeps {
    return {
      client: { householdPdf: vi.fn(), allClientsPdf: vi.fn(), saveToDrive: vi.fn(), scan },
      dispatch: () => {},
      schedule: () => () => {},
      scanClear: { cancel: null },
      download: () => {},
    };
  }

  it("starts the import only after the scan response has arrived (WO-AC-4)", async () => {
    const order: string[] = [];
    let respond!: () => void;
    const responded = new Promise<void>((resolve) => { respond = resolve; });
    const scanning = performScan(() => order.push("import"), docDeps(async () => {
      await responded;
      order.push("scan response");
      return { kind: "finished", clientsProcessed: 2 };
    }));
    await Promise.resolve();
    expect(order).toEqual([]);
    respond();
    await scanning;
    expect(order).toEqual(["scan response", "import"]);
  });

  it.each([{ kind: "busy" }, { kind: "forbidden" }, { kind: "failed", status: 500, detail: null }] as const)("starts no import when the scan ends $kind", async (result) => {
    const onFinished = vi.fn();
    await performScan(onFinished, docDeps(async () => result));
    expect(onFinished).not.toHaveBeenCalled();
  });
});
