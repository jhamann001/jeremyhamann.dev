import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260827173000_directory_read_performance/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("directory read performance migration", () => {
  it("indexes only normalized join keys used by the bounded directories", () => {
    expect(sqlOnly).toMatch(/mirror\.client \(left\(household_id, 15\)\)/i);
    expect(sqlOnly).toMatch(
      /mirror\.client_account_aum \(left\(household_sf_id, 15\)\)[\s\S]+WHERE source_present/i,
    );
    expect(sqlOnly).toMatch(/app\.employee_client_status \(left\(client_sf_id, 15\)\)/i);
    expect(sqlOnly).not.toMatch(/name|email|subject|body|note/i);
  });

  it("is additive, transactional, and permission-neutral", () => {
    expect(sqlOnly).toMatch(/^\s*BEGIN;/);
    expect(sqlOnly).toMatch(/COMMIT;\s*$/);
    expect(sqlOnly).not.toMatch(/DROP\s+(?:TABLE|POLICY|INDEX)|CREATE\s+POLICY/i);
    expect(sqlOnly).not.toMatch(/\bUPDATE\b|DELETE\s+FROM|INSERT\s+INTO/i);
    expect(sqlOnly).not.toMatch(/GRANT|REVOKE/i);
  });
});
