import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260825143000_crm_duplicate_signal_guardrails/migration.sql",
), "utf8");

describe("CRM duplicate signal guardrails migration", () => {
  it("limits weak name clusters to exactly two identities", () => {
    expect(sql).toMatch(/household_name_clusters[\s\S]+HAVING count\(\*\) = 2/);
    expect(sql).toMatch(/cluster\.identity_count = 2/);
  });

  it("requires one empty shell and one populated household", () => {
    expect(sql).toMatch(/l\.member_count = 0 AND r\.member_count > 0/);
    expect(sql).toMatch(/r\.member_count = 0 AND l\.member_count > 0/);
  });

  it("preserves durable household and exact-account signals", () => {
    expect(sql).toContain("SHARED_CEDAR_RIDGE_USER_ID");
    expect(sql).toContain("SOURCE_MERGE_REPLACEMENT");
    expect(sql).toContain("EXACT_CUSTODIAN_IDENTITY");
  });

  it("keeps the reviewed definer boundary", () => {
    expect(sql).toMatch(/reconcile_crm_duplicate_candidates\(\)[\s\S]+SECURITY DEFINER/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION app\.reconcile_crm_duplicate_candidates\(\)/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION app\.reconcile_crm_duplicate_candidates\(\) TO identity_reconciler/);
  });
});
