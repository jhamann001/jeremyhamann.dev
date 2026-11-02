import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// confirmLink / rejectLink server-action WIRING (P2.3), WITHOUT a DB. The gate
// (auth + canReviewAssetMapLinks), the ops-scoped write (updateLinkDecision), the
// client validation (resolveClientForLink), and the audit are exercised with
// @/auth, @/lib/rls, the two seams, @/lib/audit, @/lib/data/clients, and next
// cache/navigation MOCKED — so the REAL gate predicate runs and we assert the
// confirm→CONFIRMED / reject→REJECTED / VIEWER-blocked / invalid-client-blocked
// paths. Follows the acat-lane-actions.test.ts idiom.

const {
  authSpy,
  withUserScopeSpy,
  updateLinkDecisionSpy,
  resolveClientSpy,
  writeAuditSpy,
  listClientsSpy,
  revalidateSpy,
  redirectSpy,
} = vi.hoisted(() => ({
  authSpy: vi.fn(),
  withUserScopeSpy: vi.fn(),
  updateLinkDecisionSpy: vi.fn(),
  resolveClientSpy: vi.fn(),
  writeAuditSpy: vi.fn(async () => {}),
  listClientsSpy: vi.fn(),
  revalidateSpy: vi.fn(),
  redirectSpy: vi.fn(() => {
    throw new Error("REDIRECT");
  }),
}));

vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
vi.mock("@/lib/data/asset-map-link", () => ({
  updateLinkDecision: updateLinkDecisionSpy,
  getLink: vi.fn(),
}));
vi.mock("@/lib/data/asset-map-review", () => ({
  resolveClientForLink: resolveClientSpy,
  resolveMemberForAccountLink: vi.fn(),
}));
// actions.ts now also imports the P2.5 account-link seam (which pulls "server-only");
// stub it so the module loads (confirmLink/rejectLink here never call it).
vi.mock("@/lib/data/asset-map-account-link", () => ({
  replaceAccountOwnerDecision: vi.fn(),
  rejectAccountOwners: vi.fn(),
}));
vi.mock("@/lib/data/clients", () => ({ listClients: listClientsSpy }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditSpy };
});
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

import {
  confirmLink,
  rejectLink,
  loadReviewClients,
} from "@/app/(authenticated)/asset-mapping-review/actions";
import {
  ASSET_MAP_LINK_CONFIRM,
  ASSET_MAP_LINK_REJECT,
} from "@/lib/audit";

const sessionFor = (role: string | undefined) => ({
  user: { email: "ops@example.com", ...(role !== undefined ? { role } : {}) },
});

