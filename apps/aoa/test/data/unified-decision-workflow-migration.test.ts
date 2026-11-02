import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260908193000_unified_decision_workflow",
    "migration.sql",
  ),
  "utf8",
);

describe("unified decision workflow migration", () => {
  it("creates one generic case model with optional Asset Transfer linkage", () => {
    expect(SQL).toMatch(/CREATE TABLE "app"\."decision_case"/);
    expect(SQL).toMatch(/"source" "app"\."DecisionCaseSource" NOT NULL/);
    expect(SQL).toMatch(/"transfer_id" text/);
    expect(SQL).toMatch(/decision_case_transfer_source_check/);
    expect(SQL).toMatch(/"source_key" VARCHAR\(191\) NOT NULL/);
    expect(SQL).toMatch(/decision_case_source_key_key/);
  });

  it("pins finalized resolution provenance and versioning", () => {
    expect(SQL).toMatch(/decision_case_resolution_check/);
    expect(SQL).toMatch(/"resolved_by" VARCHAR\(320\)/);
    expect(SQL).toMatch(/"resolved_at" timestamptz/);
    expect(SQL).toMatch(/"version" integer NOT NULL DEFAULT 0/);
    expect(SQL).toMatch(/"status" = 'RESOLVED'[\s\S]+"version" > 0/);
  });

  it("supports owned parent and child tasks without client assignment", () => {
    expect(SQL).toMatch(/CREATE TABLE "app"\."decision_task"/);
    expect(SQL).toMatch(/"parent_task_id" text/);
    expect(SQL).toMatch(/DecisionOwnerTeam.+OPERATIONS.+CLIENT_SERVICE.+ADVISORY.+TRADE_DESK/s);
    expect(SQL).not.toMatch(/DecisionOwnerTeam.+CLIENT['"]/s);
  });

  it("uses FORCE RLS, no deletes, and an append-only event trail", () => {
    for (const table of ["decision_case", "decision_task", "decision_case_event"]) {
      expect(SQL).toContain(`ALTER TABLE "app"."${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(SQL).toMatch(/REVOKE DELETE.+decision_case.+decision_task.+decision_case_event.+FROM app_rw/s);
    expect(SQL).toMatch(/REVOKE UPDATE ON "app"\."decision_case_event" FROM app_rw/);
    expect(SQL).not.toMatch(/CREATE TRIGGER/);
  });
});
