import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { readAssetMapHousehold, readAssetMapHouseholdList } from "@/lib/data/asset-map";
import { ASSET_MAP_WORKSPACE_SCOPE } from "@/lib/data/asset-map-workspace-scope";
import { prisma } from "@/lib/db";
import { withUserScope, type Identity, type UserScopeTransactionOptions } from "@/lib/rls";

// ticket: Advisor and Client Service read the asset-map mirror only inside the
// workspace scope; Viewer never does; no other reader of these tables widens.

const gated = process.env.INGEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "ZZTEST-ASSET-ROLE-READ-";
const id = (suffix: string) => `${PREFIX}${suffix}`;
const who = (role: string): Identity => ({ role, email: `asset-map-role-${role.toLowerCase()}@example.test` });

async function visible(identity: Identity, options?: UserScopeTransactionOptions) {
  const pattern = `${PREFIX}%`;
  return withUserScope(identity, async (tx) => {
    const [row] = await tx.$queryRaw<{ households: number; accounts: number; positions: number }[]>`
      SELECT
        (SELECT count(*)::int FROM mirror.acat_asset_map_household WHERE id LIKE ${pattern}) AS households,
        (SELECT count(*)::int FROM mirror.acat_asset_map_account WHERE id LIKE ${pattern}) AS accounts,
        (SELECT count(*)::int FROM mirror.acat_asset_map_position WHERE id LIKE ${pattern}) AS positions`;
    return row;
  }, options);
}

const ALL = { households: 1, accounts: 1, positions: 1 };
const NONE = { households: 0, accounts: 0, positions: 0 };

gated("Asset-map mirror role reads with actual PostgreSQL/RLS (ticket)", () => {
  let owner: PrismaClient | undefined;

  async function cleanup() {
    if (!owner) return;
    await owner.$executeRaw`DELETE FROM mirror.acat_asset_map_household WHERE id LIKE ${`${PREFIX}%`}`;
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
        ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key))
      ) {
        throw new Error("Role-read integration tests require one loopback synthetic database");
      }
    }
    if (new URL(appUrl).username !== "app_rw") {
      throw new Error("Role-read RLS reads must run as app_rw");
    }
    owner = new PrismaClient({ datasourceUrl: cleanupUrl });
    await cleanup();
    await owner.$executeRaw`
      INSERT INTO mirror.acat_asset_map_household (id, client_name, processed_at)
      VALUES (${id("household")}, 'Synthetic Role Reader', ${new Date("2026-10-01")})`;
    await owner.$executeRaw`
      INSERT INTO mirror.acat_asset_map_account (id, household_id, custodian, account_holder, total_value)
      VALUES (${id("account")}, ${id("household")}, 'Synthetic Custodian', 'Synthetic Role Reader', 100.00)`;
    await owner.$executeRaw`
      INSERT INTO mirror.acat_asset_map_position (id, account_id, symbol, market_value)
      VALUES (${id("position")}, ${id("account")}, 'SYNX', 100.00)`;
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await owner?.$disconnect();
      await prisma.$disconnect();
    }
  });

  it("Advisor and Client Service see every table inside the workspace scope", async () => {
    for (const role of ["ADVISOR", "CLIENT_SERVICE"]) {
      expect(await visible(who(role), ASSET_MAP_WORKSPACE_SCOPE)).toEqual(ALL);
      const household = await withUserScope(who(role), (tx) => readAssetMapHousehold(tx, id("household")), ASSET_MAP_WORKSPACE_SCOPE);
      expect(household?.accounts.map((a) => a.positions.map((p) => p.symbol))).toEqual([["SYNX"]]);
      const list = await withUserScope(who(role), (tx) => readAssetMapHouseholdList(tx), ASSET_MAP_WORKSPACE_SCOPE);
      expect(list.map((run) => run.id)).toContain(id("household"));
    }
  });

  it("Advisor and Client Service see nothing outside the workspace scope, as the asset-transfer page reads", async () => {
    for (const role of ["ADVISOR", "CLIENT_SERVICE"]) {
      expect(await visible(who(role))).toEqual(NONE);
    }
  });

  it("Viewer and unknown roles see nothing, even with the workspace scope", async () => {
    for (const role of ["VIEWER", "OWNER"]) {
      expect(await visible(who(role), ASSET_MAP_WORKSPACE_SCOPE)).toEqual(NONE);
    }
  });

  it("Operations reads unchanged with or without the workspace scope", async () => {
    expect(await visible(who("OPERATIONS"))).toEqual(ALL);
    expect(await visible(who("OPERATIONS"), ASSET_MAP_WORKSPACE_SCOPE)).toEqual(ALL);
  });

  it("the workspace scope gives Advisor no write: an update touches no row", async () => {
    const changed = await withUserScope(who("ADVISOR"), (tx) =>
      tx.$executeRaw`UPDATE mirror.acat_asset_map_position SET override_status = 'NOT_TRANSFERABLE' WHERE id = ${id("position")}`,
      ASSET_MAP_WORKSPACE_SCOPE,
    ).catch(() => 0);
    expect(changed).toBe(0);
    const [row] = await owner!.$queryRaw<{ override_status: string | null }[]>`
      SELECT override_status FROM mirror.acat_asset_map_position WHERE id = ${id("position")}`;
    expect(row.override_status).toBeNull();
  });
});
