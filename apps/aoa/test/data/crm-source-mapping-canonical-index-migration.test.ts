import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260806190000_crm_source_mapping_canonical_lookup_index/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM source-mapping canonical lookup index migration", () => {
  it("indexes the normalized CRM parent lookup used after mappings exist", () => {
    expect(sqlOnly).toMatch(
      /ON app\.crm_source_mapping\s*\(source_namespace, left\(source_key, 15\)\)/i,
    );
    expect(sqlOnly).toMatch(/WHERE source_system = 'CRM'/i);
  });

  it("does not index business or client-content columns", () => {
    expect(sqlOnly).not.toMatch(
      /(?:name|email|subject|body|note|value|account_number)\s*[,)]/i,
    );
  });
});
