import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(join(import.meta.dirname, "..", "..", "prisma", "migrations", "20260817120000_review_queue", "migration.sql"), "utf8");
const sqlOnly = SQL.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

describe("central review queue migration", () => {
  it("stores workflow/provenance and redacted detector references, not authoritative payloads", () => {
    expect(sqlOnly).toMatch(/CREATE TABLE "app"\."review_queue_item"/i);
    expect(sqlOnly).toMatch(/CREATE TABLE "app"\."review_queue_sweep_state"/i);
    expect(sqlOnly).toMatch(/"detector_key" CHAR\(64\).*UNIQUE|UNIQUE INDEX "review_queue_item_detector_key_key"/is);
    expect(sqlOnly).toMatch(/"source_snapshot" JSONB/i);
    expect(sqlOnly).not.toMatch(/risk_score|instructions|client_name|account_number|request_body/i);
  });

  it("forces Operations/Admin-only RLS and prevents deletion", () => {
    expect(sqlOnly).toMatch(/ALTER TABLE "app"\."review_queue_item" FORCE ROW LEVEL SECURITY/i);
    expect(sqlOnly).toMatch(/ALTER TABLE "app"\."review_queue_event" FORCE ROW LEVEL SECURITY/i);
    expect(sqlOnly).toMatch(/ALTER TABLE "app"\."review_queue_sweep_state" FORCE ROW LEVEL SECURITY/i);
    expect(sqlOnly).toContain("'ADMIN', 'OPERATIONS'");
    expect(sqlOnly).not.toMatch(/'ADVISOR'|'CLIENT_SERVICE'|'VIEWER'/i);
    expect(sqlOnly).toMatch(/REVOKE DELETE ON "app"\."review_queue_item" FROM app_rw/i);
    expect(sqlOnly).toMatch(/REVOKE UPDATE, DELETE ON "app"\."review_queue_event" FROM app_rw/i);
    expect(sqlOnly).toMatch(/REVOKE DELETE ON "app"\."review_queue_sweep_state" FROM app_rw/i);
  });

  it("persists only bounded resumable sweep progress and failure freshness", () => {
    expect(sqlOnly).toMatch(/"trade_cursor" VARCHAR\(128\)/i);
    expect(sqlOnly).toMatch(/"crm_cursor" VARCHAR\(128\)/i);
    expect(sqlOnly).toMatch(/"last_completed_at" TIMESTAMPTZ/i);
    expect(sqlOnly).toMatch(/"last_failure_at" TIMESTAMPTZ/i);
    expect(sqlOnly).toMatch(/"lease_expires_at" TIMESTAMPTZ/i);
    expect(sqlOnly).not.toMatch(/sweep.*client_name|sweep.*account_number/is);
  });

  it("keeps an append-only event history and validates workflow state dates", () => {
    expect(sqlOnly).toMatch(/CREATE TABLE "app"\."review_queue_event"/i);
    expect(sqlOnly).toMatch(/GRANT SELECT, INSERT ON "app"\."review_queue_event" TO app_rw/i);
    expect(sqlOnly).toMatch(/status.*RESOLVED.*resolved_at/is);
    expect(sqlOnly).toMatch(/status.*SNOOZED.*snoozed_until/is);
  });

  it("allows only constrained local routes, including the CRM exception fragment", () => {
    expect(sqlOnly).toContain("^/[A-Za-z0-9][A-Za-z0-9/_?&=.%+#-]*$");
    expect(sqlOnly).toContain("!~ '//'");
    expect(sqlOnly).toContain("!~ '(^|/)\\.\\.(/|$)'");
    expect(sqlOnly).not.toMatch(/https?:\/\//i);
  });
});
