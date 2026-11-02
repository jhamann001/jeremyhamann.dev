import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// feat/transfer-archive-falloff — locks the archiveTransfer server action's
// wiring (the transfer-setstage-gate mock idiom): `@/auth`, `@/lib/rls`,
// `@/lib/flags` and Next's cache/navigation are mocked so the server action
// imports cleanly in the node env; `withUserScope` runs the real callback
// against a fake tx whose transfer.update / auditLog.create are spies. Asserts:
// flag OFF → WRITE_REJECTED with NO scope opened; VIEWER → WRITE_REJECTED (the
// app-side canWriteTransfers gate, fail closed) with NO scope opened; already
// archived → explicit refusal, NO write, NO audit; success → archived_at/by/
// reason='manual' + updated_by stamped, one transfer.archive audit row in the
// SAME tx, then revalidate + redirect to /asset-transfer. The pure banner
// mapper (archivedReasonLabel) is pinned at the bottom.

const { authSpy, withUserScopeSpy, archiveFlagSpy, redirectSpy, revalidateSpy } =
  vi.hoisted(() => ({
    authSpy: vi.fn(),
    withUserScopeSpy: vi.fn(),
    archiveFlagSpy: vi.fn(),
    redirectSpy: vi.fn(),
    revalidateSpy: vi.fn(),
  }));

// actions.ts transitively imports a server-only data seam (transfer-asset-map);
// stub it so this node-env test can import the module.
vi.mock("server-only", () => ({}));

vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
// PARTIAL mock of @/lib/flags: every flag actions.ts calls must exist here, or
// the && short-circuits throw "not a function" (the setstage-gate lesson).
vi.mock("@/lib/flags", () => ({
  assetTransferWorkspaceEnabled: () => false,
  transferDealSourcedRedesignEnabled: () => false,
  assetMapTransferLinkEnabled: () => false,
  checklistStageGateEnabled: () => false,
  slackCloseoutEnabled: () => false,
  transferArchiveActionEnabled: archiveFlagSpy,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

import { archiveTransfer } from "@/app/(authenticated)/asset-transfer/actions";
import { TRANSFER_ARCHIVE } from "@/lib/audit";
import {
  archivedReasonLabel,
  MANUAL_ARCHIVE_REASON,
} from "@/lib/data/transfer-archive";

type FakeTx = {
  transfer: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

const LIVE_ROW = {
  id: "t1",
  stage: "DECISION",
  value: "1000.00",
  archived_at: null,
  archived_by: null,
  archived_reason: null,
};

let tx: FakeTx;

beforeEach(() => {
  authSpy.mockResolvedValue({
    user: { email: "ops@example.com", role: "OPERATIONS" },
  });
  archiveFlagSpy.mockReturnValue(true);
  tx = {
    transfer: {
      findUnique: vi.fn().mockResolvedValue(LIVE_ROW),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  withUserScopeSpy.mockImplementation(
    async (_identity: unknown, fn: (t: FakeTx) => unknown) => fn(tx),
  );
});

afterEach(() => vi.clearAllMocks());

describe("archiveTransfer — gates", () => {
  it("flag OFF → WRITE_REJECTED before auth or any scope (ships dark)", async () => {
    archiveFlagSpy.mockReturnValue(false);
    const res = await archiveTransfer("t1");
    expect(res && res.ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
    expect(authSpy).not.toHaveBeenCalled();
  });

  it("VIEWER → WRITE_REJECTED without opening a scope (canWriteTransfers, fail closed)", async () => {
    authSpy.mockResolvedValue({
      user: { email: "viewer@example.com", role: "VIEWER" },
    });
    const res = await archiveTransfer("t1");
    expect(res && res.ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it("missing role → treated as VIEWER → WRITE_REJECTED", async () => {
    authSpy.mockResolvedValue({ user: { email: "x@example.com" } });
    const res = await archiveTransfer("t1");
    expect(res && res.ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it("vanished row → WRITE_REJECTED, no write, no audit", async () => {
    tx.transfer.findUnique.mockResolvedValue(null);
    const res = await archiveTransfer("t1");
    expect(res && res.ok).toBe(false);
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("already archived → explicit refusal (owner spec), NO write, NO audit", async () => {
    tx.transfer.findUnique.mockResolvedValue({
      ...LIVE_ROW,
      archived_at: new Date("2026-07-01"),
      archived_reason: "deal_lost",
    });
    const res = await archiveTransfer("t1");
    expect(res && res.ok).toBe(false);
    expect(res && !res.ok && res.errors[0]?.message).toMatch(
      /already archived/i,
    );
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("an RLS rejection (update throws) → WRITE_REJECTED, never a 500", async () => {
    tx.transfer.update.mockRejectedValue(new Error("RLS"));
    const res = await archiveTransfer("t1");
    expect(res && res.ok).toBe(false);
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});

describe("archiveTransfer — success path", () => {
  it("stamps archived_at/by/reason='manual' + updated_by, audits transfer.archive in the same tx, revalidates, redirects to the board", async () => {
    const res = await archiveTransfer("t1");
    expect(res).toBeUndefined(); // success exits via redirect

    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
    const update = tx.transfer.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: "t1" });
    expect(update.data.archived_at).toBeInstanceOf(Date);
    expect(update.data.archived_by).toBe("ops@example.com");
    expect(update.data.archived_reason).toBe(MANUAL_ARCHIVE_REASON);
    expect(update.data.updated_by).toBe("ops@example.com");

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe(TRANSFER_ARCHIVE);
    expect(audit.entityType).toBe("transfer");
    expect(audit.entityId).toBe("t1");
    // Detail is enums + numbers only (ADR-5) — never a client name.
    expect(JSON.parse(audit.detail)).toEqual({
      stage: "DECISION",
      value: 1000,
      reason: MANUAL_ARCHIVE_REASON,
    });

    expect(revalidateSpy).toHaveBeenCalledWith("/asset-transfer");
    expect(revalidateSpy).toHaveBeenCalledWith("/asset-transfer/t1");
    expect(redirectSpy).toHaveBeenCalledWith("/asset-transfer");
  });
});

describe("archivedReasonLabel — the detail banner's friendly text", () => {
  it("maps the three reconciler stamps", () => {
    expect(archivedReasonLabel("deal_lost", null)).toBe(
      "the linked deal was marked Lost",
    );
    expect(archivedReasonLabel("uncommitted", null)).toBe(
      "the linked deal returned to Potential",
    );
    expect(archivedReasonLabel("deal_gone", null)).toBe(
      "the linked deal was removed from the pipeline",
    );
  });

  it("manual carries the archiver when known", () => {
    expect(archivedReasonLabel("manual", "ops@example.com")).toBe(
      "archived by ops@example.com",
    );
    expect(archivedReasonLabel("manual", null)).toBe("archived manually");
  });

  it("an unknown stamp shows verbatim (audit surface — never hidden); null stays null", () => {
    expect(archivedReasonLabel("mystery_reason", null)).toBe("mystery_reason");
    expect(archivedReasonLabel(null, null)).toBeNull();
  });
});
