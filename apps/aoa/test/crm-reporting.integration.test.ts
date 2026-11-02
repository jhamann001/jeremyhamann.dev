import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import { getCrmReportingDatasets } from "@/lib/data/crm-reporting";
import { parseCrmReportQuery } from "@/lib/crm/reporting-query";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;

const OPS = {
  role: "OPERATIONS",
  email: "crm-reporting-integration@example.test",
};
const HOUSEHOLD_ID = "001CUH323759842AAA";
const HOUSEHOLD_NAME = "CRM Reporting Integration Household";
const CONTACT_ONE = "003CUH323759842AAA";
const CONTACT_TWO = "003GHD182773703AAA";
const ACCOUNT_ONE = "CRM-REPORTING-AUM-1";
const ACCOUNT_TWO = "CRM-REPORTING-AUM-2";
const DEAL_ID = "CRM-REPORTING-DEAL-1";
const FUTURE_DEAL_ID = "CRM-REPORTING-DEAL-2";
const DEAL_OWNER = "CRM Reporting Integration Owner";
const OPEN_TASK_ID = "CRM-REPORTING-TASK-1";
const COMPLETED_TASK_ID = "CRM-REPORTING-TASK-2";
const ACTIVITY_ID = "CRM-REPORTING-ACTIVITY-1";
const EMAIL_ID = "CRM-REPORTING-EMAIL-1";
const TRANSFER_ID = "CRM-REPORTING-TRANSFER-1";
const TRANSFER_TASK_ID = "CRM-REPORTING-TRANSFER-TASK-1";

