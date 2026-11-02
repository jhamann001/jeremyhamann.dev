import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  edits: vi.fn(),
  destinations: vi.fn(),
  scope: vi.fn(),
  audit: vi.fn(),
  baseUrl: vi.fn(),
  writeThrough: vi.fn(),
  folder: vi.fn(),
  context: vi.fn(),
  fetch: vi.fn(),
  build: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({
  assetMappingReadEnabled: m.read,
  assetMappingEditsEnabled: m.edits,
  assetMappingDestinationsEnabled: m.destinations,
}));
vi.mock("@/lib/rls", () => ({ withUserScope: m.scope }));
vi.mock("@/lib/audit", () => ({
  writeAudit: m.audit,
  ASSET_MAP_DESTINATION_ADD: "asset_map_destination.add",
  ASSET_MAP_DESTINATION_NEEDS_OPEN: "asset_map_destination.needs_to_be_opened",
  ASSET_MAP_DESTINATION_TYPE: "asset_map_destination.type",
  ASSET_MAP_DESTINATION_DELETE: "asset_map_destination.delete",
  ASSET_MAP_SOURCE_REASSIGN: "asset_map_destination.source_reassign",
}));
vi.mock("@/lib/data/asset-map", () => ({ assetMapBaseUrl: m.baseUrl }));
vi.mock("@/lib/data/asset-map-write-through", () => ({ writeThroughAssetMapEdit: m.writeThrough }));
vi.mock("@/lib/data/asset-map-destinations", () => ({
  readAssetMapSourceFolderId: m.folder,
  readAssetMapDestinationContext: m.context,
  fetchAssetMapDestinations: m.fetch,
  buildDestinationsView: m.build,
  sendAssetMapDestinationWrite: m.send,
}));

import {
  addAssetMapDestination,
  loadAssetMapDestinations,
  reassignAssetMapSource,
  removeAssetMapDestination,
  setAssetMapDestinationNeedsOpen,
  setAssetMapDestinationType,
} from "@/app/(authenticated)/asset-mapping/actions";

const BASE = "https://pipeline.example.test";
const HH = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const LINK = "33333333-3333-4333-8333-333333333333";
const NEW = "44444444-4444-4444-8444-444444444444";
const OWNER = "Synthetic Owner";
const IDENTITY = { role: "OPERATIONS", email: "synthetic@example.invalid" };
const tx = { synthetic: "tx" };

function signIn(role: string) {
  m.auth.mockResolvedValue({ user: { role, email: "synthetic@example.invalid" } });
}

function allFive() {
  return Promise.all([
    addAssetMapDestination(HH, OWNER, "Roth IRA"),
    setAssetMapDestinationNeedsOpen(TARGET, false),
    setAssetMapDestinationType(TARGET, "Roth IRA"),
    removeAssetMapDestination(TARGET),
    reassignAssetMapSource(HH, LINK, { targetAccountId: TARGET }),
  ]);
}

const FORBIDDEN = { ok: false, reason: "forbidden" };
const REJECTED = { ok: false, reason: "rejected" };
const NOT_FOUND = { ok: false, reason: "not_found" };
const UNAVAILABLE = { ok: false, reason: "unavailable" };

function expectNoPipelineWork() {
  expect(m.folder).not.toHaveBeenCalled();
  expect(m.context).not.toHaveBeenCalled();
  expect(m.fetch).not.toHaveBeenCalled();
  expect(m.send).not.toHaveBeenCalled();
  expect(m.audit).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  m.read.mockReturnValue(true);
  m.edits.mockReturnValue(false);
  m.destinations.mockReturnValue(true);
  signIn("OPERATIONS");
  m.baseUrl.mockReturnValue(BASE);
  m.folder.mockResolvedValue("synthetic-folder");
  m.send.mockResolvedValue({ ok: true, body: {} });
  m.scope.mockImplementation(async (_identity, callback) => callback(tx));
});

