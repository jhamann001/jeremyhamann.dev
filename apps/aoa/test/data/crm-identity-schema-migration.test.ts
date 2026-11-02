import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260804190000_crm_identity_schema/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM Phase 1 identity schema migration", () => {
  it("creates only the additive identity, source-mapping, and exception tables", () => {
    expect(sqlOnly).toMatch(/CREATE TABLE "app"\."crm_identity"/i);
    expect(sqlOnly).toMatch(/CREATE TABLE "app"\."crm_source_mapping"/i);
    expect(sqlOnly).toMatch(/CREATE TABLE "app"\."crm_identity_exception"/i);
    expect(sqlOnly).not.toMatch(/ALTER TABLE "mirror"/i);
    expect(sqlOnly).not.toMatch(/UPDATE "(?:app|mirror)"/i);
    expect(sqlOnly).not.toMatch(/DELETE\s+FROM/i);
    expect(sqlOnly).not.toMatch(/DROP\s+TABLE/i);
  });

  it("pins every approved entity/record type to its typed public-ID prefix", () => {
    const pairs = [
      ["HOUSEHOLD", "hld"],
      ["CONTACT", "con"],
      ["ACCOUNT", "acc"],
      ["DEAL", "dea"],
      ["TRANSFER", "xfr"],
      ["TASK", "tsk"],
      ["DOCUMENT", "doc"],
      ["THIRD_PARTY", "tpr"],
      ["EMAIL", "eml"],
      ["ACTIVITY", "act"],
      ["APPOINTMENT", "apt"],
    ] as const;

    for (const [type, prefix] of pairs) {
      expect(sqlOnly).toMatch(
        new RegExp(`"identity_type"\\s*=\\s*'${type}'[\\s\\S]*?\\^${prefix}_`),
      );
    }
    expect(sqlOnly).not.toMatch(/"identity_type"\s*=\s*'RELATIONSHIP'/);
  });

  it("makes source replay idempotent without colliding across namespaces", () => {
    expect(sqlOnly).toMatch(
      /CREATE UNIQUE INDEX "crm_source_mapping_source_system_source_namespace_source_key_key"[\s\S]*?\("source_system", "source_namespace", "source_key"\)/i,
    );
    expect(sqlOnly).toMatch(
      /CREATE TRIGGER crm_source_mapping_protect_identity[\s\S]*?BEFORE UPDATE OF "identity_id", "source_system", "source_namespace", "source_key"/i,
    );
    expect(sqlOnly).toMatch(/mapping_state" IN \('ACTIVE', 'SUPERSEDED'\)/i);
  });

  it("enforces merge lifecycle, same-type targets, and cycle rejection", () => {
    expect(sqlOnly).toMatch(/crm_identity_merge_state_check/i);
    expect(sqlOnly).toMatch(/target_type <> NEW\."identity_type"/i);
    expect(sqlOnly).toMatch(/WITH RECURSIVE merge_chain/i);
    expect(sqlOnly).toMatch(/CRM identity merge cycle rejected/i);
  });

  it("stores reviewable exceptions as controlled codes without free-text details", () => {
    expect(sqlOnly).toMatch(/MISSING_PARENT_MAPPING/i);
    expect(sqlOnly).toMatch(/AMBIGUOUS_PARENT_MAPPING/i);
    expect(sqlOnly).toMatch(/IDENTITY_TYPE_MISMATCH/i);
    expect(sqlOnly).toMatch(/SOURCE_KEY_COLLISION/i);
    expect(sqlOnly).toMatch(
      /CREATE UNIQUE INDEX "crm_identity_exception_source_mapping_id_reason_code_key"/i,
    );
    expect(sqlOnly).not.toMatch(/"(?:detail|note|description)"\s+TEXT/i);
  });

  it("keeps Phase 1 dark to app_rw and ingest_rw behind FORCE RLS", () => {
    for (const table of [
      "crm_identity",
      "crm_source_mapping",
      "crm_identity_exception",
    ]) {
      expect(sqlOnly).toMatch(
        new RegExp(
          `REVOKE ALL ON "app"\\."${table}" FROM PUBLIC, app_rw, ingest_rw`,
          "i",
        ),
      );
      expect(sqlOnly).toMatch(
        new RegExp(
          `ALTER TABLE "app"\\."${table}" ENABLE ROW LEVEL SECURITY`,
          "i",
        ),
      );
      expect(sqlOnly).toMatch(
        new RegExp(
          `ALTER TABLE "app"\\."${table}" FORCE ROW LEVEL SECURITY`,
          "i",
        ),
      );
    }
    expect(sqlOnly).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)/i);
    expect(sqlOnly).not.toMatch(/CREATE POLICY \w+_(?:read|insert|update|delete)/i);
  });

  it("audits identities/exceptions and redacts source keys from mapping audit", () => {
    expect(sqlOnly).toMatch(
      /CREATE TRIGGER crm_identity_audit[\s\S]*?audit"\."log_row_change"/i,
    );
    expect(sqlOnly).toMatch(
      /CREATE TRIGGER crm_identity_exception_audit[\s\S]*?audit"\."log_row_change"/i,
    );
    expect(sqlOnly).toMatch(
      /CREATE TRIGGER crm_source_mapping_audit[\s\S]*?audit"\."log_crm_source_mapping_change"/i,
    );

    const redactingBody = SQL.match(
      /CREATE OR REPLACE FUNCTION "audit"\."log_crm_source_mapping_change"\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/i,
    )?.[1];
    expect(redactingBody).toBeDefined();
    expect(redactingBody).not.toMatch(/source_key/i);
    expect(redactingBody).not.toMatch(/to_jsonb\((?:NEW|OLD)\)/i);
  });

  it("is one transaction and creates no runtime reconciler role", () => {
    expect(sqlOnly).toMatch(/^\s*BEGIN;/);
    expect(sqlOnly).toMatch(/COMMIT;\s*$/);
    expect(sqlOnly).not.toMatch(/CREATE ROLE/i);
    expect(sqlOnly).not.toMatch(/identity_reconciler/i);
  });
});
