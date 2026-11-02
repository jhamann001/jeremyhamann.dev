import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const m = vi.hoisted(() => ({ auth: vi.fn(), runImport: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: vi.fn() }));
vi.mock("@/lib/data/asset-map-import", () => ({ runAssetMapImport: m.runImport }));
vi.mock("@/lib/data/asset-map-write-through", () => ({ writeThroughAssetMapEdit: vi.fn() }));
vi.mock("@/lib/data/asset-map-destinations", () => ({}));

import { runAssetMapOnDemandImport } from "@/app/(authenticated)/asset-mapping/actions";

const FLAG = "EPIC_AOA_ASSET_MAPPING_ON_DEMAND_IMPORT";
const OTHERS = [
  "EPIC_AOA_ASSET_MAPPING_READ", "EPIC_AOA_ASSET_MAPPING_EDITS", "EPIC_AOA_ASSET_MAPPING_DESTINATIONS",
  "EPIC_AOA_ASSET_MAPPING_CLIENT_LINKING", "EPIC_AOA_ASSET_MAPPING_DOCUMENTS", "EPIC_AOA_ASSET_MAPPING_WORKSPACE",
] as const;
const saved = [FLAG, ...OTHERS].map((k) => [k, process.env[k]] as const);

beforeEach(() => {
  vi.resetAllMocks();
  for (const k of [FLAG, ...OTHERS]) delete process.env[k];
  m.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "synthetic@example.invalid" } });
  m.runImport.mockResolvedValue({ status: 200, body: {} });
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("runAssetMapOnDemandImport (ticket)", () => {
  it.each([undefined, "", "0", "true", "yes", " 1", "1 "])("starts no import while the flag is %j, even with every other asset-mapping flag on (WO-AC-7, WO-AC-8)", async (value) => {
    for (const k of OTHERS) process.env[k] = "1";
    if (value !== undefined) process.env[FLAG] = value;
    expect(await runAssetMapOnDemandImport()).toEqual({ ok: false });
    expect(m.runImport).not.toHaveBeenCalled();
  });

  it('runs the shared live import when the flag is exactly "1", with every other flag off (WO-AC-1, WO-AC-8)', async () => {
    process.env[FLAG] = "1";
    expect(await runAssetMapOnDemandImport()).toEqual({ ok: true });
    expect(m.runImport).toHaveBeenCalledWith({ dryRun: false });
  });

  it.each([
    ["a failed import", async () => ({ status: 502, body: { error: "pipeline_error" } })],
    ["a throwing import", async () => { throw new Error("synthetic"); }],
  ])("reports %s as not ok (WO-AC-11)", async (_label, impl) => {
    process.env[FLAG] = "1";
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.runImport.mockImplementation(impl);
    expect(await runAssetMapOnDemandImport()).toEqual({ ok: false });
  });

  it("refuses a signed-out user and a role that cannot review asset maps", async () => {
    process.env[FLAG] = "1";
    m.auth.mockResolvedValueOnce(null);
    expect(await runAssetMapOnDemandImport()).toEqual({ ok: false });
    for (const role of ["VIEWER", "ADVISOR", "CLIENT_SERVICE"]) {
      m.auth.mockResolvedValueOnce({ user: { role, email: "read.only@example.invalid" } });
      expect(await runAssetMapOnDemandImport()).toEqual({ ok: false });
    }
    expect(m.runImport).not.toHaveBeenCalled();
  });
});
