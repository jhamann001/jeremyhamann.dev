import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260807190000_crm_relationship_read_seam/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM Phase 4D relationship read migration", () => {
  it("adds only a constrained app read grant and Operations policy", () => {
    expect(sqlOnly).toMatch(
      /GRANT SELECT \([\s\S]*?"id"[\s\S]*?"relationship_type"[\s\S]*?"from_identity_id"[\s\S]*?"to_identity_id"[\s\S]*?"relationship_state"[\s\S]*?\) ON "app"\."crm_relationship" TO app_rw/i,
    );
    expect(sqlOnly).toMatch(
      /CREATE POLICY crm_relationship_ops_read[\s\S]*?FOR SELECT TO app_rw[\s\S]*?IN \('ADMIN', 'OPERATIONS'\)/i,
    );
    expect(sqlOnly).toMatch(/AND "relationship_state" = 'ACTIVE'/i);
    expect(sqlOnly).not.toMatch(/evidence_mapping_id/i);
    expect(sqlOnly).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON "app"\."crm_relationship" FROM app_rw/i,
    );
  });

  it("does not create data, expose source mappings, or add a database traversal bypass", () => {
    expect(sqlOnly).not.toMatch(/INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM/i);
    expect(sqlOnly).not.toMatch(/crm_source_mapping|source_key|evidence_mapping/i);
    expect(sqlOnly).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION/i);
    expect(sqlOnly).not.toMatch(/SECURITY DEFINER/i);
    expect(sqlOnly).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE|ALL)/i);
  });

  it("is one additive transaction", () => {
    expect(sqlOnly).toMatch(/^\s*BEGIN;/);
    expect(sqlOnly).toMatch(/COMMIT;\s*$/);
    expect(sqlOnly).not.toMatch(/DROP\s+(?:TABLE|SCHEMA)|ALTER TABLE/i);
  });
});
