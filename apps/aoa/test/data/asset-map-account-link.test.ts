import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";

// lib/data/asset-map-account-link imports "server-only" (throws outside an RSC
// bundle) — stub it so the module loads under the vitest node env (the
// asset-map-link.test.ts idiom). Fake tx: $queryRaw/$executeRaw are tagged-template
// calls (strings, ...values); the seam runs inside the caller's tx (RLS owned by
// the caller), so a fake tx exercises the SQL + bound params with no DB/auth.
vi.mock("server-only", () => ({}));

import {
  listAccountLinksByFolder,
  listAccountLinksByStatus,
  upsertAccountLink,
  replaceAccountOwnerCandidates,
  replaceAccountOwnerDecision,
  rejectAccountOwners,
  resolveDeterministicOwners,
  type AccountLink,
} from "@/lib/data/asset-map-account-link";

function fakeTx(queryRows: unknown[] = [], execResult = 1) {
  const queryRaw = vi.fn(async (..._args: unknown[]) => queryRows);
  const executeRaw = vi.fn(async (..._args: unknown[]) => execResult);
  const tx = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
  } as unknown as Prisma.TransactionClient;
  return { tx, queryRaw, executeRaw };
}

function rawRow(over: Record<string, unknown> = {}) {
  return {
    source_folder_id: "folder_abc",
    custodian: "Fidelity",
    account_number: "1234",
    cedar_ridge_user_id: null,
    client_sf_id: null,
    ownership_role: "PRIMARY",
    is_entity: false,
    match_status: "NEEDS_REVIEW",
    confidence: null,
    confirmed_by: null,
    confirmed_at: null,
    synced_at: new Date("2026-07-22T00:00:00.000Z"),
    ...over,
  };
}

const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join("?");
const paramsOf = (call: unknown[]) => call.slice(1);

describe("rowToAccountLink (via listAccountLinksByFolder) — coercion", () => {
  it("Decimal confidence → Number; NULL stays null; role/status carried", async () => {
    const { tx } = fakeTx([
      rawRow({
        cedar_ridge_user_id: "crw_1",
        client_sf_id: "003AAA",
        ownership_role: "JOINT",
        match_status: "AUTO_LINKED",
        confidence: "0.973",
      }),
      rawRow({ confidence: null, is_entity: true, ownership_role: "ENTITY" }),
    ]);
    const rows = (await listAccountLinksByFolder(tx, "folder_abc")) as AccountLink[];
    expect(rows[0].confidence).toBe(0.973);
    expect(rows[0].ownershipRole).toBe("JOINT");
    expect(rows[0].matchStatus).toBe("AUTO_LINKED");
    expect(rows[0].cedarRidgeUserId).toBe("crw_1");
    expect(rows[1].confidence).toBeNull(); // never 0
    expect(rows[1].isEntity).toBe(true);
    expect(rows[1].ownershipRole).toBe("ENTITY");
  });
});

