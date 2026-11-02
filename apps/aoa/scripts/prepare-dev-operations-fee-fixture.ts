/**
 * Add one fixed, zero-balance account to the existing development-only CRM
 * duplicate fixture so Operations can exercise the Fee Request workflow.
 *
 * The script cannot create arbitrary clients or accounts. It proves the exact
 * synthetic household/contact first, refuses conflicting account data, and is
 * invoked only by the manually gated dev workflow.
 */
import { PrismaClient } from "@prisma/client";

const ingestUrl = process.env.SEED_INGEST_URL;
if (!ingestUrl) throw new Error("SEED_INGEST_URL is required.");

const FIXTURE = {
  householdId: "DEV-DUP-HH-A-20260824",
  householdName: "Duplicate Review Demo Household",
  clientId: "DEV-DUP-CONTACT-A-20260824",
  firstName: "Alex",
  lastName: "Demo",
  accountId: "DEV-OPS-FEE-ACCOUNT-20260904",
  apexAccountNumber: "MWS-DZA-2744",
  accountType: "Individual",
  accountStatus: "ACTIVE",
  snapshotRunId: "dev-operations-fee-fixture",
} as const;

const ingest = new PrismaClient({ datasourceUrl: ingestUrl });

async function main(): Promise<void> {
  const prepared = await ingest.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtext('dev-operations-fee-fixture'))::text`;

    const guarded = await tx.$queryRaw<Array<{
      household_name: string;
      first_name: string;
      last_name: string;
    }>>`
      SELECT household.name AS household_name,
             client.first_name,
             client.last_name
        FROM mirror.client client
        JOIN mirror.household household
          ON household.sf_id = client.household_id
       WHERE client.sf_id = ${FIXTURE.clientId}
         AND client.household_id = ${FIXTURE.householdId}`;
    if (
      guarded.length !== 1
      || guarded[0]?.household_name !== FIXTURE.householdName
      || guarded[0]?.first_name !== FIXTURE.firstName
      || guarded[0]?.last_name !== FIXTURE.lastName
    ) {
      throw new Error("Exact synthetic fee-request fixture guard failed; no data was changed.");
    }

    const conflicts = await tx.$queryRaw<Array<{
      custodian_account_id: string;
      apex_account_number: string | null;
      client_sf_id: string | null;
      household_sf_id: string | null;
    }>>`
      SELECT custodian_account_id, apex_account_number, client_sf_id, household_sf_id
        FROM mirror.client_account_aum
       WHERE custodian_account_id = ${FIXTURE.accountId}
          OR apex_account_number = ${FIXTURE.apexAccountNumber}`;
    if (conflicts.some((row) =>
      row.custodian_account_id !== FIXTURE.accountId
      || row.apex_account_number !== FIXTURE.apexAccountNumber
      || row.client_sf_id !== FIXTURE.clientId
      || row.household_sf_id !== FIXTURE.householdId
    )) {
      throw new Error("Synthetic fee-request account identity conflict; no data was changed.");
    }

    return tx.$queryRaw<Array<{ custodian_account_id: string }>>`
      INSERT INTO mirror.client_account_aum
        (custodian_account_id, apex_account_number, client_sf_id,
         household_sf_id, account_type, is_managed, account_status,
         account_aum, account_cash, account_securities, as_of, balance_as_of,
         source_snapshot_as_of, balance_current, source_present,
         snapshot_run_id)
      VALUES
        (${FIXTURE.accountId}, ${FIXTURE.apexAccountNumber}, ${FIXTURE.clientId},
         ${FIXTURE.householdId}, ${FIXTURE.accountType}, true,
         ${FIXTURE.accountStatus}, 0, 0, 0, CURRENT_TIMESTAMP,
         CURRENT_DATE, CURRENT_DATE, false, true, ${FIXTURE.snapshotRunId})
      ON CONFLICT (custodian_account_id) DO UPDATE SET
        apex_account_number = EXCLUDED.apex_account_number,
        client_sf_id = EXCLUDED.client_sf_id,
        household_sf_id = EXCLUDED.household_sf_id,
        account_type = EXCLUDED.account_type,
        is_managed = EXCLUDED.is_managed,
        account_status = EXCLUDED.account_status,
        account_aum = EXCLUDED.account_aum,
        account_cash = EXCLUDED.account_cash,
        account_securities = EXCLUDED.account_securities,
        as_of = EXCLUDED.as_of,
        balance_as_of = EXCLUDED.balance_as_of,
        source_snapshot_as_of = EXCLUDED.source_snapshot_as_of,
        balance_current = EXCLUDED.balance_current,
        source_present = EXCLUDED.source_present,
        snapshot_run_id = EXCLUDED.snapshot_run_id,
        synced_at = now()
      RETURNING custodian_account_id`;
  }, { isolationLevel: "Serializable", timeout: 30_000 });
  if (prepared.length !== 1 || prepared[0]?.custodian_account_id !== FIXTURE.accountId) {
    throw new Error("Synthetic fee-request account was not prepared exactly once.");
  }

  console.log(JSON.stringify({
    prepared: true,
    syntheticClients: 1,
    syntheticAccounts: 1,
    accountBalance: 0,
    sourcePresent: true,
    productionTouched: false,
  }));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Fixture preparation failed.");
    process.exitCode = 1;
  })
  .finally(async () => ingest.$disconnect());
