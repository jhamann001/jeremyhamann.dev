import { Prisma, type PrismaClient } from "@prisma/client";

export const PORTRAIT_DEALS = {
  household: "001MSWHPH640009AAA",
  memberA: "003MSWHPH640009AAA",
  memberB: "003JVHRSD640621AAA",
  first: "portrait-table-open",
  future: "portrait-table-future",
  missing: "portrait-table-missing",
  funded: "portrait-table-funded",
  lost: "portrait-table-lost",
  sibling: "portrait-table-sibling",
  siblingFunded: "portrait-table-sibling-funded",
  archived: "portrait-table-archived",
} as const;

const f = PORTRAIT_DEALS;
const memberIds = [f.memberA, f.memberB];
const rows = [
  [f.first, f.memberA, "POTENTIAL", 1000, "2020-01-01"],
  [f.future, f.memberA, "FUNDING", 2000, "2099-12-01"],
  [f.missing, f.memberA, "COMMITTED", 3000, null],
  [f.funded, f.memberA, "WON", 4000, "2020-02-01"],
  [f.lost, f.memberA, "LOST", 9000, "2020-03-01"],
  [f.sibling, f.memberB, "POTENTIAL", 7000, "2020-01-02"],
  [f.siblingFunded, f.memberB, "WON", 8000, "2020-02-02"],
  [f.archived, f.memberA, "POTENTIAL", 100000, "2019-01-01"],
] as const;
const dealIds = rows.map(([id]) => id);

/** Only invented exact IDs in the existing isolated browser-test database. */
export async function setupPortraitDealsFixture(owner: PrismaClient): Promise<() => Promise<void>> {
  const [target] = await owner.$queryRaw<Array<{ db: string; role: string; host: string }>>`
    SELECT current_database() AS db, current_user AS role, inet_server_addr()::text AS host`;
  if (target?.db !== "aoa_pagination_synthetic" || target.role !== "aoa" ||
    !["127.0.0.1/32", "127.0.0.1", "::1/128", "::1"].includes(target.host) ||
    process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || ["prod", "dev"].includes(process.env.APP_ENV ?? "")) {
    throw new Error("portrait_deals_fixture_requires_isolated_loopback_database");
  }
  const [collision] = await owner.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT (
      (SELECT count(*) FROM mirror.household WHERE sf_id = ${f.household}
        AND name IS DISTINCT FROM 'Portrait Table Fixture Household') +
      (SELECT count(*) FROM mirror.client WHERE sf_id IN (${Prisma.join(memberIds)})
        AND (household_id IS DISTINCT FROM ${f.household} OR first_name IS DISTINCT FROM 'Portrait Table Fixture')) +
      (SELECT count(*) FROM app.deal WHERE id IN (${Prisma.join(dealIds)})
        AND (name IS DISTINCT FROM 'Portrait Table Fixture ' || id OR household_sf_id IS DISTINCT FROM ${f.household}))
    ) AS count`);
  if (Number(collision?.count)) throw new Error("portrait_deals_fixture_id_collision");

  const cleanup = async () => {
    await owner.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`DELETE FROM app.deal WHERE id IN (${Prisma.join(dealIds)})`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM audit.row_change WHERE schema_name = 'app'
        AND table_name = 'deal' AND row_pk IN (${Prisma.join(dealIds)})`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM mirror.client WHERE sf_id IN (${Prisma.join(memberIds)})`);
      await tx.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${f.household}`;
    });
  };
  await cleanup();
  try {
    await owner.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
        VALUES (${f.household}, 'Portrait Table Fixture Household', 'Client', 'avery@example.com')`;
      await tx.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
        VALUES (${f.memberA}, ${f.household}, 'Portrait Table Fixture', 'Member A', 'avery@example.com'),
          (${f.memberB}, ${f.household}, 'Portrait Table Fixture', 'Member B', 'avery@example.com')`;
      for (const [id, client, stage, amount, close] of rows) {
        await tx.deal.create({ data: {
          id, source: "APP", name: `Portrait Table Fixture ${id}`,
          client_first_name: "Portrait Table Fixture", client_last_name: client === f.memberA ? "Member A" : "Member B",
          client_sf_id: client, household_name: "Portrait Table Fixture Household", household_sf_id: f.household,
          amount, stage, created_date: new Date("2026-01-01T00:00:00Z"),
          close_date: close ? new Date(`${close}T00:00:00Z`) : null, statements: false,
          account_type: id === f.missing ? null : "Synthetic IRA",
          transferring_firm: id === f.missing ? null : "Invented Custodian",
          ...(id === f.archived ? {
            archived_at: new Date("2026-01-02T00:00:00Z"), archived_by: "synthetic@example.invalid",
            archived_reason: "Synthetic archived fixture",
          } : {}),
        } });
      }
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return cleanup;
}
