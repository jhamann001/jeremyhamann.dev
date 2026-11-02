import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260814100000_trade_profile_selection",
    "migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("app.trade_profile_selection migration", () => {
  it("stores one source reference per client and account without copying profile facts", () => {
    expect(sqlOnly).toMatch(/CREATE TABLE "app"\."trade_profile_selection"/i);
    expect(sqlOnly).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*ON "app"\."trade_profile_selection"\("client_sf_id", "custodian_account_id"\)/i,
    );
    expect(sqlOnly).toMatch(/"selected_request_id" TEXT NOT NULL/i);
    expect(sqlOnly).toMatch(/"reviewed_request_ids" TEXT\[\] NOT NULL/i);
    expect(sqlOnly).not.toMatch(/risk_score|instructions|allocation/i);
  });

  it("retains confirmations, limits notes, and records every row change", () => {
    expect(sqlOnly).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON "app"\."trade_profile_selection" TO app_rw/i,
    );
    expect(sqlOnly).toMatch(
      /REVOKE DELETE ON "app"\."trade_profile_selection" FROM app_rw/i,
    );
    expect(sqlOnly).not.toMatch(/FOR DELETE/i);
    expect(sqlOnly).toMatch(/char_length\("selection_note"\) <= 500/i);
    expect(sqlOnly).toMatch(
      /CREATE TRIGGER trade_profile_selection_audit[\s\S]*EXECUTE FUNCTION audit\.log_row_change\(\)/i,
    );
  });

  it("forces client-visible RLS and permits only current write roles", () => {
    expect(sqlOnly).toMatch(
      /ALTER TABLE "app"\."trade_profile_selection" ENABLE ROW LEVEL SECURITY/i,
    );
    expect(sqlOnly).toMatch(
      /ALTER TABLE "app"\."trade_profile_selection" FORCE ROW LEVEL SECURITY/i,
    );
    expect(sqlOnly).toMatch(/SELECT 1 FROM mirror\.client c/i);
    for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE"]) {
      expect(sqlOnly).toContain(`'${role}'`);
    }
    expect(sqlOnly).not.toMatch(/\bVIEWER\b|\bHEAD_OF_ADVISORY\b/);
  });
});
