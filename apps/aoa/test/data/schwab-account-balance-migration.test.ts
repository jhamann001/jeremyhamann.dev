import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(
  import.meta.dirname,
  "..",
  "..",
  "prisma",
  "migrations",
  "20260916210000_schwab_account_balance_snapshot",
  "migration.sql",
), "utf8");

describe("Schwab account-balance migration", () => {
  it("keeps the full account number outside the application column grant", () => {
    expect(sql).toMatch(/REVOKE SELECT ON mirror\.schwab_account_balance FROM app_rw/i);
    const grant = sql.match(/GRANT SELECT \(([\s\S]*?)\) ON mirror\.schwab_account_balance TO app_rw/i)?.[1];
    expect(grant).toBeDefined();
    expect(grant).toContain("account_number_last4");
    expect(grant).toContain("account_name");
    expect(grant).not.toMatch(/\baccount_number\b/);
    expect(grant).not.toContain("source_key");
    expect(grant).not.toContain("source_sha256");
  });

  it("forces RLS and exposes only confirmed own-book rows outside Operations", () => {
    expect(sql).toMatch(/ALTER TABLE mirror\.schwab_account_balance FORCE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/resolution_state = 'CONFIRMED'/i);
    expect(sql).toMatch(/FROM mirror\.household household/i);
  });

  it("keeps Schwab retirement and reconciliation constraints source-local", () => {
    expect(sql).toMatch(/source_present\s+boolean NOT NULL DEFAULT true/i);
    expect(sql).toMatch(/abs\(account_aum - account_cash - account_securities\) <= 0\.01/i);
    expect(sql).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+mirror\.client_account_aum/i);
  });
});
