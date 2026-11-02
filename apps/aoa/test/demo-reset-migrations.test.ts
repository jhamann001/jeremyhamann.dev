// The nightly reset's migration check (lib/demo/reset.ts, migrationProblems): the reset empties the database only
// when its migration history is exactly the checkout's, so the seed that follows meets the schema it was written for.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { migrationFolders, migrationProblems, type AppliedMigration } from "@/lib/demo/reset";

const at = new Date("2026-11-01T07:00:00Z");
const done = (migration_name: string): AppliedMigration => ({ migration_name, finished_at: at, rolled_back_at: null });
const CHECKOUT = ["20260101000000_first", "20260201000000_second", "20260301000000_third"];

describe("the reset's migration check", () => {
  it("passes when the database has applied exactly the checkout's migrations", () => {
    expect(migrationProblems(CHECKOUT.map(done), CHECKOUT)).toEqual([]);
  });

  it("refuses a migration the checkout carries but the database lacks (merged, not deployed)", () => {
    expect(migrationProblems(CHECKOUT.slice(0, 2).map(done), CHECKOUT)).toEqual([
      "20260301000000_third: not applied to the database",
    ]);
  });

  it("refuses a migration only the database has (it is ahead of this code)", () => {
    expect(migrationProblems([...CHECKOUT, "20260401000000_fourth"].map(done), CHECKOUT)).toEqual([
      "20260401000000_fourth: in the database but not in this checkout",
    ]);
  });

  it("refuses a migration that started and never finished", () => {
    const applied = [...CHECKOUT.slice(0, 2).map(done), { migration_name: CHECKOUT[2], finished_at: null, rolled_back_at: null }];
    expect(migrationProblems(applied, CHECKOUT)).toEqual(["20260301000000_third: started in the database but never finished"]);
  });

  it("reads a rolled-back attempt as history: what counts is whether the migration then ran", () => {
    const rolledBack = { migration_name: CHECKOUT[2], finished_at: null, rolled_back_at: at };
    expect(migrationProblems([...CHECKOUT.map(done), rolledBack], CHECKOUT)).toEqual([]);
    expect(migrationProblems([...CHECKOUT.slice(0, 2).map(done), rolledBack], CHECKOUT)).toEqual([
      "20260301000000_third: not applied to the database",
    ]);
  });

  it("reads the checkout's migrations as prisma/migrations' folders, not its lock file", () => {
    const folders = migrationFolders(join(import.meta.dirname, "..", "prisma", "migrations"));
    expect(folders.length).toBeGreaterThan(100);
    expect(folders).toEqual([...folders].sort());
    expect(folders.every((name) => /^\d{14}_\w+$/.test(name))).toBe(true);
  });
});
