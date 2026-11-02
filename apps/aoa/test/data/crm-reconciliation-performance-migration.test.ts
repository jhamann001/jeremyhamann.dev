import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260806140000_crm_parent_mapping_lookup_index/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM reconciliation parent lookup performance migration", () => {
  it("indexes the exact canonical Salesforce expression used by reconciliation", () => {
    expect(sqlOnly).toMatch(
      /CREATE INDEX crm_source_mapping_crm_parent_canonical_idx/i,
    );
    expect(sqlOnly).toMatch(/left\(source_key, 15\)/i);
    expect(sqlOnly).toMatch(
      /source_namespace,\s*left\(source_key, 15\),\s*mapping_state/i,
    );
    expect(sqlOnly).toMatch(/INCLUDE \(identity_id\)/i);
  });

  it("is restricted to approved CRM parent namespaces", () => {
    expect(sqlOnly).toMatch(/source_system = 'CRM'/i);
    expect(sqlOnly).toMatch(
      /source_namespace IN \('household', 'contact'\)/i,
    );
    expect(sqlOnly).not.toMatch(
      /'email'|'activity'|'opportunity'|'account'|'task'/i,
    );
  });

  it("changes no grants, data, identities, mappings, or exceptions", () => {
    expect(sqlOnly).not.toMatch(/\bGRANT\b|\bREVOKE\b/i);
    expect(sqlOnly).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
    expect(sqlOnly).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
  });
});
