import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// confirmAccountOwners / rejectAccount server-action WIRING (P2.5), WITHOUT a DB.
// The gate (auth + canReviewAssetMapLinks), the ops-scoped writes
// (replaceAccountOwnerDecision / rejectAccountOwners), the membership validation
// (resolveMemberForAccountLink), the folder-link read (getLink) and the audit are
// mocked — so the REAL gate predicate runs and we assert multi-owner /
// all-or-nothing / entity / D-j / reject paths. Follows the
// asset-map-review-actions.test.ts hoisted-mock idiom.

const {
  authSpy,
  withUserScopeSpy,
  getLinkSpy,
  updateLinkSpy,
  resolveClientSpy,
  resolveAccountSpy,
  resolveMemberSpy,
  replaceDecisionSpy,
  rejectOwnersSpy,
  writeAuditSpy,
  revalidateSpy,
  redirectSpy,
} = vi.hoisted(() => ({
  authSpy: vi.fn(),
  withUserScopeSpy: vi.fn(),
  getLinkSpy: vi.fn(),
  updateLinkSpy: vi.fn(),
  resolveClientSpy: vi.fn(),
  resolveAccountSpy: vi.fn(),
  resolveMemberSpy: vi.fn(),
  replaceDecisionSpy: vi.fn(),
  rejectOwnersSpy: vi.fn(),
  writeAuditSpy: vi.fn(async () => {}),
  revalidateSpy: vi.fn(),
  redirectSpy: vi.fn(() => {
    throw new Error("REDIRECT");
  }),
}));

vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
vi.mock("@/lib/data/asset-map-link", () => ({
  getLink: getLinkSpy,
  updateLinkDecision: updateLinkSpy,
}));
vi.mock("@/lib/data/asset-map-account-link", () => ({
  replaceAccountOwnerDecision: replaceDecisionSpy,
  rejectAccountOwners: rejectOwnersSpy,
}));
vi.mock("@/lib/data/asset-map-review", () => ({
  resolveClientForLink: resolveClientSpy,
  resolveAccountForReview: resolveAccountSpy,
  resolveMemberForAccountLink: resolveMemberSpy,
}));
vi.mock("@/lib/data/clients", () => ({ listClients: vi.fn() }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditSpy };
});
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

import {
  confirmAccountOwners,
  rejectAccount,
} from "@/app/(authenticated)/asset-mapping-review/actions";
import {
  ASSET_MAP_ACCOUNT_CONFIRM,
  ASSET_MAP_ACCOUNT_REJECT,
  ASSET_MAP_LINK_CONFIRM,
} from "@/lib/audit";

const sessionFor = (role: string | undefined) => ({
  user: { email: "ops@example.com", ...(role !== undefined ? { role } : {}) },
});

