import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  listAssignableAssetMapAccounts,
  resolveAssignableAssetMapAccount,
  type AssignableAssetMapAccounts,
} from "@/lib/data/transfer-asset-map";
import { prisma } from "@/lib/db";
import { withUserScope, type Identity } from "@/lib/rls";

// Same gate as the transfer/ingest integration suites. Reads use DATABASE_URL
// as app_rw; fixtures use the explicit owner URL against the SAME disposable
// loopback database. No production data or network database can be used here.
const gated = process.env.INGEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "ZZTEST-ASSET-PICKER-";
const id = (suffix: string) => `${PREFIX}${suffix}`;
const OPS: Identity = {
  role: "OPERATIONS",
  email: "asset-map-picker-synthetic@example.test",
};
const NUMBER_A = "SYNTHETIC-11001234";
const NUMBER_B = "SYNTHETIC-99001234";
const CUSTODIAN = "Synthetic Custodian";

function fixtureOptions(result: AssignableAssetMapAccounts) {
  return [...result.recommended, ...result.others].filter((row) =>
    row.accountId.startsWith(PREFIX),
  );
}

function resolve(accountId: string, identity: Identity = OPS) {
  return withUserScope(identity, (tx) =>
    resolveAssignableAssetMapAccount(tx, accountId),
  );
}

