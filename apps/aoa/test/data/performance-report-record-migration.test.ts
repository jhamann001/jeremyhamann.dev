import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260803000000_performance_report_record/migration.sql",
  ),
  "utf8",
);
const sqlOnly = SQL.replace(/--.*$/gm, "");

describe("performance report record migration", () => {
  it("creates a forced-RLS audit table with append-only application grants", () => {
    expect(sqlOnly).toMatch(
      /CREATE TABLE audit\.performance_report_record\s*\(/i,
    );
    expect(sqlOnly).toMatch(
      /ALTER TABLE audit\.performance_report_record ENABLE ROW LEVEL SECURITY/i,
    );
    expect(sqlOnly).toMatch(
      /ALTER TABLE audit\.performance_report_record FORCE ROW LEVEL SECURITY/i,
    );
    expect(sqlOnly).toMatch(
      /GRANT INSERT, SELECT ON audit\.performance_report_record TO app_rw/i,
    );
    expect(sqlOnly).not.toMatch(
      /GRANT[^;]*(?:UPDATE|DELETE)[^;]*performance_report_record/i,
    );
  });

  it("pins insert identity to the scoped transaction and limits reads", () => {
    expect(sqlOnly).toMatch(
      /CREATE POLICY performance_report_record_insert[\s\S]*FOR INSERT TO app_rw[\s\S]*current_setting\('app\.user_role', true\)[\s\S]*actor_email IS NOT DISTINCT FROM[\s\S]*current_setting\('app\.user_email', true\)/i,
    );
    expect(sqlOnly).toMatch(
      /CREATE POLICY performance_report_record_privileged_read[\s\S]*FOR SELECT TO app_rw[\s\S]*'ADMIN'[\s\S]*'OPERATIONS'[\s\S]*'HEAD_OF_ADVISORY'/i,
    );
    expect(sqlOnly).toMatch(
      /actor_role = current_setting\('app\.user_role', true\)[\s\S]*actor_email IS NOT DISTINCT FROM/i,
    );
  });

  it("constrains scope, versions, dates, and the content digest", () => {
    expect(sqlOnly).toMatch(/CHECK \(scope IN \('account', 'household'\)\)/i);
    expect(sqlOnly).toMatch(/CHECK \(snapshot_version = 1\)/i);
    expect(sqlOnly).toMatch(/CHECK \(report_date ~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$'\)/i);
    expect(sqlOnly).toMatch(/CHECK \(as_of ~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$'\)/i);
    expect(sqlOnly).toMatch(/CHECK \(payload_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  });
});
