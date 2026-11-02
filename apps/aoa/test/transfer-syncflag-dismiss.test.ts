import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// transfer-syncflag-surface — locks the dismissSyncFlag server action's wiring
// (the transfer-archive-action mock idiom): `@/auth`, `@/lib/rls`, `@/lib/flags`
// and Next's cache/navigation are mocked so the server action imports cleanly in
// the node env; `withUserScope` runs the real callback against a fake tx whose
// transfer.update / auditLog.create are spies. Asserts: VIEWER → WRITE_REJECTED
// (canWriteTransfers, fail closed) with NO scope opened; vanished row →
// WRITE_REJECTED; no flag set → explicit refusal, NO write, NO audit; success →
// sync_flag: null + updated_by stamped, one transfer.sync_flag_dismiss audit row
// ({ cleared_flag }) in the SAME tx, revalidate both surfaces, NO redirect (the
// user stays on the detail page). The action is UNGATED (no feature flag — it
// only clears review state the reconciler already wrote). The pure banner/chip
// mapper (syncFlagLabel) is pinned at the bottom.

const { authSpy, withUserScopeSpy, redirectSpy, revalidateSpy } = vi.hoisted(
  () => ({
    authSpy: vi.fn(),
    withUserScopeSpy: vi.fn(),
    redirectSpy: vi.fn(),
    revalidateSpy: vi.fn(),
  }),
);

// actions.ts transitively imports a server-only data seam (transfer-asset-map);
// stub it so this node-env test can import the module.
vi.mock("server-only", () => ({}));

vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
// PARTIAL mock of @/lib/flags: every flag actions.ts calls must exist here, or
// the && short-circuits throw "not a function" (the setstage-gate lesson).
// dismissSyncFlag itself calls NO flag — deliberately ungated.
vi.mock("@/lib/flags", () => ({
  transferDealSourcedRedesignEnabled: () => false,
  assetMapTransferLinkEnabled: () => false,
  checklistStageGateEnabled: () => false,
  slackCloseoutEnabled: () => false,
  transferArchiveActionEnabled: () => false,
  assetTransferWorkspaceEnabled: () => false,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

import { dismissSyncFlag } from "@/app/(authenticated)/asset-transfer/actions";
import { TRANSFER_SYNC_FLAG_DISMISS } from "@/lib/audit";
import { syncFlagLabel } from "@/lib/data/transfer-archive";

type FakeTx = {
  transfer: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

const FLAGGED_ROW = {
  id: "t1",
  stage: "IN_TRANSFER",
  sync_flag: "uncommitted_review",
  archived_at: null,
};

let tx: FakeTx;

beforeEach(() => {
  authSpy.mockResolvedValue({
    user: { email: "ops@example.com", role: "OPERATIONS" },
  });
  tx = {
    transfer: {
      findUnique: vi.fn().mockResolvedValue(FLAGGED_ROW),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  withUserScopeSpy.mockImplementation(
    async (_identity: unknown, fn: (t: FakeTx) => unknown) => fn(tx),
  );
});

afterEach(() => vi.clearAllMocks());

describe("dismissSyncFlag — gates", () => {
  it("VIEWER → WRITE_REJECTED without opening a scope (canWriteTransfers, fail closed)", async () => {
    authSpy.mockResolvedValue({
      user: { email: "viewer@example.com", role: "VIEWER" },
    });
    const res = await dismissSyncFlag("t1");
    expect(res && res.ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it("missing role → treated as VIEWER → WRITE_REJECTED", async () => {
    authSpy.mockResolvedValue({ user: { email: "x@example.com" } });
    const res = await dismissSyncFlag("t1");
    expect(res && res.ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it("vanished row → WRITE_REJECTED, no write, no audit", async () => {
    tx.transfer.findUnique.mockResolvedValue(null);
    const res = await dismissSyncFlag("t1");
    expect(res && res.ok).toBe(false);
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("no flag set → explicit refusal, NO write, NO audit (a second dismisser learns it's gone)", async () => {
    tx.transfer.findUnique.mockResolvedValue({
      ...FLAGGED_ROW,
      sync_flag: null,
    });
    const res = await dismissSyncFlag("t1");
    expect(res && res.ok).toBe(false);
    expect(res && !res.ok && res.errors[0]?.message).toMatch(
      /no review flag/i,
    );
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("an RLS rejection (update throws) → WRITE_REJECTED, never a 500", async () => {
    tx.transfer.update.mockRejectedValue(new Error("RLS"));
    const res = await dismissSyncFlag("t1");
    expect(res && res.ok).toBe(false);
    expect(revalidateSpy).not.toHaveBeenCalled();
  });
});

describe("dismissSyncFlag — success path", () => {
  it("clears sync_flag + stamps updated_by, audits transfer.sync_flag_dismiss {cleared_flag} in the same tx, revalidates, stays on the page", async () => {
    const res = await dismissSyncFlag("t1");
    expect(res).toBeUndefined();

    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
    const update = tx.transfer.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: "t1" });
    expect(update.data).toEqual({
      sync_flag: null,
      updated_by: "ops@example.com",
    });

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe(TRANSFER_SYNC_FLAG_DISMISS);
    expect(audit.entityType).toBe("transfer");
    expect(audit.entityId).toBe("t1");
    // Detail is the enum stamp only (ADR-5) — never a client name.
    expect(JSON.parse(audit.detail)).toEqual({
      cleared_flag: "uncommitted_review",
    });

    expect(revalidateSpy).toHaveBeenCalledWith("/asset-transfer");
    expect(revalidateSpy).toHaveBeenCalledWith("/asset-transfer/t1");
    expect(redirectSpy).not.toHaveBeenCalled(); // stay on the detail page
  });

  it("audits the orphan_review stamp verbatim when that is what was cleared", async () => {
    tx.transfer.findUnique.mockResolvedValue({
      ...FLAGGED_ROW,
      sync_flag: "orphan_review",
    });
    await dismissSyncFlag("t1");
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(JSON.parse(audit.detail)).toEqual({ cleared_flag: "orphan_review" });
  });
});

describe("syncFlagLabel — the banner/chip friendly text", () => {
  it("maps the two reconciler stamps to the locked review copy", () => {
    expect(syncFlagLabel("uncommitted_review")).toBe(
      "The linked deal moved back to Potential — review whether this transfer should stay on the board.",
    );
    expect(syncFlagLabel("orphan_review")).toBe(
      "The linked deal was removed — review whether this transfer should stay on the board.",
    );
  });

  it("an unknown stamp renders a generic prompt that still shows the raw value (audit surface); null stays null", () => {
    expect(syncFlagLabel("mystery_flag")).toBe(
      "This transfer was flagged for review (mystery_flag) — review whether it should stay on the board.",
    );
    expect(syncFlagLabel(null)).toBeNull();
  });
});