gated("Asset-map picker IDs with actual PostgreSQL/RLS", () => {
  let owner: PrismaClient | undefined;

  async function cleanup() {
    if (!owner) return;
    const pattern = `${PREFIX}%`;
    await owner.$executeRaw`DELETE FROM app.transfer WHERE id LIKE ${pattern}`;
    await owner.$executeRaw`DELETE FROM mirror.acat_asset_map_household WHERE id LIKE ${pattern}`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE table_name = 'transfer' AND row_pk LIKE ${pattern}`;
  }

  beforeAll(async () => {
    const cleanupUrl = process.env.INGEST_TEST_CLEANUP_URL;
    const appUrl = process.env.DATABASE_URL;
    const ingestUrl = process.env.INGEST_DATABASE_URL;
    if (!cleanupUrl || !appUrl || !ingestUrl) {
      throw new Error("Explicit synthetic database URLs are required");
    }
    const target = new URL(cleanupUrl);
    for (const value of [cleanupUrl, appUrl, ingestUrl]) {
      const url = new URL(value);
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.host !== target.host ||
        url.pathname !== target.pathname ||
        ["host", "hostaddr", "service", "servicefile"].some((key) =>
          url.searchParams.has(key),
        )
      ) {
        throw new Error("Picker integration tests require one loopback synthetic database");
      }
    }
    if (new URL(appUrl).username !== "app_rw") {
      throw new Error("Picker RLS reads must run as app_rw");
    }
    owner = new PrismaClient({ datasourceUrl: cleanupUrl });
    await cleanup();

    const households = [
      // The older folder deliberately still has superseded_by = NULL. The
      // latest-per-client inventory must reject its account even after re-keying.
      ["older", "old-folder", "Synthetic Picker Household", "2026-09-01", null],
      ["current", "new-folder", "Synthetic Picker Household", "2026-09-20", null],
      // A renamed former run is explicitly superseded, even though it is newer.
      ["superseded", "renamed-folder", "Synthetic Former Name", "2026-09-23", id("current")],
      ["duplicates", "duplicate-folder", "Synthetic Duplicate Household", "2026-09-20", null],
      ["nameless-a", "nameless-folder-a", null, "2026-09-20", null],
      ["nameless-b", "nameless-folder-b", "   ", "2026-09-20", null],
      ["no-folder", null, "Synthetic Missing Folder", "2026-09-20", null],
    ] as const;
    for (const [household, folder, name, processed, superseded] of households) {
      await owner.$executeRaw`
        INSERT INTO mirror.acat_asset_map_household
          (id, source_folder_id, client_name, processed_at, superseded_by)
        VALUES (${id(household)}, ${folder == null ? null : id(folder)}, ${name},
                ${new Date(processed)}, ${superseded})`;
    }

    const accounts = [
      ["collision-a", "current", NUMBER_A, "Brokerage", CUSTODIAN],
      ["collision-b", "current", NUMBER_B, "Brokerage", CUSTODIAN],
      ["numberless-roth", "current", null, "Roth IRA", CUSTODIAN],
      ["numberless-traditional", "current", null, "Traditional IRA", CUSTODIAN],
      ["older-account", "older", NUMBER_A, "Brokerage", CUSTODIAN],
      ["superseded-account", "superseded", NUMBER_A, "Brokerage", CUSTODIAN],
      // Physical duplicates must keep the existing single logical picker row.
      ["duplicate-a", "duplicates", "SYNTHETIC-22005678", "Trust", CUSTODIAN],
      ["duplicate-z", "duplicates", "SYNTHETIC-22005678", "Trust", CUSTODIAN],
      ["nameless-account-a", "nameless-a", "SYNTHETIC-33001001", "Brokerage", CUSTODIAN],
      ["nameless-account-b", "nameless-b", "SYNTHETIC-33001002", "Brokerage", CUSTODIAN],
      ["missing-custodian", "current", "SYNTHETIC-33001003", "Brokerage", null],
      ["missing-folder", "no-folder", "SYNTHETIC-33001004", "Brokerage", CUSTODIAN],
    ] as const;
    for (const [account, household, number, type, custodian] of accounts) {
      await owner.$executeRaw`
        INSERT INTO mirror.acat_asset_map_account
          (id, household_id, custodian, account_number, account_type, account_holder, total_value)
        VALUES (${id(account)}, ${id(household)}, ${custodian}, ${number}, ${type},
                'Synthetic Account Holder', 1250.75)`;
    }

    for (const [suffix, number, type] of [
      ["current-transfer", NUMBER_A, "Brokerage"],
      ["other-transfer", NUMBER_A, "Brokerage"],
      ["numberless-transfer", null, "Roth IRA"],
    ] as const) {
      await owner.transfer.create({
        data: {
          id: id(suffix),
          source: "APP",
          client_first_name: "Synthetic",
          client_last_name: suffix,
          value: "1250.75",
          owner_kind: "OPERATIONS",
          stage: "DECISION",
          funding_type: "ACAT_FULL",
          asset_map_folder_id: id("new-folder"),
          asset_map_custodian: CUSTODIAN,
          asset_map_account_number: number,
          asset_map_account_type: type,
        },
      });
    }
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await owner?.$disconnect();
      await prisma.$disconnect();
    }
  });

  it("serializes masked fields and distinct opaque IDs for accounts sharing last four", async () => {
    const result = await listAssignableAssetMapAccounts(OPS, { hrqjSbevsbySbin8: "1234" });
    const recommended = result.recommended.filter((row) => row.accountId.startsWith(PREFIX));
    expect(recommended.map((row) => row.accountId).sort()).toEqual([
      id("collision-a"), id("collision-b"),
    ]);
    expect(recommended.map((row) => row.accountNumberMasked)).toEqual(["••••1234", "••••1234"]);
    expect(fixtureOptions(result).every((row) => !("accountNumber" in row))).toBe(true);
    const payload = JSON.stringify(result);
    expect(payload).not.toContain(NUMBER_A);
    expect(payload).not.toContain(NUMBER_B);
    expect(payload).not.toContain("SYNTHETIC-");
    expect(recommended[0].totalValue).toBe(1250.75);
    expect(await resolve(id("collision-a"))).toEqual({
      sourceFolderId: id("new-folder"),
      custodian: CUSTODIAN,
      accountNumber: NUMBER_A,
      accountType: "Brokerage",
    });
    expect(await resolve(id("collision-b"))).toMatchObject({ accountNumber: NUMBER_B });
  });

  it("retains numberless siblings and resolves their different registration types", async () => {
    const result = await listAssignableAssetMapAccounts(OPS, { hrqjSbevsbySbin8: "1234" });
    const numberless = result.others.filter((row) => row.accountId.startsWith(id("numberless-")));
    expect(numberless).toHaveLength(2);
    expect(numberless.every((row) => row.accountNumberMasked === null)).toBe(true);
    for (const [suffix, type] of [
      ["numberless-roth", "Roth IRA"],
      ["numberless-traditional", "Traditional IRA"],
    ]) {
      expect(await resolve(id(suffix))).toEqual({
        sourceFolderId: id("new-folder"),
        custodian: CUSTODIAN,
        accountNumber: null,
        accountType: type,
      });
    }
  });

  it("uses the same current inventory for listing and resolving re-keyed, stale and superseded runs", async () => {
    const rows = fixtureOptions(await listAssignableAssetMapAccounts(OPS));
    const ids = rows.map((row) => row.accountId);
    expect(ids).toContain(id("collision-a"));
    for (const suffix of ["older-account", "superseded-account", "missing-custodian", "missing-folder"]) {
      expect(ids).not.toContain(id(suffix));
      expect(await resolve(id(suffix))).toBeNull();
    }
    expect(await resolve(id("does-not-exist"))).toBeNull();
    expect(await resolve("")).toBeNull();
    // Nameless households remain separate by folder, rather than collapsing.
    expect(ids).toContain(id("nameless-account-a"));
    expect(ids).toContain(id("nameless-account-b"));
  });

  it("keeps duplicate physical accounts in one logical option with a resolvable representative", async () => {
    const rows = fixtureOptions(await listAssignableAssetMapAccounts(OPS))
      .filter((row) => row.sourceFolderId === id("duplicate-folder"));
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(id("duplicate-a"));
    expect(await resolve(rows[0].accountId)).toEqual({
      sourceFolderId: id("duplicate-folder"),
      custodian: CUSTODIAN,
      accountNumber: "SYNTHETIC-22005678",
      accountType: "Trust",
    });
    expect(await resolve(id("duplicate-z"))).toBeNull();
  });

  it("rejects a previously listed ID after a newer client run replaces it", async () => {
    const before = fixtureOptions(await listAssignableAssetMapAccounts(OPS));
    expect(before.map((row) => row.accountId)).toContain(id("collision-a"));
    try {
      await owner!.$executeRaw`
        UPDATE mirror.acat_asset_map_household SET processed_at = '2026-09-24'::timestamptz
        WHERE id = ${id("older")}`;
      expect(await resolve(id("collision-a"))).toBeNull();
      const after = fixtureOptions(await listAssignableAssetMapAccounts(OPS));
      expect(after.map((row) => row.accountId)).not.toContain(id("collision-a"));
      expect(after.map((row) => row.accountId)).toContain(id("older-account"));
    } finally {
      await owner!.$executeRaw`
        UPDATE mirror.acat_asset_map_household SET processed_at = '2026-09-01'::timestamptz
        WHERE id = ${id("older")}`;
    }
  });

  it("annotates reusable accounts and excludes only the current transfer's exact key", async () => {
    const available = fixtureOptions(await listAssignableAssetMapAccounts(OPS));
    const reused = available.find((row) => row.accountId === id("collision-a"));
    expect(reused?.linkedTransferCount).toBe(2);
    expect(reused?.linkedTransferClients.toSorted()).toEqual([
      "Synthetic current-transfer", "Synthetic other-transfer",
    ]);
    const forCurrent = fixtureOptions(await listAssignableAssetMapAccounts(OPS, {
      currentTransferId: id("current-transfer"),
    }));
    expect(forCurrent.map((row) => row.accountId)).not.toContain(id("collision-a"));
    expect(forCurrent.map((row) => row.accountId)).toContain(id("collision-b"));
    expect(forCurrent.map((row) => row.accountId)).toContain(id("numberless-roth"));
    // Resolution permits reuse; current-transfer exclusion is only a picker UI rule.
    expect(await resolve(id("collision-a"))).not.toBeNull();

    const forNumberless = fixtureOptions(await listAssignableAssetMapAccounts(OPS, {
      currentTransferId: id("numberless-transfer"),
    }));
    expect(forNumberless.map((row) => row.accountId)).not.toContain(id("numberless-roth"));
    expect(forNumberless.map((row) => row.accountId)).toContain(id("numberless-traditional"));
  });

  it.each(["OPERATIONS", "ADMIN", "HEAD_OF_ADVISORY"])("allows %s to list and resolve", async (role) => {
    const identity = { ...OPS, role };
    const rows = fixtureOptions(await listAssignableAssetMapAccounts(identity));
    expect(rows.map((row) => row.accountId)).toContain(id("collision-a"));
    expect(await resolve(id("collision-a"), identity)).not.toBeNull();
  });

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER", "UNKNOWN", null])(
    "returns no inventory and cannot resolve a guessed valid ID for role %s",
    async (role) => {
      const identity = { ...OPS, role };
      expect(await listAssignableAssetMapAccounts(identity)).toEqual({ recommended: [], others: [] });
      expect(await resolve(id("collision-a"), identity)).toBeNull();
    },
  );
});
