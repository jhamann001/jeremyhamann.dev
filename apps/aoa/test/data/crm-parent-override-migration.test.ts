import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(join(
  import.meta.dirname, "..", "..", "prisma", "migrations",
  "20260821120000_crm_parent_override", "migration.sql",
), "utf8");
const sqlOnly = SQL.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

describe("Operations-confirmed CRM parent override migration", () => {
  it("stores controlled internal relationships with reviewer provenance and field audit", () => {
    expect(sqlOnly).toMatch(/CREATE TABLE "app"\."crm_parent_override"/i);
    expect(sqlOnly).toContain("crm_parent_override_relationship_check");
    expect(sqlOnly).toMatch(/confirmed_by.*confirmed_at/is);
    expect(sqlOnly).toMatch(/crm_parent_override_audit[\s\S]*audit"\."log_row_change/i);
    expect(sqlOnly).not.toMatch(/appointment_text|client_name|household_name|display_name/i);
  });

  it("permits read-only Operations access and funnels writes through one constrained function", () => {
    expect(sqlOnly).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(sqlOnly).toContain("'ADMIN', 'OPERATIONS'");
    expect(sqlOnly).toMatch(/REVOKE INSERT, UPDATE, DELETE ON "app"\."crm_parent_override" FROM app_rw/i);
    expect(sqlOnly).toMatch(/CREATE OR REPLACE FUNCTION "app"\."confirm_crm_parent_override"/i);
    expect(sqlOnly).toMatch(/GRANT EXECUTE ON FUNCTION "app"\."confirm_crm_parent_override"\(text, text, text\) TO app_rw/i);
  });

  it("atomically resolves the exception and matching central queue item", () => {
    expect(sqlOnly).toMatch(/UPDATE app\.crm_identity_exception[\s\S]*resolution_code = 'MANUAL_LINK'/i);
    expect(sqlOnly).toMatch(/UPDATE app\.review_queue_item[\s\S]*source_active = false[\s\S]*status = 'RESOLVED'/i);
    expect(sqlOnly).toContain("CONTEXT_RESOLVED");
  });

  it("keeps a manual mapping authoritative across later machine reconciliation", () => {
    expect(sqlOnly).toMatch(/CREATE TRIGGER crm_identity_exception_preserve_manual_parent/i);
    expect(sqlOnly).toMatch(/OLD\.resolution_code = 'MANUAL_LINK'[\s\S]*NEW\.exception_state = 'OPEN'[\s\S]*RETURN NULL/is);
  });
});
