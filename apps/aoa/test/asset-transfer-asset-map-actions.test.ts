import { beforeEach, describe, expect, it, vi } from "vitest";

// linkAssetMapToTransfer / unlinkAssetMapFromTransfer / loadAssignableAssetMapAccounts
// wiring (rework S3), WITHOUT a DB. @/auth, @/lib/rls, @/lib/flags, the read seam,
// and Next cache/navigation are mocked; withUserScope runs the real callback against
// a fake tx whose transfer.{findUnique,update} + auditLog.create are spies. Asserts:
// flag/role gates, opaque selection resolution, durable-key write, masked audit, the
// unlink clear + no-op-when-already-unlinked, and the loader's flag gate.

const { authSpy, withUserScopeSpy, flagSpy, dealFlagSpy, listAssignableSpy, resolveAssignableSpy } = vi.hoisted(
  () => ({
    authSpy: vi.fn(),
    withUserScopeSpy: vi.fn(),
    flagSpy: vi.fn(),
    dealFlagSpy: vi.fn(() => false),
    listAssignableSpy: vi.fn(),
    resolveAssignableSpy: vi.fn(),
  }),
);

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
vi.mock("@/lib/flags", () => ({
  transferDealSourcedRedesignEnabled: dealFlagSpy,
  assetMapTransferLinkEnabled: flagSpy,
  transferArchiveActionEnabled: () => false,
  assetTransferWorkspaceEnabled: () => false,
}));
vi.mock("@/lib/data/transfer-asset-map", () => ({
  listAssignableAssetMapAccounts: listAssignableSpy,
  resolveAssignableAssetMapAccount: resolveAssignableSpy,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/crm/post-commit-signal", () => ({
  scheduleCrmIdentityReconciliation: vi.fn(),
}));
// actions.ts now imports the ACAT status fetchers (either-id link routing);
// the real module imports "server-only" + google-auth, so it must be mocked in
// the node env (these actions never call it).
vi.mock("@/lib/data/acat-status", () => ({
  getAcatStatus: vi.fn(),
  getAcatStatusByRecordId: vi.fn(),
}));

import {
  linkAssetMapToTransfer,
  unlinkAssetMapFromTransfer,
  loadAssignableAssetMapAccounts,
} from "@/app/(authenticated)/asset-transfer/actions";
import { TRANSFER_ASSET_MAP_LINK, TRANSFER_ASSET_MAP_UNLINK } from "@/lib/audit";

