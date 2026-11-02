import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";

// lib/data/asset-map-link imports "server-only" (throws outside an RSC bundle) —
// stub it so the module loads under the vitest node env (the asset-map.test.ts
// idiom).
vi.mock("server-only", () => ({}));

import {
  getLink,
  listLinksByStatus,
  setLink,
  updateLinkDecision,
  type AssetMapLink,
} from "@/lib/data/asset-map-link";

// Minimal fake transaction client — just the two raw members the seam touches.
// $queryRaw / $executeRaw are tagged-template calls: (strings, ...values). The
// seam runs inside the caller's tx (RLS scope owned by the caller), so a fake tx
// exercises the SQL + bound params with no DB or auth in the loop.
function fakeTx(queryRows: unknown[] = []) {
  const queryRaw = vi.fn(async (..._args: unknown[]) => queryRows);
  const executeRaw = vi.fn(async (..._args: unknown[]) => 1);
  const tx = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
  } as unknown as Prisma.TransactionClient;
  return { tx, queryRaw, executeRaw };
}

// A raw row shaped as the DB returns it (snake_case; confidence a Decimal-like).
function rawRow(over: Record<string, unknown> = {}) {
  return {
    source_folder_id: "folder_abc",
    client_sf_id: null,
    cedar_ridge_user_id: null,
    household_sf_id: null,
    match_status: "UNMATCHED",
    confidence: null,
    confirmed_by: null,
    confirmed_at: null,
    synced_at: new Date("2026-07-19T00:00:00.000Z"),
    ...over,
  };
}

