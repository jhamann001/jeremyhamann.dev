import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260807160000_crm_relationship_snapshot/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM Phase 4C relationship snapshot migration", () => {
  it("adds preview/live functions without running a backfill", () => {
    expect(sqlOnly).toMatch(
      /CREATE OR REPLACE FUNCTION app\.reconcile_crm_relationship_snapshot/i,
    );
    expect(sqlOnly).toMatch(
      /CREATE OR REPLACE FUNCTION app\.preview_crm_relationship_snapshot/i,
    );
    expect(sqlOnly).not.toMatch(
      /SELECT\s+app\.(?:reconcile|preview)_crm_relationship_snapshot\s*\(/i,
    );
    expect(sqlOnly).not.toMatch(/ALTER TABLE\s+mirror\./i);
    expect(sqlOnly).not.toMatch(/CREATE ROLE/i);
  });

  it("uses the reviewed three-derivation catalog and exact Salesforce keys", () => {
    for (const derivation of [
      "CRM_CONTACT_HOUSEHOLD",
      "AOA_DEAL_HOUSEHOLD",
      "AOA_TRANSFER_HOUSEHOLD",
    ]) {
      expect(sqlOnly).toContain(`'${derivation}'`);
    }
    for (const relationshipType of [
      "HOUSEHOLD_HAS_MEMBER",
      "DEAL_FOR_HOUSEHOLD",
      "TRANSFER_FOR_HOUSEHOLD",
    ]) {
      expect(sqlOnly).toContain(`'${relationshipType}'`);
    }
    expect(sqlOnly).toContain("^001[[:alnum:]]{12}([[:alnum:]]{3})?$");
    expect(sqlOnly).toMatch(
      /left\(parent_map\.source_key, 15\) = left\(s\.parent_key, 15\)/i,
    );
    expect(sqlOnly).not.toMatch(/PERSON_AUTHORIZES_PERSON/i);
    expect(sqlOnly).not.toMatch(/HOUSEHOLD_AUTHORIZES_THIRD_PARTY/i);
    expect(sqlOnly).not.toMatch(/(?:OWNS_ACCOUNT|FUNDS_ACCOUNT|DOCUMENT_ABOUT)/i);
  });

  it("serializes snapshots and uses rollback-backed exact preview", () => {
    expect(sqlOnly).toMatch(
      /pg_advisory_xact_lock[\s\S]*?app\.crm\.relationship\.reconcile\.v1/i,
    );
    expect(sqlOnly).toMatch(
      /FROM app\.reconcile_crm_relationship_snapshot[\s\S]*?RAISE EXCEPTION 'CRM relationship preview rollback'[\s\S]*?SQLSTATE 'P4C01'/i,
    );
    expect(sqlOnly).toMatch(/ON CONFLICT[\s\S]*?DO NOTHING/i);
  });

  it("requires explicit source completeness before inactivation", () => {
    for (const completeness of [
      "p_contact_snapshot_complete",
      "p_deal_snapshot_complete",
      "p_transfer_snapshot_complete",
    ]) {
      expect(sqlOnly).toContain(completeness);
    }
    expect(sqlOnly).toMatch(
      /SET relationship_state = 'INACTIVE'[\s\S]*?p_contact_snapshot_complete[\s\S]*?p_deal_snapshot_complete[\s\S]*?p_transfer_snapshot_complete/i,
    );
    expect(sqlOnly).toMatch(
      /SET relationship_state = 'ACTIVE'[\s\S]*?inactivated_at = NULL/i,
    );
  });

  it("returns and audits counts only for every derivation", () => {
    for (const count of [
      "candidates",
      "created",
      "refreshed",
      "reactivated",
      "inactivated",
      "missing_endpoint",
      "ambiguous_endpoint",
      "rejected_type",
    ]) {
      expect(sqlOnly).toContain(count);
    }
    expect(sqlOnly).toContain("'crm.relationship.reconcile'");
    expect(sqlOnly).toContain("'crm_relationship_run'");
    expect(sqlOnly).not.toMatch(/jsonb_build_object\([\s\S]*?source_key/i);
  });

  it("grants function execution only and preserves the dark table boundary", () => {
    expect(sqlOnly).toMatch(/SECURITY DEFINER/i);
    expect(sqlOnly).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.reconcile_crm_relationship_snapshot[\s\S]*?TO identity_reconciler/i,
    );
    expect(sqlOnly).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.preview_crm_relationship_snapshot[\s\S]*?TO identity_reconciler/i,
    );
    expect(sqlOnly).toMatch(
      /REVOKE ALL ON app\.crm_relationship[\s\S]*?FROM PUBLIC, app_rw, ingest_rw, identity_reconciler/i,
    );
    expect(sqlOnly).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*?ON\s+app\.crm_relationship/i,
    );
    expect(sqlOnly).not.toMatch(/CREATE POLICY crm_relationship_reconciler/i);
  });

  it("keeps internal merge and ID helpers unavailable to runtime roles", () => {
    expect(sqlOnly).toMatch(/crm_active_identity_survivor/i);
    expect(sqlOnly).toMatch(/new_crm_relationship_id/i);
    expect(sqlOnly).toMatch(
      /REVOKE ALL ON FUNCTION app\.crm_active_identity_survivor[\s\S]*?identity_reconciler/i,
    );
    expect(sqlOnly).toMatch(
      /REVOKE ALL ON FUNCTION app\.new_crm_relationship_id[\s\S]*?identity_reconciler/i,
    );
  });
});
