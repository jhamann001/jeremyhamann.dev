import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  edits: vi.fn(),
  scope: vi.fn(),
  audit: vi.fn(),
  baseUrl: vi.fn(),
  send: vi.fn(),
  writeThrough: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({ assetMappingReadEnabled: m.read, assetMappingEditsEnabled: m.edits }));
vi.mock("@/lib/rls", () => ({ withUserScope: m.scope }));
vi.mock("@/lib/audit", () => ({
  writeAudit: m.audit,
  ASSET_MAP_EDIT_POSITION_STATUS: "asset_map_edit.position_status",
  ASSET_MAP_EDIT_POSITION_TRANSFERRING: "asset_map_edit.position_transferring",
  ASSET_MAP_EDIT_ACCOUNT_TYPE: "asset_map_edit.account_type",
  ASSET_MAP_EDIT_POSITION_DELETE: "asset_map_edit.position_delete",
  ASSET_MAP_EDIT_POSITION_RESTORE: "asset_map_edit.position_restore",
  ASSET_MAP_EDIT_ACCOUNT_DELETE: "asset_map_edit.account_delete",
  ASSET_MAP_EDIT_ACCOUNT_RESTORE: "asset_map_edit.account_restore",
}));
vi.mock("@/lib/data/asset-map", () => ({
  assetMapBaseUrl: m.baseUrl,
  sendAssetMapEdit: m.send,
  statusOverrideNote: (s: string) => `Manual override to ${s}`,
}));
vi.mock("@/lib/data/asset-map-write-through", () => ({ writeThroughAssetMapEdit: m.writeThrough }));
vi.mock("@/lib/data/asset-map-destinations", () => ({}));

import {
  removeAssetMapAccount,
  removeAssetMapPosition,
  restoreAssetMapAccount,
  restoreAssetMapPosition,
  saveAssetMapAccountType,
  saveAssetMapPositionStatus,
  saveAssetMapPositionTransferring,
} from "@/app/(authenticated)/asset-mapping/actions";

const BASE = "https://pipeline.example.test";
const POS = "55555555-5555-4555-8555-555555555555";
const ACC = "66666666-6666-4666-8666-666666666666";
const tx = { synthetic: "tx" };

function signIn(role: string) {
  m.auth.mockResolvedValue({ user: { role, email: "synthetic@example.invalid" } });
}

function allSeven() {
  return Promise.all([
    saveAssetMapPositionStatus(POS, "REVIEW"),
    saveAssetMapPositionTransferring(POS, "YES"),
    saveAssetMapAccountType(ACC, "Other", "Synthetic label"),
    removeAssetMapPosition(POS),
    restoreAssetMapPosition(POS),
    removeAssetMapAccount(ACC),
    restoreAssetMapAccount(ACC),
  ]);
}

const FORBIDDEN = { ok: false, reason: "forbidden" };

beforeEach(() => {
  vi.resetAllMocks();
  m.read.mockReturnValue(true);
  m.edits.mockReturnValue(true);
  signIn("OPERATIONS");
  m.baseUrl.mockReturnValue(BASE);
  m.send.mockResolvedValue({ ok: true, body: {} });
  m.writeThrough.mockResolvedValue(true);
  m.scope.mockImplementation(async (_identity, callback) => callback(tx));
});

