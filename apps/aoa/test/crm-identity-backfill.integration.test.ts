import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import { resolveCrmRouteKey } from "@/lib/crm/resolve";
import { withUserScope } from "@/lib/rls";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;

const HH = "CRM-P2-HOUSEHOLD";
const CONTACT = "CRM-P2-CONTACT";
const EMAIL = "CRM-P2-EMAIL";
const ACTIVITY = "CRM-P2-ACTIVITY";
const APPOINTMENT = "CRM-P2-APPOINTMENT";
const ORPHAN_APPOINTMENT = "CRM-P2-ORPHAN-APPOINTMENT";
const DEAL = "CRM-P2-DEAL";
const CRM_DEAL = "CRM-P2-OPPORTUNITY";
const TRANSFER = "CRM-P2-TRANSFER";
const ADVISOR_EMAIL = "crm-phase2-advisor@example.test";

function makeOwner(): PrismaClient {
  const url =
    process.env.AUDIT_TEST_CLEANUP_URL ??
    `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`;
  return new PrismaClient({ datasourceUrl: url });
}

async function cleanup(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRaw<Array<{ id: string; identity_id: string }>>`
    SELECT id, identity_id
      FROM app.crm_source_mapping
     WHERE source_key LIKE 'CRM-P2-%'`;
  const exceptionRows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT e.id
      FROM app.crm_identity_exception e
      JOIN app.crm_source_mapping m ON m.id = e.source_mapping_id
     WHERE m.source_key LIKE 'CRM-P2-%'`;
  const auditIds = [
    ...rows.flatMap((row) => [row.id, row.identity_id]),
    ...exceptionRows.map((row) => row.id),
    DEAL,
    TRANSFER,
  ];

  await db.$executeRaw`
    DELETE FROM app.crm_identity_exception
     WHERE source_mapping_id IN (
       SELECT id FROM app.crm_source_mapping WHERE source_key LIKE 'CRM-P2-%'
     )`;
  await db.$executeRaw`
    DELETE FROM app.crm_source_mapping WHERE source_key LIKE 'CRM-P2-%'`;

  const identityIds = [...new Set(rows.map((row) => row.identity_id))];
  if (identityIds.length > 0) {
    await db.$executeRaw(
      Prisma.sql`DELETE FROM app.crm_identity WHERE id IN (${Prisma.join(identityIds)})`,
    );
  }

  await db.transfer.deleteMany({ where: { id: TRANSFER } });
  await db.deal.deleteMany({ where: { id: DEAL } });
  await db.$executeRaw`DELETE FROM mirror.appointment WHERE external_key LIKE 'CRM-P2-%'`;
  await db.$executeRaw`DELETE FROM mirror.activity WHERE sf_id LIKE 'CRM-P2-%'`;
  await db.$executeRaw`DELETE FROM mirror.email WHERE sf_id LIKE 'CRM-P2-%'`;
  await db.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE 'CRM-P2-%'`;
  await db.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE 'CRM-P2-%'`;

  if (auditIds.length > 0) {
    await db.$executeRaw(
      Prisma.sql`DELETE FROM audit.row_change WHERE row_pk IN (${Prisma.join(auditIds)})`,
    );
  }
}

async function seedSourceRows(db: PrismaClient): Promise<void> {
  await db.$executeRaw`
    INSERT INTO mirror.household
      (sf_id, name, lead_advisor_email, synced_at)
    VALUES (${HH}, 'CRM Phase 2 Household', ${ADVISOR_EMAIL}, now())`;
  await db.$executeRaw`
    INSERT INTO mirror.client
      (sf_id, household_id, first_name, last_name, lead_advisor_email, synced_at)
    VALUES (${CONTACT}, ${HH}, 'CRM', 'Contact', ${ADVISOR_EMAIL}, now())`;
  await db.$executeRaw`
    INSERT INTO mirror.email
      (sf_id, household_sf_id, subject, synced_at)
    VALUES (${EMAIL}, ${HH}, 'Synthetic integration record', now())`;
  await db.$executeRaw`
    INSERT INTO mirror.activity
      (sf_id, household_sf_id, subject, synced_at)
    VALUES (${ACTIVITY}, ${HH}, 'Synthetic integration record', now())`;
  await db.$executeRaw`
    INSERT INTO mirror.appointment
      (external_key, source, client_name, client_sf_id, starts_at, synced_at)
    VALUES (
      ${APPOINTMENT}, 'crm-phase2-test', 'Synthetic integration record',
      ${CONTACT}, '2026-08-10T14:00:00Z', now()
    )`;

  await db.deal.create({
    data: {
      id: DEAL,
      source: "IMPORT",
      sf_deal_id: CRM_DEAL,
      name: "CRM Phase 2 Deal",
      client_first_name: "CRM",
      client_last_name: "Contact",
      household_name: "CRM Phase 2 Household",
      household_sf_id: HH,
      client_sf_id: CONTACT,
      amount: "1000.00",
      stage: "POTENTIAL",
      created_date: new Date("2026-08-01T00:00:00Z"),
    },
  });
  await db.transfer.create({
    data: {
      id: TRANSFER,
      source: "APP",
      client_first_name: "CRM",
      client_last_name: "Contact",
      client_sf_id: CONTACT,
      household_name: "CRM Phase 2 Household",
      household_sf_id: HH,
      value: "1000.00",
    },
  });
}

async function runBackfill(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe("SELECT app.backfill_crm_identity_snapshot()");
}

gated("CRM Phase 2A backfill and dual-key reads", () => {
  let owner: PrismaClient;

  beforeAll(() => {
    owner = makeOwner();
  });
  beforeEach(async () => {
    await cleanup(owner);
    await seedSourceRows(owner);
  });
  afterEach(() => {
    delete process.env.CRM_IDENTITY_READS;
  });
  afterAll(async () => {
    await cleanup(owner);
    await owner.$disconnect();
  });

  it("backfills every approved domain, preserves aliases, and reruns without changing IDs", async () => {
    await runBackfill(owner);
    const first = await owner.$queryRaw<
      Array<{
        source_system: string;
        source_namespace: string;
        source_key: string;
        identity_id: string;
        identity_type: string;
      }>
    >`
      SELECT m.source_system, m.source_namespace, m.source_key,
             m.identity_id, i.identity_type
        FROM app.crm_source_mapping m
        JOIN app.crm_identity i ON i.id = m.identity_id
       WHERE m.source_key LIKE 'CRM-P2-%'
       ORDER BY m.source_system, m.source_namespace, m.source_key`;

    expect(first).toHaveLength(8);
    expect(new Set(first.map((row) => row.identity_id)).size).toBe(7);
    expect(new Set(first.map((row) => row.identity_type))).toEqual(
      new Set([
        "HOUSEHOLD",
        "CONTACT",
        "DEAL",
        "TRANSFER",
        "EMAIL",
        "ACTIVITY",
        "APPOINTMENT",
      ]),
    );
    const dealAliases = first.filter((row) => row.identity_type === "DEAL");
    expect(dealAliases).toHaveLength(2);
    expect(dealAliases[0].identity_id).toBe(dealAliases[1].identity_id);

    await runBackfill(owner);
    const second = await owner.$queryRaw<
      Array<{ source_system: string; source_namespace: string; source_key: string; identity_id: string }>
    >`
      SELECT source_system, source_namespace, source_key, identity_id
        FROM app.crm_source_mapping
       WHERE source_key LIKE 'CRM-P2-%'
       ORDER BY source_system, source_namespace, source_key`;
    expect(second).toEqual(
      first.map(({ identity_type: _identityType, ...mapping }) => mapping),
    );

    const exceptions = await owner.$queryRaw<Array<{ id: string }>>`
      SELECT e.id
        FROM app.crm_identity_exception e
        JOIN app.crm_source_mapping m ON m.id = e.source_mapping_id
       WHERE m.source_key LIKE 'CRM-P2-%'`;
    expect(exceptions).toEqual([]);
  });

  it("accepts old and CRM IDs while retaining the source record's RLS scope", async () => {
    await runBackfill(owner);
    process.env.CRM_IDENTITY_READS = "1";

    const crmIds = await owner.$queryRaw<Array<{ identity_type: string; id: string }>>`
      SELECT i.identity_type, i.id
        FROM app.crm_identity i
        JOIN app.crm_source_mapping m ON m.identity_id = i.id
       WHERE (m.source_system, m.source_namespace, m.source_key) IN (
         ('CRM', 'household', ${HH}),
         ('CRM', 'contact', ${CONTACT}),
         ('AOA', 'deal', ${DEAL}),
         ('AOA', 'transfer', ${TRANSFER})
       )`;
    const byType = new Map(crmIds.map((row) => [row.identity_type, row.id]));
    const ops = { role: "OPERATIONS", email: "ops@example.test" };

    await expect(
      resolveCrmRouteKey(ops, "HOUSEHOLD", byType.get("HOUSEHOLD")!),
    ).resolves.toBe(HH);
    await expect(
      resolveCrmRouteKey(ops, "CONTACT", byType.get("CONTACT")!),
    ).resolves.toBe(CONTACT);
    await expect(
      resolveCrmRouteKey(ops, "DEAL", byType.get("DEAL")!),
    ).resolves.toBe(DEAL);
    await expect(
      resolveCrmRouteKey(ops, "TRANSFER", byType.get("TRANSFER")!),
    ).resolves.toBe(TRANSFER);
    await expect(resolveCrmRouteKey(ops, "HOUSEHOLD", HH)).resolves.toBe(HH);

    await expect(
      resolveCrmRouteKey(
        { role: "ADVISOR", email: ADVISOR_EMAIL },
        "HOUSEHOLD",
        byType.get("HOUSEHOLD")!,
      ),
    ).resolves.toBe(HH);
    await expect(
      resolveCrmRouteKey(
        { role: "ADVISOR", email: "outside-book@example.test" },
        "HOUSEHOLD",
        byType.get("HOUSEHOLD")!,
      ),
    ).resolves.toBe(byType.get("HOUSEHOLD"));
  });

  it("creates coded unresolved records and exposes them only to Operations/Admin", async () => {
    await owner.$executeRaw`
      INSERT INTO mirror.appointment
        (external_key, source, client_name, client_sf_id, starts_at, synced_at)
      VALUES (
        ${ORPHAN_APPOINTMENT}, 'crm-phase2-test', 'Synthetic orphan',
        NULL, '2026-08-11T14:00:00Z', now()
      )`;
    await runBackfill(owner);

    const opsRows = await withUserScope(
      { role: "OPERATIONS", email: "ops@example.test" },
      (tx) => tx.$queryRaw<Array<{ reason_code: string }>>`
        SELECT e.reason_code
          FROM app.crm_identity_exception e
          JOIN app.crm_source_mapping m ON m.id = e.source_mapping_id
         WHERE m.source_key = ${ORPHAN_APPOINTMENT}`,
    );
    expect(opsRows).toEqual([{ reason_code: "MISSING_PARENT_MAPPING" }]);

    const viewerRows = await withUserScope(
      { role: "VIEWER", email: "viewer@example.test" },
      (tx) => tx.$queryRaw<Array<{ reason_code: string }>>`
        SELECT e.reason_code
          FROM app.crm_identity_exception e
          JOIN app.crm_source_mapping m ON m.id = e.source_mapping_id
         WHERE m.source_key = ${ORPHAN_APPOINTMENT}`,
    );
    expect(viewerRows).toEqual([]);
  });

  it("does not let app_rw invoke the owner-only backfill function", async () => {
    await expect(
      withUserScope({ role: "OPERATIONS", email: "ops@example.test" }, (tx) =>
        tx.$executeRawUnsafe("SELECT app.backfill_crm_identity_snapshot()"),
      ),
    ).rejects.toThrow();
  });
});
