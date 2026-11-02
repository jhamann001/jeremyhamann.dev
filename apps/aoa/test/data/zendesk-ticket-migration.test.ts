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
    "20260829120000_mirror_zendesk_ticket",
    "migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("mirror Zendesk ticket migration", () => {
  it("stores ticket context and a separate public-comment thread", () => {
    expect(sqlOnly).toMatch(/CREATE TABLE mirror\.zendesk_ticket\s*\(/i);
    expect(sqlOnly).toMatch(/\bdescription\s+text/i);
    expect(sqlOnly).toMatch(/CREATE TABLE mirror\.zendesk_ticket_comment\s*\(/i);
    expect(sqlOnly).toMatch(/\bbody\s+text NOT NULL/i);
  });

  it("does not persist requester matching identifiers or profile fields", () => {
    expect(sqlOnly).not.toMatch(/requester_(email|cedar_ridge_user_id|name)/i);
    expect(sqlOnly).not.toMatch(/\battachment/i);
  });

  it("is upsert-only and gives the app read access only", () => {
    expect(sqlOnly).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON mirror\.zendesk_ticket TO ingest_rw/i,
    );
    expect(sqlOnly).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON mirror\.zendesk_ticket_comment TO ingest_rw/i,
    );
    expect(sqlOnly).toMatch(/GRANT SELECT ON mirror\.zendesk_ticket TO app_rw/i);
    expect(sqlOnly).toMatch(/GRANT SELECT ON mirror\.zendesk_ticket_comment TO app_rw/i);
    expect(sqlOnly).not.toMatch(/\bDELETE\b/i);
  });

  it("forces RLS on tickets and comments and scopes comments through their ticket", () => {
    expect(sqlOnly).toMatch(
      /ALTER TABLE mirror\.zendesk_ticket FORCE ROW LEVEL SECURITY/i,
    );
    expect(sqlOnly).toMatch(
      /ALTER TABLE mirror\.zendesk_ticket_comment FORCE ROW LEVEL SECURITY/i,
    );
    expect(sqlOnly).toMatch(
      /CREATE POLICY zendesk_ticket_own_book[\s\S]*?FOR SELECT TO app_rw/i,
    );
    expect(sqlOnly).toMatch(
      /CREATE POLICY zendesk_ticket_comment_own_book[\s\S]*?FROM mirror\.zendesk_ticket ticket/i,
    );
  });
});
