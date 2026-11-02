import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import {
  EMPLOYEE_CONTACT_CONFIRM,
  EMPLOYEE_CONTACT_INVALIDATE,
  EMPLOYEE_CONTACT_REJECT,
  EMPLOYEE_ROSTER_APPLY,
  EMPLOYEE_ROSTER_PREVIEW,
  writeAudit,
} from "@/lib/audit";
import type { ParsedEmployeeRoster } from "@/lib/employee-roster/parser";
import { EMPLOYEE_ROSTER_PARSER_VERSION } from "@/lib/employee-roster/parser";
import {
  evaluateEmployeeRosterReminder,
  type EmployeeRosterReminder,
} from "@/lib/data/employee-roster-reminder";

const MANAGE_ROLES = new Set(["ADMIN", "OPERATIONS"]);
const isOpaqueUploadId = (input: string): boolean => /^c[a-z0-9]{24,30}$/.test(input);
const isOpaqueEntryId = (input: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);

export function canManageEmployeeRoster(role: string | null | undefined): boolean {
  return MANAGE_ROLES.has(role ?? "");
}

export type EmployeeRosterUploadSummary = {
  id: string;
  effectiveDate: string;
  status: "DRAFT" | "APPLIED" | "SUPERSEDED";
  rowCount: number;
  employeeCount: number;
  dependentRowCount: number;
  activeCount: number;
  formerCount: number;
  uploadedAt: string;
  appliedAt: string | null;
};

export type EmployeeRosterReviewRow = {
  entryId: string;
  displayName: string;
  sourceStatus: string;
  employmentState: "ACTIVE" | "FORMER";
  startDate: string | null;
  lastDay: string | null;
  legalEntity: string | null;
  dependentRowCount: number;
  confirmedClientName: string | null;
  rejectedCount: number;
};

export type EmployeeContactCandidate = {
  crmId: string;
  clientSfId: string;
  displayName: string;
  householdName: string | null;
  exactName: boolean;
  decision: "CONFIRMED" | "REJECTED" | null;
};

export type EmployeeContactSearchResult = {
  candidates: EmployeeContactCandidate[];
  previousRejections: EmployeeContactCandidate[];
};

export type EmployeeRosterPageData = {
  uploads: EmployeeRosterUploadSummary[];
  selectedUpload: EmployeeRosterUploadSummary | null;
  rows: EmployeeRosterReviewRow[];
};

export async function employeeRosterReminder(
  identity: Identity,
  now = new Date(),
): Promise<EmployeeRosterReminder | null> {
  if (!canManageEmployeeRoster(identity.role)) return null;
  return withUserScope(identity, async (tx) => {
    // PostgreSQL must cancel the query itself; an interactive-transaction
    // deadline alone can leave an in-flight statement occupying the pool.
    await tx.$executeRaw`SELECT
      set_config('statement_timeout', '1500', true),
      set_config('lock_timeout', '500', true)`;
    const active = await tx.employeeRosterUpload.findFirst({
      where: { status: "APPLIED" },
      select: { effective_date: true },
    });
    return evaluateEmployeeRosterReminder({
      activeEffectiveDate: active ? isoDate(active.effective_date) : null,
      now,
    });
  }, { timeout: 2_500, maxWait: 1_000 });
}

const isoDate = (value: Date): string => value.toISOString().slice(0, 10);

type UploadWithDates = {
  id: string;
  effective_date: Date;
  status: "DRAFT" | "APPLIED" | "SUPERSEDED";
  row_count: number;
  employee_count: number;
  dependent_row_count: number;
  active_count: number;
  former_count: number;
  created_at: Date;
  applied_at: Date | null;
};

function uploadSummary(row: UploadWithDates): EmployeeRosterUploadSummary {
  return {
    id: row.id,
    effectiveDate: isoDate(row.effective_date),
    status: row.status,
    rowCount: row.row_count,
    employeeCount: row.employee_count,
    dependentRowCount: row.dependent_row_count,
    activeCount: row.active_count,
    formerCount: row.former_count,
    uploadedAt: row.created_at.toISOString(),
    appliedAt: row.applied_at?.toISOString() ?? null,
  };
}

