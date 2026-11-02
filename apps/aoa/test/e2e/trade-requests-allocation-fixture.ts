import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

export const TRW14_DATABASE = "aoa_trw14_synthetic";
export const CLIENT_SERVICE_EMAIL = "client-service.synthetic@example.com";
export const TRW14_PORTS = { on: 3201, off: 3202, service: 8201, warehouse: 9201 } as const;
export const OTHER_ADVISOR_EMAIL = "trw14-other-advisor@synthetic.invalid";
export const ADVISOR_EMAIL = "avery@example.com";

/**
 * Synthetic prior allocations in the local service database: Esta Barrows's on
 * a request the signed-in ADVISOR submitted (visible to every workspace role),
 * Abdullah Beatty's on another advisor's request (visible to reviewers only), and a
 * newer Pending Review request that must not count.
 */
export const PRIORS = {
  morgan: { riskProfile: 15, base: { equity: 70, fixed: 27, cash: 3 }, strategies: [
    { id: 1, benchmark: "IWM", allocation: 60, rationale: "Small-cap tilt (synthetic)" },
    { id: 2, benchmark: "EFA", allocation: 40, rationale: "International (synthetic)" }] },
  abdullah: { riskProfile: 9, base: { equity: 52, fixed: 42, cash: 6 }, strategies: [
    { id: 1, benchmark: "SPY", allocation: 100, rationale: "Core (synthetic)" }] },
} as const;

function loopback(raw: string | undefined, user: string): URL {
  if (!raw) throw new Error("trade_requests_allocation_browser_database_url_required");
  const url = new URL(raw);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port
    || url.pathname !== `/${TRW14_DATABASE}`
    || url.username !== user
    || ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key))
    || process.env.K_SERVICE
    || process.env.CLOUD_RUN_SERVICE
    || process.env.APP_ENV === "prod"
  ) throw new Error("trade_requests_allocation_browser_requires_isolated_loopback_database");
  return url;
}

export function validateAllocationBrowserDatabase(): URL {
  const owner = loopback(process.env.DIRECT_DATABASE_URL, "aoa");
  const runtime = loopback(process.env.DATABASE_URL, "app_rw");
  if (owner.host !== runtime.host) throw new Error("trade_requests_allocation_browser_database_target_mismatch");
  return owner;
}

function serviceSql(sql: string) {
  const db = process.env.TRW14_SERVICE_DB ?? "";
  if (!/^trw_local_[a-z0-9_]+$/.test(db)) throw new Error("trade_requests_allocation_browser_requires_local_service_database");
  execFileSync("psql", ["-h", "/tmp", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { stdio: "pipe" });
}

const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;
const json = (value: unknown) => `${lit(JSON.stringify(value))}::jsonb`;
const CLEANUP = "DELETE FROM trade_requests WHERE id LIKE 'TRW14-%'";

function request(id: string, client: { id: string; name: string }, tradeType: string, status: string, advisorEmail: string,
  prior: { riskProfile: number; base: object; strategies: readonly object[] }, updatedAt: string) {
  return `INSERT INTO trade_requests (id, client_id, client_name, client_ids, client_names, advisor_id, trade_type, status, priority,
      risk_profile, base_allocation, equity_strategies, created_at, updated_at)
    SELECT ${lit(id)}, ${lit(client.id)}, ${lit(client.name)}, ${json([client.id])}, ${json([client.name])}, u.id, ${lit(tradeType)}, ${lit(status)},
      'Standard', ${prior.riskProfile}, ${json(prior.base)}, ${json(prior.strategies)}, ${lit(updatedAt)}, ${lit(updatedAt)}
    FROM users u WHERE lower(u.email) = ${lit(advisorEmail)}`;
}

export function seedPriorAllocations() {
  const morgan = { id: "trw11-morgan", name: "Esta Barrows (synthetic)" };
  const abdullah = { id: "trw11-abdullah", name: "Abdullah Beatty (synthetic)" };
  serviceSql([
    CLEANUP,
    `INSERT INTO users (email, name, role, is_active) VALUES
      (${lit(ADVISOR_EMAIL)}, 'Avery Stone', 'advisor', false), (${lit(OTHER_ADVISOR_EMAIL)}, 'Other Advisor (synthetic)', 'advisor', false)
      ON CONFLICT (email) DO NOTHING`,
    request("TRW14-PRIOR-MORGAN", morgan, "Rebalance", "Approved", ADVISOR_EMAIL, PRIORS.morgan, "2026-10-01T15:00:00Z"),
    request("TRW14-PENDING-MORGAN", morgan, "Rebalance", "Pending Review", ADVISOR_EMAIL,
      { riskProfile: 22, base: { equity: 91, fixed: 9, cash: 0 }, strategies: [{ id: 1, benchmark: "QQQ", allocation: 100, rationale: "x" }] },
      "2026-10-10T15:00:00Z"),
    request("TRW14-PRIOR-ABDULLAH", abdullah, "Initial Funding", "Completed", OTHER_ADVISOR_EMAIL, PRIORS.abdullah, "2026-09-20T15:00:00Z"),
  ].join(";\n"));
}

/** Adds the synthetic CLIENT_SERVICE user the seed lacks and the service's prior allocations; removes both afterwards. */
export default async function tradeRequestsAllocationFixture() {
  const owner = new PrismaClient({ datasourceUrl: validateAllocationBrowserDatabase().toString(), log: [] });
  try {
    const [{ database }] = await owner.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (database !== TRW14_DATABASE) throw new Error("trade_requests_allocation_browser_actual_database_mismatch");
    await owner.user.upsert({
      where: { email: CLIENT_SERVICE_EMAIL },
      create: { email: CLIENT_SERVICE_EMAIL, name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
      update: { name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
    });
    seedPriorAllocations();
  } catch (error) {
    await owner.$disconnect();
    throw error;
  }
  return async () => {
    try {
      serviceSql(CLEANUP);
      await owner.user.deleteMany({ where: { email: CLIENT_SERVICE_EMAIL } });
    } finally {
      await owner.$disconnect();
    }
  };
}
