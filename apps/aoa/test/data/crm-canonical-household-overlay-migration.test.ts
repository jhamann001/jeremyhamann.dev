import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260825203000_crm_canonical_household_overlay/migration.sql",
), "utf8");

describe("CRM canonical household overlay migration", () => {
  it("resolves confirmed household choices without mutating source or identity records", () => {
    const resolver = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION app.resolve_crm_canonical_household_source_key"),
      sql.indexOf("CREATE OR REPLACE FUNCTION app.review_crm_duplicate_candidate_v3"),
    );
    expect(resolver).toMatch(/SECURITY DEFINER/);
    expect(resolver).toMatch(/status = 'READY_FOR_FOLLOW_UP'/);
    expect(resolver).toMatch(/canonical_identity_id/);
    expect(resolver).toMatch(/GRANT EXECUTE[\s\S]*TO app_rw/);
    expect(resolver).not.toMatch(/UPDATE\s+(mirror|app\.crm_identity|app\.crm_source_mapping)/i);
    expect(resolver).not.toMatch(/DELETE\s+FROM/i);
  });

  it("fails closed for ambiguous chains and keeps the overlay reversible", () => {
    expect(sql).toMatch(/cardinality\(v_targets\) <> 1/);
    expect(sql).toMatch(/v_targets\[1\] = ANY\(v_seen\)/);
    expect(sql).toMatch(/p_decision = 'NEW' AND v_candidate\.status <> 'READY_FOR_FOLLOW_UP'/);
    expect(sql).toContain("'REOPENED'");
    expect(sql).toContain("review_crm_duplicate_candidate_v3");
    expect(sql).not.toMatch(/DROP FUNCTION app\.review_crm_duplicate_candidate_v2/);
  });
});