describe("getLink — read + coercion", () => {
  it("empty folder id → null without querying", async () => {
    const { tx, queryRaw } = fakeTx();
    expect(await getLink(tx, "")).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("no row → null", async () => {
    const { tx } = fakeTx([]);
    expect(await getLink(tx, "folder_abc")).toBeNull();
  });

  it("binds the folder id as a param and maps a resolved+confirmed row", async () => {
    const { tx, queryRaw } = fakeTx([
      rawRow({
        client_sf_id: "003AAA",
        cedar_ridge_user_id: "crw_1",
        household_sf_id: "001HHH",
        match_status: "CONFIRMED",
        confidence: "0.973", // Decimal-like → Number
        confirmed_by: "ops@example.com",
        confirmed_at: new Date("2026-07-19T12:00:00.000Z"),
      }),
    ]);
    const link = (await getLink(tx, "folder_abc")) as AssetMapLink;

    // Parameterized read: the folder id binds as a value, never interpolated.
    const [strings, ...params] = queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("FROM mirror.acat_asset_map_link");
    expect(strings.join("?")).toContain("WHERE source_folder_id = ");
    expect(params).toEqual(["folder_abc"]);

    expect(link.sourceFolderId).toBe("folder_abc");
    expect(link.clientSfId).toBe("003AAA");
    expect(link.cedarRidgeUserId).toBe("crw_1");
    expect(link.householdSfId).toBe("001HHH");
    expect(link.matchStatus).toBe("CONFIRMED");
    // Decimal → number.
    expect(link.confidence).toBe(0.973);
    expect(link.confirmedBy).toBe("ops@example.com");
    expect(link.confirmedAt).toEqual(new Date("2026-07-19T12:00:00.000Z"));
  });

  it("null confidence stays null (never 0)", async () => {
    const { tx } = fakeTx([rawRow({ confidence: null })]);
    const link = (await getLink(tx, "folder_abc")) as AssetMapLink;
    expect(link.confidence).toBeNull();
  });
});

describe("listLinksByStatus — status filter", () => {
  it("binds the status as a param and maps every row", async () => {
    const { tx, queryRaw } = fakeTx([
      rawRow({ source_folder_id: "f1", match_status: "NEEDS_REVIEW", confidence: "0.500" }),
      rawRow({ source_folder_id: "f2", match_status: "NEEDS_REVIEW", confidence: null }),
    ]);
    const rows = await listLinksByStatus(tx, "NEEDS_REVIEW");

    const [strings, ...params] = queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("WHERE match_status = ");
    expect(strings.join("?")).toContain("ORDER BY synced_at DESC");
    expect(params).toEqual(["NEEDS_REVIEW"]);

    expect(rows.map((r) => r.sourceFolderId)).toEqual(["f1", "f2"]);
    expect(rows[0].confidence).toBe(0.5);
    expect(rows[1].confidence).toBeNull();
  });

  it("no rows → empty array", async () => {
    const { tx } = fakeTx([]);
    expect(await listLinksByStatus(tx, "UNMATCHED")).toEqual([]);
  });
});

describe("setLink — parameterized upsert", () => {
  it("binds every field in order with an ON CONFLICT DO UPDATE clause", async () => {
    const { tx, executeRaw } = fakeTx();
    const confirmedAt = new Date("2026-07-19T12:00:00.000Z");
    await setLink(tx, {
      sourceFolderId: "folder_abc",
      clientSfId: "003AAA",
      cedarRidgeUserId: "crw_1",
      householdSfId: "001HHH",
      matchStatus: "CONFIRMED",
      confidence: 0.973,
      confirmedBy: "ops@example.com",
      confirmedAt,
    });

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...params] = executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    // Upsert keyed on the durable folder id; synced_at stamped in SQL, not bound.
    expect(sql).toContain("INSERT INTO mirror.acat_asset_map_link");
    expect(sql).toContain("ON CONFLICT (source_folder_id) DO UPDATE SET");
    expect(sql).toMatch(/synced_at\s*=\s*now\(\)/);
    // Values bind positionally — never interpolated into the SQL text.
    expect(params).toEqual([
      "folder_abc",
      "003AAA",
      "crw_1",
      "001HHH",
      "CONFIRMED",
      0.973,
      "ops@example.com",
      confirmedAt,
    ]);
  });

  it("absent optional fields bind as null (a freshly-queued row carries no link)", async () => {
    const { tx, executeRaw } = fakeTx();
    await setLink(tx, { sourceFolderId: "folder_new", matchStatus: "UNMATCHED" });

    const [, ...params] = executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(params).toEqual([
      "folder_new",
      null, // client_sf_id
      null, // cedar_ridge_user_id
      null, // household_sf_id
      "UNMATCHED",
      null, // confidence
      null, // confirmed_by
      null, // confirmed_at
    ]);
  });
});

describe("updateLinkDecision — parameterized ops UPDATE (P2.3)", () => {
  it("empty folder id → 0 without querying", async () => {
    const { tx, executeRaw } = fakeTx();
    expect(
      await updateLinkDecision(tx, {
        sourceFolderId: "",
        matchStatus: "CONFIRMED",
        confirmedBy: "ops@example.com",
        confirmedAt: new Date(),
      }),
    ).toBe(0);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("CONFIRM: plain UPDATE (not INSERT), binds resolved ids + confirmation, omits confidence", async () => {
    const { tx, executeRaw } = fakeTx();
    const confirmedAt = new Date("2026-07-20T12:00:00.000Z");
    const n = await updateLinkDecision(tx, {
      sourceFolderId: "folder_abc",
      matchStatus: "CONFIRMED",
      clientSfId: "003AAA",
      cedarRidgeUserId: "crw_1",
      householdSfId: "001HHH",
      confirmedBy: "ops@example.com",
      confirmedAt,
    });
    // fakeTx.$executeRaw returns 1 (one row updated).
    expect(n).toBe(1);

    const [strings, ...params] = executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    // A plain UPDATE — never INSERT ... ON CONFLICT (app_rw has UPDATE only).
    expect(sql).toContain("UPDATE mirror.acat_asset_map_link");
    expect(sql).not.toContain("INSERT");
    expect(sql).not.toContain("ON CONFLICT");
    expect(sql).toContain("WHERE source_folder_id = ");
    // Queued-rows-only guard: the UPDATE only touches machine-tier rows, so a
    // terminal (CONFIRMED/REJECTED) row can't be silently re-decided (→ 0 rows).
    expect(sql).toMatch(/match_status\s+IN\s*\(\s*'NEEDS_REVIEW'\s*,\s*'AUTO_LINKED'\s*\)/);
    expect(sql).toMatch(/synced_at\s*=\s*now\(\)/);
    // confidence is NOT written (human decision preserves the machine score).
    expect(sql).not.toContain("confidence");
    // Values bind positionally, folder id LAST (the WHERE param).
    expect(params).toEqual([
      "003AAA",
      "crw_1",
      "001HHH",
      "CONFIRMED",
      "ops@example.com",
      confirmedAt,
      "folder_abc",
    ]);
  });

  it("REJECT: clears the resolved ids (bound null) and marks REJECTED", async () => {
    const { tx, executeRaw } = fakeTx();
    const confirmedAt = new Date("2026-07-20T13:00:00.000Z");
    await updateLinkDecision(tx, {
      sourceFolderId: "folder_xyz",
      matchStatus: "REJECTED",
      clientSfId: null,
      cedarRidgeUserId: null,
      householdSfId: null,
      confirmedBy: "ops@example.com",
      confirmedAt,
    });
    const [, ...params] = executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(params).toEqual([
      null, // client_sf_id cleared
      null, // cedar_ridge_user_id cleared
      null, // household_sf_id cleared
      "REJECTED",
      "ops@example.com",
      confirmedAt,
      "folder_xyz",
    ]);
  });

  it("returns the DB affected-row count (0 → caller treats as rejected)", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(async () => 0),
    } as unknown as Prisma.TransactionClient;
    const n = await updateLinkDecision(tx, {
      sourceFolderId: "folder_gone",
      matchStatus: "CONFIRMED",
      confirmedBy: "ops@example.com",
      confirmedAt: new Date(),
    });
    expect(n).toBe(0);
  });
});
