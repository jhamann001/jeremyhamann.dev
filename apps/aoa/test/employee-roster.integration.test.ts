import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import {
  applyEmployeeRoster,
  createEmployeeRosterPreview,
  decideEmployeeContactMapping,
  employeeContactCandidates,
  employeeRosterPageData,
} from "@/lib/data/employee-roster";
import { withUserScope } from "@/lib/rls";
import type { ParsedEmployeeRoster } from "@/lib/employee-roster/parser";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const EMPLOYEE_ID = "employee-roster-integration-1";
const CONTACT_ID = "con_employeerostertest";
const SOURCE_MAPPING_ID = "c777777777777777777777777";
const CLIENT_ID = "003EMPLOYEETEST000";
const HOUSEHOLD_ID = "001EMPLOYEETEST000";

gated("employee roster database lifecycle", () => {
  let su: PrismaClient;
  const uploadIds: string[] = [];

  async function cleanup() {
    await su.employeeClientStatus.deleteMany({ where: { client_sf_id: CLIENT_ID } });
    await su.employeeContactMapping.deleteMany({ where: { employee_id: EMPLOYEE_ID } });
    const staleUploads = await su.employeeRosterEntry.findMany({
      where: { employee_id: EMPLOYEE_ID }, select: { upload_id: true },
    });
    const ids = [...new Set([...uploadIds, ...staleUploads.map((row) => row.upload_id)])];
    if (ids.length > 0) {
      await su.employeeRosterEntry.deleteMany({ where: { upload_id: { in: ids } } });
      await su.employeeRosterUpload.deleteMany({ where: { id: { in: ids } } });
    }
    await su.crmSourceMapping.deleteMany({ where: { id: SOURCE_MAPPING_ID } });
    await su.crmIdentity.deleteMany({ where: { id: CONTACT_ID } });
    await su.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ${CLIENT_ID}`;
    await su.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${HOUSEHOLD_ID}`;
    await su.auditLog.deleteMany({
      where: { entityType: { in: ["employee_roster_upload", "employee_contact_mapping"] } },
    });
  }

  beforeAll(async () => {
    su = new PrismaClient({ datasources: {
      db: { url: process.env.AUDIT_TEST_CLEANUP_URL ?? "postgresql://aoa@localhost:5432/aoa" },
    } });
    await cleanup();
    await su.$executeRaw`
      INSERT INTO mirror.household
        (sf_id, name, status, stage, lead_advisor_email, synced_at)
      VALUES
        (${HOUSEHOLD_ID}, 'Synthetic Employee Household', 'Active', 'Client',
         'advisor.employee@example.com', now())`;
    await su.$executeRaw`
      INSERT INTO mirror.client
        (sf_id, household_id, first_name, last_name, stage,
         lead_advisor_email, synced_at)
      VALUES
        (${CLIENT_ID}, ${HOUSEHOLD_ID}, 'Synthetic', 'Employee', 'Client',
         'advisor.employee@example.com', now())`;
    await su.crmIdentity.create({ data: { id: CONTACT_ID, identity_type: "CONTACT" } });
    await su.crmSourceMapping.create({ data: {
      id: SOURCE_MAPPING_ID,
      identity_id: CONTACT_ID,
      source_system: "CRM",
      source_namespace: "contact",
      source_key: CLIENT_ID,
    } });
  });

  afterAll(async () => {
    await cleanup();
    await su.$disconnect();
  });

  it("keeps roster rows private while publishing a book-scoped derived badge", async () => {
    const identity = { role: "OPERATIONS", email: "ops@example.com" };
    const parsed: ParsedEmployeeRoster = {
      fileSha256: "7".repeat(64),
      rowCount: 1,
      employeeCount: 1,
      dependentRowCount: 0,
      activeCount: 1,
      formerCount: 0,
      entries: [{
        employeeId: EMPLOYEE_ID,
        displayName: "Synthetic Employee",
        sourceStatus: "Active",
        employmentState: "ACTIVE",
        startDate: "2024-01-01",
        lastDay: null,
        legalEntity: "Synthetic Legal Entity",
        dependentRowCount: 0,
      }],
    };
    const preview = await createEmployeeRosterPreview(identity, parsed, "2026-08-22");
    expect(preview.status).toBe("created");
    if (!("uploadId" in preview)) throw new Error("preview failed");
    const uploadId = preview.uploadId;
    uploadIds.push(uploadId);
    const entryId = (await su.employeeRosterEntry.findUniqueOrThrow({
      where: { upload_id_employee_id: { upload_id: uploadId, employee_id: EMPLOYEE_ID } },
      select: { id: true },
    })).id;
    const privileges = await su.$queryRaw<Array<{
      upload_delete: boolean;
      upload_update: boolean;
      upload_status_update: boolean;
      entry_update: boolean;
      entry_delete: boolean;
      mapping_delete: boolean;
      mapping_update: boolean;
      mapping_state_update: boolean;
      status_update: boolean;
    }>>`
      SELECT
        has_table_privilege('app_rw', 'app.employee_roster_upload', 'DELETE') AS upload_delete,
        has_table_privilege('app_rw', 'app.employee_roster_upload', 'UPDATE') AS upload_update,
        has_column_privilege('app_rw', 'app.employee_roster_upload', 'status', 'UPDATE') AS upload_status_update,
        has_table_privilege('app_rw', 'app.employee_roster_entry', 'UPDATE') AS entry_update,
        has_table_privilege('app_rw', 'app.employee_roster_entry', 'DELETE') AS entry_delete,
        has_table_privilege('app_rw', 'app.employee_contact_mapping', 'DELETE') AS mapping_delete,
        has_table_privilege('app_rw', 'app.employee_contact_mapping', 'UPDATE') AS mapping_update,
        has_column_privilege('app_rw', 'app.employee_contact_mapping', 'state', 'UPDATE') AS mapping_state_update,
        has_table_privilege('app_rw', 'app.employee_client_status', 'UPDATE') AS status_update`;
    expect(privileges[0]).toEqual({
      upload_delete: false,
      upload_update: false,
      upload_status_update: true,
      entry_update: false,
      entry_delete: false,
      mapping_delete: false,
      mapping_update: false,
      mapping_state_update: true,
      status_update: false,
    });

    expect(await decideEmployeeContactMapping(identity, {
      entryId,
      crmId: CONTACT_ID,
      clientSfId: CLIENT_ID,
      decision: "FORGED" as "CONFIRMED",
    })).toBe("invalid");
    expect(await decideEmployeeContactMapping(identity, {
      entryId,
      crmId: CONTACT_ID,
      clientSfId: CLIENT_ID,
      decision: "CONFIRMED",
    })).toBe("saved");
    const confirmedMapping = await su.employeeContactMapping.findFirstOrThrow({
      where: { employee_id: EMPLOYEE_ID }, select: { id: true, evidence: true },
    });
    expect(confirmedMapping.evidence).toBe("EXACT_NAME");
    expect(await applyEmployeeRoster(identity, uploadId)).toBe("applied");

    const visibleBadge = await withUserScope(
      { role: "ADVISOR", email: "advisor.employee@example.com" },
      (tx) => tx.employeeClientStatus.findMany({ where: { client_sf_id: CLIENT_ID } }),
    );
    expect(visibleBadge).toHaveLength(1);
    expect(visibleBadge[0]?.employment_state).toBe("ACTIVE");
    await expect(withUserScope(
      { role: "ADVISOR", email: "other.advisor@example.com" },
      (tx) => tx.employeeClientStatus.findMany({ where: { client_sf_id: CLIENT_ID } }),
    )).resolves.toEqual([]);
    await expect(withUserScope(
      { role: "ADVISOR", email: "advisor.employee@example.com" },
      (tx) => tx.employeeRosterEntry.findMany({ where: { employee_id: EMPLOYEE_ID } }),
    )).resolves.toEqual([]);

    const audit = await su.auditLog.findMany({
      where: { entityType: { in: ["employee_roster_upload", "employee_contact_mapping"] } },
      orderBy: { at: "asc" },
    });
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining([
      "employee_roster.preview", "employee_contact.confirm", "employee_roster.apply",
    ]));
    const auditText = audit.map((row) => row.detail ?? "").join(" ");
    expect(auditText).not.toContain(EMPLOYEE_ID);
    expect(auditText).not.toContain(CLIENT_ID);
    expect(auditText).not.toContain("Synthetic Employee");

    const duplicate = await createEmployeeRosterPreview(identity, parsed, "2026-08-22");
    expect(duplicate).toEqual({ status: "existing", uploadId });
    const next = await createEmployeeRosterPreview(identity, parsed, "2026-08-23");
    expect(next.status).toBe("created");
    if (!("uploadId" in next)) throw new Error("next preview failed");
    uploadIds.push(next.uploadId);
    const nextEntryId = (await su.employeeRosterEntry.findUniqueOrThrow({
      where: {
        upload_id_employee_id: { upload_id: next.uploadId, employee_id: EMPLOYEE_ID },
      },
      select: { id: true },
    })).id;

    await su.crmIdentity.update({
      where: { id: CONTACT_ID }, data: { lifecycle_state: "ARCHIVED" },
    });
    await expect(withUserScope(
      { role: "ADVISOR", email: "advisor.employee@example.com" },
      (tx) => tx.employeeClientStatus.findMany({ where: { client_sf_id: CLIENT_ID } }),
    )).resolves.toEqual([]);
    expect(await su.employeeClientStatus.count({ where: { client_sf_id: CLIENT_ID } })).toBe(1);
    expect(await applyEmployeeRoster(identity, next.uploadId)).toBe("applied");
    expect(await su.employeeContactMapping.findFirst({
      where: { employee_id: EMPLOYEE_ID }, select: { state: true },
    })).toEqual({ state: "INVALIDATED" });
    expect(await su.auditLog.findFirst({
      where: {
        action: "employee_contact.invalidate",
        entityType: "employee_contact_mapping",
        entityId: confirmedMapping.id,
      },
      select: { actorEmail: true, actorRole: true, detail: true },
    })).toEqual({
      actorEmail: null,
      actorRole: "SYSTEM",
      detail: JSON.stringify({ reason: "CRM_LINK_INACTIVE" }),
    });
    expect(await su.employeeClientStatus.count({ where: { client_sf_id: CLIENT_ID } })).toBe(0);
    const pageWithStaleConfirmation = await employeeRosterPageData(identity, next.uploadId);
    expect(pageWithStaleConfirmation?.rows[0]?.confirmedClientName).toBeNull();

    const older = await createEmployeeRosterPreview(identity, parsed, "2026-08-21");
    expect(older.status).toBe("created");
    if (!("uploadId" in older)) throw new Error("older preview failed");
    uploadIds.push(older.uploadId);
    expect(await applyEmployeeRoster(identity, older.uploadId)).toBe("older_snapshot");
    expect(await su.employeeRosterUpload.findUniqueOrThrow({
      where: { id: older.uploadId }, select: { status: true },
    })).toEqual({ status: "DRAFT" });

    await su.crmIdentity.update({
      where: { id: CONTACT_ID }, data: { lifecycle_state: "ACTIVE" },
    });

    expect(await decideEmployeeContactMapping(identity, {
      entryId: nextEntryId,
      crmId: CONTACT_ID,
      clientSfId: CLIENT_ID,
      decision: "REJECTED",
    })).toBe("saved");
    expect(await su.employeeContactMapping.findFirst({
      where: { employee_id: EMPLOYEE_ID }, select: { state: true },
    })).toEqual({ state: "REJECTED" });
    expect(await su.employeeClientStatus.count({ where: { client_sf_id: CLIENT_ID } })).toBe(0);

    const rejectedSearch = await employeeContactCandidates(
      identity, nextEntryId, "Synthetic Employee",
    );
    expect(rejectedSearch.candidates).toEqual([]);
    expect(rejectedSearch.previousRejections).toHaveLength(1);
    expect(await decideEmployeeContactMapping(identity, {
      entryId: nextEntryId,
      crmId: CONTACT_ID,
      clientSfId: CLIENT_ID,
      decision: "CONFIRMED",
    })).toBe("saved");
    expect(await su.employeeClientStatus.count({ where: { client_sf_id: CLIENT_ID } })).toBe(1);

    await su.crmSourceMapping.update({
      where: { id: SOURCE_MAPPING_ID },
      data: { mapping_state: "SUPERSEDED", superseded_at: new Date() },
    });
    await expect(withUserScope(
      { role: "ADVISOR", email: "advisor.employee@example.com" },
      (tx) => tx.employeeClientStatus.findMany({ where: { client_sf_id: CLIENT_ID } }),
    )).resolves.toEqual([]);
    expect(await su.employeeClientStatus.count({ where: { client_sf_id: CLIENT_ID } })).toBe(1);

    const third = await createEmployeeRosterPreview(identity, parsed, "2026-08-24");
    expect(third.status).toBe("created");
    if (!("uploadId" in third)) throw new Error("third preview failed");
    uploadIds.push(third.uploadId);
    expect(await applyEmployeeRoster(identity, third.uploadId)).toBe("applied");
    expect(await su.employeeContactMapping.findFirst({
      where: { employee_id: EMPLOYEE_ID }, select: { state: true },
    })).toEqual({ state: "INVALIDATED" });
    expect(await su.auditLog.count({
      where: {
        action: "employee_contact.invalidate",
        entityType: "employee_contact_mapping",
        entityId: confirmedMapping.id,
      },
    })).toBe(2);
    expect(await su.employeeClientStatus.count({ where: { client_sf_id: CLIENT_ID } })).toBe(0);

    await su.crmSourceMapping.update({
      where: { id: SOURCE_MAPPING_ID },
      data: { mapping_state: "ACTIVE", superseded_at: null },
    });
    await su.$executeRaw`
      UPDATE mirror.client SET first_name = 'Different', last_name = 'Person'
       WHERE sf_id = ${CLIENT_ID}`;
    const thirdEntryId = (await su.employeeRosterEntry.findUniqueOrThrow({
      where: {
        upload_id_employee_id: { upload_id: third.uploadId, employee_id: EMPLOYEE_ID },
      },
      select: { id: true },
    })).id;
    expect(await decideEmployeeContactMapping(identity, {
      entryId: thirdEntryId,
      crmId: CONTACT_ID,
      clientSfId: CLIENT_ID,
      decision: "CONFIRMED",
    })).toBe("saved");
    expect(await su.employeeContactMapping.findFirst({
      where: { employee_id: EMPLOYEE_ID }, select: { evidence: true },
    })).toEqual({ evidence: "MANUAL_SEARCH" });
  });
});
