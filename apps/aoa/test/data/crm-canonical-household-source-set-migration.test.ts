import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260825220000_crm_canonical_household_source_set/migration.sql",
), "utf8");

describe("CRM canonical household source-set migration", () => {
  it("widens only confirmed, bounded, independently verified household groups", () => {
    expect(sql).toContain("app.crm_canonical_household_source_keys");
    expect(sql).toMatch(/status = 'READY_FOR_FOLLOW_UP'/);
    expect(sql).toMatch(/grouped\.depth < 8/);
    expect(sql).toMatch(/count\(\*\) FROM mapped_source\) > 16/);
    expect(sql).toMatch(/NOT loser\.identity_id = ANY\(grouped\.path\)/);
    expect(sql).toMatch(/resolve_crm_canonical_household_source_key\(household\.sf_id\)/);
  });

  it("is read-only, RLS-filtered by callers, and unavailable to ingestion roles", () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/REVOKE ALL[\s\S]+FROM PUBLIC, ingest_rw, identity_reconciler/);
    expect(sql).toMatch(/GRANT EXECUTE[\s\S]+TO app_rw/);
    expect(sql).not.toMatch(/UPDATE\s+(mirror|app\.crm_identity|app\.crm_source_mapping)/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });
});
