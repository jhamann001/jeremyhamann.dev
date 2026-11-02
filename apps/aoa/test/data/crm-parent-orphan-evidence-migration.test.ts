import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260805220000_crm_parent_orphan_evidence/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM parent orphan evidence migration", () => {
  it("stores only typed keys, state, replacement, and observation time", () => {
    expect(sqlOnly).toMatch(/CREATE TABLE mirror\.crm_parent_orphan_evidence/i);
    expect(sqlOnly).toMatch(/normalized_key text GENERATED ALWAYS AS \(left\(source_key, 15\)\)/i);
    expect(sqlOnly).toMatch(/replacement_normalized_key text GENERATED ALWAYS AS/i);
    expect(sqlOnly).toMatch(/evidence_type IN \('DELETED', 'MERGED'\)/i);
    expect(sqlOnly).not.toMatch(/\b(name|email|stage|subject|body|note|value|account_number)\b/i);
  });

  it("requires a same-type, non-self replacement only for merged rows", () => {
    expect(sqlOnly).toContain("^001[[:alnum:]]{12}([[:alnum:]]{3})?$");
    expect(sqlOnly).toContain("^003[[:alnum:]]{12}([[:alnum:]]{3})?$");
    expect(sqlOnly).toMatch(/evidence_type = 'DELETED' AND replacement_key IS NULL/i);
    expect(sqlOnly).toMatch(/evidence_type = 'MERGED'[\s\S]*?replacement_key IS NOT NULL/i);
    expect(sqlOnly).toMatch(/left\(source_key, 15\) <> left\(replacement_key, 15\)/i);
  });

  it("keeps app users dark and withholds delete from every runtime role", () => {
    expect(sqlOnly).toMatch(/REVOKE ALL ON mirror\.crm_parent_orphan_evidence[\s\S]*?FROM PUBLIC, app_rw, ingest_rw, identity_reconciler/i);
    expect(sqlOnly).toMatch(/GRANT INSERT[\s\S]*?TO ingest_rw/i);
    expect(sqlOnly).toMatch(/GRANT UPDATE[\s\S]*?TO ingest_rw/i);
    expect(sqlOnly).not.toMatch(/GRANT DELETE/i);
    expect(sqlOnly).not.toMatch(/GRANT SELECT[\s\S]*?TO app_rw/i);
    expect(sqlOnly).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(sqlOnly).toMatch(/FORCE ROW LEVEL SECURITY/i);
  });

  it("gives the reconciler aggregate-diagnostic columns only and no write path", () => {
    expect(sqlOnly).toMatch(/GRANT SELECT \([\s\S]*?replacement_normalized_key[\s\S]*?\)[\s\S]*?TO identity_reconciler/i);
    expect(sqlOnly).not.toMatch(
      /GRANT (?:INSERT|UPDATE|DELETE)(?:\s*\([^)]*\))?\s+ON mirror\.crm_parent_orphan_evidence TO identity_reconciler/i,
    );
    expect(sqlOnly).not.toMatch(/FUNCTION app\.reconcile_crm_parent_source/i);
    expect(sqlOnly).not.toMatch(/INSERT INTO app\.crm_(?:identity|source_mapping)/i);
  });
});
