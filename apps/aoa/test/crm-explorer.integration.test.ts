import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import {
  getCrmIdentityDetail,
  listCrmIdentities,
} from "@/lib/data/crm-explorer";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;

const HH = "CRM-P2B-HOUSEHOLD";
const HH_15 = HH.slice(0, 15);
const CONTACT = "CRM-P2B-CONTACT";
const EMAIL = "CRM-P2B-EMAIL";
const ACTIVITY = "CRM-P2B-ACTIVITY";
const TASK = "CRM-P2B-TASK";
const APPOINTMENT = "CRM-P2B-APPOINTMENT";
const ORPHAN = "CRM-P2B-ORPHAN";
const DEAL = "CRM-P2B-DEAL";
const CRM_DEAL = "CRM-P2B-OPPORTUNITY";
const TRANSFER = "CRM-P2B-TRANSFER";
const ADVISOR_EMAIL = "crm-phase2b-advisor@example.test";
const OPS = { role: "OPERATIONS", email: "crm-phase2b-ops@example.test" };

function makeOwner(): PrismaClient {
  const url = process.env.AUDIT_TEST_CLEANUP_URL
    ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`;
  return new PrismaClient({ datasourceUrl: url });
}

async function cleanup(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRaw<Array<{ id: string; identity_id: string }>>`
    SELECT id, identity_id FROM app.crm_source_mapping WHERE source_key LIKE 'CRM-P2B-%'`;
  const exceptionRows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT e.id
      FROM app.crm_identity_exception e
      JOIN app.crm_source_mapping m ON m.id = e.source_mapping_id
     WHERE m.source_key LIKE 'CRM-P2B-%'`;
  const auditIds = [
    ...rows.flatMap((row) => [row.id, row.identity_id]),
    ...exceptionRows.map((row) => row.id),
    DEAL,
    TRANSFER,
  ];

  await db.$executeRaw`
    DELETE FROM app.crm_identity_exception
     WHERE source_mapping_id IN (
       SELECT id FROM app.crm_source_mapping WHERE source_key LIKE 'CRM-P2B-%'
     )`;
  await db.$executeRaw`DELETE FROM app.crm_source_mapping WHERE source_key LIKE 'CRM-P2B-%'`;
  const identityIds = [...new Set(rows.map((row) => row.identity_id))];
  if (identityIds.length > 0) {
    await db.$executeRaw(
      Prisma.sql`DELETE FROM app.crm_identity WHERE id IN (${Prisma.join(identityIds)})`,
    );
  }

  await db.transfer.deleteMany({ where: { id: TRANSFER } });
  await db.deal.deleteMany({ where: { id: DEAL } });
  await db.$executeRaw`DELETE FROM mirror.appointment WHERE external_key LIKE 'CRM-P2B-%'`;
  await db.$executeRaw`DELETE FROM mirror.activity WHERE sf_id LIKE 'CRM-P2B-%'`;
  await db.$executeRaw`DELETE FROM mirror.task WHERE sf_id LIKE 'CRM-P2B-%'`;
  await db.$executeRaw`DELETE FROM mirror.email WHERE sf_id LIKE 'CRM-P2B-%'`;
  await db.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE 'CRM-P2B-%'`;
  await db.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE 'CRM-P2B-%'`;
  await db.$executeRaw`
    DELETE FROM audit."AuditLog"
     WHERE "action" = 'crm.identity.reconcile'
       AND "entityId" = '00000000-0000-4000-8000-0000000002b2'`;
  if (auditIds.length > 0) {
    await db.$executeRaw(
      Prisma.sql`DELETE FROM audit.row_change WHERE row_pk IN (${Prisma.join(auditIds)})`,
    );
  }
}