function ownerClient(): PrismaClient {
  const url = process.env.AUDIT_TEST_CLEANUP_URL
    ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`;
  return new PrismaClient({ datasourceUrl: url });
}

async function cleanup(db: PrismaClient): Promise<void> {
  await db.$executeRaw`
    DELETE FROM app.transfer_task WHERE id = ${TRANSFER_TASK_ID}`;
  await db.$executeRaw`
    DELETE FROM app.transfer WHERE id = ${TRANSFER_ID}`;
  await db.$executeRaw`
    DELETE FROM mirror.task WHERE sf_id IN (${OPEN_TASK_ID}, ${COMPLETED_TASK_ID})`;
  await db.$executeRaw`
    DELETE FROM mirror.activity WHERE sf_id = ${ACTIVITY_ID}`;
  await db.$executeRaw`
    DELETE FROM mirror.email WHERE sf_id = ${EMAIL_ID}`;
  await db.$executeRaw`
    DELETE FROM mirror.client_account_aum
     WHERE custodian_account_id IN (${ACCOUNT_ONE}, ${ACCOUNT_TWO})`;
  await db.$executeRaw`
    DELETE FROM mirror.client
     WHERE sf_id IN (${CONTACT_ONE}, ${CONTACT_TWO}, ${HOUSEHOLD_ID})`;
  await db.$executeRaw`
    DELETE FROM mirror.household WHERE sf_id = ${HOUSEHOLD_ID}`;
  await db.$executeRaw`
    DELETE FROM app.deal WHERE id IN (${DEAL_ID}, ${FUTURE_DEAL_ID})`;
  await db.$executeRaw`
    DO $$ BEGIN
      IF to_regclass('audit.row_change') IS NOT NULL THEN
        DELETE FROM audit.row_change
         WHERE (table_name = 'deal'
                AND row_pk IN ('CRM-REPORTING-DEAL-1', 'CRM-REPORTING-DEAL-2'))
            OR (table_name = 'transfer'
                AND row_pk = 'CRM-REPORTING-TRANSFER-1');
      END IF;
    END $$`;
}

async function seed(db: PrismaClient): Promise<void> {
  await db.$executeRaw`
    INSERT INTO mirror.household
      (sf_id, name, status, stage, lead_advisor_email, household_kind)
    VALUES
      (${HOUSEHOLD_ID}, ${HOUSEHOLD_NAME}, 'Active', 'Client', ${OPS.email}, 'CLIENT')`;
  await db.$executeRaw`
    INSERT INTO mirror.client
      (sf_id, household_id, first_name, last_name, stage, lead_advisor_email)
    VALUES
      (${CONTACT_ONE}, ${HOUSEHOLD_ID}, 'Report', 'Member One', 'Client', ${OPS.email}),
      (${CONTACT_TWO}, ${HOUSEHOLD_ID}, 'Report', 'Member Two', 'Client', ${OPS.email}),
      (${HOUSEHOLD_ID}, ${HOUSEHOLD_ID}, 'Placeholder', 'Household', 'Client', ${OPS.email})`;
  await db.$executeRaw`
    INSERT INTO mirror.client_account_aum
      (custodian_account_id, apex_account_number, client_sf_id, household_sf_id,
       account_type, is_managed, account_status, account_aum, as_of,
       balance_as_of, source_snapshot_as_of, balance_current, source_present)
    VALUES
      (${ACCOUNT_ONE}, 'RPT-AUM-1', ${CONTACT_ONE}, ${HOUSEHOLD_ID},
       'Individual', true, 'Open', 450000000000.00, '2026-08-12T12:00:00Z',
       DATE '2026-08-12', DATE '2026-08-12', true, true),
      (${ACCOUNT_TWO}, 'RPT-AUM-2', ${CONTACT_TWO}, ${HOUSEHOLD_ID},
       'Joint', true, 'Open', 450000000000.00, '2026-08-12T12:00:00Z',
       DATE '2026-08-12', DATE '2026-08-12', true, true)`;
  await db.$executeRaw`
    INSERT INTO app.deal
      (id, source, name, client_first_name, client_last_name, amount, stage,
       created_date, close_date, owner_name, updated_at)
    VALUES
      (${DEAL_ID}, 'APP', 'CRM Reporting Integration Deal', 'Report', 'Deal',
       900000000000.00, 'POTENTIAL', CURRENT_DATE - 10, CURRENT_DATE - 1,
       ${DEAL_OWNER}, now()),
      (${FUTURE_DEAL_ID}, 'APP', 'CRM Reporting Future Deal', 'Report', 'Future',
       1.00, 'POTENTIAL', CURRENT_DATE - 2, CURRENT_DATE + 7,
       ${DEAL_OWNER}, now())`;
  await db.$executeRaw`
    INSERT INTO mirror.task
      (sf_id, household_sf_id, subject, status, source_modified_at)
    VALUES
      (${OPEN_TASK_ID}, ${HOUSEHOLD_ID}, 'Open reporting task', 'Not Started',
       CURRENT_DATE - INTERVAL '2 days'),
      (${COMPLETED_TASK_ID}, ${HOUSEHOLD_ID}, 'Completed reporting task', 'Completed',
       CURRENT_DATE - INTERVAL '1 day')`;
  await db.$executeRaw`
    INSERT INTO mirror.activity
      (sf_id, household_sf_id, subject, activity_at, owner_name, source_modified_at)
    VALUES
      (${ACTIVITY_ID}, ${HOUSEHOLD_ID}, 'Reporting call',
       CURRENT_DATE - INTERVAL '20 days', ${DEAL_OWNER}, now())`;
  await db.$executeRaw`
    INSERT INTO mirror.email
      (sf_id, household_sf_id, subject, sent_at, source_modified_at)
    VALUES
      (${EMAIL_ID}, ${HOUSEHOLD_ID}, 'Reporting email',
       CURRENT_DATE - INTERVAL '5 days', now())`;
  await db.$executeRaw`
    INSERT INTO app.transfer
      (id, source, client_first_name, client_last_name, household_name,
       household_sf_id, value, stage, stage_entered_at, owner_kind, owner_name,
       funding_type, deal_id, updated_at)
    VALUES
      (${TRANSFER_ID}, 'APP', 'Report', 'Transfer', ${HOUSEHOLD_NAME},
       ${HOUSEHOLD_ID}, 1.00, 'IN_TRANSFER', CURRENT_DATE - INTERVAL '20 days',
       'OPERATIONS', ${DEAL_OWNER}, 'ACAT_FULL', ${DEAL_ID}, now())`;
  await db.$executeRaw`
    INSERT INTO app.transfer_task
      (id, transfer_id, title, sort_order, done, updated_at)
    VALUES
      (${TRANSFER_TASK_ID}, ${TRANSFER_ID}, 'Transfer accepted by contra', 0,
       false, now())`;
}

gated("CRM live reporting database seam", () => {
  let owner: PrismaClient;

  beforeAll(() => {
    owner = ownerClient();
  });
  beforeEach(async () => {
    process.env.CRM_REPORTING = "1";
    await cleanup(owner);
    await seed(owner);
  });
  afterEach(async () => {
    delete process.env.CRM_REPORTING;
    await cleanup(owner);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  it("returns real RLS-scoped household AUM and deal pipeline aggregates", async () => {
    const read = async (dataset: "household_aum" | "deal_pipeline" | "client_engagement" | "transfers_funding") => {
      const result = await getCrmReportingDatasets(OPS, parseCrmReportQuery({ dataset }));
      expect(result.ok).toBe(true);
      return result.ok ? result.datasets[0] : null;
    };
    const householdDataset = await read("household_aum");
    expect(householdDataset?.available).toBe(true);
    expect(householdDataset?.rows.find((row) => row.household === HOUSEHOLD_NAME)).toEqual({
      household: HOUSEHOLD_NAME,
      advisor: OPS.email,
      clientStage: "Client",
      aum: 900_000_000_000,
      accounts: 2,
      members: 2,
      aumAsOf: "2026-08-12",
    });

    const pipelineDataset = await read("deal_pipeline");
    expect(pipelineDataset?.available).toBe(true);
    expect(pipelineDataset?.rows.find((row) => row.owner === DEAL_OWNER)).toEqual({
      stage: "POTENTIAL",
      owner: DEAL_OWNER,
      deals: 2,
      pipelineValue: 900_000_000_001,
      averageAgeDays: 6,
      overdue: 1,
      earliestOverdueClose: expect.any(String),
      nextExpectedClose: expect.any(String),
    });

    const engagementDataset = await read("client_engagement");
    expect(engagementDataset?.available).toBe(true);
    expect(engagementDataset?.rows.find((row) => row.household === HOUSEHOLD_NAME)).toEqual({
      household: HOUSEHOLD_NAME,
      advisor: OPS.email,
      openTasks: 1,
      lastCall: expect.any(String),
      lastEmail: expect.any(String),
      lastInteraction: expect.any(String),
      daysSinceInteraction: 5,
    });

    const transfersDataset = await read("transfers_funding");
    expect(transfersDataset?.available).toBe(true);
    expect(transfersDataset?.rows.find((row) => row.owner === DEAL_OWNER)).toEqual({
      stage: "In Transfer",
      owner: DEAL_OWNER,
      fundingType: "ACAT Full",
      transfers: 1,
      transferValue: 900_000_000_000,
      averageDaysInStage: 20,
      stalled: 1,
      openChecklistItems: 1,
    });

    for (const dataset of [householdDataset, pipelineDataset, engagementDataset, transfersDataset]) {
      if (!dataset) continue;
      expect(dataset.rows.length).toBeLessThanOrEqual(dataset.pageSize);
      expect(JSON.stringify(dataset.rows)).not.toContain("001RPT");
      expect(JSON.stringify(dataset.rows)).not.toContain("RPT-AUM");
      expect(JSON.stringify(dataset.rows)).not.toContain("CRM-REPORTING-TASK");
      expect(JSON.stringify(dataset.rows)).not.toContain("Reporting call");
      expect(JSON.stringify(dataset.rows)).not.toContain("Reporting email");
      expect(JSON.stringify(dataset.rows)).not.toContain("CRM-REPORTING-TRANSFER");
      expect(JSON.stringify(dataset.rows)).not.toContain("Transfer accepted by contra");
    }
  });
});
