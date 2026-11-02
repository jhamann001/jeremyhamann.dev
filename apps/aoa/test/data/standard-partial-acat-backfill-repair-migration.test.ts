import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(join(import.meta.dirname, "../../prisma/migrations/20260924120000_standard_partial_acat_backfill_repair/migration.sql"), "utf8");
const statements = SQL.replace(/--[^\n]*/g, "");

describe("standard partial-ACAT backfill repair migration", () => {
  it("restores forced RLS atomically after owner-only backfill access", () => {
    expect(statements.trim()).toMatch(/^BEGIN;/);
    expect(statements.trim()).toMatch(/COMMIT;$/);
    for (const table of ["decision_case", "decision_task", "decision_case_event"]) {
      const relax = statements.indexOf(`ALTER TABLE "app"."${table}" NO FORCE ROW LEVEL SECURITY;`);
      const restore = statements.indexOf(`ALTER TABLE "app"."${table}" FORCE ROW LEVEL SECURITY;`);
      expect(relax).toBeGreaterThan(0);
      expect(relax).toBeLessThan(statements.indexOf("WITH standard_cases"));
      expect(restore).toBeGreaterThan(statements.lastIndexOf('UPDATE "app"."decision_case"'));
      expect(restore).toBeLessThan(statements.indexOf("COMMIT;"));
    }
    expect(statements).not.toMatch(/DISABLE ROW LEVEL SECURITY|CREATE POLICY|GRANT|BYPASSRLS/i);
  });

  it("replays the original data repair without rewriting the applied migration", () => {
    const original = readFileSync(join(import.meta.dirname, "../../prisma/migrations/20260909184500_standard_partial_acat_tasks/migration.sql"), "utf8");
    expect(SQL).toContain(original.slice(original.indexOf("WITH standard_cases AS (")));
    expect(statements).not.toMatch(/DELETE\s+FROM|DROP|CREATE TABLE|ADD COLUMN/i);
  });
});
