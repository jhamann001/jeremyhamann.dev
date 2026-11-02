import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260806160000_crm_reconciliation_transactional_preview/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM transactional reconciliation preview migration", () => {
  it("runs the exact live phases inside a forced rollback subtransaction", () => {
    expect(sqlOnly).toMatch(/FUNCTION app\.preview_crm_identity_reconciliation/i);
    expect(sqlOnly).toMatch(/reconcile_crm_parent_source\(false\)/i);
    expect(sqlOnly).toMatch(/reconcile_crm_identity_snapshot\(p_run_id, false\)/i);
    expect(sqlOnly).toMatch(/RAISE EXCEPTION[\s\S]*?ERRCODE = 'P3A01'/i);
    expect(sqlOnly).toMatch(/EXCEPTION[\s\S]*?WHEN SQLSTATE 'P3A01'/i);
  });

  it("keeps the preview invoker-scoped and grants only the reconciler", () => {
    expect(sqlOnly).toMatch(/SECURITY INVOKER/i);
    expect(sqlOnly).toMatch(/REVOKE ALL[\s\S]*?FROM PUBLIC, app_rw, ingest_rw/i);
    expect(sqlOnly).toMatch(/GRANT EXECUTE[\s\S]*?TO identity_reconciler/i);
  });

  it("indexes only normalized key columns used by parent reconciliation", () => {
    for (const expression of [
      "mirror.household (left(sf_id, 15))",
      "mirror.client (left(sf_id, 15))",
      "mirror.email (left(household_sf_id, 15))",
      "mirror.activity (left(household_sf_id, 15))",
      "app.deal (left(household_sf_id, 15))",
      "app.deal (left(client_sf_id, 15))",
      "app.transfer (left(household_sf_id, 15))",
      "app.transfer (left(client_sf_id, 15))",
      "mirror.appointment (left(client_sf_id, 15))",
    ]) {
      expect(sqlOnly).toContain(expression);
    }
    expect(sqlOnly).not.toMatch(/(?:name|email|subject|body|note|value|account_number)\s*\)/i);
  });
});
