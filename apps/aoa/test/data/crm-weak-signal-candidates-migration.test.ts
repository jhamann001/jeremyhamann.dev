import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260824170000_crm_weak_signal_candidates/migration.sql",
), "utf8");

describe("CRM weak-signal candidate migration", () => {
  it("adds only controlled review evidence", () => {
    expect(sql).toContain("EXACT_NORMALIZED_HOUSEHOLD_NAME");
    expect(sql).toContain("SAME_ADVISOR_AND_STAGE");
    expect(sql).toContain("EMPTY_SHELL_WITH_POPULATED_MATCH");
    expect(sql).toMatch(/normalized_name[^;]+advisor_key[^;]+stage_key/s);
  });

  it("requires exact normalized name plus matching advisor and stage", () => {
    expect(sql).toMatch(/r\.normalized_name = l\.normalized_name/);
    expect(sql).toMatch(/r\.advisor_key = l\.advisor_key/);
    expect(sql).toMatch(/r\.stage_key = l\.stage_key/);
    expect(sql).not.toMatch(/similarity\s*\(/i);
    expect(sql).not.toMatch(/levenshtein/i);
  });

  it("detects empty shells without introducing a merge surface", () => {
    expect(sql).toMatch(/member_count = 0[\s\S]+member_count > 0/);
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/UPDATE app\.crm_identity/i);
    expect(sql).not.toMatch(/UPDATE app\.crm_source_mapping/i);
    expect(sql).not.toMatch(/merged_into_id\s*=/i);
  });

  it("preserves the reviewed definer boundary", () => {
    expect(sql).toMatch(/reconcile_crm_duplicate_candidates\(\)[\s\S]+SECURITY DEFINER/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION app\.reconcile_crm_duplicate_candidates\(\)/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION app\.reconcile_crm_duplicate_candidates\(\) TO identity_reconciler/);
  });
});