describe("listAccountLinksByFolder", () => {
  it("empty folder id → [] without querying", async () => {
    const { tx, queryRaw } = fakeTx();
    expect(await listAccountLinksByFolder(tx, "")).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("binds the folder id and orders account then person (NULLS FIRST)", async () => {
    const { tx, queryRaw } = fakeTx([rawRow()]);
    await listAccountLinksByFolder(tx, "folder_abc");
    const call = queryRaw.mock.calls[0] as unknown[];
    expect(sqlOf(call)).toContain("FROM mirror.acat_asset_map_account_link");
    expect(sqlOf(call)).toContain("WHERE source_folder_id = ");
    expect(sqlOf(call)).toContain("ORDER BY custodian, account_number, cedar_ridge_user_id NULLS FIRST");
    expect(paramsOf(call)).toEqual(["folder_abc"]);
  });
});

describe("listAccountLinksByStatus", () => {
  it("binds the status and orders synced_at DESC", async () => {
    const { tx, queryRaw } = fakeTx([rawRow({ match_status: "AUTO_LINKED" })]);
    const rows = await listAccountLinksByStatus(tx, "AUTO_LINKED");
    const call = queryRaw.mock.calls[0] as unknown[];
    expect(sqlOf(call)).toContain("WHERE match_status = ");
    expect(sqlOf(call)).toContain("ORDER BY synced_at DESC");
    expect(paramsOf(call)).toEqual(["AUTO_LINKED"]);
    expect(rows).toHaveLength(1);
  });
});

describe("upsertAccountLink — parameterized upsert on the 4-col NULLS-NOT-DISTINCT key", () => {
  it("INSERT ... ON CONFLICT (…4 cols…) DO UPDATE; synced_at=now() in SQL not bound", async () => {
    const { tx, executeRaw } = fakeTx();
    await upsertAccountLink(tx, {
      sourceFolderId: "folder_abc",
      custodian: "Fidelity",
      accountNumber: "1234",
      cedarRidgeUserId: "crw_1",
      clientSfId: "003AAA",
      ownershipRole: "PRIMARY",
      isEntity: false,
      matchStatus: "AUTO_LINKED",
      confidence: 0.97,
    });
    const call = executeRaw.mock.calls[0] as unknown[];
    const sql = sqlOf(call);
    expect(sql).toContain("INSERT INTO mirror.acat_asset_map_account_link");
    expect(sql).toContain(
      "ON CONFLICT (source_folder_id, custodian, account_number, cedar_ridge_user_id) DO UPDATE SET",
    );
    expect(sql).toMatch(/synced_at\s*=\s*now\(\)/);
    expect(paramsOf(call)).toEqual([
      "folder_abc",
      "Fidelity",
      "1234",
      "crw_1",
      "003AAA",
      "PRIMARY",
      false,
      "AUTO_LINKED",
      0.97,
    ]);
  });

  it("entity row binds cedar_ridge_user_id = null", async () => {
    const { tx, executeRaw } = fakeTx();
    await upsertAccountLink(tx, {
      sourceFolderId: "f",
      custodian: "Schwab",
      accountNumber: "9",
      cedarRidgeUserId: null,
      clientSfId: null,
      ownershipRole: "ENTITY",
      isEntity: true,
      matchStatus: "NEEDS_REVIEW",
    });
    const params = paramsOf(executeRaw.mock.calls[0] as unknown[]);
    expect(params[3]).toBeNull(); // cedar_ridge_user_id
    expect(params[4]).toBeNull(); // client_sf_id
    expect(params[6]).toBe(true); // is_entity
  });
});

describe("replaceAccountOwnerCandidates — machine multi-owner write + stale demote", () => {
  it("two owners → two upserts + one demote UPDATE (guarded, <> ALL, never terminal)", async () => {
    const { tx, executeRaw } = fakeTx();
    await replaceAccountOwnerCandidates(tx, {
      sourceFolderId: "folder_abc",
      custodian: "Fidelity",
      accountNumber: "1234",
      isEntity: false,
      matchStatus: "AUTO_LINKED",
      confidence: 0.99,
      owners: [
        { cedarRidgeUserId: "crw_1", clientSfId: "003AAA", ownershipRole: "JOINT" },
        { cedarRidgeUserId: "crw_2", clientSfId: "003BBB", ownershipRole: "JOINT" },
      ],
    });
    // 2 upserts + 1 demote.
    expect(executeRaw).toHaveBeenCalledTimes(3);
    const inserts = executeRaw.mock.calls.filter((c) => sqlOf(c as unknown[]).includes("INSERT INTO"));
    expect(inserts).toHaveLength(2);
    const demote = executeRaw.mock.calls.find((c) => sqlOf(c as unknown[]).includes("UPDATE mirror.acat_asset_map_account_link"))!;
    const demoteSql = sqlOf(demote as unknown[]);
    expect(demoteSql).toMatch(/match_status\s*=\s*'UNMATCHED'/);
    expect(demoteSql).toMatch(
      /match_status\s+IN\s*\(\s*'NEEDS_REVIEW'\s*,\s*'AUTO_LINKED'\s*,\s*'UNMATCHED'\s*\)/,
    );
    expect(demoteSql).toContain("<> ALL(");
    // The chosen person ids are bound as the ALL(...) array param.
    expect((demote as unknown[]).some((v) => Array.isArray(v) && v.includes("crw_1") && v.includes("crw_2"))).toBe(true);
  });

  it("entity → one entity upsert (null person) + demote keeps the null row (isEntity=true)", async () => {
    const { tx, executeRaw } = fakeTx();
    await replaceAccountOwnerCandidates(tx, {
      sourceFolderId: "f",
      custodian: "Schwab",
      accountNumber: "9",
      isEntity: true,
      matchStatus: "NEEDS_REVIEW",
      confidence: null,
      owners: [{ cedarRidgeUserId: null, clientSfId: null, ownershipRole: "ENTITY" }],
    });
    expect(executeRaw).toHaveBeenCalledTimes(2); // 1 upsert + 1 demote
    const demote = executeRaw.mock.calls.find((c) => sqlOf(c as unknown[]).startsWith("\n    UPDATE") || sqlOf(c as unknown[]).includes("UPDATE mirror.acat_asset_map_account_link"))!;
    // isEntity=true bound so the freshly-written entity (NULL) row is not demoted.
    expect((demote as unknown[]).includes(true)).toBe(true);
  });
});

describe("replaceAccountOwnerDecision — atomic human multi-owner confirm", () => {
  it("N chosen → N confirm-upserts (queued-only re-decision guard) + soft-reject; returns count", async () => {
    const { tx, executeRaw } = fakeTx();
    const confirmedAt = new Date("2026-07-22T12:00:00.000Z");
    const n = await replaceAccountOwnerDecision(tx, {
      sourceFolderId: "folder_abc",
      custodian: "Fidelity",
      accountNumber: "1234",
      owners: [
        { cedarRidgeUserId: "crw_1", clientSfId: "003AAA", ownershipRole: "JOINT" },
        { cedarRidgeUserId: "crw_2", clientSfId: "003BBB", ownershipRole: "JOINT" },
      ],
      isEntity: false,
      confirmedBy: "ops@example.com",
      confirmedAt,
    });
    expect(n).toBe(2); // fakeTx executeRaw returns 1 per confirm

    const confirmCalls = executeRaw.mock.calls.filter((c) => sqlOf(c as unknown[]).includes("INSERT INTO"));
    expect(confirmCalls).toHaveLength(2);
    for (const c of confirmCalls) {
      const sql = sqlOf(c as unknown[]);
      expect(sql).toContain("ON CONFLICT (source_folder_id, custodian, account_number, cedar_ridge_user_id) DO UPDATE SET");
      // Queued-rows-only re-decision guard on the DO UPDATE.
      expect(sql).toMatch(
        /WHERE\s+acat_asset_map_account_link\.match_status\s+IN\s*\(\s*'NEEDS_REVIEW'\s*,\s*'AUTO_LINKED'\s*\)/,
      );
      expect(sql).toMatch(/match_status\s*=\s*'CONFIRMED'/);
    }
    // Soft-reject UPDATE present (no DELETE); the confirm score is NOT written.
    const reject = executeRaw.mock.calls.find(
      (c) => sqlOf(c as unknown[]).includes("UPDATE mirror.acat_asset_map_account_link") && sqlOf(c as unknown[]).includes("REJECTED"),
    )!;
    expect(reject).toBeTruthy();
    expect(sqlOf(reject as unknown[])).toContain("<> ALL(");
    const allSql = executeRaw.mock.calls.map((c) => sqlOf(c as unknown[])).join("\n");
    expect(allSql).not.toMatch(/DELETE/i);
    expect(allSql).not.toContain("confidence");
  });

  it("entity confirm → one row binding NULL person + ownership_role='ENTITY'", async () => {
    const { tx, executeRaw } = fakeTx();
    const n = await replaceAccountOwnerDecision(tx, {
      sourceFolderId: "f",
      custodian: "Schwab",
      accountNumber: "9",
      owners: [],
      isEntity: true,
      confirmedBy: "ops@example.com",
      confirmedAt: new Date(),
    });
    expect(n).toBe(1);
    const insert = executeRaw.mock.calls.find((c) => sqlOf(c as unknown[]).includes("INSERT INTO"))!;
    const params = paramsOf(insert as unknown[]);
    // params order: folder, custodian, account_number, cedar_ridge_user_id, client_sf_id, role, is_entity, status..., confirmed_by, confirmed_at
    expect(params[3]).toBeNull(); // cedar_ridge_user_id NULL for entity
    expect(params[4]).toBeNull(); // client_sf_id NULL
    expect(params[5]).toBe("ENTITY");
    expect(params[6]).toBe(true); // is_entity
  });

  it("a chosen owner colliding with a terminal row (0 affected) → count short of owners.length", async () => {
    const { tx } = fakeTx([], 0); // every executeRaw returns 0
    const n = await replaceAccountOwnerDecision(tx, {
      sourceFolderId: "f",
      custodian: "Fidelity",
      accountNumber: "1",
      owners: [{ cedarRidgeUserId: "crw_1", clientSfId: "003AAA", ownershipRole: "PRIMARY" }],
      isEntity: false,
      confirmedBy: "ops@example.com",
      confirmedAt: new Date(),
    });
    expect(n).toBe(0);
  });
});

describe("rejectAccountOwners — whole-account reject", () => {
  it("REJECTS every queued owner, guard match_status IN (…), clears client_sf_id", async () => {
    const { tx, executeRaw } = fakeTx();
    const confirmedAt = new Date("2026-07-22T13:00:00.000Z");
    const n = await rejectAccountOwners(tx, {
      sourceFolderId: "folder_abc",
      custodian: "Fidelity",
      accountNumber: "1234",
      confirmedBy: "ops@example.com",
      confirmedAt,
    });
    expect(n).toBe(1);
    const call = executeRaw.mock.calls[0] as unknown[];
    const sql = sqlOf(call);
    expect(sql).toContain("UPDATE mirror.acat_asset_map_account_link");
    expect(sql).toMatch(/match_status\s*=\s*'REJECTED'/);
    expect(sql).toMatch(/client_sf_id\s*=\s*NULL/);
    expect(sql).toMatch(/match_status\s+IN\s*\(\s*'NEEDS_REVIEW'\s*,\s*'AUTO_LINKED'\s*\)/);
    expect(sql).not.toMatch(/DELETE/i);
    // folder/custodian/account_number + confirmedBy/confirmedAt bound.
    expect(call).toContain("folder_abc");
    expect(call).toContain("Fidelity");
    expect(call).toContain("1234");
  });

  it("empty key → 0 without querying", async () => {
    const { tx, executeRaw } = fakeTx();
    const n = await rejectAccountOwners(tx, {
      sourceFolderId: "",
      custodian: "Fidelity",
      accountNumber: "1234",
      confirmedBy: "x",
      confirmedAt: new Date(),
    });
    expect(n).toBe(0);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});

describe("resolveDeterministicOwners — documented no-op (P2.5)", () => {
  it("returns [] (no mapping account is post-funding)", async () => {
    const { tx, queryRaw, executeRaw } = fakeTx();
    const owners = await resolveDeterministicOwners(tx, { custodian: "Fidelity", accountNumber: "1234" });
    expect(owners).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
