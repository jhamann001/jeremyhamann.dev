import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  enabled: vi.fn(),
  scope: vi.fn(),
  baseUrl: vi.fn(),
  list: vi.fn(),
  household: vi.fn(),
  offset: vi.fn(),
  schedule: vi.fn(),
  extras: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({ assetMappingReadEnabled: m.enabled }));
vi.mock("@/lib/rls", () => ({ withUserScope: m.scope }));
vi.mock("@/lib/data/asset-map", () => ({
  assetMapBaseUrl: m.baseUrl,
  readAssetMapHouseholdList: m.list,
  readAssetMapHousehold: m.household,
  readAssetMapBulkOffset: m.offset,
  fetchAssetMapScheduleStatus: m.schedule,
  fetchAssetMapHouseholdLiveExtras: m.extras,
}));
vi.mock("@/lib/data/asset-map-write-through", () => ({ writeThroughAssetMapEdit: vi.fn() }));
vi.mock("@/lib/data/asset-map-destinations", () => ({}));

import {
  loadAssetMapHousehold,
  loadAssetMapHouseholdList,
  loadAssetMapHouseholdLiveExtras,
  loadAssetMapSchedule,
} from "@/app/(authenticated)/asset-mapping/actions";
import { ASSET_MAP_WORKSPACE_SCOPE } from "@/lib/data/asset-map-workspace-scope";

const BASE = "https://pipeline.example.test";
const tx = { synthetic: "tx" };
const SCHEDULE = { active: true, scanIntervalMinutes: 15, businessDays: "Mon–Fri", businessHours: "8:00 AM – 7:00 PM ET" };

function signIn(role: string) {
  m.auth.mockResolvedValue({ user: { role, email: "synthetic@example.invalid" } });
}

beforeEach(() => {
  vi.resetAllMocks();
  m.enabled.mockReturnValue(true);
  signIn("OPERATIONS");
  m.baseUrl.mockReturnValue(BASE);
  m.scope.mockImplementation(async (_identity, callback) => callback(tx));
});