describe("asset-mapping destination actions", () => {
  it("returns forbidden without a pipeline call when the destinations flag is off", async () => {
    m.destinations.mockReturnValue(false);
    expect(await allFive()).toEqual(Array(5).fill(FORBIDDEN));
    expect(await loadAssetMapDestinations(HH)).toEqual(NOT_FOUND);
    expectNoPipelineWork();
  });

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER"])("rejects staff role %s without a pipeline call", async (role) => {
    signIn(role);
    expect(await allFive()).toEqual(Array(5).fill(FORBIDDEN));
    expect(await loadAssetMapDestinations(HH)).toEqual(NOT_FOUND);
    expectNoPipelineWork();
    expect(m.scope).not.toHaveBeenCalled();
  });

  it("rejects a signed-out caller without a pipeline call", async () => {
    m.auth.mockResolvedValue(null);
    expect(await allFive()).toEqual(Array(5).fill(FORBIDDEN));
    expect(await loadAssetMapDestinations(HH)).toEqual(NOT_FOUND);
    expectNoPipelineWork();
  });

  it("allows ADMIN", async () => {
    signIn("ADMIN");
    const results = await allFive();
    expect(results.every((r) => r.ok)).toBe(true);
    expect(m.send).toHaveBeenCalledTimes(5);
  });

  it("loads the household's destinations through the read route with the household's own folder", async () => {
    const context = { sourceFolderId: "synthetic-folder", accounts: [], overriddenPositionIds: [] };
    const raw = [{ id: TARGET }];
    const built = { destinations: [], accountNumbers: {}, overriddenPositionIds: [] };
    m.context.mockResolvedValue(context);
    m.fetch.mockResolvedValue(raw);
    m.build.mockReturnValue(built);
    expect(await loadAssetMapDestinations(HH)).toEqual({ ok: true, data: built });
    expect(m.scope).toHaveBeenCalledWith(IDENTITY, expect.any(Function));
    expect(m.context).toHaveBeenCalledWith(tx, HH);
    expect(m.fetch).toHaveBeenCalledWith(BASE, "synthetic-folder");
    expect(m.build).toHaveBeenCalledWith(raw, context);
  });

  it("load returns not_found when the household or its folder is absent, and unavailable when the read fails or the base url is unset", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadAssetMapDestinations("")).toEqual(NOT_FOUND);
    m.context.mockResolvedValueOnce(null);
    expect(await loadAssetMapDestinations(HH)).toEqual(NOT_FOUND);
    expect(m.fetch).not.toHaveBeenCalled();
    m.context.mockResolvedValue({ sourceFolderId: "synthetic-folder", accounts: [], overriddenPositionIds: [] });
    m.fetch.mockResolvedValueOnce(null);
    expect(await loadAssetMapDestinations(HH)).toEqual(UNAVAILABLE);
    m.context.mockRejectedValueOnce(new Error("synthetic mirror failure"));
    expect(await loadAssetMapDestinations(HH)).toEqual(UNAVAILABLE);
    expect(error).toHaveBeenCalledWith("[asset-mapping] destinations_unavailable");
    m.baseUrl.mockReturnValue(null);
    m.context.mockClear();
    expect(await loadAssetMapDestinations(HH)).toEqual(UNAVAILABLE);
    expect(m.context).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("add resolves the folder from the household and sends the trimmed owner and type", async () => {
    m.send.mockResolvedValueOnce({ ok: true, body: { id: NEW } });
    const r = await addAssetMapDestination(HH, `  ${OWNER}  `, "Roth IRA");
    expect(m.folder).toHaveBeenCalledWith(tx, HH);
    expect(m.send).toHaveBeenCalledWith(BASE, { kind: "add", sourceFolderId: "synthetic-folder", owner: OWNER, targetAccountType: "Roth IRA" });
    expect(r).toEqual({ ok: true, data: { id: NEW, owner: OWNER, targetAccountType: "Roth IRA" } });
    m.send.mockClear();
    await addAssetMapDestination(HH, "   ", "Individual");
    expect(m.send).toHaveBeenCalledWith(BASE, { kind: "add", sourceFolderId: "synthetic-folder", owner: null, targetAccountType: "Individual" });
  });

  it("marks a destination as needing to be opened or as existing", async () => {
    expect(await setAssetMapDestinationNeedsOpen(TARGET, true)).toEqual({ ok: true, data: { needsToBeOpened: true } });
    expect(await setAssetMapDestinationNeedsOpen(TARGET, false)).toEqual({ ok: true, data: { needsToBeOpened: false } });
    expect(m.send.mock.calls).toEqual([
      [BASE, { kind: "needsOpen", targetId: TARGET, needsToBeOpened: true }],
      [BASE, { kind: "needsOpen", targetId: TARGET, needsToBeOpened: false }],
    ]);
    expect(m.folder).not.toHaveBeenCalled();
  });

  it("changes a destination's account type", async () => {
    expect(await setAssetMapDestinationType(TARGET, "Traditional IRA")).toEqual({ ok: true, data: { targetAccountType: "Traditional IRA" } });
    expect(m.send).toHaveBeenCalledWith(BASE, { kind: "type", targetId: TARGET, targetAccountType: "Traditional IRA" });
  });

  it("removes a destination", async () => {
    expect(await removeAssetMapDestination(TARGET)).toEqual({ ok: true, data: { id: TARGET } });
    expect(m.send).toHaveBeenCalledWith(BASE, { kind: "remove", targetId: TARGET });
  });

  it("moves a source onto an existing destination or a new one", async () => {
    m.send.mockResolvedValueOnce({ ok: true, body: { link_id: LINK, target_account_id: TARGET } });
    expect(await reassignAssetMapSource(HH, LINK, { targetAccountId: TARGET })).toEqual({ ok: true, data: { linkId: LINK, targetAccountId: TARGET } });
    expect(m.send).toHaveBeenLastCalledWith(BASE, { kind: "reassign", linkId: LINK, targetAccountId: TARGET });
    expect(m.folder).not.toHaveBeenCalled();
    m.send.mockResolvedValueOnce({ ok: true, body: { link_id: LINK, target_account_id: NEW } });
    expect(await reassignAssetMapSource(HH, LINK, { newOwner: OWNER })).toEqual({ ok: true, data: { linkId: LINK, targetAccountId: NEW } });
    expect(m.folder).toHaveBeenCalledWith(tx, HH);
    expect(m.send).toHaveBeenLastCalledWith(BASE, { kind: "reassignNew", linkId: LINK, sourceFolderId: "synthetic-folder", newOwner: OWNER });
  });

  it("rejects invalid input without a pipeline call", async () => {
    const results = await Promise.all([
      addAssetMapDestination("not-a-uuid", OWNER, "Individual"),
      addAssetMapDestination(HH, OWNER, "Joint"),
      addAssetMapDestination(HH, OWNER, "Synthetic Type"),
      addAssetMapDestination(HH, 42 as unknown as string, "Individual"),
      setAssetMapDestinationNeedsOpen("not-a-uuid", true),
      setAssetMapDestinationNeedsOpen(TARGET, "yes" as unknown as boolean),
      setAssetMapDestinationType("not-a-uuid", "Individual"),
      setAssetMapDestinationType(TARGET, "Joint"),
      removeAssetMapDestination("not-a-uuid"),
      reassignAssetMapSource(HH, "not-a-uuid", { targetAccountId: TARGET }),
      reassignAssetMapSource(HH, LINK, { targetAccountId: "not-a-uuid" }),
      reassignAssetMapSource("not-a-uuid", LINK, { newOwner: OWNER }),
      reassignAssetMapSource(HH, LINK, { newOwner: 42 as unknown as string }),
    ]);
    expect(results).toEqual(Array(results.length).fill(REJECTED));
    expect(m.folder).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("rejects a household-scoped save when the household has no folder", async () => {
    m.folder.mockResolvedValue(null);
    expect(await addAssetMapDestination(HH, OWNER, "Individual")).toEqual(REJECTED);
    expect(await reassignAssetMapSource(HH, LINK, { newOwner: OWNER })).toEqual(REJECTED);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("returns rejected or unavailable and writes no audit row when the pipeline refuses or does not respond", async () => {
    m.send.mockResolvedValueOnce({ ok: false, reason: "rejected" });
    expect(await removeAssetMapDestination(TARGET)).toEqual(REJECTED);
    m.send.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    expect(await setAssetMapDestinationType(TARGET, "Roth IRA")).toEqual(UNAVAILABLE);
    m.baseUrl.mockReturnValue(null);
    expect(await setAssetMapDestinationNeedsOpen(TARGET, true)).toEqual(UNAVAILABLE);
    expect(m.send).toHaveBeenCalledTimes(2);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("writes one audit row under the operator's own identity with ids and enums only", async () => {
    m.send.mockResolvedValueOnce({ ok: true, body: { id: NEW } });
    await addAssetMapDestination(HH, OWNER, "Roth IRA");
    m.send.mockResolvedValueOnce({ ok: true, body: { link_id: LINK, target_account_id: TARGET } });
    await reassignAssetMapSource(HH, LINK, { targetAccountId: TARGET });
    expect(m.audit.mock.calls).toEqual([
      [tx, IDENTITY, { action: "asset_map_destination.add", entityType: "asset_map_destination", entityId: NEW, detail: { targetAccountType: "Roth IRA" } }],
      [tx, IDENTITY, { action: "asset_map_destination.source_reassign", entityType: "asset_map_source_link", entityId: LINK, detail: { targetAccountId: TARGET, newDestination: false } }],
    ]);
    for (const [identity] of m.scope.mock.calls) expect(identity).toEqual(IDENTITY);
    expect(JSON.stringify(m.audit.mock.calls)).not.toContain(OWNER);
    expect(m.writeThrough).not.toHaveBeenCalled();
  });

  it("still returns the saved value when the audit insert fails, logging only a static marker", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    m.audit.mockRejectedValue(new Error("synthetic audit failure"));
    expect(await removeAssetMapDestination(TARGET)).toEqual({ ok: true, data: { id: TARGET } });
    expect(error.mock.calls).toEqual([["[asset-mapping] destination_audit_failed"]]);
    error.mockRestore();
  });
});
