import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260826163000_crm_canonical_household_bulk_overlay/migration.sql",
), "utf8");

describe("CRM canonical household bulk-overlay migration", () => {
  it("resolves only confirmed suppressed keys supplied by the RLS-scoped caller", () => {
    expect(sql).toContain("app.resolve_crm_canonical_household_overlays");
    expect(sql).toMatch(/unnest\([\s\S]*p_source_keys/);
    expect(sql).toMatch(/status = 'READY_FOR_FOLLOW_UP'/);
    expect(sql).toMatch(/JOIN requested[\s\S]*suppressed\.source_key/);
    expect(sql).toMatch(/JOIN requested canonical_visible/);
    expect(sql).toMatch(/SELECT DISTINCT resolved\.source_key/);
    expect(sql).toMatch(/cardinality\(p_source_keys\) BETWEEN 1 AND 10000/);
  });

  it("calls the scalar chain resolver only for the matched suppressed subset", () => {
    const suppressed = sql.indexOf("suppressed_requested AS MATERIALIZED");
    const resolved = sql.indexOf("resolved AS MATERIALIZED");
    const scalar = sql.indexOf("app.resolve_crm_canonical_household_source_key");
    expect(suppressed).toBeGreaterThan(0);
    expect(resolved).toBeGreaterThan(suppressed);
    expect(scalar).toBeGreaterThan(resolved);
    expect(sql).not.toMatch(/UPDATE\s+(mirror|app\.crm_identity|app\.crm_source_mapping)/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });

  it("keeps the helper unavailable to ingestion roles", () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/REVOKE ALL[\s\S]+FROM PUBLIC, ingest_rw, identity_reconciler/);
    expect(sql).toMatch(/GRANT EXECUTE[\s\S]+TO app_rw/);
  });
});
