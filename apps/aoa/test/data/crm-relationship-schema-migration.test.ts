import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260807133000_crm_relationship_schema/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM Phase 4B relationship schema migration", () => {
  it("creates one empty additive relationship table and no data", () => {
    expect(sqlOnly).toMatch(/CREATE TABLE "app"\."crm_relationship"/i);
    expect(sqlOnly).not.toMatch(/ALTER TABLE "mirror"/i);
    expect(sqlOnly).not.toMatch(/INSERT\s+INTO\s+"?app"?\."?crm_relationship"?/i);
    expect(sqlOnly).not.toMatch(/UPDATE\s+"?(?:app|mirror)"?\./i);
    expect(sqlOnly).not.toMatch(/DELETE\s+FROM/i);
    expect(sqlOnly).not.toMatch(/DROP\s+TABLE/i);
  });

  it("pins typed IDs, immutable evidence coordinates, and no-delete foreign keys", () => {
    expect(sqlOnly).toMatch(/\^rel_\[a-z0-9\]\+\$/i);
    expect(sqlOnly).toMatch(/crm_relationship_not_self_check/i);
    expect(sqlOnly).toMatch(
      /CREATE UNIQUE INDEX "crm_relationship_coordinate_key"[\s\S]*?"relationship_type"[\s\S]*?"from_identity_id"[\s\S]*?"to_identity_id"[\s\S]*?"evidence_mapping_id"/i,
    );
    expect(sqlOnly.match(/ON DELETE RESTRICT ON UPDATE CASCADE/gi)).toHaveLength(3);
    expect(sqlOnly).toMatch(
      /CREATE TRIGGER crm_relationship_protect_coordinate[\s\S]*?BEFORE UPDATE OF[\s\S]*?"relationship_type"[\s\S]*?"evidence_mapping_id"[\s\S]*?"contract_version"/i,
    );
  });

  it("allows only the three exact non-permission Phase 4 edge types", () => {
    for (const type of [
      "HOUSEHOLD_HAS_MEMBER",
      "DEAL_FOR_HOUSEHOLD",
      "TRANSFER_FOR_HOUSEHOLD",
    ]) {
      expect(sqlOnly).toContain(`'${type}'`);
    }
    expect(sqlOnly).not.toMatch(/PERSON_AUTHORIZES_PERSON/i);
    expect(sqlOnly).not.toMatch(/HOUSEHOLD_AUTHORIZES_THIRD_PARTY/i);
    expect(sqlOnly).not.toMatch(/(?:OWNS_ACCOUNT|FUNDS_ACCOUNT|DOCUMENT_ABOUT)/i);
  });

  it("validates active endpoint types, lifecycle, and designated evidence", () => {
    expect(sqlOnly).toMatch(/CREATE TRIGGER crm_relationship_validate/i);
    expect(sqlOnly).toMatch(/from_state <> 'ACTIVE' OR to_state <> 'ACTIVE'/i);
    expect(sqlOnly).toMatch(/evidence_state <> 'ACTIVE'/i);
    expect(sqlOnly).toMatch(
      /WHEN 'HOUSEHOLD_HAS_MEMBER' THEN NEW\."to_identity_id"/i,
    );
    expect(sqlOnly).toMatch(/WHEN 'DEAL_FOR_HOUSEHOLD' THEN NEW\."from_identity_id"/i);
    expect(sqlOnly).toMatch(
      /WHEN 'TRANSFER_FOR_HOUSEHOLD' THEN NEW\."from_identity_id"/i,
    );
    expect(sqlOnly).toMatch(/evidence_identity_id IS DISTINCT FROM expected_evidence_identity_id/i);
  });

  it("enforces controlled lifecycle state and traversal-ready indexes", () => {
    expect(sqlOnly).toMatch(/relationship_state" IN \('ACTIVE', 'INACTIVE'\)/i);
    expect(sqlOnly).toMatch(/crm_relationship_inactive_state_check/i);
    expect(sqlOnly).toMatch(/crm_relationship_seen_order_check/i);
    expect(sqlOnly).toMatch(/crm_relationship_from_active_type_idx/i);
    expect(sqlOnly).toMatch(/crm_relationship_to_active_type_idx/i);
    expect(sqlOnly).toMatch(/crm_relationship_evidence_active_idx/i);
  });

  it("is audited and dark to every runtime principal behind forced RLS", () => {
    expect(sqlOnly).toMatch(
      /CREATE TRIGGER crm_relationship_audit[\s\S]*?audit"\."log_row_change"/i,
    );
    expect(sqlOnly).toMatch(
      /REVOKE ALL ON "app"\."crm_relationship"[\s\S]*?FROM PUBLIC, app_rw, ingest_rw, identity_reconciler/i,
    );
    expect(sqlOnly).toMatch(
      /ALTER TABLE "app"\."crm_relationship" ENABLE ROW LEVEL SECURITY/i,
    );
    expect(sqlOnly).toMatch(
      /ALTER TABLE "app"\."crm_relationship" FORCE ROW LEVEL SECURITY/i,
    );
    expect(sqlOnly).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)/i);
    expect(sqlOnly).not.toMatch(/CREATE POLICY crm_relationship_(?:app|reconciler)/i);
    expect(sqlOnly).toMatch(/CREATE POLICY crm_relationship_owner_all/i);
  });

  it("is one transaction and creates no runtime function or role", () => {
    expect(sqlOnly).toMatch(/^\s*BEGIN;/);
    expect(sqlOnly).toMatch(/COMMIT;\s*$/);
    expect(sqlOnly).not.toMatch(/CREATE ROLE/i);
    expect(sqlOnly).not.toMatch(/reconcile_crm_relationship/i);
    expect(sqlOnly).not.toMatch(/WITH RECURSIVE/i);
  });
});
