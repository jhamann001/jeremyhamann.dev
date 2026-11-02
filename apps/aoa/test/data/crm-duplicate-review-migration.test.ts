import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260822150000_crm_duplicate_review/migration.sql",
), "utf8");

describe("CRM duplicate review migration", () => {
  it("persists review candidates and append-only events under Ops/Admin RLS", () => {
    expect(sql).toMatch(/CREATE TABLE "app"\."crm_duplicate_candidate"/);
    expect(sql).toMatch(/CREATE TABLE "app"\."crm_duplicate_candidate_event"/);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/g);
    expect(sql).toMatch(/IN \('ADMIN', 'OPERATIONS'\)/);
    expect(sql).not.toMatch(/GRANT (?:ALL|INSERT|UPDATE|DELETE)[\s\S]*?ON "app"\."crm_duplicate_candidate" TO app_rw/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION app\.review_crm_duplicate_candidate[\s\S]*?TO app_rw/);
    expect(sql).toMatch(/current_setting\('app\.user_email', true\)/);
    expect(sql).toMatch(/current_setting\('app\.user_role', true\)/);
    expect(sql).toMatch(/CREATE TRIGGER crm_duplicate_candidate_audit/);
    expect(sql).toMatch(/IF k IN \('updated_at', 'last_seen_at'\)/);
  });

  it("keeps raw PII and account identifiers outside the machine-role boundary", () => {
    expect(sql).toMatch(/REVOKE SELECT \(email, cedar_ridge_user_id\)[\s\S]*?FROM identity_reconciler/);
    expect(sql).toMatch(/REVOKE SELECT \(custodian_account_id, cedar_ridge_user_id\)[\s\S]*?FROM identity_reconciler/);
    expect(sql).not.toMatch(
      /GRANT SELECT \((?:email|custodian_account_id)[^;]+TO identity_reconciler/,
    );
    expect(sql).toMatch(/reconcile_crm_duplicate_candidates\(\)[\s\S]*?SECURITY DEFINER/);
  });

  it("runs definer work through a constrained FORCE-RLS role", () => {
    expect(sql).toMatch(/definer_role text := quote_ident\(current_user\)/);
    expect(sql).toMatch(/crm_identity_duplicate_definer_read/);
    expect(sql).toMatch(/crm_source_mapping_duplicate_definer_read/);
    expect(sql).toMatch(/client_duplicate_definer_read/);
    expect(sql).toMatch(/account_holder_duplicate_definer_read/);
    expect(sql).toMatch(/crm_parent_orphan_duplicate_definer_read/);
    expect(sql).toMatch(/crm_duplicate_candidate_definer_(?:read|insert|update)/);
    expect(sql).toMatch(/crm_duplicate_candidate_event_definer_(?:read|insert)/);
    expect(sql).not.toMatch(/CREATE ROLE crm_duplicate_definer/);
    expect(sql).not.toMatch(/FOR DELETE TO %s/);
  });

  it("keeps the combined preview on the machine-role boundary", () => {
    const combined = sql.slice(sql.indexOf(
      "CREATE OR REPLACE FUNCTION app.preview_crm_identity_duplicate_reconciliation",
    ));
    expect(combined).toMatch(/LANGUAGE plpgsql\s+SECURITY INVOKER/);
    expect(combined).toMatch(/reconcile_crm_parent_source\(false\)/);
    expect(combined).toMatch(/reconcile_crm_identity_snapshot\(p_run_id, false\)/);
  });

  it("allows app account detail to compare only an opaque fingerprint", () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION app\.crm_duplicate_fingerprint\(text\)[\s\S]*?TO app_rw/);
    expect(sql).not.toMatch(/GRANT SELECT \(custodian_account_id[^;]+TO app_rw/);
  });

  it("offers a rollback-backed counts-only preview", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION app\.preview_crm_duplicate_candidates\(\)/);
    expect(sql).toMatch(/CRM duplicate detector preview rollback/);
    expect(sql).toMatch(/WHEN SQLSTATE 'P2D01'/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION app\.preview_crm_identity_duplicate_reconciliation/);
    const combined = sql.slice(sql.indexOf(
      "CREATE OR REPLACE FUNCTION app.preview_crm_identity_duplicate_reconciliation",
    ));
    expect(combined).toMatch(/reconcile_crm_parent_source\(false\)/);
    expect(combined).toMatch(/reconcile_crm_identity_snapshot\(p_run_id, false\)/);
    expect(combined).toMatch(/reconcile_crm_duplicate_candidates\(\)/);
    expect(combined).toMatch(/WHEN SQLSTATE 'P2D02'/);
    expect(combined).toMatch(/duplicate_candidates_would_open/);
  });

  it("allows only controlled evidence and blocks unsafe account guesses", () => {
    expect(sql).toMatch(/'SHARED_CEDAR_RIDGE_USER_ID'/);
    expect(sql).toMatch(/'SOURCE_MERGE_REPLACEMENT'/);
    expect(sql).toMatch(/'EXACT_CUSTODIAN_IDENTITY'/);
    expect(sql).toMatch(/'CONFLICTING_MEMBER_IDENTITY'/);
    expect(sql).toMatch(/r\.custodian_account_id = l\.custodian_account_id/);
    expect(sql).not.toMatch(/companion/i);
  });

  it("contains detection and review only, with no physical merge surface", () => {
    const functionBody = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION app.reconcile_crm_duplicate_candidates"));
    expect(functionBody).not.toMatch(/DELETE FROM/i);
    expect(functionBody).not.toMatch(/merged_into_id\s*=/i);
    expect(functionBody).not.toMatch(/UPDATE app\.crm_identity/i);
    expect(functionBody).not.toMatch(/UPDATE app\.crm_source_mapping/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION app\.reconcile_crm_duplicate_candidates\(\) TO identity_reconciler/);
  });

  it("preserves false-positive decisions but invalidates unsafe READY state", () => {
    const start = sql.indexOf("ON CONFLICT (detector_key) DO UPDATE SET");
    const conflict = sql.slice(start, sql.indexOf(";", start));
    expect(conflict).toMatch(/evidence_codes = EXCLUDED\.evidence_codes/);
    expect(conflict).toMatch(/source_active = true/);
    expect(conflict).toMatch(/status = CASE/);
    expect(conflict).toMatch(/existing\.status = 'READY_FOR_FOLLOW_UP'/);
    expect(conflict).toMatch(/cardinality\(EXCLUDED\.hard_conflict_codes\) > 0/);
    expect(sql).toMatch(/FOR UPDATE OF existing/);
    expect(sql).toMatch(/crm_duplicate_candidate_ready_without_conflicts/);
    expect(sql).toMatch(/'INVALIDATED_BY_CONFLICT'/);
    expect(sql).toMatch(/'HARD_CONFLICT_ADDED'/);
  });

  it("increments optimistic review version when detector evidence changes", () => {
    const conflict = sql.slice(sql.indexOf("ON CONFLICT (detector_key) DO UPDATE SET"));
    expect(conflict).toMatch(/review_version = existing\.review_version \+ CASE/);
    expect(conflict).toMatch(/existing\.evidence_codes IS DISTINCT FROM EXCLUDED\.evidence_codes/);
    expect(conflict).toMatch(/existing\.hard_conflict_codes IS DISTINCT FROM EXCLUDED\.hard_conflict_codes/);
    expect(sql).toMatch(/p_decision <> 'READY_FOR_FOLLOW_UP'[\s\S]*?cardinality\(candidate\.hard_conflict_codes\) = 0/);
  });
});
