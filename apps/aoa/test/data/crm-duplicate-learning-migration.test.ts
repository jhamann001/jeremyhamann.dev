import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260824120000_crm_duplicate_learning_phase1/migration.sql",
), "utf8");

describe("CRM duplicate learning phase 1 migration", () => {
  it("stores only controlled reasons and a canonical identity from the compared pair", () => {
    expect(sql).toMatch(/ADD COLUMN "decision_reason" VARCHAR\(48\)/);
    expect(sql).toMatch(/ADD COLUMN "canonical_identity_id" TEXT/);
    expect(sql).toMatch(/crm_duplicate_candidate_reason_controlled/);
    expect(sql).toMatch(/crm_duplicate_candidate_canonical_in_pair/);
    expect(sql).toMatch(/"canonical_identity_id" IN \("left_identity_id", "right_identity_id"\)/);
    expect(sql).not.toMatch(/decision_note|free_text|comment_text/i);
  });

  it("keeps the structured review function non-executing and Operations-scoped", () => {
    const fn = sql.slice(sql.indexOf(
      "CREATE OR REPLACE FUNCTION app.review_crm_duplicate_candidate_v2",
    ));
    expect(fn).toMatch(/current_setting\('app\.user_role', true\)/);
    expect(fn).toMatch(/IN \('ADMIN', 'OPERATIONS'\)/);
    expect(fn).toMatch(/GRANT EXECUTE[\s\S]*TO app_rw/);
    expect(fn).not.toMatch(/DELETE FROM/i);
    expect(fn).not.toMatch(/merged_into_id\s*=/i);
    expect(fn).not.toMatch(/UPDATE app\.crm_identity/i);
    expect(fn).not.toMatch(/UPDATE app\.crm_source_mapping/i);
  });

  it("preserves rolling-deploy compatibility and clears invalidated outcomes", () => {
    expect(sql).toContain("review_crm_duplicate_candidate_v2");
    expect(sql).not.toMatch(/DROP FUNCTION app\.review_crm_duplicate_candidate/);
    expect(sql).toMatch(/crm_duplicate_candidate_clear_outcome/);
    expect(sql).toMatch(/NEW\.canonical_identity_id := NULL/);
  });
});
