import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { LINK_ERRORS } from "@/lib/data/acat-link";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), scope: vi.fn(), revalidate: vi.fn(), redirect: vi.fn(), tracker: vi.fn(), signal: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: mocks.scope }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/data/clients", () => ({ listClients: vi.fn() }));
vi.mock("@/lib/data/households", () => ({ listHouseholds: vi.fn() }));
vi.mock("@/lib/data/transfers", () => ({ listTransfers: vi.fn() }));
vi.mock("@/lib/data/acat-status", () => ({
  getAcatStatus: mocks.tracker, getAcatStatusByRecordId: mocks.tracker,
}));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: mocks.signal }));

import { unlinkAcatFromExistingTransfer } from "@/app/(authenticated)/acat-tracking/actions";

const expectedAcat = { recordId: "synthetic-record", acatTransferId: "ACAT-synthetic" };
const transferId = "synthetic-transfer";
const current = {
  id: transferId,
  acat_record_id: expectedAcat.recordId as string | null,
  acat_transfer_id: expectedAcat.acatTransferId as string | null,
  archived_at: null as Date | null,
  acat_link_version: 7,
};
const sessionFor = (role?: string) => ({ user: { role, email: "synthetic@example.test" } });

function transaction(row: typeof current | null = current) {
  const tx = {
    transfer: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn(async () => ({ id: "synthetic-audit" })) },
  };
  mocks.scope.mockImplementation(async (_identity: unknown, fn: (scope: typeof tx) => Promise<unknown>) => fn(tx));
  return tx;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockReset();
  mocks.scope.mockReset();
  mocks.tracker.mockRejectedValue(new Error("synthetic tracker outage"));
});

describe("unlinkAcatFromExistingTransfer", () => {
  it.each([null, sessionFor(), sessionFor("VIEWER"), sessionFor("ADVISOR"), sessionFor("CLIENT_SERVICE"), sessionFor("unknown")])(
    "rejects unauthorized or expired sessions without opening a scope or redirecting: %j", async (session) => {
      mocks.auth.mockResolvedValue(session);
      expect(await unlinkAcatFromExistingTransfer(transferId, expectedAcat)).toEqual({
        ok: false, errors: [{ field: "form", message: "You do not have permission to unlink ACATs." }],
      });
      expect(mocks.scope).not.toHaveBeenCalled();
      expect(mocks.tracker).not.toHaveBeenCalled();
      expect(mocks.revalidate).not.toHaveBeenCalled();
      expect(mocks.redirect).not.toHaveBeenCalled();
    },
  );

  it.each(["ADMIN", "OPERATIONS"])("runs the unlink and audit in one user-scoped transaction for %s without consulting the tracker", async (role) => {
    mocks.auth.mockResolvedValue(sessionFor(role));
    const tx = transaction();
    expect(await unlinkAcatFromExistingTransfer(transferId, expectedAcat)).toEqual({ ok: true });
    expect(mocks.scope).toHaveBeenCalledExactlyOnceWith({ role, email: "synthetic@example.test" }, expect.any(Function));
    expect(tx.transfer.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate.mock.calls).toEqual([
      ["/acat-tracking"], ["/asset-transfer"], [`/asset-transfer/${transferId}`],
    ]);
    expect(mocks.tracker).not.toHaveBeenCalled();
    expect(mocks.signal).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("passes through stale-link errors without invalidation or redirects", async () => {
    mocks.auth.mockResolvedValue(sessionFor("OPERATIONS"));
    const tx = transaction({ ...current, acat_record_id: "different-record" });
    expect(await unlinkAcatFromExistingTransfer(transferId, expectedAcat))
      .toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] });
    expect(tx.transfer.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("refreshes an already-cleared link without writing or auditing it again", async () => {
    mocks.auth.mockResolvedValue(sessionFor("OPERATIONS"));
    const tx = transaction({ ...current, acat_record_id: null, acat_transfer_id: null });
    expect(await unlinkAcatFromExistingTransfer(transferId, expectedAcat)).toEqual({ ok: true });
    expect(tx.transfer.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.revalidate.mock.calls).toEqual([
      ["/acat-tracking"], ["/asset-transfer"], [`/asset-transfer/${transferId}`],
    ]);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("rejects an audit failure inside the transaction and leaves the committed link intact", async () => {
    mocks.auth.mockResolvedValue(sessionFor("OPERATIONS"));
    const committed = { ...current };
    const staged = { ...current };
    const tx = transaction(staged);
    tx.transfer.findUnique.mockImplementation(async () => ({ ...staged }));
    tx.transfer.updateMany.mockImplementation(async (args?: unknown) => {
      Object.assign(staged, (args as { data: Partial<typeof staged> }).data);
      return { count: 1 };
    });
    tx.auditLog.create.mockRejectedValueOnce(new Error("sensitive synthetic audit failure"));
    const commit = vi.fn(() => Object.assign(committed, staged));
    // Model the transaction boundary: only a resolved callback commits. This
    // proves the action does not catch the audit failure inside that boundary.
    mocks.scope.mockImplementation(async (_identity: unknown, fn: (scope: typeof tx) => Promise<unknown>) => {
      const result = await fn(tx);
      commit();
      return result;
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await unlinkAcatFromExistingTransfer(transferId, expectedAcat)).toEqual({
        ok: false, errors: [{ field: "form", message: "Unlink failed. Refresh the page and try again." }],
      });
      expect(tx.transfer.updateMany).toHaveBeenCalledTimes(1);
      expect(staged.acat_record_id).toBeNull();
      expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      expect(committed).toEqual(current);
      expect(log).toHaveBeenCalledExactlyOnceWith("[acat-link] unlink_failed");
      expect(mocks.revalidate).not.toHaveBeenCalled();
      expect(mocks.tracker).not.toHaveBeenCalled();
      expect(mocks.signal).not.toHaveBeenCalled();
      expect(mocks.redirect).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("rejects an invisible transfer through the scoped read", async () => {
    mocks.auth.mockResolvedValue(sessionFor("OPERATIONS"));
    const tx = transaction(null);
    expect(await unlinkAcatFromExistingTransfer(transferId, expectedAcat))
      .toEqual({ ok: false, errors: [LINK_ERRORS.TRANSFER_NOT_FOUND] });
    expect(tx.transfer.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("returns an inline error for a transaction/RLS rejection without invalidating or leaking the error", async () => {
    mocks.auth.mockResolvedValue(sessionFor("OPERATIONS"));
    mocks.scope.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("sensitive database detail", {
      code: "P2010", clientVersion: "test", meta: { code: "42501" },
    }));
    expect(await unlinkAcatFromExistingTransfer(transferId, expectedAcat)).toEqual({
      ok: false, errors: [{ field: "form", message: "Unlink failed. Refresh the page and try again." }],
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