export async function employeeRosterPageData(
  identity: Identity,
  selectedUploadId?: string,
): Promise<EmployeeRosterPageData | null> {
  if (!canManageEmployeeRoster(identity.role)) return null;
  return withUserScope(identity, async (tx) => {
    const uploads = await tx.employeeRosterUpload.findMany({
      orderBy: { created_at: "desc" },
      take: 12,
      select: {
        id: true, effective_date: true, status: true, row_count: true,
        employee_count: true, dependent_row_count: true, active_count: true,
        former_count: true, created_at: true, applied_at: true,
      },
    });
    const selected = selectedUploadId
      ? uploads.find((upload) => upload.id === selectedUploadId)
        ?? await tx.employeeRosterUpload.findUnique({
          where: { id: selectedUploadId },
          select: {
            id: true, effective_date: true, status: true, row_count: true,
            employee_count: true, dependent_row_count: true, active_count: true,
            former_count: true, created_at: true, applied_at: true,
          },
        })
      : uploads.find((upload) => upload.status === "DRAFT")
        ?? uploads.find((upload) => upload.status === "APPLIED")
        ?? null;
    if (!selected) {
      return { uploads: uploads.map(uploadSummary), selectedUpload: null, rows: [] };
    }

    const entries = await tx.employeeRosterEntry.findMany({
      where: { upload_id: selected.id },
      orderBy: [{ display_name: "asc" }, { employee_id: "asc" }],
    });
    const employeeIds = entries.map((entry) => entry.employee_id);
    const mappings = employeeIds.length === 0
      ? []
      : await tx.employeeContactMapping.findMany({
        where: { employee_id: { in: employeeIds } },
        select: {
          employee_id: true, client_sf_id: true, contact_identity_id: true, state: true,
        },
      });
    const validConfirmed = employeeIds.length === 0 ? [] : await tx.$queryRaw<Array<{
      employee_id: string; client_sf_id: string;
    }>>(Prisma.sql`
      SELECT DISTINCT m.employee_id, c.sf_id AS client_sf_id
        FROM app.employee_contact_mapping m
        JOIN app.crm_identity i
          ON i.id = m.contact_identity_id
         AND i.identity_type = 'CONTACT' AND i.lifecycle_state = 'ACTIVE'
        JOIN app.crm_source_mapping sm
          ON sm.identity_id = i.id
         AND sm.source_system = 'CRM' AND sm.source_namespace = 'contact'
         AND sm.mapping_state = 'ACTIVE'
         AND left(sm.source_key, 15) = left(m.client_sf_id, 15)
        JOIN mirror.client c ON left(c.sf_id, 15) = left(m.client_sf_id, 15)
       WHERE m.state = 'CONFIRMED'
         AND m.employee_id IN (${Prisma.join(employeeIds)})`);
    const confirmedClientIds = validConfirmed.map((mapping) => mapping.client_sf_id);
    const clientNames = confirmedClientIds.length === 0
      ? []
      : await tx.$queryRaw<Array<{ sf_id: string; display_name: string }>>(Prisma.sql`
        SELECT c.sf_id,
               trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS display_name
          FROM mirror.client c
         WHERE c.sf_id IN (${Prisma.join(confirmedClientIds)})`);
    const nameByClient = new Map(clientNames.map((client) => [client.sf_id, client.display_name]));
    const mappingsByEmployee = new Map<string, typeof mappings>();
    for (const mapping of mappings) {
      const list = mappingsByEmployee.get(mapping.employee_id) ?? [];
      list.push(mapping);
      mappingsByEmployee.set(mapping.employee_id, list);
    }
    const validConfirmedByEmployee = new Map(
      validConfirmed.map((mapping) => [mapping.employee_id, mapping]),
    );

    return {
      uploads: uploads.map(uploadSummary),
      selectedUpload: uploadSummary(selected),
      rows: entries.map((entry) => {
        const decisions = mappingsByEmployee.get(entry.employee_id) ?? [];
        const confirmed = validConfirmedByEmployee.get(entry.employee_id);
        return {
          entryId: entry.id,
          displayName: entry.display_name,
          sourceStatus: entry.source_status,
          employmentState: entry.employment_state,
          startDate: entry.start_date ? isoDate(entry.start_date) : null,
          lastDay: entry.last_day ? isoDate(entry.last_day) : null,
          legalEntity: entry.legal_entity,
          dependentRowCount: entry.dependent_row_count,
          confirmedClientName: confirmed
            ? nameByClient.get(confirmed.client_sf_id) ?? "Confirmed contact"
            : null,
          rejectedCount: decisions.filter((decision) => decision.state === "REJECTED").length,
        };
      }),
    };
  });
}

