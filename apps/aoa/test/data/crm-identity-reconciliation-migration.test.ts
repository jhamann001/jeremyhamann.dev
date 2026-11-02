import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260805150000_crm_identity_reconciliation/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM Phase 3A reconciliation migration", () => {
  it("uses a dedicated role and fails closed when Cloud SQL was not provisioned first", () => {
    expect(sqlOnly).toMatch(/rolname = 'identity_reconciler'/i);
    expect(sqlOnly).toMatch(/rolname = 'cloudsqlsuperuser'[\s\S]*?RAISE EXCEPTION/i);
    expect(sqlOnly).not.toMatch(/GRANT identity_reconciler TO (app_rw|ingest_rw)/i);
    expect(sqlOnly).toMatch(/SECURITY INVOKER/i);
  });

  it("grants only approved source-key and parent-link columns", () => {
    expect(sqlOnly).toMatch(/GRANT SELECT \(sf_id, synced_at\)[\s\S]*?mirror\.household/i);
    expect(sqlOnly).toMatch(/GRANT SELECT \(sf_id, household_id, synced_at\)[\s\S]*?mirror\.client/i);
    expect(sqlOnly).toMatch(/GRANT SELECT \(external_key, client_sf_id, synced_at\)[\s\S]*?mirror\.appointment/i);
    expect(sqlOnly).not.toMatch(/GRANT SELECT \([^)]*(?:name|email|subject|body|note|value|account)/i);
    expect(sqlOnly).not.toMatch(/GRANT SELECT ON mirror\.[a-z_]+ TO identity_reconciler/i);
  });

  it("constrains registry writes and never grants delete, re-key, or merge mutation", () => {
    expect(sqlOnly).toMatch(/GRANT INSERT[\s\S]*?ON app\.crm_identity TO identity_reconciler/i);
    expect(sqlOnly).toMatch(/GRANT UPDATE \(last_seen_at, updated_at\)[\s\S]*?crm_source_mapping/i);
    expect(sqlOnly).toMatch(/REVOKE DELETE ON app\.crm_identity, app\.crm_source_mapping/i);
    expect(sqlOnly).not.toMatch(/GRANT UPDATE \([^)]*identity_id/i);
    expect(sqlOnly).not.toMatch(/GRANT UPDATE \([^)]*merged_into_id/i);
    expect(sqlOnly).not.toMatch(/GRANT DELETE/i);
  });

  it("serializes and batch-processes the same seven reviewed primary domains", () => {
    expect(sqlOnly).toMatch(/pg_advisory_xact_lock/i);
    for (const type of [
      "HOUSEHOLD",
      "CONTACT",
      "DEAL",
      "TRANSFER",
      "EMAIL",
      "ACTIVITY",
      "APPOINTMENT",
    ]) {
      expect(sqlOnly).toContain(`'${type}'`);
    }
    expect(sqlOnly).not.toMatch(/'ACCOUNT'\s*,\s*'CRM'/i);
    expect(sqlOnly).not.toMatch(/'TASK'\s*,\s*'CRM'/i);
  });

  it("uses exact keys only and resolves only the approved missing-parent exception", () => {
    expect(sqlOnly).not.toMatch(/ILIKE|similarity\s*\(|levenshtein\s*\(/i);
    expect(sqlOnly).toMatch(/left\(hm\.source_key, 15\) = left\(s\.household_parent_key, 15\)/i);
    expect(sqlOnly).toMatch(/resolution_code = 'PARENT_MAPPED'/i);
    expect(sqlOnly).toMatch(/reason_code = 'MISSING_PARENT_MAPPING'/i);
    expect(sqlOnly).not.toMatch(/resolution_code = 'MANUAL_LINK'/i);
  });

  it("supports no-write preview and records a PII-free counts-only live audit", () => {
    expect(sqlOnly).toMatch(/IF p_dry_run THEN/i);
    expect(sqlOnly).toMatch(/'crm\.identity\.reconcile'/i);
    for (const count of [
      "sources_seen",
      "identities_created",
      "mappings_created",
      "exceptions_opened",
      "exceptions_reopened",
      "exceptions_resolved",
    ]) {
      expect(sqlOnly).toContain(`'${count}'`);
    }
    expect(sqlOnly).not.toMatch(/jsonb_build_object\([\s\S]*?'source_key'/i);
  });
});
