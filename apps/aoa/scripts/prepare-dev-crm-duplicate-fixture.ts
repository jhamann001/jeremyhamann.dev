/**
 * Prepare the existing, fixed development-only CRM duplicate fixture.
 *
 * This does not create arbitrary data and cannot operate on client records. It
 * first proves that the two exact synthetic households, contacts, and CRM
 * mappings exist, then gives those two synthetic contacts one shared durable
 * identifier and invokes the normal duplicate detector. The human confirmation
 * still happens through AOA's audited review UI.
 */
import { PrismaClient } from "@prisma/client";

const appUrl = process.env.DATABASE_URL;
const ingestUrl = process.env.SEED_INGEST_URL;
const reconcilerUrl = process.env.CRM_RECONCILER_DATABASE_URL;
if (!appUrl || !ingestUrl || !reconcilerUrl) {
  throw new Error(
    "DATABASE_URL, SEED_INGEST_URL, and CRM_RECONCILER_DATABASE_URL are required.",
  );
}

const HOUSEHOLDS = [
  {
    sfId: "DEV-DUP-HH-A-20260824",
    name: "Duplicate Review Demo Household",
    advisor: "avery@example.com",
    identityId: "hld_c2af54f934f41ee290293f730",
  },
  {
    sfId: "DEV-DUP-HH-B-20260824",
    name: "Duplicate Review Demo Household",
    advisor: "avery@example.com",
    identityId: "hld_cb6dbd0ac13065bc2fe7ed34a",
  },
] as const;

const CONTACTS = [
  {
    sfId: "DEV-DUP-CONTACT-A-20260824",
    householdId: HOUSEHOLDS[0].sfId,
    firstName: "Alex",
    lastName: "Demo",
  },
  {
    sfId: "DEV-DUP-CONTACT-B-20260824",
    householdId: HOUSEHOLDS[1].sfId,
    firstName: "Adah",
    lastName: "Demo",
  },
] as const;

const SHARED_USER_ID = "DEV-DUP-SHARED-USER-20260825";
const owner = new PrismaClient({ datasourceUrl: appUrl });
const ingest = new PrismaClient({ datasourceUrl: ingestUrl });
const reconciler = new PrismaClient({ datasourceUrl: reconcilerUrl });

async function main(): Promise<void> {
  const householdRows = await ingest.$queryRaw<Array<{
    sf_id: string;
    name: string;
    lead_advisor_email: string;
  }>>`
    SELECT sf_id, name, lead_advisor_email
      FROM mirror.household
     WHERE sf_id IN (${HOUSEHOLDS[0].sfId}, ${HOUSEHOLDS[1].sfId})
     ORDER BY sf_id`;
  const expectedHouseholds = [...HOUSEHOLDS].sort((a, b) => a.sfId.localeCompare(b.sfId));
  if (householdRows.length !== 2 || householdRows.some((row, index) =>
    row.sf_id !== expectedHouseholds[index].sfId
      || row.name !== expectedHouseholds[index].name
      || row.lead_advisor_email !== expectedHouseholds[index].advisor
  )) {
    throw new Error("Exact synthetic household guard failed; no data was changed.");
  }

  const contactRows = await ingest.$queryRaw<Array<{
    sf_id: string;
    household_id: string;
    first_name: string;
    last_name: string;
  }>>`
    SELECT sf_id, household_id, first_name, last_name
      FROM mirror.client
     WHERE sf_id IN (${CONTACTS[0].sfId}, ${CONTACTS[1].sfId})
     ORDER BY sf_id`;
  const expectedContacts = [...CONTACTS].sort((a, b) => a.sfId.localeCompare(b.sfId));
  if (contactRows.length !== 2 || contactRows.some((row, index) =>
    row.sf_id !== expectedContacts[index].sfId
      || row.household_id !== expectedContacts[index].householdId
      || row.first_name !== expectedContacts[index].firstName
      || row.last_name !== expectedContacts[index].lastName
  )) {
    throw new Error("Exact synthetic contact guard failed; no data was changed.");
  }

  // DATABASE_URL is deliberately the normal app_rw credential. Establish the
  // same transaction-local Operations scope the application uses before
  // evaluating RLS; without it the safe guard sees zero rows and fails closed.
  const mappings = await owner.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('app.user_role', 'OPERATIONS', true),
             set_config('app.user_email', '', true)`;
    return tx.$queryRaw<Array<{
      source_key: string;
      identity_id: string;
    }>>`
      SELECT source_key, identity_id
        FROM app.crm_source_mapping
       WHERE source_system = 'CRM'
         AND source_namespace = 'household'
         AND mapping_state = 'ACTIVE'
         AND source_key IN (${HOUSEHOLDS[0].sfId}, ${HOUSEHOLDS[1].sfId})
       ORDER BY source_key`;
  });
  if (mappings.length !== 2 || mappings.some((row, index) =>
    row.source_key !== expectedHouseholds[index].sfId
      || row.identity_id !== expectedHouseholds[index].identityId
  )) {
    throw new Error("Exact synthetic CRM mapping guard failed; no data was changed.");
  }

  const changed = await ingest.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('dev-crm-duplicate-fixture'))::text`;
    return tx.$queryRaw<Array<{ sf_id: string }>>`
      UPDATE mirror.client
         SET cedar_ridge_user_id = ${SHARED_USER_ID}
       WHERE sf_id IN (${CONTACTS[0].sfId}, ${CONTACTS[1].sfId})
         AND household_id IN (${HOUSEHOLDS[0].sfId}, ${HOUSEHOLDS[1].sfId})
      RETURNING sf_id`;
  });
  if (changed.length !== 2) {
    throw new Error("Synthetic contact update did not affect exactly two rows.");
  }

  await reconciler.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT * FROM app.reconcile_crm_duplicate_candidates()`;
  });

  const candidates = await owner.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('app.user_role', 'OPERATIONS', true),
             set_config('app.user_email', '', true)`;
    return tx.$queryRaw<Array<{
      status: string;
      source_active: boolean;
      evidence_codes: string[];
      hard_conflict_codes: string[];
    }>>`
      SELECT status::text, source_active, evidence_codes, hard_conflict_codes
        FROM app.crm_duplicate_candidate
       WHERE entity_type = 'HOUSEHOLD'
         AND left_identity_id IN (${HOUSEHOLDS[0].identityId}, ${HOUSEHOLDS[1].identityId})
         AND right_identity_id IN (${HOUSEHOLDS[0].identityId}, ${HOUSEHOLDS[1].identityId})`;
  });
  const reviewStatus = candidates[0]?.status;
  const acceptedStatus = reviewStatus === "NEW" || reviewStatus === "READY_FOR_FOLLOW_UP";
  if (candidates.length !== 1
      || !acceptedStatus
      || !candidates[0].source_active
      || !candidates[0].evidence_codes.includes("SHARED_CEDAR_RIDGE_USER_ID")
      || candidates[0].hard_conflict_codes.length > 0) {
    throw new Error(
      "The normal detector did not produce one safe active review candidate or preserve its confirmed decision.",
    );
  }

  console.log(JSON.stringify({
    prepared: true,
    syntheticHouseholds: 2,
    syntheticContacts: 2,
    reviewStatus,
    reviewPending: reviewStatus === "NEW",
    canonicalizationActive: reviewStatus === "READY_FOR_FOLLOW_UP",
    sourceActive: candidates[0].source_active,
    durableEvidence: true,
    productionTouched: false,
  }));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Fixture preparation failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([
      owner.$disconnect(),
      ingest.$disconnect(),
      reconciler.$disconnect(),
    ]);
  });
