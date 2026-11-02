import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Guards the ACAT record-id linking migration's CONTRACT (a content assertion —
// the CI-exact gates run no Postgres). Mirrors the 20260716000000
// transfer_acat_transfer_id_unique idiom: the defensive keep-earliest dedupe
// CTE, the partial unique index, and NOTHING else (no table/column/enum/grant/
// policy change — an index-only migration). Also pins the timestamp ordering
// after the latest shipped migration so `migrate deploy` applies it last.

const DIR = join(import.meta.dirname, "..", "..", "prisma", "migrations");
const NAME = "20260723000000_transfer_acat_record_id_unique";
const SQL = readFileSync(join(DIR, NAME, "migration.sql"), "utf8");
// Comment-stripped copy (the prose names statements it forbids, which would
// trip a naive scan) — inspect real statements against this.
const sqlOnly = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("transfer_acat_record_id_unique migration", () => {
  it("creates the partial unique index transfer_acat_record_id_key", () => {
    expect(sqlOnly).toMatch(
      /CREATE UNIQUE INDEX "transfer_acat_record_id_key"\s+ON "app"\."transfer" \("acat_record_id"\)\s+WHERE "acat_record_id" IS NOT NULL/i,
    );
  });

  it("de-duplicates before indexing (keep-earliest CTE)", () => {
    expect(sqlOnly).toMatch(
      /WITH ranked AS[\s\S]*PARTITION BY acat_record_id[\s\S]*ORDER BY created_at ASC, id ASC/i,
    );
    expect(sqlOnly).toMatch(
      /SET acat_record_id = NULL[\s\S]*ranked\.rn > 1/i,
    );
  });

  it("changes nothing else — no ALTER TABLE / CREATE TABLE / GRANT / POLICY / DROP", () => {
    expect(sqlOnly).not.toMatch(/ALTER\s+TABLE/i);
    expect(sqlOnly).not.toMatch(/CREATE\s+TABLE/i);
    expect(sqlOnly).not.toMatch(/\bGRANT\b/i);
    expect(sqlOnly).not.toMatch(/\bPOLICY\b/i);
    expect(sqlOnly).not.toMatch(/\bDROP\b/i);
  });

  it("is timestamped after the migrations that predated it (scans the real dir)", () => {
    // Scan prisma/migrations rather than comparing two literals. This migration
    // must sort AFTER everything that existed when it shipped — its baseline was
    // 20260722000000_asset_map_account_link. It need NOT be the eternal newest:
    // later INDEPENDENT migrations legitimately land after it (e.g.
    // 20260724000000_transfer_asset_map_link — additive asset_map_* columns, no
    // ordering dependency on this unique index). Guard against a pre-baseline
    // migration out-ordering this one, not against all future work.
    const BASELINE = "20260722000000_asset_map_account_link";
    const priorOrBaseline = readdirSync(DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name) && e.name !== NAME)
      .map((e) => e.name)
      .filter((name) => name <= BASELINE)
      .sort();
    const latestPrior = priorOrBaseline[priorOrBaseline.length - 1];
    expect(priorOrBaseline.length).toBeGreaterThan(0);
    expect(NAME > latestPrior).toBe(true);
  });
});
