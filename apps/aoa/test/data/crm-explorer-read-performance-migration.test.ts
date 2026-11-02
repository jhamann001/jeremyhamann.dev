import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260813120000_crm_explorer_read_performance/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM Explorer read performance migration", () => {
  it("does not broaden registry access or replace source-backed RLS", () => {
    expect(sqlOnly).not.toMatch(/CREATE\s+POLICY/i);
    expect(sqlOnly).not.toMatch(/DROP\s+POLICY/i);
    expect(sqlOnly).not.toMatch(/GRANT|REVOKE/i);
    expect(sqlOnly).not.toMatch(/app\.user_role|ADMIN|OPERATIONS/i);
  });

  it("indexes list ordering and open-exception lookups without client content", () => {
    expect(sqlOnly).toMatch(/ON app\.crm_identity \(updated_at DESC, id\)/i);
    expect(sqlOnly).toMatch(
      /ON app\.crm_identity_exception \(source_mapping_id\)[\s\S]+WHERE exception_state = 'OPEN'/i,
    );
    expect(sqlOnly).not.toMatch(/(?:name|email|subject|body|note|source_key)\s*[,)]/i);
  });

  it("is additive and transactional", () => {
    expect(sqlOnly).toMatch(/^\s*BEGIN;/);
    expect(sqlOnly).toMatch(/COMMIT;\s*$/);
    expect(sqlOnly).not.toMatch(/DROP\s+(?:TABLE|POLICY|INDEX)/i);
    expect(sqlOnly).not.toMatch(/\bUPDATE\b|DELETE\s+FROM|INSERT\s+INTO/i);
  });
});
