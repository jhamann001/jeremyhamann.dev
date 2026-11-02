import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260804000000_remove_head_of_advisory_role/migration.sql",
);
const sql = fs.readFileSync(migrationPath, "utf8");

describe("Head of Advisory role retirement migration", () => {
  it("converts every stored Head of Advisory user to Operations first", () => {
    const updateAt = sql.indexOf('UPDATE "app"."User"');
    const rebuildAt = sql.indexOf('ALTER TYPE "app"."Role"');

    expect(updateAt).toBeGreaterThan(-1);
    expect(sql).toMatch(
      /UPDATE "app"\."User"\s+SET "role" = 'OPERATIONS'\s+WHERE "role" = 'HEAD_OF_ADVISORY'/,
    );
    expect(rebuildAt).toBeGreaterThan(updateAt);
  });

  it("rebuilds the enum with only the five current application roles", () => {
    const createType = sql.match(
      /CREATE TYPE "app"\."Role" AS ENUM \(([\s\S]*?)\);/,
    )?.[1];

    expect(createType).toBeDefined();
    expect(createType).toContain("'ADMIN'");
    expect(createType).toContain("'OPERATIONS'");
    expect(createType).toContain("'ADVISOR'");
    expect(createType).toContain("'CLIENT_SERVICE'");
    expect(createType).toContain("'VIEWER'");
    expect(createType).not.toContain("HEAD_OF_ADVISORY");
  });

  it("preserves the User role column and its VIEWER default transactionally", () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(
      /ALTER COLUMN "role" TYPE "app"\."Role"\s+USING \("role"::text::"app"\."Role"\)/,
    );
    expect(sql).toMatch(
      /ALTER COLUMN "role" SET DEFAULT 'VIEWER'::"app"\."Role"/,
    );
    expect(sql).toMatch(/DROP TYPE "app"\."Role_with_head_of_advisory";/);
    expect(sql).toMatch(/COMMIT;\s*$/);
  });

  it("does not delete users or cascade away dependencies", () => {
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/\bCASCADE\b/i);
  });
});
