import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260806210000_crm_crm_task_identity/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM task CRM identity migration", () => {
  it("registers only the mirrored CRM task coordinate and household key", () => {
    expect(sqlOnly).toMatch(
      /GRANT SELECT\s*\(sf_id, household_sf_id, synced_at\)\s*ON mirror\.task TO identity_reconciler/i,
    );
    expect(sqlOnly).toMatch(
      /SELECT 'TASK', 'CRM', 'task', t\.sf_id, t\.household_sf_id, true\s*FROM mirror\.task t/i,
    );
    expect(sqlOnly).toMatch(/WHEN 'TASK' THEN 'tsk'/i);
    expect(sqlOnly).not.toMatch(/app\.transfer_task/i);
  });

  it("keeps task content outside the reconciler grant", () => {
    const grant = sqlOnly.match(
      /GRANT SELECT\s*\(([^)]+)\)\s*ON mirror\.task TO identity_reconciler/i,
    )?.[1] ?? "";
    expect(grant).toBe("sf_id, household_sf_id, synced_at");
    expect(grant).not.toMatch(/subject|status|priority|description/i);
  });

  it("allows Operations and Admin to follow only visible task parent references", () => {
    expect(sqlOnly).toMatch(/CREATE POLICY crm_source_mapping_crm_task_app_read/i);
    expect(sqlOnly).toMatch(/t\.sf_id = source_key/i);
    expect(sqlOnly).toMatch(/CREATE POLICY crm_source_mapping_task_parent_reference_app_read/i);
    expect(sqlOnly).toMatch(/IN \('ADMIN', 'OPERATIONS'\)/i);
    expect(sqlOnly).toMatch(/t\.household_sf_id = source_key/i);
  });
});
