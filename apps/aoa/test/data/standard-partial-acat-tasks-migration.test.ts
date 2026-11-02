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
    "20260909184500_standard_partial_acat_tasks",
    "migration.sql",
  ),
  "utf8",
);

describe("standard partial-ACAT task migration", () => {
  it("allows transfer-owned tasks with a stable idempotency key", () => {
    expect(SQL).toMatch(/ADD COLUMN "source_key" VARCHAR\(191\)/);
    expect(SQL).toMatch(/ALTER COLUMN "decision_id" DROP NOT NULL/);
    expect(SQL).toMatch(/UNIQUE INDEX "decision_task_source_key_key"/);
    expect(SQL).toMatch(/decision_id" IS NOT NULL OR "transfer_id" IS NOT NULL/);
  });

  it("backfills the three owned execution tasks without a decision link", () => {
    expect(SQL).toMatch(/prepare-wet-signature-paperwork/);
    expect(SQL).toMatch(/review-submit-partial-acat/);
    expect(SQL).toMatch(/track-partial-acat/);
    expect(SQL).toMatch(/NULL,\s*c\.transfer_id,\s*s\.task_key/s);
    expect(SQL).toMatch(/ON CONFLICT \("source_key"\) DO NOTHING/);
  });

  it("retires legacy automatic blockers while preserving their audit history", () => {
    expect(SQL).toMatch(/resolution_code = 'STANDARD_PARTIAL_ACAT'/);
    expect(SQL).toMatch(/blocks_transfer = false/);
    expect(SQL).toMatch(/known_route_not_decision/);
    expect(SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
