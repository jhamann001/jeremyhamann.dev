import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260824190000_crm_duplicate_household_definer_policy/migration.sql",
), "utf8");

describe("CRM duplicate household definer policy migration", () => {
  it("adds only the owner-targeted household read policy", () => {
    expect(sql).toMatch(/CREATE POLICY household_duplicate_definer_read/i);
    expect(sql).toMatch(/ON mirror\.household FOR SELECT TO %s USING \(true\)/i);
    expect(sql).toMatch(/quote_ident\(current_user\)/i);
    expect(sql).not.toMatch(/TO\s+(app_rw|identity_reconciler|ingest_rw)/i);
  });

  it("does not mutate household or registry data", () => {
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/UPDATE\s+(mirror|app)\./i);
    expect(sql).not.toMatch(/INSERT INTO/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
  });
});
