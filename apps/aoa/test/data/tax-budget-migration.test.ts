import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260803120000_app_tax_budget",
    "migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("app.tax_budget migration", () => {
  it("stores one row per client/year with non-negative values and retained history", () => {
    expect(sqlOnly).toMatch(/CREATE TABLE "app"\."tax_budget"/i);
    expect(sqlOnly).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*?ON "app"\."tax_budget"\("client_sf_id", "year"\)/i,
    );
    expect(sqlOnly).toMatch(/CHECK \("budget" >= 0\)/i);
    expect(sqlOnly).toMatch(/CHECK \("realized" >= 0\)/i);
  });

  it("is human-written only, never hard-deleted or ingested", () => {
    expect(sqlOnly).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON "app"\."tax_budget" TO app_rw/i,
    );
    expect(sqlOnly).toMatch(/REVOKE DELETE ON "app"\."tax_budget" FROM app_rw/i);
    expect(sqlOnly).not.toMatch(/FOR DELETE/i);
    expect(sqlOnly).not.toMatch(/ingest_rw/i);
  });

  it("enables FORCE RLS and resolves visibility through mirror.client", () => {
    expect(sqlOnly).toMatch(
      /ALTER TABLE "app"\."tax_budget" ENABLE ROW LEVEL SECURITY/i,
    );
    expect(sqlOnly).toMatch(
      /ALTER TABLE "app"\."tax_budget" FORCE ROW LEVEL SECURITY/i,
    );
    expect(sqlOnly).toMatch(/SELECT 1 FROM mirror\.client c/i);
    expect(sqlOnly).not.toMatch(/\bVIEWER\b/);
  });

  it("has no cross-schema FK and carries the DB row-change audit trigger", () => {
    expect(sqlOnly).not.toMatch(/REFERENCES/i);
    expect(sqlOnly).toMatch(
      /CREATE TRIGGER tax_budget_audit[\s\S]*?EXECUTE FUNCTION audit\.log_row_change\(\)/i,
    );
  });
});
