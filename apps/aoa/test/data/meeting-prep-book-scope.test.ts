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
    "20260830000000_meeting_prep_book_scope",
    "migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("app.meeting_prep book-scoped RLS repair", () => {
  it("replaces every role-only meeting-prep policy", () => {
    expect(sqlOnly).toMatch(/DROP POLICY meeting_prep_read_write_roles/i);
    expect(sqlOnly).toMatch(/DROP POLICY meeting_prep_insert_write_roles/i);
    expect(sqlOnly).toMatch(/DROP POLICY meeting_prep_update_write_roles/i);
    expect(sqlOnly).toMatch(/CREATE POLICY meeting_prep_read_book_scope[\s\S]*FOR SELECT/i);
    expect(sqlOnly).toMatch(/CREATE POLICY meeting_prep_insert_book_scope[\s\S]*FOR INSERT/i);
    expect(sqlOnly).toMatch(/CREATE POLICY meeting_prep_update_book_scope[\s\S]*FOR UPDATE/i);
  });

  it("keeps firm-wide access only for current privileged roles", () => {
    expect(sqlOnly.match(/IN \('ADMIN', 'OPERATIONS'\)/g)).toHaveLength(4);
    expect(sqlOnly).not.toMatch(/HEAD_OF_ADVISORY/);
    expect(sqlOnly).not.toMatch(/VIEWER/);
  });

  it("requires advisors and client service to resolve through visible mirror clients", () => {
    expect(sqlOnly.match(/IN \('ADVISOR', 'CLIENT_SERVICE'\)/g)).toHaveLength(4);
    expect(sqlOnly.match(/client_sf_id IS NOT NULL/g)).toHaveLength(4);
    expect(sqlOnly.match(/FROM mirror\.client visible_client/g)).toHaveLength(4);
    expect(sqlOnly.match(/visible_client\.sf_id = client_sf_id/g)).toHaveLength(4);
  });

  it("guards both the old and new row on UPDATE", () => {
    expect(sqlOnly).toMatch(
      /CREATE POLICY meeting_prep_update_book_scope[\s\S]*FOR UPDATE TO app_rw[\s\S]*USING \([\s\S]*\)[\s\S]*WITH CHECK \(/i,
    );
  });

  it("adds no grant, delete path, table, function, or security definer bypass", () => {
    expect(sqlOnly).not.toMatch(/\bGRANT\b/i);
    expect(sqlOnly).not.toMatch(/FOR DELETE/i);
    expect(sqlOnly).not.toMatch(/CREATE TABLE/i);
    expect(sqlOnly).not.toMatch(/CREATE FUNCTION/i);
    expect(sqlOnly).not.toMatch(/SECURITY DEFINER/i);
  });
});

describe("meeting-prep appointment authorization seam", () => {
  const seam = readFileSync(
    join(import.meta.dirname, "..", "..", "lib", "data", "meeting-prep.ts"),
    "utf8",
  );

  it("checks book visibility before returning an appointment to the generation action", () => {
    expect(seam).toMatch(/FROM mirror\.appointment appointment/);
    expect(seam).toMatch(/FROM mirror\.client visible_client/);
    expect(seam).toMatch(/visible_client\.sf_id = appointment\.client_sf_id/);
    expect(seam).toMatch(/IN \('ADMIN', 'OPERATIONS'\)/);
    expect(seam).toMatch(/IN \('ADVISOR', 'CLIENT_SERVICE'\)/);
  });
});
