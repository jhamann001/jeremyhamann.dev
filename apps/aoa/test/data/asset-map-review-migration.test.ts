import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the P2.3 ops-write migration's CONTRACT — the hybrid-table architecture
// decision must not silently drift: app_rw gets UPDATE (only), a FOR UPDATE RLS
// policy on the same ops role-GUC predicate as the read policy, and NEVER DELETE
// / INSERT to app_rw. A content assertion (not a live DB) — the CI-exact gates
// run no Postgres.

const SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260720000000_asset_map_link_ops_write",
    "migration.sql",
  ),
  "utf8",
);

describe("P2.3 ops-write migration", () => {
  it("grants app_rw UPDATE on the link table", () => {
    expect(SQL).toMatch(
      /GRANT\s+UPDATE\s+ON\s+mirror\.acat_asset_map_link\s+TO\s+app_rw/i,
    );
  });

  it("adds a FOR UPDATE RLS policy for app_rw with USING and WITH CHECK", () => {
    expect(SQL).toMatch(/CREATE POLICY .*acat_asset_map_link.*\n?[\s\S]*FOR UPDATE TO app_rw/i);
    expect(SQL).toMatch(/USING\s*\(/i);
    expect(SQL).toMatch(/WITH CHECK\s*\(/i);
  });

  it("gates the write on the SAME ops role-GUC predicate as the read policy", () => {
    // Both USING and WITH CHECK reference app.user_role IN (ADMIN/OPERATIONS/HoA).
    const matches = SQL.match(
      /current_setting\('app\.user_role', true\) IN \('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY'\)/g,
    );
    expect(matches?.length).toBe(2); // USING + WITH CHECK
  });

  it("never grants DELETE or INSERT to app_rw (UPDATE-only human write)", () => {
    // Strip `--` comments first (the prose explains the NOT-INSERT rule, which
    // would otherwise trip a naive scan), then inspect real GRANT statements: the
    // ONLY app_rw grant is UPDATE, and no FOR DELETE policy exists anywhere.
    const sqlOnly = SQL.split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    const grants = sqlOnly.match(/GRANT[^;]*;/gi) ?? [];
    const appRwGrants = grants.filter((g) => /\bapp_rw\b/i.test(g));
    expect(appRwGrants).toHaveLength(1);
    expect(appRwGrants[0]).toMatch(
      /GRANT\s+UPDATE\s+ON\s+mirror\.acat_asset_map_link\s+TO\s+app_rw/i,
    );
    expect(appRwGrants.some((g) => /\b(INSERT|DELETE)\b/i.test(g))).toBe(false);
    expect(sqlOnly).not.toMatch(/FOR\s+DELETE/i);
  });

  it("adds no new columns (P2.0 already carries every field)", () => {
    expect(SQL).not.toMatch(/ALTER TABLE[\s\S]*ADD COLUMN/i);
    expect(SQL).not.toMatch(/CREATE TABLE/i);
  });
});
