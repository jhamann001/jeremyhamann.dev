import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260908160000_transfer_funding_plan_approval",
    "migration.sql",
  ),
  "utf8",
);

describe("transfer funding-plan approval migration", () => {
  it("adds current-version metadata to the transfer root", () => {
    expect(SQL).toMatch(/funding_plan_version.+integer NOT NULL DEFAULT 0/i);
    expect(SQL).toMatch(/funding_plan_approved_at.+timestamptz/i);
    expect(SQL).toMatch(/funding_plan_approved_by.+text/i);
  });

  it("creates immutable, Operations-restricted snapshot history", () => {
    expect(SQL).toMatch(/CREATE TABLE "app"\."transfer_funding_plan_approval"/i);
    expect(SQL).toMatch(/"snapshot" jsonb NOT NULL/i);
    expect(SQL).toMatch(/GRANT SELECT, INSERT.+TO app_rw/i);
    expect(SQL).toMatch(/REVOKE UPDATE, DELETE.+FROM app_rw/i);
    expect(SQL).toMatch(
      /CREATE POLICY transfer_funding_plan_approval_read_ops[\s\S]+ADMIN[\s\S]+OPERATIONS/i,
    );
    expect(SQL).not.toMatch(
      /transfer_funding_plan_approval_read_ops[\s\S]+(?:VIEWER|ADVISOR|CLIENT_SERVICE|HEAD_OF_ADVISORY)/i,
    );
  });

  it("does not add a generic audit trigger that would copy snapshot details", () => {
    expect(SQL).not.toMatch(/\bDROP\b/i);
    expect(SQL).not.toMatch(/CREATE TRIGGER/i);
  });
});
