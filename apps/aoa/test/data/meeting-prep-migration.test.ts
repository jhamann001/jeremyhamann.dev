import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the app.meeting_prep migration's CONTRACT — this table holds the
// densest client PII in the app, so its access decisions must not silently
// drift. A CONTENT assertion (not a live DB): the CI-exact gates run no Postgres,
// the asset-map-review-migration idiom.
//
// Locks blueprint ADR-2 (no FK to the mirror) and ADR-3 (five non-VIEWER roles,
// no DELETE anywhere, no ingest_rw grant).

const SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260731000000_app_meeting_prep",
    "migration.sql",
  ),
  "utf8",
);

/** The SQL with `--` comments stripped — the prose explains the NOT-rules, which
 *  would otherwise trip a naive scan for them. */
const sqlOnly = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

const ROLES = "'ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE'";

describe("app.meeting_prep migration", () => {
  it("creates the table in the app schema with the appointment_key unique", () => {
    expect(sqlOnly).toMatch(/CREATE TABLE "app"\."meeting_prep"/i);
    expect(sqlOnly).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*?ON "app"\."meeting_prep"\("appointment_key"\)/i,
    );
  });

  it("grants app_rw SELECT + INSERT + UPDATE and REVOKEs DELETE", () => {
    expect(sqlOnly).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON "app"\."meeting_prep" TO app_rw/i,
    );
    expect(sqlOnly).toMatch(/REVOKE DELETE ON "app"\."meeting_prep" FROM app_rw/i);
  });

  it("ENABLEs and FORCEs row level security", () => {
    expect(sqlOnly).toMatch(/ALTER TABLE "app"\."meeting_prep" ENABLE ROW LEVEL SECURITY/i);
    expect(sqlOnly).toMatch(/ALTER TABLE "app"\."meeting_prep" FORCE ROW LEVEL SECURITY/i);
  });

  it("has SELECT / INSERT / UPDATE policies on the role GUC and NO DELETE policy", () => {
    expect(sqlOnly).toMatch(/CREATE POLICY meeting_prep_read_write_roles[\s\S]*?FOR SELECT TO app_rw/i);
    expect(sqlOnly).toMatch(/CREATE POLICY meeting_prep_insert_write_roles[\s\S]*?FOR INSERT TO app_rw/i);
    expect(sqlOnly).toMatch(/CREATE POLICY meeting_prep_update_write_roles[\s\S]*?FOR UPDATE TO app_rw/i);
    expect(sqlOnly).not.toMatch(/FOR DELETE/i);
  });

  it("EXCLUDES VIEWER from every policy predicate (ADR-3)", () => {
    expect(sqlOnly).not.toMatch(/VIEWER/);
    // SELECT USING, INSERT WITH CHECK, UPDATE USING + WITH CHECK = 4 predicates.
    const matches = sqlOnly.match(
      new RegExp(
        `current_setting\\('app\\.user_role', true\\) IN\\s*\\n?\\s*\\(${ROLES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
        "g",
      ),
    );
    expect(matches?.length).toBe(4);
  });

  it("grants NOTHING to ingest_rw — nothing machine-written touches this table", () => {
    expect(sqlOnly).not.toMatch(/ingest_rw/);
  });

  it("has NO foreign key into the mirror schema (ADR-2)", () => {
    expect(sqlOnly).not.toMatch(/REFERENCES\s+"?mirror"?\./i);
    expect(sqlOnly).not.toMatch(/FOREIGN KEY/i);
  });

  it("keeps the pg_roles-guarded owner-bypass policy (FORCE RLS binds the owner)", () => {
    expect(sqlOnly).toMatch(/FROM pg_roles/i);
    expect(sqlOnly).toMatch(/meeting_prep_owner_all/);
    expect(sqlOnly).toMatch(/'aoa', 'aoa_admin'/);
  });
});

// --- Save-to-portrait migration (20260801000000_meeting_prep_saved) ----------
// Save is a PROMOTION of the already-stored brief, not a second store. The
// contract this guards: two nullable stamp columns on the EXISTING table, the
// portrait's read index, and — the important part — NO new grant, NO new policy
// and above all NO DELETE. Un-saving must stay an UPDATE, so it can never
// destroy an audited PII artifact.

const SAVED_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260801000000_meeting_prep_saved",
    "migration.sql",
  ),
  "utf8",
);

const savedSqlOnly = SAVED_SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("app.meeting_prep — save-to-portrait migration", () => {
  it("adds saved_at + saved_by to the EXISTING table (no second table)", () => {
    expect(savedSqlOnly).toMatch(/ALTER TABLE "app"\."meeting_prep"/i);
    expect(savedSqlOnly).toMatch(/ADD COLUMN "saved_at" TIMESTAMPTZ\(6\)/i);
    expect(savedSqlOnly).toMatch(/ADD COLUMN "saved_by" TEXT/i);
    expect(savedSqlOnly).not.toMatch(/CREATE TABLE/i);
  });

  it("both stamp columns are NULLABLE — NULL is 'not saved'", () => {
    expect(savedSqlOnly).not.toMatch(/ADD COLUMN "saved_(at|by)"[^,;]*NOT NULL/i);
  });

  it("indexes what the portrait read needs (client_sf_id, saved_at)", () => {
    expect(savedSqlOnly).toMatch(
      /CREATE INDEX[\s\S]*?ON "app"\."meeting_prep"\("client_sf_id", "saved_at"\)/i,
    );
  });

  it("adds NO grant and NO policy — save/unsave ride the existing UPDATE policy", () => {
    expect(savedSqlOnly).not.toMatch(/GRANT/i);
    expect(savedSqlOnly).not.toMatch(/CREATE POLICY/i);
    expect(savedSqlOnly).not.toMatch(/ROW LEVEL SECURITY/i);
  });

  it("introduces NO delete path — un-saving is an UPDATE, never a DELETE", () => {
    expect(savedSqlOnly).not.toMatch(/\bDELETE\b/i);
    expect(savedSqlOnly).not.toMatch(/DROP (TABLE|COLUMN)/i);
  });

  it("stays out of the mirror — still no FK and no ingest_rw", () => {
    expect(savedSqlOnly).not.toMatch(/REFERENCES/i);
    expect(savedSqlOnly).not.toMatch(/ingest_rw/i);
  });
});
