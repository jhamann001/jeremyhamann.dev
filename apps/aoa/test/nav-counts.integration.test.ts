import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { navCounts } from "@/lib/data/nav-counts";
import type { Identity } from "@/lib/rls";

// nav-counts.ts guards with `import "server-only"` (it feeds a server component);
// that package throws outside a bundler, so stub it — the seam otherwise runs
// unchanged against the real DB below (the transfer-asset-map unit-test idiom).
vi.mock("server-only", () => ({}));

// DB-gated seam test for the left-nav badge counts (nav-counts.ts). Like the
// board fall-off suite, the counts are SQL aggregates over an RLS-scoped
// Postgres, so the only faithful test drives the real query. Gate + sudo/seed
// pattern are identical to test/transfer-board-falloff.integration.test.ts.
//
// Counts are firm-wide count(*)s, so pre-existing rows would make absolute
// assertions brittle — we assert the DELTA (after − before) each seeded fixture
// contributes. Namespaced ids (NAV-COUNT-*) keep teardown exact.
const RUN = process.env.INGEST_DATABASE_URL ? describe : describe.skip;

function makeSudoClient(): PrismaClient {
  const url =
    process.env.INGEST_TEST_CLEANUP_URL ??
    `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`;
  return new PrismaClient({ datasources: { db: { url } } });
}

// OPERATIONS sees the whole firm (household_ops_all / client_ops_all), so every
// seeded row is visible regardless of lead_advisor_email.
const OPS: Identity = { role: "OPERATIONS", email: "ops@example.com" };

const HH = {
  c1: "NAV-COUNT-HH-C1", // Client
  c2: "NAV-COUNT-HH-C2", // Client
  prospect: "NAV-COUNT-HH-P", // Prospect
  lost: "NAV-COUNT-HH-LC", // Lost Client
  nullStage: "NAV-COUNT-HH-NULL", // null stage (like the synthetic firm household)
} as const;
const CRM_IDENTITY = "dea_navcountcrm";
const CRM_MAPPING = "c333333333333333333333333";
const CRM_EXCEPTION = "c444444444444444444444444";

async function seed(sudo: PrismaClient) {
  await teardown(sudo);

  // Households: 2 Client, 1 Prospect, 1 Lost Client, 1 null-stage → Δ = +2.
  await sudo.$executeRaw`
    INSERT INTO mirror.household (sf_id, name, status, stage, lead_advisor_email) VALUES
      (${HH.c1}, 'Nav C1', 'Active', 'Client', 'a@x.com'),
      (${HH.c2}, 'Nav C2', 'Active', 'client', 'a@x.com'),        -- casing folded
      (${HH.prospect}, 'Nav P', 'Active', 'Prospect', 'a@x.com'),
      (${HH.lost}, 'Nav LC', 'Active', 'Lost Client', 'a@x.com'),
      (${HH.nullStage}, 'Nav Null', 'Active', NULL, 'a@x.com')`;

  // Clients → Δ = +2 (only non-placeholder Client-stage rows count):
  //   2 real Client contacts (sf_id <> household_id)          → count
  //   1 placeholder Client (sf_id = household_id)             → excluded
  //   1 Prospect, 1 Lost Client                               → excluded
  await sudo.$executeRaw`
    INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, stage, lead_advisor_email) VALUES
      ('NAV-COUNT-C-R1', ${HH.c1}, 'Real', 'One', 'Client', 'a@x.com'),
      ('NAV-COUNT-C-R2', ${HH.c2}, 'Real', 'Two', 'Client', 'a@x.com'),
      (${HH.c1}, ${HH.c1}, 'Placeholder', 'Row', 'Client', 'a@x.com'),  -- sf_id = household_id → excluded
      ('NAV-COUNT-C-P', ${HH.c1}, 'Pros', 'Pect', 'Prospect', 'a@x.com'),
      ('NAV-COUNT-C-LC', ${HH.c1}, 'Lost', 'Client', 'Lost Client', 'a@x.com')`;

  // Deals: 1 OPEN (COMMITTED) + 2 WON → ΔopenDeals = +1. The second WON
  // deal carries a synthetic external id and backs the derived transfer below.
  await sudo.$executeRaw`
    INSERT INTO app.deal (id, source, name, client_first_name, client_last_name, amount, stage, created_date, updated_at, sf_deal_id) VALUES
      ('NAV-COUNT-D-OPEN', 'APP', 'Nav Open', 'Nav', 'Open', 1000, 'COMMITTED', '2026-07-01', now(), NULL),
      ('NAV-COUNT-D-WON', 'APP', 'Nav Won', 'Nav', 'Won', 1000, 'WON', '2026-07-01', now(), NULL),
      ('NAV-COUNT-D-DEMO', 'APP', 'Nav Demo', 'Nav', 'Demo', 1000, 'WON', '2026-07-01', now(), 'DEMO-NAV-COUNT')`;

  // CRM Explorer badge: one active exception requiring Operations resolution.
  await sudo.$executeRaw`
    INSERT INTO app.crm_identity (id, identity_type, updated_at)
    VALUES (${CRM_IDENTITY}, 'DEAL', now())`;
  await sudo.$executeRaw`
    INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, updated_at)
    VALUES (${CRM_MAPPING}, ${CRM_IDENTITY}, 'AOA', 'deal', 'NAV-COUNT-D-OPEN', now())`;
  await sudo.$executeRaw`
    INSERT INTO app.crm_identity_exception
      (id, source_mapping_id, reason_code, updated_at)
    VALUES (${CRM_EXCEPTION}, ${CRM_MAPPING}, 'MISSING_PARENT_MAPPING', now())`;

  // Transfers: DECISION + IN_TRANSFER count; FUNDED + archived-DECISION do not.
  // Both the DEMO-T-* row and a normal-keyed row derived from a DEMO-* deal
  // count by default but are excluded when canonical dev hides demo cards.
  await sudo.$executeRaw`
    INSERT INTO app.transfer (id, source, value, updated_at, client_first_name, client_last_name, stage, owner_kind, archived_at, deal_id, deal_sf_id) VALUES
      ('NAV-COUNT-T-DEC', 'APP', 1, now(), 'Nav', 'Dec', 'DECISION', 'OPERATIONS', NULL, NULL, NULL),
      ('NAV-COUNT-T-INT', 'APP', 1, now(), 'Nav', 'Int', 'IN_TRANSFER', 'OPERATIONS', NULL, NULL, NULL),
      ('NAV-COUNT-T-FUND', 'APP', 1, now(), 'Nav', 'Fund', 'FUNDED', 'OPERATIONS', NULL, NULL, NULL),
      ('NAV-COUNT-T-ARCH', 'APP', 1, now(), 'Nav', 'Arch', 'DECISION', 'OPERATIONS', now(), NULL, NULL),
      ('NAV-COUNT-T-DEMO-DEAL', 'APP', 1, now(), 'Demo', 'Derived', 'DECISION', 'OPERATIONS', NULL, 'NAV-COUNT-D-DEMO', NULL),
      ('DEMO-T-NAV-COUNT', 'APP', 1, now(), 'Demo', 'Hidden', 'DECISION', 'OPERATIONS', NULL, NULL, NULL)`;
}

