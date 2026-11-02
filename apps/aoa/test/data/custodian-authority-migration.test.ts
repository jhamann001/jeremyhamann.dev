import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markCase } from "../acat-book-flywheel";

const SQL = readFileSync(
  join(import.meta.dirname, "..", "..", "prisma", "migrations", "20261102120000_custodian_authority_storage", "migration.sql"),
  "utf8",
);
const sqlOnly = SQL.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
const TABLES = ["custodian_profile", "custodian_fee_rule", "custodian_authority_state", "custodian_authority_event"];

describe("custodian authority storage migration", () => {
  it("creates the four authority tables without the retired Tracker fields", () => {
    for (const table of TABLES) expect(sqlOnly).toMatch(new RegExp(`CREATE TABLE "app"\\."${table}"`));
    expect(sqlOnly).not.toMatch(/recent_clients|requires_manual_review/i);
    expect(sqlOnly).not.toMatch(/REFERENCES "app"\."transfer/i);
    markCase("custodian-authority-migration", "creates the four authority tables without the retired Tracker fields");
  });

  it("forces RLS, reads for ADMIN/OPERATIONS, writes for ADMIN only and never grants DELETE", () => {
    for (const table of TABLES) {
      expect(sqlOnly).toMatch(new RegExp(`ALTER TABLE "app"\\."${table}" FORCE ROW LEVEL SECURITY`));
      expect(sqlOnly).toMatch(new RegExp(`CREATE POLICY ${table}_read ON "app"\\."${table}"\\s+FOR SELECT TO app_rw USING \\(current_setting\\('app\\.user_role', true\\) IN \\('ADMIN', 'OPERATIONS'\\)\\)`));
    }
    expect(sqlOnly.match(/= 'ADMIN'/g)?.length).toBe(9);
    expect(sqlOnly).not.toMatch(/'ADVISOR'|'CLIENT_SERVICE'|'VIEWER'/);
    expect(sqlOnly).not.toMatch(/GRANT[^;]*DELETE[^;]*TO app_rw/i);
    expect(sqlOnly).toMatch(/REVOKE UPDATE, DELETE ON "app"\."custodian_authority_event" FROM app_rw/);
    markCase("custodian-authority-migration", "forces RLS, reads for ADMIN/OPERATIONS, writes for ADMIN only and never grants DELETE");
  });

  it("pins the Tracker enum values as CHECK allow-lists", () => {
    expect(sqlOnly).toContain(`"review_status" IN ('NEEDS_SETUP', 'VERIFIED')`);
    expect(sqlOnly).toContain(`"transfer_type" IN ('ACAT_API', 'MANUAL', 'MIXED', 'INTERNAL', 'UNCONFIRMED')`);
    expect(sqlOnly).toContain(`"documentation_status" IN ('DOCUMENTED', 'PARTIAL', 'NEEDS_CALL')`);
    expect(sqlOnly).toContain(`"contact_method" IN ('EMAIL', 'PHONE', 'PORTAL', 'OTHER')`);
    expect(sqlOnly).toContain(`"account_type" IN ('ANY', 'IRA', 'BROKERAGE')`);
    expect(sqlOnly).toContain(`"transfer_type" IN ('ANY', 'FULL', 'PARTIAL')`);
    expect(sqlOnly).toContain(`"direction" IN ('ANY', 'IN', 'OUT')`);
    expect(sqlOnly).toContain(`"kind" IN ('CUSTODIAN_SAVE', 'CUSTODIAN_MERGE')`);
    markCase("custodian-authority-migration", "pins the Tracker enum values as CHECK allow-lists");
  });

  it("seeds one state row whose confirmed revision can never pass the accepted revision", () => {
    expect(sqlOnly).toContain(`INSERT INTO "app"."custodian_authority_state" ("id") VALUES (1);`);
    expect(sqlOnly).toContain(`CHECK ("id" = 1)`);
    expect(sqlOnly).toMatch(/"confirmed_revision" >= 0 AND "confirmed_revision" <= "accepted_revision"/);
    markCase("custodian-authority-migration", "seeds one state row whose confirmed revision can never pass the accepted revision");
  });

  it("attaches the generic row-change audit trigger to every authority table", () => {
    for (const table of TABLES) {
      expect(sqlOnly).toMatch(new RegExp(`CREATE TRIGGER ${table}_audit\\s+AFTER INSERT OR UPDATE OR DELETE ON "app"\\."${table}"\\s+FOR EACH ROW EXECUTE FUNCTION audit\\.log_row_change\\(\\);`));
    }
    markCase("custodian-authority-migration", "attaches the generic row-change audit trigger to every authority table");
  });
});