function normalizeName(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export async function employeeContactCandidates(
  identity: Identity,
  entryId: string,
  query: string,
): Promise<EmployeeContactSearchResult> {
  if (!canManageEmployeeRoster(identity.role)) return { candidates: [], previousRejections: [] };
  const q = query.trim().replace(/[%_]/g, "");
  if (q.length < 2 || q.length > 120 || !isOpaqueEntryId(entryId)) {
    return { candidates: [], previousRejections: [] };
  }
  return withUserScope(identity, async (tx) => {
    const entry = await tx.employeeRosterEntry.findUnique({
      where: { id: entryId }, select: { employee_id: true, display_name: true },
    });
    if (!entry) return { candidates: [], previousRejections: [] };
    const rows = await tx.$queryRaw<Array<{
      crm_id: string;
      client_sf_id: string;
      display_name: string;
      household_name: string | null;
    }>>(Prisma.sql`
      SELECT DISTINCT ON (i.id)
             i.id AS crm_id,
             c.sf_id AS client_sf_id,
             trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS display_name,
             h.name AS household_name
        FROM mirror.client c
        JOIN app.crm_source_mapping m
          ON m.source_system = 'CRM'
         AND m.source_namespace = 'contact'
         AND m.mapping_state = 'ACTIVE'
         AND left(m.source_key, 15) = left(c.sf_id, 15)
        JOIN app.crm_identity i
          ON i.id = m.identity_id
         AND i.identity_type = 'CONTACT'
         AND i.lifecycle_state = 'ACTIVE'
        LEFT JOIN mirror.household h ON h.sf_id = c.household_id
       WHERE trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) ILIKE ${`%${q}%`}
       ORDER BY i.id, display_name
       LIMIT 25`);
    const decisions = rows.length === 0 ? [] : await tx.employeeContactMapping.findMany({
      where: {
        employee_id: entry.employee_id,
        contact_identity_id: { in: rows.map((row) => row.crm_id) },
      },
      select: { contact_identity_id: true, state: true },
    });
    const decisionByCrm = new Map(decisions.map((decision) => [
      decision.contact_identity_id,
      decision.state === "INVALIDATED" ? null : decision.state,
    ]));
    const employeeName = normalizeName(entry.display_name);
    const mapped = rows.map((row) => ({
      crmId: row.crm_id,
      clientSfId: row.client_sf_id,
      displayName: row.display_name,
      householdName: row.household_name,
      exactName: normalizeName(row.display_name) === employeeName,
      decision: decisionByCrm.get(row.crm_id) ?? null,
    }));
    return {
      candidates: mapped.filter((candidate) => candidate.decision !== "REJECTED"),
      previousRejections: mapped.filter((candidate) => candidate.decision === "REJECTED"),
    };
  });
}

export type CreateEmployeeRosterPreviewResult =
  | { status: "created" | "existing"; uploadId: string }
  | { status: "forbidden" | "invalid" };

export async function createEmployeeRosterPreview(
  identity: Identity,
  parsed: ParsedEmployeeRoster,
  effectiveDate: string,
): Promise<CreateEmployeeRosterPreviewResult> {
  if (!canManageEmployeeRoster(identity.role) || !identity.email) return { status: "forbidden" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || parsed.employeeCount === 0) {
    return { status: "invalid" };
  }
  const effective = new Date(`${effectiveDate}T00:00:00.000Z`);
  if (Number.isNaN(effective.valueOf())
      || effective.toISOString().slice(0, 10) !== effectiveDate) {
    return { status: "invalid" };
  }

  try {
    return await withUserScope(identity, async (tx) => {
      const existing = await tx.employeeRosterUpload.findUnique({
        where: { file_sha256_effective_date_parser_version: {
          file_sha256: parsed.fileSha256,
          effective_date: effective,
          parser_version: EMPLOYEE_ROSTER_PARSER_VERSION,
        } },
        select: { id: true },
      });
      if (existing) return { status: "existing", uploadId: existing.id } as const;
      const upload = await tx.employeeRosterUpload.create({ data: {
        file_sha256: parsed.fileSha256,
        effective_date: effective,
        parser_version: EMPLOYEE_ROSTER_PARSER_VERSION,
        row_count: parsed.rowCount,
        employee_count: parsed.employeeCount,
        dependent_row_count: parsed.dependentRowCount,
        active_count: parsed.activeCount,
        former_count: parsed.formerCount,
        validation_error_count: 0,
        uploaded_by: identity.email!,
        entries: { createMany: { data: parsed.entries.map((entry) => ({
          id: randomUUID(),
          employee_id: entry.employeeId,
          display_name: entry.displayName,
          source_status: entry.sourceStatus,
          employment_state: entry.employmentState,
          start_date: entry.startDate ? new Date(`${entry.startDate}T00:00:00.000Z`) : null,
          last_day: entry.lastDay ? new Date(`${entry.lastDay}T00:00:00.000Z`) : null,
          legal_entity: entry.legalEntity,
          dependent_row_count: entry.dependentRowCount,
        })) } },
      }, select: { id: true } });
      await writeAudit(tx, identity, {
        action: EMPLOYEE_ROSTER_PREVIEW,
        entityType: "employee_roster_upload",
        entityId: upload.id,
        detail: {
          rows: parsed.rowCount,
          employees: parsed.employeeCount,
          dependentRows: parsed.dependentRowCount,
          active: parsed.activeCount,
          former: parsed.formerCount,
          validationErrors: 0,
        },
      });
      return { status: "created", uploadId: upload.id } as const;
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    const existing = await withUserScope(identity, (tx) => tx.employeeRosterUpload.findUnique({
      where: { file_sha256_effective_date_parser_version: {
        file_sha256: parsed.fileSha256,
        effective_date: effective,
        parser_version: EMPLOYEE_ROSTER_PARSER_VERSION,
      } },
      select: { id: true },
    }));
    return existing
      ? { status: "existing", uploadId: existing.id }
      : { status: "invalid" };
  }
}

async function invalidateStaleEmployeeConfirmations(
  tx: Prisma.TransactionClient,
): Promise<number> {
  const invalidated = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE app.employee_contact_mapping m
       SET state = 'INVALIDATED', updated_at = now()
     WHERE m.state = 'CONFIRMED'
       AND NOT app.employee_badge_is_current(m.client_sf_id)
     RETURNING m.id`;
  for (const mapping of invalidated) {
    await writeAudit(tx, { role: "SYSTEM", email: null }, {
      action: EMPLOYEE_CONTACT_INVALIDATE,
      entityType: "employee_contact_mapping",
      entityId: mapping.id,
      detail: { reason: "CRM_LINK_INACTIVE" },
    });
  }
  return invalidated.length;
}

async function refreshEmployeeClientStatuses(
  tx: Prisma.TransactionClient,
): Promise<{ badges: number; invalidated: number }> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtext('employee-client-status-refresh'))::text AS lock_status`;
  const invalidated = await invalidateStaleEmployeeConfirmations(tx);
  await tx.employeeClientStatus.deleteMany();
  const badges = await tx.$executeRaw`
    INSERT INTO app.employee_client_status
      (client_sf_id, employment_state, effective_date, source_upload_id, updated_at)
    SELECT DISTINCT m.client_sf_id, e.employment_state, u.effective_date, u.id, now()
      FROM app.employee_roster_upload u
      JOIN app.employee_roster_entry e ON e.upload_id = u.id
      JOIN app.employee_contact_mapping m
        ON m.employee_id = e.employee_id AND m.state = 'CONFIRMED'
      JOIN app.crm_identity i
        ON i.id = m.contact_identity_id
       AND i.identity_type = 'CONTACT' AND i.lifecycle_state = 'ACTIVE'
      JOIN app.crm_source_mapping sm
        ON sm.identity_id = i.id
       AND sm.source_system = 'CRM' AND sm.source_namespace = 'contact'
       AND sm.mapping_state = 'ACTIVE'
       AND left(sm.source_key, 15) = left(m.client_sf_id, 15)
      JOIN mirror.client c ON left(c.sf_id, 15) = left(m.client_sf_id, 15)
     WHERE u.status = 'APPLIED'`;
  return { badges, invalidated };
}

export async function applyEmployeeRoster(
  identity: Identity,
  uploadId: string,
): Promise<"applied" | "forbidden" | "invalid" | "conflict" | "older_snapshot"> {
  if (!canManageEmployeeRoster(identity.role) || !identity.email) return "forbidden";
  if (!isOpaqueUploadId(uploadId)) return "invalid";
  try {
    return await withUserScope(identity, async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext('employee-roster-apply'))::text AS lock_status`;
      const upload = await tx.employeeRosterUpload.findUnique({ where: { id: uploadId } });
      if (!upload || upload.status !== "DRAFT" || upload.validation_error_count !== 0) {
        return "invalid" as const;
      }
      const current = await tx.employeeRosterUpload.findFirst({
        where: { status: "APPLIED" }, select: { effective_date: true },
      });
      if (current && upload.effective_date < current.effective_date) {
        return "older_snapshot" as const;
      }
      await tx.employeeRosterUpload.updateMany({
        where: { status: "APPLIED" }, data: { status: "SUPERSEDED" },
      });
      await tx.employeeRosterUpload.update({
        where: { id: upload.id },
        data: { status: "APPLIED", applied_by: identity.email!, applied_at: new Date() },
      });
      const refresh = await refreshEmployeeClientStatuses(tx);
      await writeAudit(tx, identity, {
        action: EMPLOYEE_ROSTER_APPLY,
        entityType: "employee_roster_upload",
        entityId: upload.id,
        detail: {
          employees: upload.employee_count,
          active: upload.active_count,
          former: upload.former_count,
          derivedBadges: refresh.badges,
          invalidatedConfirmations: refresh.invalidated,
        },
      });
      return "applied" as const;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return "conflict";
    }
    return "invalid";
  }
}

export async function decideEmployeeContactMapping(
  identity: Identity,
  input: {
    entryId: string;
    crmId: string;
    clientSfId: string;
    decision: "CONFIRMED" | "REJECTED";
  },
): Promise<"saved" | "forbidden" | "invalid" | "conflict"> {
  if (!canManageEmployeeRoster(identity.role) || !identity.email) return "forbidden";
  if (!isOpaqueEntryId(input.entryId)
      || !/^[A-Za-z0-9_-]{5,128}$/.test(input.crmId)
      || !input.clientSfId || input.clientSfId.length > 64
      || !["CONFIRMED", "REJECTED"].includes(input.decision)) return "invalid";
  try {
    return await withUserScope(identity, async (tx) => {
      const entry = await tx.employeeRosterEntry.findUnique({
        where: { id: input.entryId }, select: { employee_id: true, display_name: true },
      });
      if (!entry) return "invalid" as const;
      const candidate = await tx.$queryRaw<Array<{
        crm_id: string; client_sf_id: string; display_name: string;
      }>>(Prisma.sql`
        SELECT i.id AS crm_id, c.sf_id AS client_sf_id,
               trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS display_name
          FROM app.crm_identity i
          JOIN app.crm_source_mapping m ON m.identity_id = i.id
          JOIN mirror.client c ON left(c.sf_id, 15) = left(m.source_key, 15)
         WHERE i.id = ${input.crmId}
           AND i.identity_type = 'CONTACT' AND i.lifecycle_state = 'ACTIVE'
           AND m.source_system = 'CRM' AND m.source_namespace = 'contact'
           AND m.mapping_state = 'ACTIVE'
           AND left(c.sf_id, 15) = left(${input.clientSfId}, 15)
         LIMIT 1`);
      if (!candidate[0]) return "invalid" as const;
      const evidence = normalizeName(candidate[0].display_name) === normalizeName(entry.display_name)
        ? "EXACT_NAME" : "MANUAL_SEARCH";
      if (input.decision === "CONFIRMED") {
        const occupied = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT m.id
            FROM app.employee_contact_mapping m
           WHERE left(m.client_sf_id, 15) = left(${candidate[0].client_sf_id}, 15)
             AND m.state = 'CONFIRMED'
             AND m.employee_id <> ${entry.employee_id}
             AND app.employee_badge_is_current(m.client_sf_id)
           LIMIT 1`);
        if (occupied[0]) return "conflict" as const;
      }

      const invalidatedBeforeDecision = await invalidateStaleEmployeeConfirmations(tx);
      const current = await tx.employeeContactMapping.findFirst({
        where: { employee_id: entry.employee_id, state: "CONFIRMED" },
        select: { id: true, contact_identity_id: true },
      });
      const replacing = input.decision === "CONFIRMED"
        && current != null && current.contact_identity_id !== input.crmId;
      if (replacing) {
        await tx.employeeContactMapping.update({
          where: { id: current!.id },
          data: {
            state: "REJECTED", reviewed_by: identity.email!, reviewed_at: new Date(),
          },
        });
      }
      const mapping = await tx.employeeContactMapping.upsert({
        where: { employee_id_contact_identity_id: {
          employee_id: entry.employee_id, contact_identity_id: input.crmId,
        } },
        create: {
          employee_id: entry.employee_id,
          contact_identity_id: input.crmId,
          client_sf_id: candidate[0].client_sf_id,
          state: input.decision,
          evidence,
          reviewed_by: identity.email!,
        },
        update: {
          client_sf_id: candidate[0].client_sf_id,
          state: input.decision,
          evidence,
          reviewed_by: identity.email!,
          reviewed_at: new Date(),
        },
        select: { id: true },
      });
      const refresh = await refreshEmployeeClientStatuses(tx);
      await writeAudit(tx, identity, {
        action: input.decision === "CONFIRMED"
          ? EMPLOYEE_CONTACT_CONFIRM : EMPLOYEE_CONTACT_REJECT,
        entityType: "employee_contact_mapping",
        entityId: mapping.id,
        detail: {
          decisions: 1,
          replaced: replacing,
          derivedBadges: refresh.badges,
          invalidatedConfirmations: invalidatedBeforeDecision + refresh.invalidated,
        },
      });
      return "saved" as const;
    });
  } catch {
    return "invalid";
  }
}