async function seed(db: PrismaClient): Promise<void> {
  await db.$executeRaw`
    INSERT INTO mirror.household (sf_id, name, lead_advisor_email, synced_at)
    VALUES (${HH}, 'CRM Phase 2B Household', ${ADVISOR_EMAIL}, now())`;
  await db.$executeRaw`
    INSERT INTO mirror.client
      (sf_id, household_id, first_name, last_name, lead_advisor_email, synced_at)
    VALUES (${CONTACT}, ${HH}, 'CRM', 'Explorer', ${ADVISOR_EMAIL}, now())`;
  await db.$executeRaw`
    INSERT INTO mirror.email (sf_id, household_sf_id, subject, synced_at)
    VALUES (${EMAIL}, ${HH_15}, 'Explorer email', now())`;
  await db.$executeRaw`
    INSERT INTO mirror.activity (sf_id, household_sf_id, subject, synced_at)
    VALUES (${ACTIVITY}, ${HH_15}, 'Explorer activity', now())`;
  await db.$executeRaw`
    INSERT INTO mirror.task (sf_id, household_sf_id, subject, synced_at)
    VALUES (${TASK}, ${HH_15}, 'Explorer task', now())`;
  await db.$executeRaw`
    INSERT INTO mirror.appointment
      (external_key, source, client_name, client_sf_id, meeting_type, starts_at, synced_at)
    VALUES (${APPOINTMENT}, 'crm-phase2b-test', 'CRM Explorer', ${CONTACT},
            'Annual Review', '2026-08-12T14:00:00Z', now())`;
  await db.$executeRaw`
    INSERT INTO mirror.appointment
      (external_key, source, client_name, client_sf_id, meeting_type, starts_at, synced_at)
    VALUES (${ORPHAN}, 'crm-phase2b-test', 'Unresolved', NULL,
            'Review', '2026-08-13T14:00:00Z', now())`;

  await db.deal.create({
    data: {
      id: DEAL,
      source: "IMPORT",
      sf_deal_id: CRM_DEAL,
      name: "CRM Phase 2B Deal",
      client_first_name: "CRM",
      client_last_name: "Explorer",
      household_name: "CRM Phase 2B Household",
      household_sf_id: HH_15,
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
      client_last_name: "Explorer",
      client_sf_id: CONTACT,
      household_name: "CRM Phase 2B Household",
      household_sf_id: HH_15,
      deal_id: DEAL,
      value: "1000.00",
    },
  });
  await db.$executeRawUnsafe("SELECT app.backfill_crm_identity_snapshot()");
  await db.$executeRawUnsafe(
    "SELECT app.reconcile_crm_identity_snapshot('00000000-0000-4000-8000-0000000002b2', false)",
  );
}

