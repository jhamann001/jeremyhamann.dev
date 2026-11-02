import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import {
  confirmCrmParentOverride,
  searchCrmParentCandidates,
} from "@/lib/data/crm-parent-resolution";
import { withUserScope } from "@/lib/rls";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const CHILD = "apt_manualparenttest";
const FIRST_PARENT = "con_manualparentone";
const SECOND_PARENT = "hld_manualparenttwo";
const MAPPING = "c111111111111111111111111";
const CONTACT_MAPPING = "c555555555555555555555555";
const HOUSEHOLD_MAPPING = "c666666666666666666666666";
const EXCEPTION = "c222222222222222222222222";
const CONTACT_SOURCE = "003MANUALPARENTCONTACT";
const HOUSEHOLD_SOURCE = "001MANUALPARENTHOUSEHOLD";
const CONTACT_MAPPING_SOURCE = CONTACT_SOURCE.slice(0, 15);
const HOUSEHOLD_MAPPING_SOURCE = HOUSEHOLD_SOURCE.slice(0, 15);

gated("CRM manual parent resolution database lifecycle", () => {
  let su: PrismaClient;

  async function cleanup() {
    const overrides = await su.crmParentOverride.findMany({
      where: { source_mapping_id: MAPPING }, select: { id: true },
    });
    const overrideIds = overrides.map((row) => row.id);
    const queueItems = await su.reviewQueueItem.findMany({
      where: { source_record_ref: EXCEPTION }, select: { id: true },
    });
    const queueIds = queueItems.map((row) => row.id);
    if (queueIds.length > 0) {
      await su.reviewQueueEvent.deleteMany({ where: { item_id: { in: queueIds } } });
      await su.reviewQueueItem.deleteMany({ where: { id: { in: queueIds } } });
    }
    await su.crmParentOverride.deleteMany({ where: { source_mapping_id: MAPPING } });
    await su.crmIdentityException.deleteMany({ where: { id: EXCEPTION } });
    await su.crmSourceMapping.deleteMany({
      where: { id: { in: [MAPPING, CONTACT_MAPPING, HOUSEHOLD_MAPPING] } },
    });
    await su.crmIdentity.deleteMany({ where: { id: { in: [CHILD, FIRST_PARENT, SECOND_PARENT] } } });
    await su.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ${CONTACT_SOURCE}`;
    await su.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${HOUSEHOLD_SOURCE}`;
    if (overrideIds.length > 0) {
      await su.auditLog.deleteMany({
        where: { entityType: "crm_parent_override", entityId: { in: overrideIds } },
      });
      await su.$executeRaw`
        DELETE FROM audit.row_change
         WHERE table_name = 'crm_parent_override'
           AND row_pk IN (${overrideIds.join(",")})`;
    }
    await su.$executeRaw`
      DELETE FROM audit.row_change
       WHERE row_pk IN (
         ${EXCEPTION}, ${CHILD}, ${FIRST_PARENT}, ${SECOND_PARENT},
         ${MAPPING}, ${CONTACT_MAPPING}, ${HOUSEHOLD_MAPPING}
       )`;
  }

  beforeAll(async () => {
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    su = new PrismaClient({
      datasources: {
        db: { url: process.env.AUDIT_TEST_CLEANUP_URL ?? "postgresql://aoa@localhost:5432/aoa" },
      },
    });
    await cleanup();
    await su.crmIdentity.createMany({ data: [
      { id: CHILD, identity_type: "APPOINTMENT" },
      { id: FIRST_PARENT, identity_type: "CONTACT" },
      { id: SECOND_PARENT, identity_type: "HOUSEHOLD" },
    ] });
    await su.$executeRaw`
      INSERT INTO mirror.household
        (sf_id, name, status, stage, lead_advisor_email, synced_at)
      VALUES
        (${HOUSEHOLD_SOURCE}, 'Reichert-Smith Household', 'Active', 'Client',
         'ops@example.com', now())`;
    await su.$executeRaw`
      INSERT INTO mirror.client
        (sf_id, household_id, first_name, last_name, stage,
         lead_advisor_email, synced_at)
      VALUES
        (${CONTACT_SOURCE}, ${HOUSEHOLD_SOURCE}, 'Alycia', 'Reichert-Smith',
         'Client', 'ops@example.com', now())`;
    await su.crmSourceMapping.createMany({ data: [
      {
        id: MAPPING, identity_id: CHILD, source_system: "CALENDAR",
        source_namespace: "appointment", source_key: "manual-parent-test",
      },
      {
        id: CONTACT_MAPPING, identity_id: FIRST_PARENT, source_system: "CRM",
        source_namespace: "contact", source_key: CONTACT_MAPPING_SOURCE,
      },
      {
        id: HOUSEHOLD_MAPPING, identity_id: SECOND_PARENT, source_system: "CRM",
        source_namespace: "household", source_key: HOUSEHOLD_MAPPING_SOURCE,
      },
    ] });
    await su.crmIdentityException.create({ data: {
      id: EXCEPTION, source_mapping_id: MAPPING, reason_code: "MISSING_PARENT_MAPPING",
    } });
  });

  afterAll(async () => {
    await cleanup();
    await su.$disconnect();
    vi.unstubAllEnvs();
  });

  it("confirms, closes queue work, permits audited replacement, and rejects Viewer writes", async () => {
    const originalDetectedAt = new Date("2026-08-10T15:26:00.000Z");
    await su.crmIdentityException.update({
      where: { id: EXCEPTION }, data: { detected_at: originalDetectedAt },
    });
    const queue = await su.reviewQueueItem.create({ data: {
      detector_key: "1".repeat(64), subject_key: "2".repeat(64), source: "CRM_IDENTITY",
      exception_type: "CRM_MISSING_PARENT_MAPPING", source_record_ref: EXCEPTION,
      resolution_href: `/crm/${CHILD}?resolutionException=${EXCEPTION}#resolve-parent-mapping`,
      summary: "A CRM identity mapping needs review", detected_at: originalDetectedAt,
    } });

    const candidates = await searchCrmParentCandidates(
      { role: "OPERATIONS", email: "ops@example.com" }, "APPOINTMENT", "Reichert-Smith",
    );
    expect(candidates.map((candidate) => candidate.crmId).sort())
      .toEqual([FIRST_PARENT, SECOND_PARENT].sort());
    await expect(searchCrmParentCandidates(
      { role: "OPERATIONS", email: "ops@example.com" },
      "APPOINTMENT",
      "Definitely-No-Match",
    )).resolves.toEqual([]);

    await expect(confirmCrmParentOverride(
      { role: "VIEWER", email: "viewer@example.com" },
      { exceptionId: EXCEPTION, childCrmId: CHILD, parentCrmId: FIRST_PARENT },
    )).resolves.toBe("forbidden");
    await expect(confirmCrmParentOverride(
      { role: "OPERATIONS", email: "ops@example.com" },
      { exceptionId: EXCEPTION, childCrmId: CHILD, parentCrmId: FIRST_PARENT },
    )).resolves.toBe("saved");

    expect(await su.crmIdentityException.findUniqueOrThrow({ where: { id: EXCEPTION } }))
      .toMatchObject({ exception_state: "RESOLVED", resolution_code: "MANUAL_LINK" });
    expect(await su.reviewQueueItem.findUniqueOrThrow({ where: { id: queue.id } }))
      .toMatchObject({ source_active: false, status: "RESOLVED", resolved_by: "ops@example.com" });
    expect(await su.crmParentOverride.findUniqueOrThrow({ where: { source_mapping_id: MAPPING } }))
      .toMatchObject({ parent_identity_id: FIRST_PARENT, relationship_code: "APPOINTMENT_TO_CONTACT" });

    await expect(confirmCrmParentOverride(
      { role: "ADMIN", email: "admin@example.com" },
      { exceptionId: EXCEPTION, childCrmId: CHILD, parentCrmId: SECOND_PARENT },
    )).resolves.toBe("saved");
    expect(await su.crmParentOverride.findUniqueOrThrow({ where: { source_mapping_id: MAPPING } }))
      .toMatchObject({ parent_identity_id: SECOND_PARENT, relationship_code: "APPOINTMENT_TO_HOUSEHOLD", confirmed_by: "admin@example.com" });

    const viewerOverrides = await withUserScope(
      { role: "VIEWER", email: "viewer@example.com" },
      (tx) => tx.crmParentOverride.findMany({ where: { source_mapping_id: MAPPING } }),
    );
    expect(viewerOverrides).toHaveLength(0);
    const [auditCount] = await su.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM audit.row_change
       WHERE table_name = 'crm_parent_override'
         AND row_pk = (SELECT id FROM app.crm_parent_override WHERE source_mapping_id = ${MAPPING})`;
    expect(Number(auditCount?.count ?? 0n)).toBeGreaterThanOrEqual(2);
  });
});
