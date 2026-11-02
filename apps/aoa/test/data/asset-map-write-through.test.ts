import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ ingest: vi.fn(), exec: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: m.ingest }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn(function () {
    return { getIdTokenClient: vi.fn() };
  }),
}));

import type { Prisma } from "@prisma/client";
import { flattenHouseholds, readAssetMapHousehold } from "@/lib/data/asset-map";
import { applyAssetMapWriteThrough, writeThroughAssetMapEdit } from "@/lib/data/asset-map-write-through";

const POS = "33333333-3333-4333-8333-333333333333";
const ACC = "44444444-4444-4444-8444-444444444444";
const tx = { $executeRaw: m.exec, $queryRaw: m.query } as unknown as Prisma.TransactionClient;

const sqlOf = (call: unknown[]) => ((call[0] as readonly string[]).join("?")).replace(/\s+/g, " ").trim();
const binds = (call: unknown[]) => call.slice(1);

beforeEach(() => {
  m.exec.mockReset();
  m.exec.mockResolvedValue(1);
  m.query.mockReset();
  m.ingest.mockReset();
  m.ingest.mockImplementation(async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) => fn(tx));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("asset-map mirror write-through", () => {
  it("status write-through sets override and effective status and notes on the position row", async () => {
    await applyAssetMapWriteThrough(tx, { kind: "positionStatus", positionId: POS, status: "LIQUIDATE", notes: "Manual override to LIQUIDATE" });
    expect(m.exec).toHaveBeenCalledTimes(1);
    const call = m.exec.mock.calls[0];
    const sql = sqlOf(call);
    expect(sql).toContain("UPDATE mirror.acat_asset_map_position");
    for (const col of ["override_status", "effective_status", "override_notes", "effective_notes"]) expect(sql).toContain(col);
    expect(binds(call)).toEqual(["LIQUIDATE", "Manual override to LIQUIDATE", "LIQUIDATE", "Manual override to LIQUIDATE", POS]);
  });

  it("transferring write-through stores YES as true, NO as false, and Clear as null", async () => {
    await applyAssetMapWriteThrough(tx, { kind: "positionTransferring", positionId: POS, value: "YES" });
    await applyAssetMapWriteThrough(tx, { kind: "positionTransferring", positionId: POS, value: "NO" });
    await applyAssetMapWriteThrough(tx, { kind: "positionTransferring", positionId: POS, value: null });
    expect(m.exec.mock.calls.map((c) => binds(c))).toEqual([[true, POS], [false, POS], [null, POS]]);
    expect(sqlOf(m.exec.mock.calls[0])).toContain("SET transferring = ?");
  });

  it("account type write-through sets type, Other label, rollover, inherited, and Apex fields", async () => {
    await applyAssetMapWriteThrough(tx, {
      kind: "accountType", accountId: ACC, accountType: "Other", accountTypeOther: "Synthetic label",
      isRollover: true, isInherited: false, apexRestriction: "Synthetic restriction",
    });
    const call = m.exec.mock.calls[0];
    const sql = sqlOf(call);
    expect(sql).toContain("UPDATE mirror.acat_asset_map_account");
    for (const col of ["account_type =", "account_type_other =", "is_rollover =", "is_inherited =", "apex_restriction ="]) expect(sql).toContain(col);
    expect(binds(call)).toEqual(["Other", "Synthetic label", true, false, true, "Synthetic restriction", false, null, null, ACC]);
  });

  it("account type write-through keeps a field the response omitted", async () => {
    await applyAssetMapWriteThrough(tx, { kind: "accountType", accountId: ACC, accountType: "IRA", accountTypeOther: null, isInherited: true });
    const call = m.exec.mock.calls[0];
    const sql = sqlOf(call);
    expect(sql).toContain("COALESCE(?::boolean, is_rollover)");
    expect(sql).toContain("ELSE apex_restriction END");
    expect(binds(call)).toEqual(["IRA", null, null, true, false, null, false, null, null, ACC]);
  });

  it("account type write-through sets the override person and save time (ticket)", async () => {
    await applyAssetMapWriteThrough(tx, {
      kind: "accountType", accountId: ACC, accountType: "IRA", accountTypeOther: null,
      overriddenBy: "saver@example.invalid", overriddenAt: "2026-10-06T14:05:00.000Z",
    });
    const call = m.exec.mock.calls[0];
    const sql = sqlOf(call);
    expect(sql).toContain("account_type_overridden_by = CASE WHEN ? THEN ? ELSE account_type_overridden_by END");
    expect(sql).toContain("account_type_overridden_at = COALESCE(?::timestamptz, account_type_overridden_at)");
    expect(binds(call)).toEqual(["IRA", null, null, null, false, null, true, "saver@example.invalid", "2026-10-06T14:05:00.000Z", ACC]);
  });

  it("position removal and restore set is_deleted on the position row", async () => {
    await applyAssetMapWriteThrough(tx, { kind: "removePosition", positionId: POS });
    await applyAssetMapWriteThrough(tx, { kind: "restorePosition", positionId: POS });
    for (const call of m.exec.mock.calls) {
      expect(sqlOf(call)).toContain("UPDATE mirror.acat_asset_map_position SET is_deleted = ? WHERE id = ?");
    }
    expect(m.exec.mock.calls.map((c) => binds(c))).toEqual([[true, POS], [false, POS]]);
  });

  it("account removal and restore set is_deleted on the account and all its positions", async () => {
    await applyAssetMapWriteThrough(tx, { kind: "removeAccount", accountId: ACC });
    await applyAssetMapWriteThrough(tx, { kind: "restoreAccount", accountId: ACC });
    expect(m.exec).toHaveBeenCalledTimes(4);
    const [acc1, pos1, acc2, pos2] = m.exec.mock.calls;
    expect(sqlOf(acc1)).toContain("UPDATE mirror.acat_asset_map_account SET is_deleted = ? WHERE id = ");
    expect(sqlOf(pos1)).toContain("UPDATE mirror.acat_asset_map_position SET is_deleted = ? WHERE account_id = ");
    expect([binds(acc1), binds(pos1), binds(acc2), binds(pos2)]).toEqual([[true, ACC], [true, ACC], [false, ACC], [false, ACC]]);
  });

  it("runs in one ingest transaction and never under the operator's user scope", async () => {
    await expect(writeThroughAssetMapEdit({ kind: "removeAccount", accountId: ACC })).resolves.toBe(true);
    expect(m.ingest).toHaveBeenCalledTimes(1);
    expect(m.exec).toHaveBeenCalledTimes(2);
    const source = readFileSync("lib/data/asset-map-write-through.ts", "utf8");
    expect(source).not.toContain("withUserScope");
    expect(source).not.toContain("@/lib/rls");
  });

  it("a write-through failure logs only a static marker and returns false", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    m.ingest.mockRejectedValueOnce(new Error(`synthetic failure ${POS}`));
    await expect(writeThroughAssetMapEdit({ kind: "removePosition", positionId: POS })).resolves.toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[asset-map] write_through_failed");
  });

  it("the pull reads the pipeline's YES and NO transferring text only when asked", () => {
    const households = [{
      id: "h1",
      accounts: [{ id: "a1", assets: [{ id: "p1", transferring: "YES" }, { id: "p2", transferring: "NO" }] }],
    }];
    const withText = flattenHouseholds(households, undefined, { transferringText: true });
    expect(withText.positions.map((p) => p.transferring)).toEqual([true, false]);
    const today = flattenHouseholds(households);
    expect(today.positions.map((p) => p.transferring)).toEqual([null, null]);
  });

  it("the migration adds a non-null is_deleted column defaulting to false and changes no grant or policy", () => {
    const sql = readFileSync("prisma/migrations/20261003120000_asset_map_position_is_deleted/migration.sql", "utf8");
    expect(sql).toContain("ADD COLUMN is_deleted boolean NOT NULL DEFAULT false");
    expect(sql).not.toMatch(/GRANT|POLICY|DROP/);
  });

  it("the migration adds two nullable override columns and changes no grant or policy (ticket)", () => {
    const sql = readFileSync("prisma/migrations/20261006120000_asset_map_account_type_override/migration.sql", "utf8");
    expect(sql).toContain("ADD COLUMN account_type_overridden_by text,");
    expect(sql).toContain("ADD COLUMN account_type_overridden_at timestamptz;");
    expect(sql).not.toMatch(/GRANT|POLICY|DROP|NOT NULL/);
  });

  it("the household read hides deleted positions", async () => {
    m.query
      .mockResolvedValueOnce([{ id: "hh-1", client_name: "Synthetic Client A", processed_at: null, status_tallies: null }])
      .mockResolvedValueOnce([{ id: ACC, custodian: "Synthetic Custodian", account_type: "Individual", validation_issues: null, custodian_intel: null }])
      .mockResolvedValueOnce([]);
    await readAssetMapHousehold(tx, "hh-1");
    const positionSql = sqlOf(m.query.mock.calls[2]);
    expect(positionSql).toContain("account_id = ANY(");
    expect(positionSql).toContain("is_deleted IS NOT TRUE");
  });
});
