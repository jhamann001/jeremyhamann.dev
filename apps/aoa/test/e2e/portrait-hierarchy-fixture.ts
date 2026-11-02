import { PrismaClient } from "@prisma/client";
import { validateProgressiveDatabaseEnvironment } from "./progressive-fixture";
import { PORTRAIT_DEALS, setupPortraitDealsFixture } from "./portrait-deals-fixture";

const identity = "con_portraithierarchy";
const mapping = "portrait-hierarchy-contact-map";
const account = "portrait-hierarchy-synthetic-account";

/** Exact invented IDs, the existing synthetic-only database, and no live connector. */
export default async function portraitHierarchyFixture() {
  const { directUrl } = validateProgressiveDatabaseEnvironment();
  const owner = new PrismaClient({ datasourceUrl: directUrl.toString(), log: [] });
  let removeDeals: (() => Promise<void>) | undefined;
  const removeIdentity = async () => owner.$transaction(async tx => {
    await tx.$executeRaw`DELETE FROM mirror.client_account_aum WHERE custodian_account_id = ${account}`;
    await tx.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id = ${mapping}`;
    await tx.$executeRaw`DELETE FROM app.crm_identity WHERE id = ${identity}`;
    await tx.$executeRaw`DELETE FROM audit.row_change WHERE schema_name = 'app'
      AND ((table_name = 'crm_source_mapping' AND row_pk = ${mapping})
        OR (table_name = 'crm_identity' AND row_pk = ${identity}))`;
  });
  try {
    const [target] = await owner.$queryRaw<Array<{ db: string; role: string; host: string }>>`
      SELECT current_database() AS db, current_user AS role, inet_server_addr()::text AS host`;
    if (target?.db !== "aoa_pagination_synthetic" || target.role !== "aoa" ||
      !["127.0.0.1/32", "127.0.0.1", "::1/128", "::1"].includes(target.host)) {
      throw new Error("portrait_hierarchy_fixture_actual_database_mismatch");
    }
    const [collision] = await owner.$queryRaw<Array<{ count: bigint }>>`
      SELECT (
        (SELECT count(*) FROM app.crm_identity WHERE id = ${identity}
          AND (identity_type <> 'CONTACT' OR first_seen_at IS DISTINCT FROM '2026-09-23'::timestamptz)) +
        (SELECT count(*) FROM app.crm_source_mapping WHERE id = ${mapping}
          AND (identity_id <> ${identity} OR source_system <> 'CRM'
            OR source_namespace <> 'contact' OR source_key <> ${PORTRAIT_DEALS.memberA})) +
        (SELECT count(*) FROM mirror.client_account_aum WHERE custodian_account_id = ${account}
          AND (client_sf_id IS DISTINCT FROM ${PORTRAIT_DEALS.memberA} OR apex_account_number IS DISTINCT FROM 'SYN-00225'))
      ) AS count`;
    if (Number(collision?.count)) throw new Error("portrait_hierarchy_fixture_id_collision");
    await removeIdentity();
    removeDeals = await setupPortraitDealsFixture(owner);
    await owner.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO app.crm_identity (id, identity_type, first_seen_at, updated_at)
        VALUES (${identity}, 'CONTACT', '2026-09-23'::timestamptz, '2026-09-23'::timestamptz)`;
      await tx.$executeRaw`INSERT INTO app.crm_source_mapping
        (id, identity_id, source_system, source_namespace, source_key, updated_at)
        VALUES (${mapping}, ${identity}, 'CRM', 'contact', ${PORTRAIT_DEALS.memberA}, '2026-09-23'::timestamptz)`;
      await tx.$executeRaw`INSERT INTO mirror.client_account_aum
        (custodian_account_id, apex_account_number, client_sf_id, household_sf_id, account_type, account_status, account_aum, is_managed, source_present)
        VALUES (${account}, 'SYN-00225', ${PORTRAIT_DEALS.memberA}, ${PORTRAIT_DEALS.household}, 'TRADITIONAL IRA', 'OPEN', 225, true, true)`;
    });
  } catch (error) {
    if (removeDeals) {
      await removeIdentity();
      await removeDeals();
    }
    await owner.$disconnect();
    throw error;
  }
  return async () => {
    try {
      await removeIdentity();
      await removeDeals?.();
    } finally { await owner.$disconnect(); }
  };
}