describe("asset-mapping edit actions", () => {
  it("returns forbidden without a pipeline call when the flag is off", async () => {
    m.edits.mockReturnValue(false);
    expect(await allSeven()).toEqual(Array(7).fill(FORBIDDEN));
    expect(m.send).not.toHaveBeenCalled();
    expect(m.writeThrough).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER"])("rejects staff role %s without a pipeline call", async (role) => {
    signIn(role);
    expect(await allSeven()).toEqual(Array(7).fill(FORBIDDEN));
    expect(m.send).not.toHaveBeenCalled();
    expect(m.writeThrough).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("rejects a signed-out caller without a pipeline call", async () => {
    m.auth.mockResolvedValue(null);
    expect(await allSeven()).toEqual(Array(7).fill(FORBIDDEN));
    expect(m.send).not.toHaveBeenCalled();
  });

  it("allows ADMIN", async () => {
    signIn("ADMIN");
    const results = await allSeven();
    expect(results.every((r) => r.ok)).toBe(true);
    expect(m.send).toHaveBeenCalledTimes(7);
  });

  it("position status save sends the status and returns the saved status from the response", async () => {
    m.send.mockResolvedValue({ ok: true, body: { position_id: POS, new_status: "REVIEW" } });
    const r = await saveAssetMapPositionStatus(POS, "LIQUIDATE");
    expect(m.send).toHaveBeenCalledWith(BASE, { kind: "positionStatus", positionId: POS, status: "LIQUIDATE" });
    expect(r).toEqual({ ok: true, data: { status: "REVIEW" } });
  });

  it("transferring save sends YES, NO, or null and returns the saved value", async () => {
    for (const value of ["YES", "NO", null] as const) {
      m.send.mockResolvedValueOnce({ ok: true, body: { position_id: POS, transferring: value } });
      const r = await saveAssetMapPositionTransferring(POS, value);
      expect(m.send).toHaveBeenLastCalledWith(BASE, { kind: "positionTransferring", positionId: POS, value });
      expect(r).toEqual({ ok: true, data: { value } });
    }
  });

  it("account type save sends the type and Other label and returns the saved account fields", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T14:05:00.000Z"));
    m.send.mockResolvedValueOnce({
      ok: true,
      body: { account_type: "Other", account_type_other: "Synthetic label", is_rollover: false, is_inherited: true, apex_restriction: null },
    });
    const r = await saveAssetMapAccountType(ACC, "Other", "  Synthetic label  ");
    expect(m.send).toHaveBeenLastCalledWith(BASE, { kind: "accountType", accountId: ACC, accountType: "Other", accountTypeOther: "Synthetic label" });
    expect(r).toEqual({
      ok: true,
      data: {
        accountType: "Other", accountTypeOther: "Synthetic label", isRollover: false, isInherited: true, apexRestriction: null,
        overriddenBy: "synthetic@example.invalid", overriddenAt: "2026-10-06T14:05:00.000Z",
      },
    });

    await saveAssetMapAccountType(ACC, "IRA", "ignored label");
    expect(m.send).toHaveBeenLastCalledWith(BASE, { kind: "accountType", accountId: ACC, accountType: "IRA", accountTypeOther: null });
    vi.useRealTimers();
  });

  it("an account-type save returns, writes through, and audits the same operator and save time (ticket)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T15:30:00.000Z"));
    m.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "saver@example.invalid" } });
    m.send.mockResolvedValueOnce({ ok: true, body: { account_type: "IRA", account_type_other: null } });
    const r = await saveAssetMapAccountType(ACC, "IRA", null);
    vi.useRealTimers();
    expect(r.ok).toBe(true);
    const data = r.ok ? r.data : null;
    expect(data?.overriddenBy).toBe("saver@example.invalid");
    expect(data?.overriddenAt).toBe("2026-10-06T15:30:00.000Z");
    expect(m.writeThrough.mock.calls[0][0]).toMatchObject({
      kind: "accountType", overriddenBy: "saver@example.invalid", overriddenAt: "2026-10-06T15:30:00.000Z",
    });
    expect(m.audit.mock.calls[0][1]).toEqual({ role: "OPERATIONS", email: "saver@example.invalid" });
  });

  it("position delete and restore call the matching routes", async () => {
    expect(await removeAssetMapPosition(POS)).toEqual({ ok: true, data: { id: POS } });
    expect(m.send).toHaveBeenLastCalledWith(BASE, { kind: "removePosition", positionId: POS });
    expect(await restoreAssetMapPosition(POS)).toEqual({ ok: true, data: { id: POS } });
    expect(m.send).toHaveBeenLastCalledWith(BASE, { kind: "restorePosition", positionId: POS });
  });

  it("account delete and restore call the matching routes", async () => {
    expect(await removeAssetMapAccount(ACC)).toEqual({ ok: true, data: { id: ACC } });
    expect(m.send).toHaveBeenLastCalledWith(BASE, { kind: "removeAccount", accountId: ACC });
    expect(await restoreAssetMapAccount(ACC)).toEqual({ ok: true, data: { id: ACC } });
    expect(m.send).toHaveBeenLastCalledWith(BASE, { kind: "restoreAccount", accountId: ACC });
  });

  it("rejects invalid input without a pipeline call", async () => {
    const REJECTED = { ok: false, reason: "rejected" };
    expect(await saveAssetMapPositionStatus(POS, "DONE")).toEqual(REJECTED);
    expect(await saveAssetMapPositionTransferring(POS, "MAYBE" as unknown as "YES")).toEqual(REJECTED);
    expect(await saveAssetMapAccountType(ACC, "Brokerage", null)).toEqual(REJECTED);
    expect(await removeAssetMapPosition("not-a-uuid")).toEqual(REJECTED);
    expect(await restoreAssetMapAccount("../" + ACC)).toEqual(REJECTED);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("returns rejected and writes no audit row or mirror value when the pipeline rejects", async () => {
    m.send.mockResolvedValue({ ok: false, reason: "rejected" });
    expect(await allSeven()).toEqual(Array(7).fill({ ok: false, reason: "rejected" }));
    expect(m.writeThrough).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("returns unavailable and writes no audit row or mirror value when the pipeline does not respond", async () => {
    m.send.mockResolvedValue({ ok: false, reason: "unavailable" });
    expect(await allSeven()).toEqual(Array(7).fill({ ok: false, reason: "unavailable" }));
    expect(m.writeThrough).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("returns unavailable without a pipeline call when STATEMENT_PIPELINE_URL is unset", async () => {
    m.baseUrl.mockReturnValue(null);
    expect(await allSeven()).toEqual(Array(7).fill({ ok: false, reason: "unavailable" }));
    expect(m.send).not.toHaveBeenCalled();
  });

  it("writes one audit row under the operator's own identity with ids and enums only", async () => {
    await saveAssetMapAccountType(ACC, "Other", "Synthetic label");
    expect(m.scope).toHaveBeenCalledTimes(1);
    expect(m.scope.mock.calls[0][0]).toEqual({ role: "OPERATIONS", email: "synthetic@example.invalid" });
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(tx, { role: "OPERATIONS", email: "synthetic@example.invalid" }, {
      action: "asset_map_edit.account_type",
      entityType: "asset_map_account",
      entityId: ACC,
      detail: { accountType: "Other", hasOther: true },
    });
    expect(JSON.stringify(m.audit.mock.calls)).not.toContain("Synthetic label");
  });

  it("still returns the saved value when the audit insert fails, logging only a static marker", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    m.audit.mockRejectedValue(new Error(`synthetic audit failure ${POS}`));
    m.send.mockResolvedValue({ ok: true, body: { new_status: "ACAT" } });
    expect(await saveAssetMapPositionStatus(POS, "ACAT")).toEqual({ ok: true, data: { status: "ACAT" } });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[asset-mapping] edit_audit_failed");
    error.mockRestore();
  });

  it("writes the confirmed value through to the mirror after the pipeline accepts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T14:05:00.000Z"));
    m.send.mockImplementation(async (_base, req: { kind: string }) => {
      if (req.kind === "positionStatus") return { ok: true, body: { new_status: "REVIEW" } };
      if (req.kind === "positionTransferring") return { ok: true, body: { transferring: "YES" } };
      if (req.kind === "accountType") {
        return { ok: true, body: { account_type: "Other", account_type_other: "Synthetic label", is_rollover: true, is_inherited: false, apex_restriction: "Synthetic restriction" } };
      }
      return { ok: true, body: {} };
    });
    await allSeven();
    expect(m.writeThrough).toHaveBeenCalledTimes(7);
    const sendOrder = m.send.mock.invocationCallOrder;
    m.writeThrough.mock.invocationCallOrder.forEach((order, i) => expect(order).toBeGreaterThan(sendOrder[i]));
    expect(m.writeThrough.mock.calls.map((c) => c[0])).toEqual([
      { kind: "positionStatus", positionId: POS, status: "REVIEW", notes: "Manual override to REVIEW" },
      { kind: "positionTransferring", positionId: POS, value: "YES" },
      {
        kind: "accountType", accountId: ACC, accountType: "Other", accountTypeOther: "Synthetic label",
        isRollover: true, isInherited: false, apexRestriction: "Synthetic restriction",
        overriddenBy: "synthetic@example.invalid", overriddenAt: "2026-10-06T14:05:00.000Z",
      },
      { kind: "removePosition", positionId: POS },
      { kind: "restorePosition", positionId: POS },
      { kind: "removeAccount", accountId: ACC },
      { kind: "restoreAccount", accountId: ACC },
    ]);
    vi.useRealTimers();
  });

  it("still returns the saved value when the write-through fails", async () => {
    m.writeThrough.mockResolvedValue(false);
    expect(await removeAssetMapPosition(POS)).toEqual({ ok: true, data: { id: POS } });
    expect(m.audit).toHaveBeenCalledTimes(1);
  });
});
