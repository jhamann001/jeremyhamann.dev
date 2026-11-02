import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import {
  runCrmIdentityCoverageDiagnostics,
  type CrmIdentityCoverageDiagnostics,
  type CrmIdentityCoverageRow,
} from "@/lib/crm/coverage";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const TASK = "CRM-COVERAGE-TASK";
const HOUSEHOLD = "CRM-COVERAGE-HOUSEHOLD";
const RUN_ID = "00000000-0000-4000-8000-00000000c001";

function makeOwner(): PrismaClient {
  const url = process.env.AUDIT_TEST_CLEANUP_URL
    ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`;
  return new PrismaClient({ datasourceUrl: url });
}

function taskRow(result: CrmIdentityCoverageDiagnostics): CrmIdentityCoverageRow {
  const row = result.by_source.find((item) => (
    item.identity_type === "TASK"
    && item.source_system === "CRM"
    && item.source_namespace === "task"
  ));
  if (!row) throw new Error("crm_coverage_task_row_missing");
  return row;
}

async function cleanup(db: PrismaClient): Promise<void> {
  const mappings = await db.$queryRaw<Array<{ id: string; identity_id: string }>>`
    SELECT id, identity_id
      FROM app.crm_source_mapping
     WHERE source_system = 'CRM'
       AND source_namespace = 'task'
       AND source_key = ${TASK}`;
  const mappingIds = mappings.map((row) => row.id);
  const identityIds = [...new Set(mappings.map((row) => row.identity_id))];
  const exceptions = mappingIds.length === 0
    ? []
    : await db.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT id FROM app.crm_identity_exception
         WHERE source_mapping_id IN (${Prisma.join(mappingIds)})`,
    );

  if (mappingIds.length > 0) {
    await db.$executeRaw(
      Prisma.sql`
        DELETE FROM app.crm_identity_exception
         WHERE source_mapping_id IN (${Prisma.join(mappingIds)})`,
    );
    await db.$executeRaw(
      Prisma.sql`DELETE FROM app.crm_source_mapping WHERE id IN (${Prisma.join(mappingIds)})`,
    );
  }
  if (identityIds.length > 0) {
    await db.$executeRaw(
      Prisma.sql`
        DELETE FROM app.crm_identity i
         WHERE i.id IN (${Prisma.join(identityIds)})
           AND NOT EXISTS (
             SELECT 1 FROM app.crm_source_mapping m WHERE m.identity_id = i.id
           )`,
    );
  }

  await db.$executeRaw`DELETE FROM mirror.task WHERE sf_id = ${TASK}`;
  await db.$executeRaw`
    DELETE FROM audit."AuditLog"
     WHERE "action" = 'crm.identity.reconcile' AND "entityId" = ${RUN_ID}`;

  const auditIds = [
    ...mappingIds,
    ...identityIds,
    ...exceptions.map((row) => row.id),
  ];
  if (auditIds.length > 0) {
    await db.$executeRaw(
      Prisma.sql`DELETE FROM audit.row_change WHERE row_pk IN (${Prisma.join(auditIds)})`,
    );
  }
}

gated("CRM identity coverage diagnostics", () => {
  const owner = makeOwner();

  beforeAll(async () => {
    await owner.$connect();
  });

  beforeEach(async () => {
    await cleanup(owner);
  });

  afterAll(async () => {
    await cleanup(owner);
    await owner.$disconnect();
  });

  it("tracks an arriving CRM task through assignment and later source refresh", async () => {
    const baseline = await runCrmIdentityCoverageDiagnostics();
    const baselineTask = baseline.by_source.find((row) => (
      row.identity_type === "TASK"
      && row.source_system === "CRM"
      && row.source_namespace === "task"
    ));
    const sourceBaseline = baselineTask?.source_rows ?? 0;
    const mappedBaseline = baselineTask?.mapped_sources ?? 0;
    const unmappedBaseline = baselineTask?.unmapped_sources ?? 0;
    const staleBaseline = baselineTask?.stale_mappings ?? 0;

    await owner.$executeRaw`
      INSERT INTO mirror.task
        (sf_id, household_sf_id, subject, status, priority, description, synced_at)
      VALUES
        (${TASK}, ${HOUSEHOLD}, 'Coverage test task', 'Open', 'Normal',
         'Coverage test description', now())`;

    const beforeAssignment = taskRow(await runCrmIdentityCoverageDiagnostics());
    expect(beforeAssignment).toMatchObject({
      source_rows: sourceBaseline + 1,
      mapped_sources: mappedBaseline,
      unmapped_sources: unmappedBaseline + 1,
    });

    await owner.$executeRaw`
      SELECT app.reconcile_crm_identity_snapshot(${RUN_ID}, false)`;

    const afterAssignment = taskRow(await runCrmIdentityCoverageDiagnostics());
    expect(afterAssignment).toMatchObject({
      source_rows: sourceBaseline + 1,
      mapped_sources: mappedBaseline + 1,
      unmapped_sources: unmappedBaseline,
    });
    expect(afterAssignment.open_exceptions).toBeGreaterThanOrEqual(1);

    await owner.$executeRaw`
      UPDATE mirror.task
         SET synced_at = now() + interval '1 minute'
       WHERE sf_id = ${TASK}`;

    const afterSourceRefresh = taskRow(await runCrmIdentityCoverageDiagnostics());
    expect(afterSourceRefresh.stale_mappings).toBe(staleBaseline + 1);
  });
});
