import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { driftSeedStatements, type DriftSeed } from "./trade-requests-drift-seed";
import { CLIENT_SERVICE_EMAIL } from "./trade-requests-workspace-fixture";

const DATABASE_NAME = "aoa_trb09_synthetic";
export const DRIFT_SEED = JSON.parse(readFileSync("test/fixtures/trade-request-drift-view-seed.json", "utf8")) as DriftSeed;

function localUrl(raw: string | undefined, user: string): URL {
  if (!raw) throw new Error("trade_requests_drift_database_url_required");
  const url = new URL(raw);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port
    || url.pathname !== `/${DATABASE_NAME}`
    || url.username !== user
    || ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key))
    || process.env.K_SERVICE
    || process.env.CLOUD_RUN_SERVICE
    || process.env.APP_ENV === "prod"
  ) throw new Error("trade_requests_drift_requires_isolated_loopback_database");
  return url;
}

/** Called by the config before any server starts, then again by setup and specs. */
export function validateTradeRequestsDriftDatabase(): URL {
  const owner = localUrl(process.env.DIRECT_DATABASE_URL, "aoa");
  const runtime = localUrl(process.env.DATABASE_URL, "app_rw");
  if (owner.host !== runtime.host) throw new Error("trade_requests_drift_database_target_mismatch");
  return owner;
}

function ownerClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: validateTradeRequestsDriftDatabase().toString(), log: [] });
}

async function withOwner<T>(fn: (owner: PrismaClient) => Promise<T>): Promise<T> {
  const owner = ownerClient();
  try {
    const [{ database }] = await owner.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (database !== DATABASE_NAME) throw new Error("trade_requests_drift_actual_database_mismatch");
    return await fn(owner);
  } finally {
    await owner.$disconnect();
  }
}

/** The serving state the Drift and Roster screens follow (only the serving source matters here). */
export function setServingSource(source: "aoa" | "standalone"): Promise<void> {
  return withOwner(async (owner) => {
    await owner.$executeRaw`UPDATE trade_request.serving_state SET serving_source = ${source}, updated_by = 'ticket-e2e' WHERE id`;
  });
}

/** Resets the synthetic drift run, the override, the shadow-only run and the trader roster, AOA-served. */
export function reseedDrift(): Promise<void> {
  return withOwner(async (owner) => {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`TRUNCATE trade_request.position_drift_accounts, trade_request.shadow_position_drift_accounts,
        trade_request.drift_status_overrides, trade_request.drift_override_changes, trade_request.roster_changes, trade_request.users CASCADE`);
      for (const sql of driftSeedStatements(DRIFT_SEED, "trade_request", { shadow: true })) await tx.$executeRawUnsafe(sql);
      for (const member of DRIFT_SEED.roster) {
        await tx.$executeRaw`INSERT INTO trade_request.users (email, name, role, is_active) VALUES (${member.email}, ${member.name}, 'trader', true)`;
      }
      await tx.$executeRaw`UPDATE trade_request.serving_state SET serving_source = 'aoa', updated_by = 'ticket-e2e' WHERE id`;
    });
  });
}

/** Global setup: the synthetic CLIENT_SERVICE user and the seed; teardown restores standalone serving and empties the tables. */
export default async function tradeRequestsDriftFixture() {
  await withOwner(async (owner) => {
    await owner.user.upsert({
      where: { email: CLIENT_SERVICE_EMAIL },
      create: { email: CLIENT_SERVICE_EMAIL, name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
      update: { name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
    });
  });
  await reseedDrift();
  return async () => {
    await withOwner(async (owner) => {
      await owner.$executeRawUnsafe(`TRUNCATE trade_request.position_drift_accounts, trade_request.shadow_position_drift_accounts,
        trade_request.drift_status_overrides, trade_request.drift_override_changes, trade_request.roster_changes, trade_request.users CASCADE`);
      await owner.$executeRaw`UPDATE trade_request.serving_state SET serving_source = 'standalone', updated_by = 'ticket-e2e' WHERE id`;
      await owner.user.deleteMany({ where: { email: CLIENT_SERVICE_EMAIL } });
    });
  };
}