async function teardown(sudo: PrismaClient) {
  await sudo.$executeRaw`DELETE FROM app.crm_identity_exception WHERE id = ${CRM_EXCEPTION}`;
  await sudo.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id = ${CRM_MAPPING}`;
  await sudo.$executeRaw`DELETE FROM app.crm_identity WHERE id = ${CRM_IDENTITY}`;
  await sudo.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE 'NAV-COUNT-%'`;
  await sudo.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE 'NAV-COUNT-%'`;
  await sudo.$executeRaw`DELETE FROM app.deal WHERE id LIKE 'NAV-COUNT-%'`;
  await sudo.$executeRaw`DELETE FROM app.transfer WHERE id LIKE 'NAV-COUNT-%'`;
  await sudo.$executeRaw`DELETE FROM app.transfer WHERE id = 'DEMO-T-NAV-COUNT'`;
  await sudo.$executeRaw`
    DO $$ BEGIN
      IF to_regclass('audit.row_change') IS NOT NULL THEN
        DELETE FROM audit.row_change
        WHERE (
          table_name IN ('transfer', 'deal')
          AND (row_pk LIKE 'NAV-COUNT-%' OR row_pk = 'DEMO-T-NAV-COUNT')
        );
      END IF;
    END $$`;
  await sudo.$executeRaw`
    DELETE FROM audit.row_change
     WHERE row_pk IN (${CRM_IDENTITY}, ${CRM_MAPPING}, ${CRM_EXCEPTION})`;
}

RUN("navCounts — left-nav badges", () => {
  let sudo: PrismaClient;
  let before: Awaited<ReturnType<typeof navCounts>>;
  let after: Awaited<ReturnType<typeof navCounts>>;
  let beforeHidden: Awaited<ReturnType<typeof navCounts>>;
  let afterHidden: Awaited<ReturnType<typeof navCounts>>;
  let savedHideDemoTransfers: string | undefined;

  beforeAll(async () => {
    savedHideDemoTransfers = process.env.HIDE_DEMO_TRANSFER_CARDS;
    delete process.env.HIDE_DEMO_TRANSFER_CARDS;
    sudo = makeSudoClient();
    before = await navCounts(OPS);
    process.env.HIDE_DEMO_TRANSFER_CARDS = "1";
    beforeHidden = await navCounts(OPS);
    delete process.env.HIDE_DEMO_TRANSFER_CARDS;
    await seed(sudo);
    after = await navCounts(OPS);
    process.env.HIDE_DEMO_TRANSFER_CARDS = "1";
    afterHidden = await navCounts(OPS);
    delete process.env.HIDE_DEMO_TRANSFER_CARDS;
  });

  afterAll(async () => {
    await teardown(sudo);
    await sudo.$disconnect();
    await prisma.$disconnect();
    if (savedHideDemoTransfers === undefined) {
      delete process.env.HIDE_DEMO_TRANSFER_CARDS;
    } else {
      process.env.HIDE_DEMO_TRANSFER_CARDS = savedHideDemoTransfers;
    }
  });

  it("households badge counts only client-stage households (+2 of 5 seeded), casing-folded", () => {
    expect(after.households - before.households).toBe(2);
  });

  it("client portrait badge counts only client-stage clients, excluding placeholder rows (+2 of 5 seeded)", () => {
    expect(after.clients - before.clients).toBe(2);
  });

  it("deals badge counts only OPEN deals (+1 of 3 seeded — WON excluded)", () => {
    expect(after.openDeals - before.openDeals).toBe(1);
  });

  it("asset transfer badge counts DECISION + IN_TRANSFER, not FUNDED or archived (+4 of 6 seeded with demos visible)", () => {
    expect(after.activeTransfers - before.activeTransfers).toBe(4);
  });

  it("asset transfer badge excludes direct and demo-deal-derived cards when canonical dev hides them", () => {
    expect(afterHidden.activeTransfers - beforeHidden.activeTransfers).toBe(2);
  });

  it("CRM Explorer badge counts open identity work requiring resolution", () => {
    expect(after.crmOpenExceptions - before.crmOpenExceptions).toBe(1);
  });
});
