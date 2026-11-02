// Shared scratch-database setup for the opt-in Trade Request copy suites (ticket). Local Postgres 16 only:
// trb_copy_src holds the standalone schema (TRADE_REQUEST_SERVICE_DIR's migrations) plus the synthetic fixture, and
// trb_copy_tgt is a fresh AoA database migrated with `prisma migrate deploy`. Both are dropped in teardown.
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { RECORD_KINDS } from "@/lib/trade-requests/records/catalog";

export const enabled = process.env.TRADE_REQUEST_COPY_TEST_DB === "1";
export const SRC_DB = "trb_copy_src";
export const TGT_DB = "trb_copy_tgt";
const ROOT = join(import.meta.dirname, "..");
const OS_USER = userInfo().username;
export const SRC_URL = `postgresql://${OS_USER}@localhost:5432/${SRC_DB}`;
export const TGT_URL = `postgresql://aoa@localhost:5432/${TGT_DB}`;
const TGT_PRISMA_URL = `${TGT_URL}?schema=app`;
const FIXTURE = join(ROOT, "test/fixtures/trade-request-source-fixture.sql");
const TABLES = RECORD_KINDS.map((k) => k.table);

export function psql(db: string, sql: string): string {
  return execFileSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", `postgresql://${OS_USER}@localhost:5432/${db}`, "-c", sql], {
    encoding: "utf8",
  }).trim();
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): void {
  execFileSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "ignore", "pipe"] });
}

export async function createDatabases(): Promise<void> {
  const standalone = process.env.TRADE_REQUEST_SERVICE_DIR;
  if (!standalone) throw new Error("TRADE_REQUEST_SERVICE_DIR must point at a trade-request checkout");
  run("dropdb", ["--if-exists", SRC_DB]);
  run("createdb", [SRC_DB]);
  run("npx", ["node-pg-migrate", "up", "--migrations-dir", "migrations"], {
    cwd: join(standalone, "server"),
    env: { DATABASE_URL: `postgres://localhost:5432/${SRC_DB}` },
  });
  psql(SRC_DB, "CREATE TABLE trb_security_sector_snapshot AS SELECT * FROM security_sector");
  run("dropdb", ["--if-exists", TGT_DB]);
  run("createdb", ["-O", "aoa", TGT_DB]);
  run("npx", ["prisma", "migrate", "deploy"], { cwd: ROOT, env: { DIRECT_DATABASE_URL: TGT_PRISMA_URL, DATABASE_URL: TGT_PRISMA_URL } });
  psql(
    TGT_DB,
    `INSERT INTO app."User" (id, name, email, "createdAt") VALUES ('trb-user-1', 'Synthetic Person', 'synthetic.person@example.com', '2026-10-01T00:00:00Z');
     INSERT INTO app."Account" (id, "userId", type, provider, "providerAccountId") VALUES ('trb-acct-1', 'trb-user-1', 'oidc', 'okta', 'synthetic-1');`,
  );
}

export function clients(): { source: PrismaClient; target: PrismaClient } {
  return { source: new PrismaClient({ datasourceUrl: SRC_URL }), target: new PrismaClient({ datasourceUrl: TGT_URL }) };
}

export function resetDatabases(): void {
  const nonSector = TABLES.filter((t) => t !== "security_sector");
  psql(
    SRC_DB,
    `TRUNCATE ${nonSector.join(", ")} CASCADE;
     TRUNCATE security_sector; INSERT INTO security_sector SELECT * FROM trb_security_sector_snapshot;`,
  );
  execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", SRC_URL, "-f", FIXTURE], { stdio: ["ignore", "ignore", "pipe"] });
  psql(
    TGT_DB,
    `DROP TABLE IF EXISTS trade_request.shadow_probe; DROP TABLE IF EXISTS trade_request.fk_probe;
     TRUNCATE ${TABLES.map((t) => `trade_request.${t}`).join(", ")}, trade_request.copy_runs, trade_request.serving_state_transitions;
     UPDATE trade_request.serving_state SET serving_source = 'standalone', digest_sender = 'standalone', drift_sender = 'standalone';`,
  );
}

export function dropDatabases(): void {
  psql("postgres", "ALTER ROLE trade_request_mcp_ro PASSWORD NULL");
  run("dropdb", ["--if-exists", "--force", SRC_DB]);
  run("dropdb", ["--if-exists", "--force", TGT_DB]);
}

/** Per-table row count and an order-independent content digest, for "nothing changed" assertions. */
export function tableDigests(db: string, schema: string, tables: readonly string[] = TABLES): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tables) {
    out[t] = psql(
      db,
      `SET TIME ZONE 'UTC'; SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text), '')) FROM "${schema}"."${t}" x`,
    );
  }
  return out;
}
