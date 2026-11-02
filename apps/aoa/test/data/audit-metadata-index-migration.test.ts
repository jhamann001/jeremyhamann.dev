import { readFileSync } from "node:fs";
import { describe,expect,it } from "vitest";
const path = "prisma/migrations/20260917233000_audit_metadata_compact_index/migration.sql";
describe("compact Audit metadata concurrent migration",()=>{
  it("uses exactly one non-transactional concurrent index statement with no payload or ID keys",()=>{
    const sql=readFileSync(path,"utf8").replace(/--[^\n]*/g,"").trim();
    expect(sql).toBe('CREATE INDEX CONCURRENTLY "row_change_table_name_op_actor_email_idx"\n  ON "audit"."row_change"("table_name", "op", "actor_email");');
    expect(sql).not.toMatch(/\b(BEGIN|SET|COMMIT|INCLUDE|IF NOT EXISTS)\b/);
    expect(readFileSync("prisma/schema.prisma","utf8")).toContain("@@index([table_name, op, actor_email])");
  });
});
