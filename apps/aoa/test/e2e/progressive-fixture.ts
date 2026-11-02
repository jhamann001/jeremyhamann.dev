import { Prisma, PrismaClient } from "@prisma/client";
import { progressiveExtraFixture } from "./progressive-extra-fixture";
import { setupDealsProgressiveFixture } from "./deals-progressive-fixture";
import { setupCrmProgressiveFixture } from "./crm-progressive-fixture";
import { setupHouseholdHistoryFixture } from "./household-history-progressive-fixture";
import { setupPortraitDealsFixture } from "./portrait-deals-fixture";

const DATABASE_NAME = "aoa_pagination_synthetic";
const FIXTURE_COUNT = 350;
const householdIds = Array.from({ length: FIXTURE_COUNT }, (_, index) =>
  `PN-HH-${String(index + 1).padStart(4, "0")}`);
const clientIds = Array.from({ length: FIXTURE_COUNT }, (_, index) =>
  `PN-CLIENT-${String(index + 1).padStart(4, "0")}`);

function localUrl(raw: string | undefined, user: string): URL {
  if (!raw) throw new Error("progressive_fixture_database_url_required");
  const url = new URL(raw);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.pathname !== `/${DATABASE_NAME}`
    || url.username !== user
    || !url.port
    || ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key))
    || process.env.K_SERVICE
    || process.env.CLOUD_RUN_SERVICE
    || process.env.APP_ENV === "prod"
    || process.env.APP_ENV === "dev"
  ) throw new Error("progressive_fixture_requires_isolated_loopback_database");
  return url;
}

/** Called by config before Playwright can start the web server, then again by setup. */
export function validateProgressiveDatabaseEnvironment() {
  const directUrl = localUrl(process.env.DIRECT_DATABASE_URL, "aoa");
  const ingestUrl = localUrl(process.env.INGEST_DATABASE_URL ?? process.env.SEED_INGEST_URL, "ingest_rw");
  const runtimeUrl = localUrl(process.env.DATABASE_URL, "app_rw");
  if (directUrl.host !== ingestUrl.host || directUrl.host !== runtimeUrl.host) {
    throw new Error("progressive_fixture_database_target_mismatch");
  }
  return { directUrl, ingestUrl };
}

/** Only invented, explicitly keyed rows in a fixed-name loopback test DB. */
export default async function progressiveFixture() {
  const { directUrl, ingestUrl } = validateProgressiveDatabaseEnvironment();
  const owner = new PrismaClient({ datasourceUrl: directUrl.toString(), log: [] });
  const ingest = new PrismaClient({ datasourceUrl: ingestUrl.toString(), log: [] });
  let extraCleanup: (() => Promise<void>) | undefined;
  let dealsCleanup: (() => Promise<void>) | undefined;
  let crmCleanup: (() => Promise<void>) | undefined;
  let historyCleanup: (() => Promise<void>) | undefined;
  let portraitDealsCleanup: (() => Promise<void>) | undefined;

  const clean = async () => {
    // Explicit fixture IDs only; never a broad LIKE/DELETE or truncate.
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM mirror.client WHERE sf_id IN (${Prisma.join(clientIds)})`);
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM mirror.household WHERE sf_id IN (${Prisma.join(householdIds)})`);
    });
  };

  try {
    const target = await owner.$queryRaw<{ database_name: string }[]>`
      SELECT current_database() AS database_name`;
    if (target[0]?.database_name !== DATABASE_NAME) {
      throw new Error("progressive_fixture_actual_database_mismatch");
    }
    const conflicts = await owner.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT count(*) AS count FROM mirror.household
       WHERE sf_id IN (${Prisma.join(householdIds)})
         AND name IS DISTINCT FROM 'PN Fixture Household ' || right(sf_id, 4)`);
    const clientConflicts = await owner.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT count(*) AS count FROM mirror.client
       WHERE sf_id IN (${Prisma.join(clientIds)})
         AND (first_name IS DISTINCT FROM 'PN Fixture'
              OR last_name IS DISTINCT FROM 'Person ' || right(sf_id, 4))`);
    if (Number(conflicts[0]?.count) || Number(clientConflicts[0]?.count)) {
      throw new Error("progressive_fixture_id_collision");
    }
    await clean();
    await ingest.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO mirror.household
          (sf_id, name, status, lead_advisor_email, aum, stage)
        SELECT 'PN-HH-' || lpad(n::text, 4, '0'),
               'PN Fixture Household ' || lpad(n::text, 4, '0'),
               'Active',
               CASE WHEN n % 2 = 1 THEN 'avery@example.com'
                    ELSE 'blake@example.com' END,
               n * 1000, 'Client'
          FROM generate_series(1, ${FIXTURE_COUNT}::integer) AS n`;
      await tx.$executeRaw`
        INSERT INTO mirror.client
          (sf_id, household_id, first_name, last_name, email, lead_advisor_email)
        SELECT 'PN-CLIENT-' || lpad(n::text, 4, '0'),
               'PN-HH-' || lpad(n::text, 4, '0'),
               'PN Fixture', 'Person ' || lpad(n::text, 4, '0'),
               'synthetic-person-' || n::text || '@example.invalid',
               CASE WHEN n % 2 = 1 THEN 'avery@example.com'
                    ELSE 'blake@example.com' END
          FROM generate_series(1, ${FIXTURE_COUNT}::integer) AS n`;
    });
    extraCleanup = await progressiveExtraFixture(owner);
    dealsCleanup = await setupDealsProgressiveFixture(owner);
    crmCleanup = await setupCrmProgressiveFixture(owner);
    historyCleanup = await setupHouseholdHistoryFixture(owner);
    portraitDealsCleanup = await setupPortraitDealsFixture(owner);
  } catch (error) {
    await Promise.all([owner.$disconnect(), ingest.$disconnect()]);
    throw error;
  }

  return async () => {
    try {
      await portraitDealsCleanup?.();
      await extraCleanup?.();
      await dealsCleanup?.();
      await crmCleanup?.();
      await historyCleanup?.();
      await clean();
    } finally {
      await Promise.all([owner.$disconnect(), ingest.$disconnect()]);
    }
  };
}