type FakeTx = {
  $queryRaw: ReturnType<typeof vi.fn>;
  transfer: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

function makeTx(row: Record<string, unknown> | null): FakeTx {
  return {
    $queryRaw: vi.fn(async () => row ? [{ id: "t1" }] : []),
    transfer: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(async () => ({})),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}

let tx: FakeTx;

beforeEach(() => {
  authSpy.mockReset();
  authSpy.mockResolvedValue({ user: { email: "ops@example.com", role: "OPERATIONS" } });
  flagSpy.mockReset();
  listAssignableSpy.mockReset();
  resolveAssignableSpy.mockReset();
  withUserScopeSpy.mockReset();
});

function wireScope(row: Record<string, unknown> | null) {
  tx = makeTx(row ? { stage: "DECISION", archived_at: null, ...row } : null);
  withUserScopeSpy.mockImplementation(
    async (_id: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
}

describe("linkAssetMapToTransfer", () => {
  const accountId = "00000000-0000-4000-8000-000000000238";
  const resolved = {
    sourceFolderId: "folder_1",
    custodian: "Fidelity",
    accountNumber: "562501053333" as string | null,
    accountType: "Individual" as string | null,
  };

  beforeEach(() => resolveAssignableSpy.mockResolvedValue(resolved));

  it("flag OFF rejects without looking up the selection", async () => {
    flagSpy.mockReturnValue(false);
    expect(await linkAssetMapToTransfer("t1", accountId)).toMatchObject({ ok: false });
    expect(withUserScopeSpy).not.toHaveBeenCalled();
    expect(resolveAssignableSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed IDs and legacy raw-key objects before opening a scope", async () => {
    flagSpy.mockReturnValue(true);
    for (const invalid of [null, undefined, "", " ", 42, {}, resolved, "x".repeat(201)]) {
      expect(await linkAssetMapToTransfer("t1", invalid as string)).toMatchObject({ ok: false });
    }
    expect(await linkAssetMapToTransfer("", accountId)).toMatchObject({ ok: false });
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY", "UNKNOWN", undefined])(
    "rejects a %s caller without resolving account data",
    async role => {
      flagSpy.mockReturnValue(true);
      authSpy.mockResolvedValue({ user: { email: "synthetic@example.test", role } });
      expect(await linkAssetMapToTransfer("t1", accountId)).toMatchObject({ ok: false });
      expect(withUserScopeSpy).not.toHaveBeenCalled();
      expect(resolveAssignableSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["OPERATIONS", "ADMIN"])(
    "%s resolves the opaque ID in the write transaction and persists only the server key",
    async role => {
      flagSpy.mockReturnValue(true);
      authSpy.mockResolvedValue({ user: { email: "synthetic@example.test", role } });
      wireScope({ id: "t1", asset_map_folder_id: null });
      expect(await linkAssetMapToTransfer("t1", accountId)).toBeUndefined();
      expect(resolveAssignableSpy).toHaveBeenCalledWith(tx, accountId);
      expect(withUserScopeSpy).toHaveBeenCalledTimes(1);
      expect(withUserScopeSpy).toHaveBeenCalledWith(
        { role, email: "synthetic@example.test" }, expect.any(Function),
      );
      expect(tx.transfer.update).toHaveBeenCalledWith({
        where: { id: "t1" },
        data: {
          asset_map_folder_id: "folder_1",
          asset_map_custodian: "Fidelity",
          asset_map_account_number: "562501053333",
          asset_map_account_type: "Individual",
          funding_plan_complete: false,
          funding_plan_version: { increment: 1 },
          funding_plan_approved_at: null,
          funding_plan_approved_by: null,
          updated_by: "synthetic@example.test",
        },
      });
      const serialized = JSON.stringify(tx.auditLog.create.mock.calls[0][0]);
      expect(serialized).toContain(TRANSFER_ASSET_MAP_LINK);
      expect(serialized).toContain("3333");
      expect(serialized).not.toContain("562501053333");
    },
  );

  it("numberless selections store the resolved type and audit a null last-four", async () => {
    flagSpy.mockReturnValue(true);
    wireScope({ id: "t1", asset_map_folder_id: null });
    resolveAssignableSpy.mockResolvedValue({
      ...resolved, custodian: "T. Rowe Price", accountNumber: null, accountType: "Roth IRA",
    });
    expect(await linkAssetMapToTransfer("t1", accountId)).toBeUndefined();
    expect(tx.transfer.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        asset_map_custodian: "T. Rowe Price", asset_map_account_number: null,
        asset_map_account_type: "Roth IRA",
      }),
    }));
    const detail = JSON.parse(tx.auditLog.create.mock.calls[0][0].data.detail);
    expect(detail).toMatchObject({ accountType: "Roth IRA", accountLast4: null });
  });

  it("a missing transfer is rejected before account resolution", async () => {
    flagSpy.mockReturnValue(true);
    wireScope(null);
    expect(await linkAssetMapToTransfer("missing", accountId)).toMatchObject({ ok: false });
    expect(resolveAssignableSpy).not.toHaveBeenCalled();
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("a stale, superseded, nonexistent or inaccessible selection makes no write or audit", async () => {
    flagSpy.mockReturnValue(true);
    wireScope({ id: "t1", asset_map_folder_id: "keep-existing-link" });
    resolveAssignableSpy.mockResolvedValue(null);
    expect(await linkAssetMapToTransfer("t1", accountId)).toMatchObject({ ok: false });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("resolution and write errors remain generic without returning source data", async () => {
    flagSpy.mockReturnValue(true);
    wireScope({ id: "t1", asset_map_folder_id: null });
    resolveAssignableSpy.mockRejectedValueOnce(new Error(resolved.accountNumber!));
    const rejected = await linkAssetMapToTransfer("t1", accountId);
    expect(rejected).toMatchObject({ ok: false });
    expect(JSON.stringify(rejected)).not.toContain(resolved.accountNumber!);
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    tx.transfer.update.mockRejectedValueOnce(new Error("write rejected"));
    expect(await linkAssetMapToTransfer("t1", accountId)).toMatchObject({ ok: false });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("unlinkAssetMapFromTransfer", () => {
  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY", "UNKNOWN", undefined])(
    "rejects a %s caller before accessing the source link", async role => {
      flagSpy.mockReturnValue(true);
      authSpy.mockResolvedValue({ user: { email: "synthetic@example.test", role } });
      expect(await unlinkAssetMapFromTransfer("t1")).toMatchObject({ ok: false });
      expect(withUserScopeSpy).not.toHaveBeenCalled();
    },
  );

  it("flag OFF → WRITE_REJECTED, no scope", async () => {
    flagSpy.mockReturnValue(false);
    const res = await unlinkAssetMapFromTransfer("t1");
    expect(res).toMatchObject({ ok: false });
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it("flag ON + linked → clears the 3 columns + audits UNLINK", async () => {
    flagSpy.mockReturnValue(true);
    wireScope({ id: "t1", asset_map_folder_id: "folder_1" });

    const res = await unlinkAssetMapFromTransfer("t1");
    expect(res).toBeUndefined();

    const updateArg = tx.transfer.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateArg.data).toMatchObject({
      asset_map_folder_id: null,
      asset_map_custodian: null,
      asset_map_account_number: null,
    });
    expect(JSON.stringify(tx.auditLog.create.mock.calls[0][0])).toContain(TRANSFER_ASSET_MAP_UNLINK);
  });

  it("flag ON + already unlinked → no write, no audit", async () => {
    flagSpy.mockReturnValue(true);
    wireScope({ id: "t1", asset_map_folder_id: null });

    await unlinkAssetMapFromTransfer("t1");
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe.each([
  ["link", () => linkAssetMapToTransfer("t1", "00000000-0000-4000-8000-000000000238")],
  ["unlink", () => unlinkAssetMapFromTransfer("t1")],
] as const)("%s source context is limited to active Preparation", (_label, mutate) => {
  it.each([
    { stage: "IN_TRANSFER", archived_at: null },
    { stage: "FUNDED", archived_at: null },
    { stage: "DECISION", archived_at: new Date("2026-09-25T12:00:00Z") },
  ])("rejects %j without resolving source data or invalidating approval", async state => {
    flagSpy.mockReturnValue(true);
    wireScope({ id: "t1", asset_map_folder_id: "saved-source", ...state });
    expect(await mutate()).toMatchObject({ ok: false });
    expect(resolveAssignableSpy).not.toHaveBeenCalled();
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("loadAssignableAssetMapAccounts", () => {
  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY", "UNKNOWN"])(
    "%s cannot load the privileged picker", async role => {
      flagSpy.mockReturnValue(true);
      authSpy.mockResolvedValue({ user: { email: "synthetic@example.test", role } });
      expect(await loadAssignableAssetMapAccounts("3333")).toEqual({ ok: false });
      expect(listAssignableSpy).not.toHaveBeenCalled();
    },
  );
  it("flag OFF → { ok:false }, no read", async () => {
    flagSpy.mockReturnValue(false);
    const res = await loadAssignableAssetMapAccounts("3333");
    expect(res).toEqual({ ok: false });
    expect(listAssignableSpy).not.toHaveBeenCalled();
  });

  it("flag ON → { ok:true, recommended, others } from the read seam", async () => {
    flagSpy.mockReturnValue(true);
    listAssignableSpy.mockResolvedValue({
      recommended: [{ accountId: "opaque-1", sourceFolderId: "f", custodian: "Fidelity", accountNumberMasked: "••••3333" }],
      others: [],
    });
    const res = await loadAssignableAssetMapAccounts("3333", "t_current");
    expect(res).toMatchObject({ ok: true });
    expect(listAssignableSpy).toHaveBeenCalledWith(expect.anything(), {
      hrqjSbevsbySbin8: "3333",
      currentTransferId: "t_current",
    });
  });
});
