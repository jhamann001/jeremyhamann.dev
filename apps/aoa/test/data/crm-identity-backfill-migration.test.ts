import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260804200000_crm_identity_backfill_dual_key/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM Phase 2A backfill and dual-key migration", () => {
  it("registers only the approved initial source namespaces", () => {
    for (const [system, namespace] of [
      ["CRM", "household"],
      ["CRM", "contact"],
      ["CRM", "opportunity"],
      ["CRM", "email"],
      ["CRM", "activity"],
      ["CALENDAR", "appointment"],
      ["AOA", "deal"],
      ["AOA", "transfer"],
    ]) {
      expect(sqlOnly).toContain(`'${system}'`);
      expect(sqlOnly).toContain(`'${namespace}'`);
    }

    expect(sqlOnly).not.toMatch(/'ACCOUNT'\s*,\s*'ACTIVE'/i);
    expect(sqlOnly).not.toMatch(/'TASK'\s*,\s*'ACTIVE'/i);
    expect(sqlOnly).not.toMatch(/'DOCUMENT'\s*,\s*'ACTIVE'/i);
    expect(sqlOnly).not.toMatch(/'THIRD_PARTY'\s*,\s*'ACTIVE'/i);
  });

  it("never rewrites existing keys, routes, or mirror source rows", () => {
    expect(sqlOnly).not.toMatch(/UPDATE\s+(?:"?app"?\.)?"?(?:deal|transfer)"?/i);
    expect(sqlOnly).not.toMatch(/DELETE\s+FROM\s+mirror\./i);
    expect(sqlOnly).not.toMatch(/INSERT\s+INTO\s+mirror\./i);
    expect(sqlOnly).not.toMatch(/UPDATE\s+mirror\./i);
    expect(sqlOnly).not.toMatch(/ALTER\s+TABLE\s+(?:"?app"?\.)?"?(?:deal|transfer)"?/i);
  });

  it("is rerunnable, serialized, and restores FORCE RLS before returning", () => {
    expect(sqlOnly).toMatch(/pg_advisory_xact_lock/i);
    expect(sqlOnly).toMatch(/ON CONFLICT \(source_system, source_namespace, source_key\) DO NOTHING/gi);
    for (const table of ["household", "client", "email", "activity", "appointment"]) {
      expect(sqlOnly).toMatch(
        new RegExp(`ALTER TABLE mirror\\.${table} NO FORCE ROW LEVEL SECURITY`, "i"),
      );
      expect(sqlOnly).toMatch(
        new RegExp(`ALTER TABLE mirror\\.${table} FORCE ROW LEVEL SECURITY`, "i"),
      );
    }
    expect(sqlOnly).toMatch(/SELECT "app"\."backfill_crm_identity_snapshot"\(\)/i);
  });

  it("uses exact stable keys and explicitly forbids fuzzy matching", () => {
    expect(sqlOnly).not.toMatch(/ILIKE|similarity\s*\(|levenshtein\s*\(/i);
    expect(sqlOnly).toMatch(/MISSING_PARENT_MAPPING/i);
    expect(sqlOnly).toMatch(/left\(parent_map\.source_key, 15\) = left\(/i);
  });

  it("grants app_rw read-only access, keeps ingest dark, and scopes reads through source RLS", () => {
    for (const table of [
      "crm_identity",
      "crm_source_mapping",
      "crm_identity_exception",
    ]) {
      expect(sqlOnly).toMatch(
        new RegExp(`GRANT SELECT ON "app"\\."${table}" TO app_rw`, "i"),
      );
      expect(sqlOnly).toMatch(
        new RegExp(
          `REVOKE INSERT, UPDATE, DELETE ON "app"\\."${table}" FROM app_rw, ingest_rw`,
          "i",
        ),
      );
    }
    expect(sqlOnly).toMatch(/CREATE POLICY crm_source_mapping_app_read/i);
    expect(sqlOnly).toMatch(/EXISTS \(SELECT 1 FROM mirror\.household/i);
    expect(sqlOnly).toMatch(/CREATE POLICY crm_identity_exception_ops_read/i);
    expect(sqlOnly).toMatch(/IN \('ADMIN', 'OPERATIONS'\)/i);
  });

  it("keeps every ID generator and backfill entry point owner-only", () => {
    expect(sqlOnly).toMatch(
      /SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, app, mirror, pg_temp/i,
    );
    for (const signature of [
      '"new_crm_identity_id"\\(text\\)',
      '"new_crm_internal_id"\\(\\)',
      '"backfill_crm_identity_snapshot"\\(\\)',
    ]) {
      expect(sqlOnly).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION "app"\\.${signature}[\\s\\S]*?FROM PUBLIC, app_rw, ingest_rw`, "i"),
      );
    }
  });
});