function scopeRuns() {
  withUserScopeSpy.mockImplementation(
    async (_id: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(TX),
  );
}

const ACCOUNT_ID = "opaque-review-account";
const RAW_ACCOUNT = "SYNTHETIC-11001234";
const TX = {};
const accountKey = {
  sourceFolderId: "folder_x",
  custodian: "Fidelity",
  accountNumber: RAW_ACCOUNT,
};

// A resolved folder link (account grain only exists beneath one).
const resolvedLink = { matchStatus: "AUTO_LINKED", householdSfId: "h1" };

beforeEach(() => {
  authSpy.mockReset();
  withUserScopeSpy.mockReset();
  getLinkSpy.mockReset();
  updateLinkSpy.mockReset();
  resolveClientSpy.mockReset();
  resolveAccountSpy.mockReset();
  resolveAccountSpy.mockResolvedValue(accountKey);
  resolveMemberSpy.mockReset();
  replaceDecisionSpy.mockReset();
  rejectOwnersSpy.mockReset();
  writeAuditSpy.mockClear();
  revalidateSpy.mockClear();
  redirectSpy.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("confirmAccountOwners — gate", () => {
  it("blocks ADVISOR / CLIENT_SERVICE / VIEWER / undefined-role (no scope, no write, no audit)", async () => {
    for (const role of ["ADVISOR", "CLIENT_SERVICE", "VIEWER", undefined]) {
      authSpy.mockResolvedValue(sessionFor(role));
      const res = await confirmAccountOwners(ACCOUNT_ID, ["cA"], false);
      expect(res.ok).toBe(false);
    }
    expect(withUserScopeSpy).not.toHaveBeenCalled();
    expect(resolveAccountSpy).not.toHaveBeenCalled();
    expect(replaceDecisionSpy).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });
});

describe("confirmAccountOwners — empty inputs", () => {
  beforeEach(() => authSpy.mockResolvedValue(sessionFor("OPERATIONS")));

  it("empty account ID or non-entity with no chosen → false without a scope", async () => {
    expect((await confirmAccountOwners("", ["cA"], false)).ok).toBe(false);
    expect((await confirmAccountOwners(ACCOUNT_ID, [], false)).ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });
});

describe("confirmAccountOwners — write", () => {
  beforeEach(() => {
    authSpy.mockResolvedValue(sessionFor("OPERATIONS"));
    scopeRuns();
    getLinkSpy.mockResolvedValue(resolvedLink);
  });

  it("two valid members → two JOINT owners + same-tx audit (ownerCount:2, no number/name)", async () => {
    resolveMemberSpy.mockImplementation(async (_tx: unknown, sfId: string) => ({
      clientSfId: sfId,
      householdSfId: "h1",
      cedarRidgeUserId: sfId === "cA" ? "eA" : "eB",
    }));
    replaceDecisionSpy.mockResolvedValue(2);

    const res = await confirmAccountOwners(ACCOUNT_ID, ["cA", "cB"], false);
    expect(res).toEqual({ ok: true });

    expect(resolveAccountSpy).toHaveBeenCalledWith(TX, ACCOUNT_ID);
    expect(getLinkSpy).toHaveBeenCalledWith(TX, accountKey.sourceFolderId);
    expect(replaceDecisionSpy.mock.calls[0][0]).toBe(TX);
    expect((writeAuditSpy.mock.calls[0] as unknown[])[0]).toBe(TX);
    const arg = (replaceDecisionSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(arg).toMatchObject({
      sourceFolderId: "folder_x",
      custodian: "Fidelity",
      accountNumber: RAW_ACCOUNT,
      isEntity: false,
    });
    expect(arg.owners).toEqual([
      { cedarRidgeUserId: "eA", clientSfId: "cA", ownershipRole: "JOINT" },
      { cedarRidgeUserId: "eB", clientSfId: "cB", ownershipRole: "JOINT" },
    ]);

    const entry = (writeAuditSpy.mock.calls[0] as unknown[])[2] as {
      action: string;
      entityType: string;
      entityId: string;
      detail: Record<string, unknown>;
    };
    expect(entry.action).toBe(ASSET_MAP_ACCOUNT_CONFIRM);
    expect(entry.entityType).toBe("asset_map_account_link");
    expect(entry.entityId).toBe("folder_x"); // durable folder id, NOT the account number
    expect(entry.detail).toMatchObject({
      status: "CONFIRMED",
      custodian: "Fidelity",
      ownerCount: 2,
      isEntity: false,
      clientSfIds: ["cA", "cB"],
      householdSfId: "h1",
    });
    const serialized = JSON.stringify(entry.detail);
    expect(serialized).not.toContain(RAW_ACCOUNT); // no account number in the audit
    expect(revalidateSpy).toHaveBeenCalledWith("/asset-mapping-review");
  });

  it("one chosen owner is not a household member (D-j) → false, no decision write (all-or-nothing)", async () => {
    resolveMemberSpy.mockImplementation(async (_tx: unknown, sfId: string) =>
      sfId === "cA" ? { clientSfId: "cA", householdSfId: "h1", cedarRidgeUserId: "eA" } : null,
    );

    const res = await confirmAccountOwners(ACCOUNT_ID, ["cA", "cB"], false);
    expect(res.ok).toBe(false);
    expect(replaceDecisionSpy).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("entity path → decision write with the entity (NULL person) row; audit ownerCount:0, isEntity:true", async () => {
    replaceDecisionSpy.mockResolvedValue(1);
    const res = await confirmAccountOwners(ACCOUNT_ID, [], true);
    expect(res).toEqual({ ok: true });
    expect(resolveMemberSpy).not.toHaveBeenCalled(); // no person resolution for an entity
    const arg = (replaceDecisionSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(arg).toMatchObject({ isEntity: true });
    expect(arg.owners).toEqual([]);
    const entry = (writeAuditSpy.mock.calls[0] as unknown[])[2] as { detail: Record<string, unknown> };
    expect(entry.detail).toMatchObject({ ownerCount: 0, isEntity: true, clientSfIds: [] });
  });

  it("partial write (n < owners.length) → false, no revalidate (all-or-nothing)", async () => {
    resolveMemberSpy.mockImplementation(async (_tx: unknown, sfId: string) => ({
      clientSfId: sfId,
      householdSfId: "h1",
      cedarRidgeUserId: `e_${sfId}`,
    }));
    replaceDecisionSpy.mockResolvedValue(1); // only 1 of 2 confirmed

    const res = await confirmAccountOwners(ACCOUNT_ID, ["cA", "cB"], false);
    expect(res.ok).toBe(false);
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("folder not resolved (link NEEDS_REVIEW / no household) → false", async () => {
    getLinkSpy.mockResolvedValue({ matchStatus: "NEEDS_REVIEW", householdSfId: null });
    resolveMemberSpy.mockResolvedValue({ clientSfId: "cA", householdSfId: "h1", cedarRidgeUserId: "eA" });
    const res = await confirmAccountOwners(ACCOUNT_ID, ["cA"], false);
    expect(res.ok).toBe(false);
    expect(replaceDecisionSpy).not.toHaveBeenCalled();
  });
});

describe("confirmAccountOwners — fold-in (unresolved folder)", () => {
  beforeEach(() => {
    authSpy.mockResolvedValue(sessionFor("OPERATIONS"));
    scopeRuns();
    // Folder is NOT resolved — the matcher left it NEEDS_REVIEW with no household.
    getLinkSpy.mockResolvedValue({ matchStatus: "NEEDS_REVIEW", householdSfId: null });
  });

  it("no householdClientSfId on an unresolved folder → false (can't attribute)", async () => {
    const res = await confirmAccountOwners(ACCOUNT_ID, ["cA"], false);
    expect(res.ok).toBe(false);
    expect(updateLinkSpy).not.toHaveBeenCalled();
    expect(replaceDecisionSpy).not.toHaveBeenCalled();
  });

  it("picks a client → resolves the folder link AND attributes the owner, both audited", async () => {
    resolveClientSpy.mockResolvedValue({
      clientSfId: "cA",
      householdSfId: "hNew",
      cedarRidgeUserId: "eA",
    });
    updateLinkSpy.mockResolvedValue(1); // folder link CONFIRMED
    resolveMemberSpy.mockResolvedValue({
      clientSfId: "cA",
      householdSfId: "hNew",
      cedarRidgeUserId: "eA",
    });
    replaceDecisionSpy.mockResolvedValue(1);

    const res = await confirmAccountOwners(
      ACCOUNT_ID,
      ["cA"],
      false,
      "cA",
    );
    expect(res).toEqual({ ok: true });

    // Folder resolved from the account row (the fold-in write).
    const folderArg = (updateLinkSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(folderArg).toMatchObject({
      sourceFolderId: "folder_x",
      matchStatus: "CONFIRMED",
      clientSfId: "cA",
      householdSfId: "hNew",
    });
    // Owner attributed against the just-resolved household.
    expect(resolveMemberSpy).toHaveBeenCalledWith(expect.anything(), "cA", "hNew");

    // TWO audit rows: the folder resolution + the account confirm.
    const actions = writeAuditSpy.mock.calls.map(
      (c) => (c as unknown[])[2] as { action: string; detail: Record<string, unknown> },
    );
    const folderAudit = actions.find((a) => a.action === ASSET_MAP_LINK_CONFIRM);
    const acctAudit = actions.find((a) => a.action === ASSET_MAP_ACCOUNT_CONFIRM);
    expect(folderAudit?.detail).toMatchObject({
      status: "CONFIRMED",
      clientSfId: "cA",
      householdSfId: "hNew",
      via: "account_fold_in",
    });
    expect(acctAudit?.detail).toMatchObject({ householdSfId: "hNew", ownerCount: 1 });
    expect(JSON.stringify(actions)).not.toContain(RAW_ACCOUNT); // no account number in audit
    expect(revalidateSpy).toHaveBeenCalledWith("/asset-mapping-review");
  });

  it("invalid household client (resolveClientForLink → null) → false, no folder/account write", async () => {
    resolveClientSpy.mockResolvedValue(null);
    const res = await confirmAccountOwners(ACCOUNT_ID, ["cA"], false, "bogus");
    expect(res.ok).toBe(false);
    expect(updateLinkSpy).not.toHaveBeenCalled();
    expect(replaceDecisionSpy).not.toHaveBeenCalled();
  });

  it("entity account under an unresolved folder: still binds the household, no owner", async () => {
    resolveClientSpy.mockResolvedValue({
      clientSfId: "cA",
      householdSfId: "hNew",
      cedarRidgeUserId: "eA",
    });
    updateLinkSpy.mockResolvedValue(1);
    replaceDecisionSpy.mockResolvedValue(1);

    const res = await confirmAccountOwners(ACCOUNT_ID, [], true, "cA");
    expect(res).toEqual({ ok: true });
    expect(resolveMemberSpy).not.toHaveBeenCalled(); // no person resolution for an entity
    const acctArg = (replaceDecisionSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(acctArg).toMatchObject({ isEntity: true });
    expect(acctArg.owners).toEqual([]);
  });
});

describe("rejectAccount", () => {
  beforeEach(() => {
    authSpy.mockResolvedValue(sessionFor("ADMIN"));
    scopeRuns();
  });

  it("→ REJECTED with same-tx audit (custodian + status only)", async () => {
    rejectOwnersSpy.mockResolvedValue(2);
    const res = await rejectAccount(ACCOUNT_ID);
    expect(res).toEqual({ ok: true });

    expect(resolveAccountSpy).toHaveBeenCalledWith(TX, ACCOUNT_ID);
    expect(rejectOwnersSpy.mock.calls[0][0]).toBe(TX);
    expect((writeAuditSpy.mock.calls[0] as unknown[])[0]).toBe(TX);
    const arg = (rejectOwnersSpy.mock.calls[0] as unknown[])[1];
    expect(arg).toMatchObject({
      sourceFolderId: "folder_x",
      custodian: "Fidelity",
      accountNumber: RAW_ACCOUNT,
      confirmedBy: "ops@example.com",
    });
    const entry = (writeAuditSpy.mock.calls[0] as unknown[])[2] as {
      action: string;
      entityId: string;
      detail: Record<string, unknown>;
    };
    expect(entry.action).toBe(ASSET_MAP_ACCOUNT_REJECT);
    expect(entry.entityId).toBe("folder_x");
    expect(entry.detail).toEqual({ status: "REJECTED", custodian: "Fidelity" });
    expect(JSON.stringify(entry.detail)).not.toContain(RAW_ACCOUNT);
    expect(revalidateSpy).toHaveBeenCalledWith("/asset-mapping-review");
  });

  it("0 rows → false, no audit", async () => {
    rejectOwnersSpy.mockResolvedValue(0);
    const res = await rejectAccount(ACCOUNT_ID);
    expect(res.ok).toBe(false);
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("blocks VIEWER (no scope, no write)", async () => {
    authSpy.mockResolvedValue(sessionFor("VIEWER"));
    const res = await rejectAccount(ACCOUNT_ID);
    expect(res.ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
    expect(resolveAccountSpy).not.toHaveBeenCalled();
    expect(rejectOwnersSpy).not.toHaveBeenCalled();
  });

  it("empty account ID → false without a scope", async () => {
    expect((await rejectAccount("")).ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });
});


describe("account actions — opaque references", () => {
  beforeEach(() => {
    authSpy.mockResolvedValue(sessionFor("OPERATIONS"));
    scopeRuns();
    getLinkSpy.mockResolvedValue(resolvedLink);
  });

  it.each(["missing", "stale", "out-of-scope"])(
    "%s reference fails before any folder or account mutation",
    async (reference) => {
      resolveAccountSpy.mockResolvedValue(null);
      const confirm = await confirmAccountOwners(reference, ["cA"], false, "cA");
      const reject = await rejectAccount(reference);
      expect(confirm.ok).toBe(false);
      expect(reject).toEqual(confirm);
      expect(resolveAccountSpy).toHaveBeenCalledWith(TX, reference);
      expect(getLinkSpy).not.toHaveBeenCalled();
      expect(updateLinkSpy).not.toHaveBeenCalled();
      expect(replaceDecisionSpy).not.toHaveBeenCalled();
      expect(rejectOwnersSpy).not.toHaveBeenCalled();
      expect(writeAuditSpy).not.toHaveBeenCalled();
      expect(revalidateSpy).not.toHaveBeenCalled();
    },
  );

  it("accounts sharing last four write the distinct server-resolved keys", async () => {
    const otherKey = {
      sourceFolderId: "folder_other",
      custodian: "Synthetic Custodian",
      accountNumber: "SYNTHETIC-99001234",
    };
    resolveAccountSpy.mockImplementation(async (_tx: unknown, accountId: string) =>
      accountId === ACCOUNT_ID ? accountKey : otherKey,
    );
    replaceDecisionSpy.mockResolvedValue(1);
    rejectOwnersSpy.mockResolvedValue(1);

    expect(await confirmAccountOwners(ACCOUNT_ID, [], true)).toEqual({ ok: true });
    expect(await confirmAccountOwners("other-opaque-id", [], true)).toEqual({ ok: true });
    expect(replaceDecisionSpy.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining(accountKey),
      expect.objectContaining(otherKey),
    ]);
    expect(await rejectAccount("other-opaque-id")).toEqual({ ok: true });
    expect(rejectOwnersSpy.mock.calls[0][1]).toMatchObject(otherKey);
    expect(JSON.stringify(writeAuditSpy.mock.calls)).not.toContain(RAW_ACCOUNT);
    expect(JSON.stringify(writeAuditSpy.mock.calls)).not.toContain(otherKey.accountNumber);
  });

  it("lookup errors return the generic failure without exposing the key in logs", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      resolveAccountSpy.mockRejectedValue(new Error(`lookup failed for ${RAW_ACCOUNT}`));
      const confirm = await confirmAccountOwners(ACCOUNT_ID, ["cA"], false);
      const reject = await rejectAccount(ACCOUNT_ID);
      expect(confirm.ok).toBe(false);
      expect(reject).toEqual(confirm);
      expect(JSON.stringify([confirm, reject, error.mock.calls])).not.toContain(RAW_ACCOUNT);
      expect(replaceDecisionSpy).not.toHaveBeenCalled();
      expect(rejectOwnersSpy).not.toHaveBeenCalled();
      expect(writeAuditSpy).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});


describe("confirmAccountOwners — transaction rollback signal", () => {
  beforeEach(() => {
    authSpy.mockResolvedValue(sessionFor("OPERATIONS"));
    getLinkSpy.mockResolvedValue(resolvedLink);
  });

  it.each(["partial owner write", "invalid member after folder write"])(
    "%s rejects the transaction callback before returning generic failure",
    async (failure) => {
      const rejected = vi.fn();
      withUserScopeSpy.mockImplementation(async (_id: unknown, fn: (tx: unknown) => Promise<unknown>) => {
        try {
          return await fn(TX);
        } catch (error) {
          rejected(error);
          throw error;
        }
      });
      resolveMemberSpy.mockResolvedValue({ clientSfId: "cA", householdSfId: "h1", cedarRidgeUserId: "eA" });
      if (failure === "partial owner write") {
        replaceDecisionSpy.mockResolvedValue(1); // one of two owners was written
      } else {
        getLinkSpy.mockResolvedValue({ matchStatus: "NEEDS_REVIEW", householdSfId: null });
        resolveClientSpy.mockResolvedValue({ clientSfId: "cA", householdSfId: "h1", cedarRidgeUserId: "eA" });
        updateLinkSpy.mockResolvedValue(1); // folder was already written
        resolveMemberSpy.mockResolvedValue(null);
      }
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await confirmAccountOwners(ACCOUNT_ID, ["cA", "cB"], false, "cA");
        expect(result.ok).toBe(false);
        expect(rejected).toHaveBeenCalledOnce();
        expect(rejected.mock.calls[0][0]).toBeInstanceOf(Error);
        if (failure === "partial owner write") {
          expect(replaceDecisionSpy).toHaveBeenCalledOnce();
        } else {
          expect(updateLinkSpy).toHaveBeenCalledOnce();
          expect(replaceDecisionSpy).not.toHaveBeenCalled();
        }
        expect(writeAuditSpy).not.toHaveBeenCalled();
        expect(revalidateSpy).not.toHaveBeenCalled();
        expect(JSON.stringify([result, log.mock.calls])).not.toContain(RAW_ACCOUNT);
      } finally {
        log.mockRestore();
      }
    },
  );
});
