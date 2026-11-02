import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260805200000_crm_parent_source_feed/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM parent source feed migration", () => {
  it("stores key-only typed parents and canonicalizes Salesforce width", () => {
    expect(sqlOnly).toMatch(/CREATE TABLE mirror\.crm_parent_source/i);
    expect(sqlOnly).toMatch(/normalized_key text GENERATED ALWAYS AS \(left\(source_key, 15\)\)/i);
    expect(sqlOnly).toMatch(/PRIMARY KEY \(parent_type, normalized_key\)/i);
    expect(sqlOnly).toContain("^001[[:alnum:]]{12}([[:alnum:]]{3})?$");
    expect(sqlOnly).toContain("^003[[:alnum:]]{12}([[:alnum:]]{3})?$");
  });

  it("keeps ingest out of the app registry and withholds delete", () => {
    expect(sqlOnly).toMatch(/REVOKE ALL ON mirror\.crm_parent_source[\s\S]*?FROM PUBLIC, app_rw, ingest_rw, identity_reconciler/i);
    expect(sqlOnly).toMatch(/GRANT INSERT \(parent_type, source_key, synced_at\)[\s\S]*?TO ingest_rw/i);
    expect(sqlOnly).toMatch(/GRANT UPDATE \(source_key, synced_at\)[\s\S]*?TO ingest_rw/i);
    expect(sqlOnly).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)[\s\S]*?app\.crm_(?:identity|source_mapping)[\s\S]*?TO ingest_rw/i);
    expect(sqlOnly).not.toMatch(/GRANT DELETE/i);
  });

  it("gives the reconciler only key columns and a security-invoker helper", () => {
    expect(sqlOnly).toMatch(/GRANT SELECT \(parent_type, source_key, normalized_key, synced_at\)[\s\S]*?identity_reconciler/i);
    expect(sqlOnly).toMatch(/FUNCTION app\.reconcile_crm_parent_source/i);
    expect(sqlOnly).toMatch(/SECURITY INVOKER/i);
    expect(sqlOnly).toMatch(/GRANT EXECUTE[\s\S]*?identity_reconciler/i);
    expect(sqlOnly).not.toMatch(/GRANT SELECT \([^)]*(?:name|email|stage|note|value|account_number)/i);
  });

  it("fails closed on type or width-alias conflicts and contains no fuzzy matching", () => {
    expect(sqlOnly).toContain("source coordinate type conflict");
    expect(sqlOnly).toContain("conflicting width aliases");
    expect(sqlOnly).not.toMatch(/ILIKE|similarity\s*\(|levenshtein\s*\(/i);
  });

  it("exposes parent mappings only through already-visible child records", () => {
    const policy = sqlOnly.slice(
      sqlOnly.indexOf("CREATE POLICY crm_source_mapping_parent_reference_app_read"),
    );
    expect(policy).toMatch(/crm_source_mapping_parent_reference_app_read/i);
    expect(policy).toContain("current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')");
    expect(policy).not.toMatch(/left\s*\(/i);
    for (const table of ["mirror.email", "mirror.activity", "mirror.appointment", "app.deal", "app.transfer"]) {
      expect(policy).toContain(table);
    }
    expect(sqlOnly).not.toMatch(/GRANT SELECT ON mirror\.crm_parent_source TO app_rw/i);
  });

  it("mints exact child-reference aliases before using indexed visibility checks", () => {
    expect(sqlOnly).toMatch(/CREATE INDEX appointment_client_sf_id_idx[\s\S]*?mirror\.appointment \(client_sf_id\)/i);
    for (const key of ["e.household_sf_id", "a.household_sf_id", "d.household_sf_id", "t.household_sf_id", "a.client_sf_id", "d.client_sf_id", "t.client_sf_id"]) {
      expect(sqlOnly).toContain(key);
    }
  });
});
