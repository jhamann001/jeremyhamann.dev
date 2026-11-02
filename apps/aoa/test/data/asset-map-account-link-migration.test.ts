import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the P2.5 account-link migration's CONTRACT (a content assertion — the
// CI-exact gates run no Postgres). Asserts the table, the NULLS-NOT-DISTINCT natural
// key (no PK, no sentinel), the three read indexes, the CHECKs, the grants (the
// app_rw INSERT + UPDATE extension of the P2.3 hybrid — and NO DELETE), FORCE RLS +
// the four policies, and the timestamp ordering after the P2.3 write migration.

const DIR = join(import.meta.dirname, "..", "..", "prisma", "migrations");
const NAME = "20260722000000_asset_map_account_link";
const SQL = readFileSync(join(DIR, NAME, "migration.sql"), "utf8");
// Comment-stripped copy (the prose explains the NOT-DELETE rule, which would trip a
// naive scan) — inspect real statements against this.
const sqlOnly = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("P2.5 account-link migration", () => {
  it("creates mirror.acat_asset_map_account_link", () => {
    expect(SQL).toMatch(/CREATE TABLE mirror\.acat_asset_map_account_link/i);
  });

  it("has the ownership_role and match_status CHECK constraints", () => {
    expect(sqlOnly).toMatch(
      /CHECK\s*\(\s*ownership_role\s+IN\s*\(\s*'PRIMARY'\s*,\s*'JOINT'\s*,\s*'ENTITY'\s*,\s*'CUSTODIAN'\s*,\s*'BENEFICIARY'\s*\)\s*\)/i,
    );
    expect(sqlOnly).toMatch(
      /CHECK\s*\(\s*match_status\s+IN\s*\(\s*'UNMATCHED'\s*,\s*'AUTO_LINKED'\s*,\s*'NEEDS_REVIEW'\s*,\s*'CONFIRMED'\s*,\s*'REJECTED'\s*\)\s*\)/i,
    );
  });

  it("resolves the entity NULL owner via a UNIQUE ... NULLS NOT DISTINCT index (no PRIMARY KEY, no sentinel)", () => {
    expect(sqlOnly).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*\(\s*source_folder_id\s*,\s*custodian\s*,\s*account_number\s*,\s*cedar_ridge_user_id\s*\)[\s\S]*NULLS NOT DISTINCT/i,
    );
    // No literal PRIMARY KEY (the nullable owner forbids it), no empty-string sentinel.
    expect(sqlOnly).not.toMatch(/PRIMARY KEY/i);
    expect(sqlOnly).not.toMatch(/cedar_ridge_user_id\s*=\s*''/);
  });

  it("has the three read indexes (folder / cedarRidge / status)", () => {
    expect(sqlOnly).toMatch(/CREATE INDEX \w*folder_idx\s+ON mirror\.acat_asset_map_account_link \(source_folder_id\)/i);
    expect(sqlOnly).toMatch(/CREATE INDEX \w*cedar_ridge_idx\s+ON mirror\.acat_asset_map_account_link \(cedar_ridge_user_id\)/i);
    expect(sqlOnly).toMatch(/CREATE INDEX \w*status_idx\s+ON mirror\.acat_asset_map_account_link \(match_status\)/i);
  });

  it("grants ingest_rw SELECT/INSERT/UPDATE", () => {
    expect(sqlOnly).toMatch(
      /GRANT\s+SELECT,\s*INSERT,\s*UPDATE\s+ON\s+mirror\.acat_asset_map_account_link\s+TO\s+ingest_rw/i,
    );
  });

  it("grants app_rw SELECT + INSERT + UPDATE (the P2.5 extension) and NEVER DELETE", () => {
    const grants = sqlOnly.match(/GRANT[^;]*;/gi) ?? [];
    const appRwGrants = grants.filter((g) => /\bapp_rw\b/i.test(g));
    const appRwText = appRwGrants.join(" ");
    expect(appRwText).toMatch(/\bSELECT\b/i);
    expect(appRwText).toMatch(/\bINSERT\b/i);
    expect(appRwText).toMatch(/\bUPDATE\b/i);
    // No DELETE grant for app_rw, and no FOR DELETE policy anywhere (ADR-7).
    expect(appRwGrants.some((g) => /\bDELETE\b/i.test(g))).toBe(false);
    expect(sqlOnly).not.toMatch(/FOR\s+DELETE/i);
  });

  it("enables + FORCEs RLS", () => {
    expect(sqlOnly).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(sqlOnly).toMatch(/FORCE\s+ROW LEVEL SECURITY/i);
  });

  it("has the four policies (ingest_all, ops SELECT, ops UPDATE, ops INSERT) on the ops role-GUC predicate", () => {
    expect(sqlOnly).toMatch(/CREATE POLICY \w*ingest_all[\s\S]*FOR ALL TO ingest_rw[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\)/i);
    expect(sqlOnly).toMatch(/CREATE POLICY \w*ops_all[\s\S]*FOR SELECT TO app_rw/i);
    expect(sqlOnly).toMatch(/CREATE POLICY \w*ops_update[\s\S]*FOR UPDATE TO app_rw/i);
    expect(sqlOnly).toMatch(/CREATE POLICY \w*ops_insert[\s\S]*FOR INSERT TO app_rw/i);
    // Every ops policy uses the ADMIN/OPERATIONS/HEAD_OF_ADVISORY GUC predicate.
    const guc = sqlOnly.match(
      /current_setting\('app\.user_role', true\) IN \('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY'\)/g,
    );
    // ops_all (1) + ops_update USING+WITH CHECK (2) + ops_insert WITH CHECK (1) = 4.
    expect(guc?.length).toBe(4);
  });

  it("timestamp sorts after the P2.3 write migration", () => {
    expect(NAME > "20260720000000_asset_map_link_ops_write").toBe(true);
  });
});