describe("asset-mapping read actions", () => {
  it("list action returns not_found without opening a scope when the flag is off", async () => {
    m.enabled.mockReturnValue(false);
    expect(await loadAssetMapHouseholdList()).toEqual({ ok: false, reason: "not_found" });
    expect(m.scope).not.toHaveBeenCalled();
  });

  it("household action returns not_found without opening a scope when the flag is off", async () => {
    m.enabled.mockReturnValue(false);
    expect(await loadAssetMapHousehold("hh-1")).toEqual({ ok: false, reason: "not_found" });
    expect(m.scope).not.toHaveBeenCalled();
  });

  it("schedule action returns not_found without a pipeline call when the flag is off", async () => {
    m.enabled.mockReturnValue(false);
    expect(await loadAssetMapSchedule()).toEqual({ ok: false, reason: "not_found" });
    expect(m.schedule).not.toHaveBeenCalled();
  });

  it("live extras action returns not_found without a pipeline call when the flag is off", async () => {
    m.enabled.mockReturnValue(false);
    expect(await loadAssetMapHouseholdLiveExtras("hh-1")).toEqual({ ok: false, reason: "not_found" });
    expect(m.scope).not.toHaveBeenCalled();
    expect(m.extras).not.toHaveBeenCalled();
  });

  it("every read returns not_found without a scope or pipeline call for VIEWER when the flag is on (ticket)", async () => {
    signIn("VIEWER");
    expect(await loadAssetMapHouseholdList()).toEqual({ ok: false, reason: "not_found" });
    expect(await loadAssetMapHousehold("hh-1")).toEqual({ ok: false, reason: "not_found" });
    expect(await loadAssetMapSchedule()).toEqual({ ok: false, reason: "not_found" });
    expect(await loadAssetMapHouseholdLiveExtras("hh-1")).toEqual({ ok: false, reason: "not_found" });
    expect(m.scope).not.toHaveBeenCalled();
    expect(m.schedule).not.toHaveBeenCalled();
    expect(m.extras).not.toHaveBeenCalled();
  });

  it.each(["ADVISOR", "CLIENT_SERVICE"])("%s reads the list, household, schedule and live extras in the workspace scope (ticket)", async (role) => {
    signIn(role);
    const identity = { role, email: "synthetic@example.invalid" };
    m.list.mockResolvedValue([{ id: "hh-1" }]);
    m.household.mockResolvedValue({ id: "hh-1", accounts: [] });
    m.schedule.mockResolvedValue(SCHEDULE);
    m.offset.mockResolvedValue(3);
    m.extras.mockResolvedValue({ docResults: [], rolloverNotes: {} });
    expect(await loadAssetMapHouseholdList()).toEqual({ ok: true, data: [{ id: "hh-1" }] });
    expect(await loadAssetMapHousehold("hh-1")).toEqual({ ok: true, data: { id: "hh-1", accounts: [] } });
    expect(await loadAssetMapSchedule()).toEqual({ ok: true, data: SCHEDULE });
    expect(await loadAssetMapHouseholdLiveExtras("hh-1")).toEqual({ ok: true, data: { docResults: [], rolloverNotes: {} } });
    expect(m.scope).toHaveBeenCalledTimes(3);
    for (const call of m.scope.mock.calls) expect(call).toEqual([identity, expect.any(Function), ASSET_MAP_WORKSPACE_SCOPE]);
  });

  it("the workspace scope sets app.asset_map_scope to 'workspace' for this transaction only", () => {
    const sql = ASSET_MAP_WORKSPACE_SCOPE.initialSettingsSql!;
    expect(sql.sql).toBe(", set_config('app.asset_map_scope', 'workspace', true)");
    expect(sql.values).toEqual([]);
  });

  it("list action reads inside the session user scope for OPERATIONS when the flag is on", async () => {
    const runs = [{ id: "hh-1" }];
    m.list.mockResolvedValue(runs);
    expect(await loadAssetMapHouseholdList()).toEqual({ ok: true, data: runs });
    expect(m.scope).toHaveBeenCalledWith({ role: "OPERATIONS", email: "synthetic@example.invalid" }, expect.any(Function), ASSET_MAP_WORKSPACE_SCOPE);
    expect(m.list).toHaveBeenCalledWith(tx);
  });

  it("household action returns the household for OPERATIONS when the flag is on", async () => {
    const view = { id: "hh-1", accounts: [] };
    m.household.mockResolvedValue(view);
    expect(await loadAssetMapHousehold("hh-1")).toEqual({ ok: true, data: view });
    expect(m.household).toHaveBeenCalledWith(tx, "hh-1");
  });

  it("schedule action returns the schedule for OPERATIONS when the flag is on", async () => {
    m.schedule.mockResolvedValue(SCHEDULE);
    expect(await loadAssetMapSchedule()).toEqual({ ok: true, data: SCHEDULE });
    expect(m.schedule).toHaveBeenCalledWith(BASE);
  });

  it("live extras action reads the offset in the user scope then calls the pipeline for OPERATIONS", async () => {
    const extras = { docResults: [], rolloverNotes: {} };
    m.offset.mockResolvedValue(437);
    m.extras.mockResolvedValue(extras);
    expect(await loadAssetMapHouseholdLiveExtras("hh-1")).toEqual({ ok: true, data: extras });
    expect(m.scope).toHaveBeenCalledTimes(1);
    expect(m.offset).toHaveBeenCalledWith(tx, "hh-1");
    expect(m.extras).toHaveBeenCalledWith(BASE, "hh-1", 437);
    expect(m.offset.mock.invocationCallOrder[0]).toBeLessThan(m.extras.mock.invocationCallOrder[0]);
  });

  it("live actions return unavailable without a pipeline call when STATEMENT_PIPELINE_URL is unset", async () => {
    m.baseUrl.mockReturnValue(null);
    expect(await loadAssetMapSchedule()).toEqual({ ok: false, reason: "unavailable" });
    expect(await loadAssetMapHouseholdLiveExtras("hh-1")).toEqual({ ok: false, reason: "unavailable" });
    expect(m.schedule).not.toHaveBeenCalled();
    expect(m.extras).not.toHaveBeenCalled();
    expect(m.scope).not.toHaveBeenCalled();
  });

  it("returns unavailable and logs only a static marker when a read throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.list.mockRejectedValue(new Error("synthetic secret detail"));
    expect(await loadAssetMapHouseholdList()).toEqual({ ok: false, reason: "unavailable" });
    expect(err).toHaveBeenCalledWith("[asset-mapping] list_unavailable");
    expect(err.mock.calls.flat().join(" ")).not.toContain("synthetic secret detail");
    err.mockRestore();
  });
});
