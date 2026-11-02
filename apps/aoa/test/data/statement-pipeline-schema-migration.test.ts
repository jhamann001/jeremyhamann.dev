import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { markCase } from "../acat-book-flywheel";

// ticket: the statement-pipeline tables move into AoA's database in their own schema.
// The migration creates them empty, grants statement_pipeline_rw nothing outside that
// schema, and fails closed on Cloud SQL when Terraform has not created the login.

const SUITE = "statement-pipeline-schema-migration";
const root = path.resolve(import.meta.dirname, "../..");
const migration = fs.readFileSync(
  path.join(root, "prisma/migrations/20261008120000_statement_pipeline_schema/migration.sql"),
  "utf8",
);
const sql = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const TABLES = [
  "households",
  "accounts",
  "positions",
  "users",
  "mcp_tokens",
  "target_accounts",
  "source_account_links",
  "active_accounts_roster",
  "client_link_schema",
  "client_link_decisions",
  "client_folder_links",
  "client_run_links",
  "client_directory_cache",
  "client_link_batches",
  "client_link_events",
];

describe("statement_pipeline schema migration (ticket)", () => {
  it("guards the login before any object is created", () => {
    const guard = sql.indexOf("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser') THEN");
    expect(guard).toBeGreaterThan(-1);
    expect(sql).toContain("RAISE EXCEPTION 'statement_pipeline_rw must be provisioned by Terraform");
    expect(guard).toBeLessThan(sql.indexOf("CREATE SCHEMA statement_pipeline;"));
    markCase(SUITE, "guard-before-objects");
  });

  it("creates exactly the 15 pipeline tables, fully qualified", () => {
    const created = [...sql.matchAll(/CREATE TABLE (\S+) \(/g)].map((m) => m[1]);
    expect(created).toEqual(TABLES.map((t) => `statement_pipeline.${t}`));
    expect(sql).not.toMatch(/CREATE TABLE (?!statement_pipeline\.)/);
    markCase(SUITE, "fifteen-tables");
  });

  it("writes no rows, including the client_link_schema version", () => {
    expect(sql).not.toMatch(/INSERT INTO|UPDATE\s+statement_pipeline\.\w+\s+SET|\bCOPY\b/);
    markCase(SUITE, "no-rows");
  });

  it("grants statement_pipeline_rw only inside statement_pipeline and nothing to other roles", () => {
    const grants = [...sql.matchAll(/GRANT [^;]+;/g)].map((m) => m[0]);
    expect(grants).toHaveLength(4);
    for (const g of grants) {
      expect(g).toMatch(/TO statement_pipeline_rw;$/);
      expect(g).not.toMatch(/\b(app|audit|mirror)\./);
    }
    expect(grants.filter((g) => g.startsWith("GRANT TRUNCATE"))).toEqual([
      "GRANT TRUNCATE ON statement_pipeline.active_accounts_roster TO statement_pipeline_rw;",
    ]);
    expect(sql).not.toMatch(/ALTER DEFAULT PRIVILEGES|ALTER ROLE|ALL TABLES IN SCHEMA/);
    markCase(SUITE, "grants-scoped");
  });
});