gated("CRM Phase 2B explorer", () => {
  let owner: PrismaClient;

  beforeAll(() => {
    owner = makeOwner();
  });
  beforeEach(async () => {
    process.env.CRM_IDENTITY_READS = "1";
    await cleanup(owner);
    await seed(owner);
  });
  afterEach(() => {
    delete process.env.CRM_IDENTITY_READS;
  });
  afterAll(async () => {
    await cleanup(owner);
    await owner.$disconnect();
  });

  it("lists every populated type, preserves the deal aliases, and searches by source ID", async () => {
    const result = await listCrmIdentities(OPS, { q: "CRM-P2B-" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.total).toBe(9);
    expect(new Set(result.rows.map((row) => row.identityType))).toEqual(
      new Set([
        "HOUSEHOLD", "CONTACT", "DEAL", "TRANSFER", "TASK", "EMAIL", "ACTIVITY",
        "APPOINTMENT",
      ]),
    );
    const deal = result.rows.find((row) => row.identityType === "DEAL");
    expect(deal?.mappings.map((mapping) => mapping.sourceKey).sort()).toEqual(
      [DEAL, CRM_DEAL].sort(),
    );
    expect(deal?.mappings.find((mapping) => mapping.sourceSystem === "AOA")?.href).toBe(`/deals/${DEAL}`);

    const email = result.rows.find((row) => row.identityType === "EMAIL");
    expect(email?.mappings[0].href).toBe(`/households/${HH}`);

    const task = result.rows.find((row) => row.identityType === "TASK");
    expect(task?.mappings[0]).toMatchObject({
      displayName: "Explorer task",
      href: `/households/${HH}`,
    });

    const exact = await listCrmIdentities(OPS, { q: CONTACT });
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.total).toBe(1);
      expect(exact.rows[0].identityType).toBe("CONTACT");
      expect(exact.rows[0].mappings[0]).toMatchObject({
        displayName: "CRM Explorer",
        href: `/client-portrait/${CONTACT}`,
      });
    }
  });

  it("shows exact household, contact, deal, transfer, task, email, activity, and appointment connections", async () => {
    const list = await listCrmIdentities(OPS, { q: HH });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const householdId = list.rows[0].id;

    const result = await getCrmIdentityDetail(OPS, householdId);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.detail) return;

    expect(result.detail.identityType).toBe("HOUSEHOLD");
    expect(result.detail.connectionTotal).toBe(7);
    expect(result.detail.connections.map((connection) => connection.relationship).sort()).toEqual([
      "Household activity",
      "Household appointment",
      "Household deal",
      "Household email",
      "Household member",
      "Household task",
      "Household transfer",
    ].sort());
    expect(result.detail.connections.every((connection) => connection.identityId.includes("_"))).toBe(true);

    const expectedRelationships = new Map<string, string[]>([
      [CONTACT, ["Contact appointment", "Contact deal", "Contact transfer", "Member of household"]],
      [DEAL, ["For contact", "For household", "Related transfer"]],
      [TRANSFER, ["Created from deal", "For contact", "For household"]],
      [EMAIL, ["For household"]],
      [ACTIVITY, ["For household"]],
      [TASK, ["For household"]],
      [APPOINTMENT, ["For contact", "For household"]],
    ]);

    for (const [sourceKey, relationships] of expectedRelationships) {
      const identityList = await listCrmIdentities(OPS, { q: sourceKey });
      expect(identityList.ok).toBe(true);
      if (!identityList.ok) return;
      const identityRow = identityList.rows.find((candidate) =>
        candidate.mappings.some((mapping) => mapping.sourceKey === sourceKey));
      expect(identityRow).toBeDefined();
      if (!identityRow) return;

      const identityDetail = await getCrmIdentityDetail(OPS, identityRow.id);
      expect(identityDetail.ok).toBe(true);
      if (!identityDetail.ok || !identityDetail.detail) return;
      expect(identityDetail.detail.connections
        .map((connection) => connection.relationship)
        .sort()).toEqual([...relationships].sort());
    }
  // This exercises eight identity types serially against PostgreSQL. Keep the
  // test allowance separate from the 15-second per-request transaction bound.
  }, 45_000);

  it("surfaces coded unresolved records and rejects every non-operations role before querying", async () => {
    const exceptions = await listCrmIdentities(OPS, { exceptionsOnly: true, q: ORPHAN });
    expect(exceptions.ok).toBe(true);
    if (!exceptions.ok) return;
    expect(exceptions.total).toBe(1);
    expect(exceptions.rows[0].openExceptionCount).toBe(1);

    const detail = await getCrmIdentityDetail(OPS, exceptions.rows[0].id);
    expect(detail.ok).toBe(true);
    if (detail.ok && detail.detail) {
      expect(detail.detail.exceptions).toEqual([
        expect.objectContaining({ reasonCode: "MISSING_PARENT_MAPPING", state: "OPEN" }),
      ]);
      expect(detail.detail.connections).toEqual([]);
    }

    for (const role of ["ADVISOR", "CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY"]) {
      await expect(listCrmIdentities({ role, email: ADVISOR_EMAIL })).resolves.toEqual({
        ok: false,
        reason: "forbidden",
      });
    }
  });

  it("stays completely dark when the identity-read flag is off", async () => {
    delete process.env.CRM_IDENTITY_READS;
    await expect(listCrmIdentities(OPS)).resolves.toEqual({ ok: false, reason: "disabled" });
    await expect(getCrmIdentityDetail(OPS, "hld_anything")).resolves.toEqual({
      ok: false,
      reason: "disabled",
    });
  });
});
