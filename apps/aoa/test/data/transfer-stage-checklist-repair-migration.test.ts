import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TASKS, type TransferStage } from "@/lib/data/transfer-types";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260819190000_transfer_stage_checklist_repair/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("transfer current-stage checklist repair migration", () => {
  it("keeps the SQL template synchronized with DEFAULT_TASKS", () => {
    const tuples = [
      ...sqlOnly.matchAll(
        /\('(DECISION|IN_TRANSFER|FUNDED)', '([^']+)', \d+\)/g,
      ),
    ];
    const actual = Object.fromEntries(
      (["DECISION", "IN_TRANSFER", "FUNDED"] as const).map((stage) => [
        stage,
        tuples
          .filter((match) => match[1] === stage)
          .map((match) => match[2]),
      ]),
    ) as Record<TransferStage, string[]>;

    expect(actual).toEqual({
      DECISION: [...DEFAULT_TASKS.DECISION],
      IN_TRANSFER: [...DEFAULT_TASKS.IN_TRANSFER],
      FUNDED: [...DEFAULT_TASKS.FUNDED],
    });
  });

  it("appends only missing current-stage rows for active transfers", () => {
    expect(sqlOnly).toMatch(
      /JOIN stage_template template ON template\.stage = t\.stage::text/i,
    );
    expect(sqlOnly).toMatch(/WHERE t\.archived_at IS NULL/i);
    expect(sqlOnly).toMatch(
      /NOT EXISTS[\s\S]+task\.transfer_id = t\.id[\s\S]+task\.title = template\.title/i,
    );
    expect(sqlOnly).toMatch(/MAX\(task\.sort_order\)/i);
    expect(sqlOnly).toMatch(/ROW_NUMBER\(\) OVER/i);
    expect(sqlOnly).toMatch(/'repair-task-' \|\| md5/i);
    expect(sqlOnly).toMatch(/INSERT INTO app\.transfer_task/i);
    expect(sqlOnly).not.toMatch(/\bUPDATE\s+app\.transfer_task/i);
    expect(sqlOnly).not.toMatch(/\bDELETE\s+FROM\s+app\.transfer_task/i);
  });
});
