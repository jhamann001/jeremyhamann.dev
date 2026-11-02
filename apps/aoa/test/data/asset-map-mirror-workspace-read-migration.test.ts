import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ticket: Advisor and Client Service read the three asset-map mirror tables only
// inside the asset-mapping workspace. The migration may add SELECT policies and nothing else.

const root = path.resolve(import.meta.dirname, "../..");
const migration = fs.readFileSync(
  path.join(root, "prisma/migrations/20261007120000_asset_map_mirror_workspace_read/migration.sql"),
  "utf8",
);
const statements = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

describe("asset-map mirror workspace read migration (ticket)", () => {
  it("adds exactly three SELECT policies, one per workspace table, for app_rw", () => {
    expect(statements).toHaveLength(3);
    for (const table of ["household", "account", "position"]) {
      const policy = statements.find((s) => s.includes(`ON mirror.acat_asset_map_${table}\n`));
      expect(policy).toMatch(new RegExp(`^CREATE POLICY acat_asset_map_${table}_workspace_read ON mirror\\.acat_asset_map_${table}\\s+FOR SELECT TO app_rw USING \\(`));
    }
  });

  it("requires both an Advisor or Client Service role and the workspace scope", () => {
    for (const s of statements) {
      expect(s).toContain("current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')");
      expect(s).toContain("AND current_setting('app.asset_map_scope', true) = 'workspace'");
      expect(s).not.toMatch(/VIEWER|HEAD_OF_ADVISORY|\bOR\b/);
    }
  });

  it("grants nothing, writes nothing, and leaves the link tables alone", () => {
    expect(statements.join("\n")).not.toMatch(/\bGRANT\b|\bREVOKE\b|\bALTER\b|\bDROP\b/i);
    expect(statements.join("\n")).not.toMatch(/FOR\s+(ALL|INSERT|UPDATE|DELETE)/i);
    expect(statements.join("\n")).not.toMatch(/WITH CHECK/i);
    expect(statements.join("\n")).not.toMatch(/acat_asset_map_(account_)?link/);
  });
});
