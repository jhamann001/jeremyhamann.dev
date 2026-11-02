import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(join(
  import.meta.dirname, "..", "..", "prisma", "migrations",
  "20260822120000_employee_roster", "migration.sql",
), "utf8");
const sqlOnly = SQL.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
const DATA = readFileSync(join(
  import.meta.dirname, "..", "..", "lib", "data", "employee-roster.ts",
), "utf8");
const CLIENT_READS = readFileSync(join(
  import.meta.dirname, "..", "..", "lib", "data", "clients.ts",
), "utf8");
const HOUSEHOLD_READS = readFileSync(join(
  import.meta.dirname, "..", "..", "lib", "data", "households.ts",
), "utf8");

describe("employee roster migration", () => {
  it("separates private snapshots and decisions from the minimal badge projection", () => {
    for (const table of [
      "employee_roster_upload", "employee_roster_entry",
      "employee_contact_mapping", "employee_client_status",
    ]) {
      expect(sqlOnly).toContain(`CREATE TABLE "app"."${table}"`);
      expect(sqlOnly).toMatch(new RegExp(`ALTER TABLE "app"\\."${table}" FORCE ROW LEVEL SECURITY`, "i"));
    }
    expect(sqlOnly).not.toMatch(/dependent_name|raw_workbook|workbook_blob|file_bytes/i);
  });

  it("limits private data to Admin/Ops and exposes badge rows only through mirror book scope", () => {
    expect(sqlOnly).toMatch(/employee_roster_upload_ops_read[\s\S]*'ADMIN', 'OPERATIONS'/i);
    expect(sqlOnly).toMatch(/employee_contact_mapping_ops_read[\s\S]*'ADMIN', 'OPERATIONS'/i);
    expect(sqlOnly).toMatch(/employee_client_status_book_read[\s\S]*'ADVISOR', 'CLIENT_SERVICE'[\s\S]*mirror\.client/is);
    expect(sqlOnly).not.toMatch(/employee_roster_entry[\s\S]{0,500}'ADVISOR'/i);
  });

  it("revokes inherited DML and uses command-specific least-privilege policies", () => {
    for (const table of [
      "employee_roster_upload", "employee_roster_entry",
      "employee_contact_mapping", "employee_client_status",
    ]) {
      expect(sqlOnly).toContain(`REVOKE ALL ON "app"."${table}" FROM PUBLIC, app_rw`);
    }
    expect(sqlOnly).toContain('GRANT SELECT, INSERT ON "app"."employee_roster_entry" TO app_rw');
    expect(sqlOnly).toContain('GRANT SELECT, INSERT ON "app"."employee_contact_mapping" TO app_rw');
    expect(sqlOnly).toMatch(/GRANT UPDATE \("status", "applied_by", "applied_at", "updated_at"\)[\s\S]*employee_roster_upload/i);
    expect(sqlOnly).toMatch(/GRANT UPDATE \("client_sf_id", "state", "evidence", "reviewed_by", "reviewed_at", "updated_at"\)[\s\S]*employee_contact_mapping/i);
    expect(sqlOnly).not.toMatch(/employee_(?:roster|contact|client)[\s\S]{0,120}FOR ALL TO app_rw/i);
    expect(sqlOnly).not.toMatch(/employee_roster_entry_ops_(?:update|delete)/i);
    expect(sqlOnly).not.toMatch(/employee_contact_mapping_ops_delete/i);
    expect(sqlOnly).not.toMatch(/employee_client_status_ops_update/i);
  });

  it("enforces one confirmed employee/contact pairing while preserving rejected decisions", () => {
    expect(sqlOnly).toMatch(/employee_roster_upload_one_applied[\s\S]*WHERE "status" = 'APPLIED'/i);
    expect(sqlOnly).toMatch(/one_confirmed_employee[\s\S]*WHERE "state" = 'CONFIRMED'/i);
    expect(sqlOnly).toMatch(/one_confirmed_client[\s\S]*WHERE "state" = 'CONFIRMED'/i);
    expect(sqlOnly).toMatch(/validate_employee_contact_mapping[\s\S]*identity_type = 'CONTACT'[\s\S]*source_system = 'CRM'/i);
  });

  it("keys previews by export, effective date, and parser while exposing only opaque entry ids", () => {
    expect(sqlOnly).toMatch(/UNIQUE \("file_sha256", "effective_date", "parser_version"\)/i);
    expect(sqlOnly).not.toMatch(/UNIQUE \("file_sha256"\)/i);
    expect(sqlOnly).toMatch(/employee_roster_entry_pkey" PRIMARY KEY \("id"\)/i);
    expect(sqlOnly).toMatch(/UNIQUE \("upload_id", "employee_id"\)/i);
  });

  it("locks before apply reads and revalidates CRM evidence on every badge refresh", () => {
    const apply = DATA.slice(DATA.indexOf("export async function applyEmployeeRoster"));
    const refresh = DATA.slice(
      DATA.indexOf("async function refreshEmployeeClientStatuses"),
      DATA.indexOf("export async function applyEmployeeRoster"),
    );
    expect(apply.indexOf("pg_advisory_xact_lock(hashtext('employee-roster-apply'))"))
      .toBeLessThan(apply.indexOf("employeeRosterUpload.findUnique"));
    expect(apply).toContain("pg_advisory_xact_lock(hashtext('employee-roster-apply'))::text");
    expect(refresh).toContain("pg_advisory_xact_lock(hashtext('employee-client-status-refresh'))::text");
    expect(apply).toContain("upload.effective_date < current.effective_date");
    expect(refresh).toMatch(/identity_type = 'CONTACT'[\s\S]*lifecycle_state = 'ACTIVE'/);
    expect(refresh).toMatch(/source_system = 'CRM'[\s\S]*mapping_state = 'ACTIVE'/);
  });

  it("revalidates every badge read and frees stale confirmations for reassignment", () => {
    expect(sqlOnly).toMatch(/employee_badge_is_current[\s\S]*SECURITY DEFINER/i);
    expect(sqlOnly).toMatch(/employee_badge_is_current[\s\S]*lifecycle_state = 'ACTIVE'/i);
    expect(sqlOnly).toMatch(/employee_badge_is_current[\s\S]*mapping_state = 'ACTIVE'/i);
    expect(sqlOnly).toMatch(/employee_badge_is_current[\s\S]*lead_advisor_email[\s\S]*app\.user_email/i);
    expect(sqlOnly).toMatch(/employee_client_status_book_read[\s\S]*employee_badge_is_current/i);
    expect(DATA).toMatch(/SET state = 'INVALIDATED'[\s\S]*NOT app\.employee_badge_is_current/);
    for (const reads of [CLIENT_READS, HOUSEHOLD_READS]) {
      const statusJoins = reads.match(/(?:LEFT )?JOIN app\.employee_client_status es[\s\S]{0,180}/g) ?? [];
      expect(statusJoins.length).toBeGreaterThan(0);
      expect(statusJoins.every((join) => join.includes("app.employee_badge_is_current"))).toBe(true);
    }
  });

  it("derives evidence on the server and validates controlled decisions", () => {
    expect(DATA).toContain('["CONFIRMED", "REJECTED"].includes(input.decision)');
    expect(DATA).toMatch(/normalizeName\(candidate\[0\]\.display_name\)[\s\S]*normalizeName\(entry\.display_name\)/);
    expect(DATA).not.toContain("input.evidence");
  });

  it("writes one redacted append-only audit event per stale mapping", () => {
    const invalidation = DATA.slice(
      DATA.indexOf("async function invalidateStaleEmployeeConfirmations"),
      DATA.indexOf("async function refreshEmployeeClientStatuses"),
    );
    expect(invalidation).toContain("RETURNING m.id");
    expect(invalidation).toContain("EMPLOYEE_CONTACT_INVALIDATE");
    expect(invalidation).toContain('role: "SYSTEM"');
    expect(invalidation).toContain('reason: "CRM_LINK_INACTIVE"');
    const auditPayload = invalidation.slice(invalidation.indexOf("await writeAudit"));
    expect(auditPayload).not.toMatch(/employee_id|client_sf_id|display_name/);
  });
});