// Run the withUserScope callback against a bare fake tx (the seams it calls are
// mocked, so the tx is never really touched).
function scopeRuns() {
  withUserScopeSpy.mockImplementation(
    async (_id: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  );
}

beforeEach(() => {
  authSpy.mockReset();
  withUserScopeSpy.mockReset();
  updateLinkDecisionSpy.mockReset();
  resolveClientSpy.mockReset();
  writeAuditSpy.mockClear();
  listClientsSpy.mockReset();
  revalidateSpy.mockClear();
  redirectSpy.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("confirmLink — gate", () => {
  it("blocks ADVISOR / CLIENT_SERVICE / VIEWER (no scope, no write, no audit)", async () => {
    for (const role of ["ADVISOR", "CLIENT_SERVICE", "VIEWER"]) {
      authSpy.mockResolvedValue(sessionFor(role));
      const res = await confirmLink("f1", "c1");
      expect(res.ok).toBe(false);
    }
    expect(withUserScopeSpy).not.toHaveBeenCalled();
    expect(updateLinkDecisionSpy).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("blocks the role-default path (session with no role → VIEWER)", async () => {
    authSpy.mockResolvedValue(sessionFor(undefined));
    const res = await confirmLink("f1", "c1");
    expect(res.ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });
});

describe("confirmLink — write", () => {
  beforeEach(() => {
    authSpy.mockResolvedValue(sessionFor("OPERATIONS"));
    scopeRuns();
  });

  it("valid client → CONFIRMED with resolved ids + confirmed_by + same-tx audit", async () => {
    resolveClientSpy.mockResolvedValue({
      clientSfId: "003AAA",
      householdSfId: "001HHH",
      cedarRidgeUserId: "crw_1",
    });
    updateLinkDecisionSpy.mockResolvedValue(1);

    const res = await confirmLink("folder_needs", "003AAA");
    expect(res).toEqual({ ok: true });

    expect(updateLinkDecisionSpy).toHaveBeenCalledTimes(1);
    const arg = updateLinkDecisionSpy.mock.calls[0][1];
    expect(arg).toMatchObject({
      sourceFolderId: "folder_needs",
      matchStatus: "CONFIRMED",
      clientSfId: "003AAA",
      householdSfId: "001HHH",
      cedarRidgeUserId: "crw_1",
      confirmedBy: "ops@example.com",
    });
    expect(arg.confirmedAt).toBeInstanceOf(Date);

    // Audit: human action, ids/enum only — NO client name in the detail.
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    const [, identity, entry] = writeAuditSpy.mock.calls[0] as unknown as [
      unknown,
      { role?: string; email?: string },
      { action: string; entityType: string; entityId: string; detail: unknown },
    ];
    expect(identity).toMatchObject({ role: "OPERATIONS", email: "ops@example.com" });
    expect(entry.action).toBe(ASSET_MAP_LINK_CONFIRM);
    expect(entry.entityType).toBe("asset_map_link");
    expect(entry.entityId).toBe("folder_needs");
    expect(entry.detail).toEqual({
      status: "CONFIRMED",
      clientSfId: "003AAA",
      householdSfId: "001HHH",
    });
    expect(JSON.stringify(entry.detail)).not.toContain("Smith");

    expect(revalidateSpy).toHaveBeenCalledWith("/asset-mapping-review");
  });

  it("confirming an AUTO_LINKED item (ops sign-off / override) → CONFIRMED", async () => {
    // The action is status-agnostic — an AUTO_LINKED row is confirmed the same
    // way, graduating it to CONFIRMED (preserved by future matcher runs).
    resolveClientSpy.mockResolvedValue({
      clientSfId: "003BBB",
      householdSfId: "001KKK",
      cedarRidgeUserId: "crw_2",
    });
    updateLinkDecisionSpy.mockResolvedValue(1);

    const res = await confirmLink("folder_auto", "003BBB");
    expect(res).toEqual({ ok: true });
    expect(updateLinkDecisionSpy.mock.calls[0][1]).toMatchObject({
      sourceFolderId: "folder_auto",
      matchStatus: "CONFIRMED",
      clientSfId: "003BBB",
    });
  });

  it("invalid / unresolvable client → REJECTED (no write, no audit)", async () => {
    resolveClientSpy.mockResolvedValue(null); // not a real mirror.client
    const res = await confirmLink("folder_needs", "003ZZZ");
    expect(res.ok).toBe(false);
    expect(updateLinkDecisionSpy).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("0 rows updated (vanished row / RLS denied) → REJECTED (no audit)", async () => {
    resolveClientSpy.mockResolvedValue({
      clientSfId: "003AAA",
      householdSfId: null,
      cedarRidgeUserId: null,
    });
    updateLinkDecisionSpy.mockResolvedValue(0);
    const res = await confirmLink("folder_needs", "003AAA");
    expect(res.ok).toBe(false);
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("empty folder id or client id → REJECTED without opening a scope", async () => {
    expect((await confirmLink("", "c1")).ok).toBe(false);
    expect((await confirmLink("f1", "")).ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });
});

describe("rejectLink", () => {
  beforeEach(() => {
    authSpy.mockResolvedValue(sessionFor("ADMIN"));
    scopeRuns();
  });

  it("→ REJECTED with cleared ids + confirmed_by + same-tx audit", async () => {
    updateLinkDecisionSpy.mockResolvedValue(1);
    const res = await rejectLink("folder_needs");
    expect(res).toEqual({ ok: true });

    const arg = updateLinkDecisionSpy.mock.calls[0][1];
    expect(arg).toMatchObject({
      sourceFolderId: "folder_needs",
      matchStatus: "REJECTED",
      clientSfId: null,
      cedarRidgeUserId: null,
      householdSfId: null,
      confirmedBy: "ops@example.com",
    });

    const [, , entry] = writeAuditSpy.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { action: string; entityType: string; entityId: string; detail: unknown },
    ];
    expect(entry.action).toBe(ASSET_MAP_LINK_REJECT);
    expect(entry.entityId).toBe("folder_needs");
    expect(entry.detail).toEqual({ status: "REJECTED" });
    expect(revalidateSpy).toHaveBeenCalledWith("/asset-mapping-review");
  });

  it("blocks VIEWER (no scope, no write)", async () => {
    authSpy.mockResolvedValue(sessionFor("VIEWER"));
    const res = await rejectLink("folder_needs");
    expect(res.ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
    expect(updateLinkDecisionSpy).not.toHaveBeenCalled();
  });

  it("0 rows → REJECTED (no audit)", async () => {
    updateLinkDecisionSpy.mockResolvedValue(0);
    const res = await rejectLink("folder_gone");
    expect(res.ok).toBe(false);
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });
});

describe("loadReviewClients — gated free-search read", () => {
  it("forbidden for non-ops (never reads clients)", async () => {
    authSpy.mockResolvedValue(sessionFor("ADVISOR"));
    const res = await loadReviewClients();
    expect(res).toEqual({ ok: false, reason: "forbidden" });
    expect(listClientsSpy).not.toHaveBeenCalled();
  });

  it("ops → maps the visible clients", async () => {
    authSpy.mockResolvedValue(sessionFor("OPERATIONS"));
    listClientsSpy.mockResolvedValue([
      { sf_id: "c1", name: "Norene Pruitt", household_name: "Smith Household" },
    ]);
    const res = await loadReviewClients();
    expect(res).toEqual({
      ok: true,
      clients: [{ sfId: "c1", name: "Norene Pruitt", householdName: "Smith Household" }],
    });
  });
});
