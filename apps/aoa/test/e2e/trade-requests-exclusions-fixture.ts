import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { byName } from "./trade-requests-new-synthetic";

export const TRW12_DATABASE = "aoa_trw12_synthetic";
export const CLIENT_SERVICE_EMAIL = "client-service.synthetic@example.com";
export const TRW12_PORTS = { on: 3211, off: 3212, service: 8211, warehouse: 9211 } as const;

function loopback(raw: string | undefined, user: string): URL {
  if (!raw) throw new Error("trade_requests_exclusions_browser_database_url_required");
  const url = new URL(raw);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port
    || url.pathname !== `/${TRW12_DATABASE}`
    || url.username !== user
    || ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key))
    || process.env.K_SERVICE
    || process.env.CLOUD_RUN_SERVICE
    || process.env.APP_ENV === "prod"
  ) throw new Error("trade_requests_exclusions_browser_requires_isolated_loopback_database");
  return url;
}

export function validateExclusionsBrowserDatabase(): URL {
  const owner = loopback(process.env.DIRECT_DATABASE_URL, "aoa");
  const runtime = loopback(process.env.DATABASE_URL, "app_rw");
  if (owner.host !== runtime.host) throw new Error("trade_requests_exclusions_browser_database_target_mismatch");
  return owner;
}

export function serviceSql(sql: string): string {
  const db = process.env.TRW12_SERVICE_DB ?? "";
  if (!/^trw_local_[a-z0-9_]+$/.test(db)) throw new Error("trade_requests_exclusions_browser_requires_local_service_database");
  return execFileSync("psql", ["-h", "/tmp", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-At", "-c", sql], { stdio: "pipe" }).toString();
}

const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;
const ALEX = byName("Maeve Brennan (synthetic)");
const BLAIR = byName("Lucille Howell (synthetic)");
const CLEANUP = [
  "DELETE FROM client_exclusions WHERE client_id LIKE 'trw11-%'",
  "DELETE FROM account_exclusions WHERE account_id LIKE '01TRW11SYN%'",
];

type Seed = { owner: string; ticker: string; kind: "advisor" | "client"; reason: string; noBuy: boolean; noSell: boolean };
const values = (rows: Seed[]) => rows.map((r) =>
  `(${lit(r.owner)}, ${lit(r.ticker)}, ${lit(r.kind)}, ${lit(r.reason)}, ${r.noBuy}, ${r.noSell}, 'Seed Operator (synthetic)', '2026-10-01T15:00:00Z')`).join(", ");

/** Synthetic standing lists: client-level for Alex and Lucille Howell, account-level on Alex's individual account. */
export function seedStandingExclusions() {
  const clients: Seed[] = [
    { owner: ALEX.id, ticker: "TSLA", kind: "advisor", reason: "Concentration risk (synthetic)", noBuy: true, noSell: false },
    { owner: ALEX.id, ticker: "AAPL", kind: "client", reason: "Employer stock (synthetic)", noBuy: true, noSell: true },
    { owner: BLAIR.id, ticker: "XOM", kind: "advisor", reason: "", noBuy: false, noSell: true },
  ];
  const accounts: Seed[] = [
    { owner: ALEX.accounts[0].ulid, ticker: "GME", kind: "advisor", reason: "", noBuy: true, noSell: false },
    { owner: ALEX.accounts[0].ulid, ticker: "AMC", kind: "client", reason: "Imported from /data/restrictions.csv", noBuy: true, noSell: true },
  ];
  serviceSql([
    ...CLEANUP,
    `INSERT INTO client_exclusions (client_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at) VALUES ${values(clients)}`,
    `INSERT INTO account_exclusions (account_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at) VALUES ${values(accounts)}`,
  ].join(";\n"));
}

/** Adds the synthetic CLIENT_SERVICE user the seed lacks and the standing lists; removes both afterwards. */
export default async function tradeRequestsExclusionsFixture() {
  const owner = new PrismaClient({ datasourceUrl: validateExclusionsBrowserDatabase().toString(), log: [] });
  try {
    const [{ database }] = await owner.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (database !== TRW12_DATABASE) throw new Error("trade_requests_exclusions_browser_actual_database_mismatch");
    await owner.user.upsert({
      where: { email: CLIENT_SERVICE_EMAIL },
      create: { email: CLIENT_SERVICE_EMAIL, name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
      update: { name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
    });
    seedStandingExclusions();
  } catch (error) {
    await owner.$disconnect();
    throw error;
  }
  return async () => {
    try {
      serviceSql(CLEANUP.join(";\n"));
      await owner.user.deleteMany({ where: { email: CLIENT_SERVICE_EMAIL } });
    } finally {
      await owner.$disconnect();
    }
  };
}
