import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { readAssetMapHousehold } from "@/lib/data/asset-map";
import { applyAssetMapWriteThrough } from "@/lib/data/asset-map-write-through";
import { prisma } from "@/lib/db";
import { ingestPrisma } from "@/lib/ingest/db";
import { withIngestScope } from "@/lib/ingest/scope";
import { withUserScope, type Identity } from "@/lib/rls";

const gated = process.env.INGEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "ZZTEST-ticket-";
const HH = `${PREFIX}household`;
const ACC = `${PREFIX}account`;
const OTHER_ACC = `${PREFIX}other-account`;
const DEV_SERVICE_ACCOUNT = "aoa-run@ops-portal-dev.iam.gserviceaccount.com";
const VIEWER: Identity = { role: "OPERATIONS", email: "ticket-viewer@example.test" };

gated("manual account-type badge with actual PostgreSQL (ticket)", () => {
  let owner: PrismaClient | undefined;
  let originalAppEnv: string | undefined;

  async function cleanup() {
    if (!owner) return;
    await owner.$executeRaw`DELETE FROM mirror.acat_asset_map_household WHERE id = ${HH}`;
    await owner.$executeRaw`DELETE FROM audit."AuditLog" WHERE "entityId" LIKE ${`${PREFIX}%`}`;
  }

  async function badge() {
    const view = await withUserScope(VIEWER, (tx) => readAssetMapHousehold(tx, HH));
    return view?.accounts.find((a) => a.id === ACC);
  }

  async function audit(email: string, at: string, action: string, entityId: string) {
    await owner!.$executeRaw`
      INSERT INTO audit."AuditLog" (at, "actorEmail", "actorRole", action, "entityType", "entityId")
      VALUES (${at}::timestamp, ${email}, 'OPERATIONS', ${action}, 'asset_map_account', ${entityId})`;
  }

  beforeAll(async () => {
    originalAppEnv = process.env.APP_ENV;
    process.env.APP_ENV = "dev";
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
        throw new Error("Badge integration tests require one loopback synthetic database");
      }
    }
    if (new URL(appUrl).username !== "app_rw") {
      throw new Error("Badge RLS reads must run as app_rw");
    }
    owner = new PrismaClient({ datasourceUrl: cleanupUrl });
    await cleanup();
    await owner.$executeRaw`
      INSERT INTO mirror.acat_asset_map_household (id, client_name) VALUES (${HH}, 'Synthetic Badge Client')`;
    await owner.$executeRaw`
      INSERT INTO mirror.acat_asset_map_account (id, household_id, custodian, account_type)
      VALUES (${ACC}, ${HH}, 'Synthetic Custodian', 'Individual')`;
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      if (originalAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = originalAppEnv;
      await owner?.$disconnect();
      await prisma.$disconnect();
      await ingestPrisma.$disconnect();
    }
  });

  it("no override shows no badge, and a confirmed save stores the operator and save time (ticket)", async () => {
    expect((await badge())?.accountTypeOverride).toBeNull();
    await withIngestScope((tx) => applyAssetMapWriteThrough(tx, {
      kind: "accountType", accountId: ACC, accountType: "IRA", accountTypeOther: null,
      overriddenBy: "ticket-saver@example.test", overriddenAt: "2026-10-06T14:05:00.000Z",
    }));
    const account = await badge();
    expect(account?.accountTypeOverride).toEqual({ by: "ticket-saver@example.test", at: "2026-10-06T14:05:00.000Z" });
    expect(account?.accountType).toBe("IRA");
  });

  it("AoA's service account is credited to the latest account-type audit row (ticket)", async () => {
    await owner!.$executeRaw`
      UPDATE mirror.acat_asset_map_account SET account_type_overridden_by = ${DEV_SERVICE_ACCOUNT} WHERE id = ${ACC}`;
    await audit("ticket-earlier@example.test", "2026-10-06 13:00:00", "asset_map_edit.account_type", ACC);
    await audit("ticket-saver@example.test", "2026-10-06 14:05:01", "asset_map_edit.account_type", ACC);
    await audit("ticket-decoy@example.test", "2026-10-06 16:00:00", "asset_map_edit.account_delete", ACC);
    await audit("ticket-other-account@example.test", "2026-10-06 16:30:00", "asset_map_edit.account_type", OTHER_ACC);
    expect((await badge())?.accountTypeOverride?.by).toBe("ticket-saver@example.test");
  });

  it("a later pipeline edit is credited to the pipeline person, not the earlier AoA editor (ticket)", async () => {
    await owner!.$executeRaw`
      UPDATE mirror.acat_asset_map_account
      SET account_type_overridden_by = 'ticket-pipeline@example.test',
          account_type_overridden_at = '2026-10-06T15:00:00Z'
      WHERE id = ${ACC}`;
    expect((await badge())?.accountTypeOverride).toEqual({ by: "ticket-pipeline@example.test", at: "2026-10-06T15:00:00.000Z" });
  });

  it("AoA's service account with no audit row names no AoA person (ticket)", async () => {
    await owner!.$executeRaw`DELETE FROM audit."AuditLog" WHERE "entityId" = ${ACC}`;
    await owner!.$executeRaw`
      UPDATE mirror.acat_asset_map_account SET account_type_overridden_by = ${DEV_SERVICE_ACCOUNT} WHERE id = ${ACC}`;
    expect((await badge())?.accountTypeOverride).toEqual({ by: null, at: "2026-10-06T15:00:00.000Z" });
  });
});
