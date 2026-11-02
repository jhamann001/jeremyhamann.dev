import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";

const DATABASE_NAME = "aoa_forms_synthetic";
const DATABASE_PORT = "55439";
const OPERATIONS_EMAIL = "ops@example.com";
const OPERATIONS_ID = "forms-synthetic-operations";

/** Invented records only; no bulk seed or source-system identifiers. */
export const FORM_FIXTURE = {
  owner: { id: "FM-OWNER-ALPHA", household: "FM-HH-ALPHA", first: "Jordan", last: "Sample" },
  other: { id: "FM-OWNER-BRAVO", household: "FM-HH-BRAVO", first: "Morgan", last: "Example" },
  empty: { id: "FM-OWNER-CHARLIE", household: "FM-HH-CHARLIE", first: "Casey", last: "Noaccount" },
  firstAccount: { id: "FM-IRA-ALPHA-1", number: "SYNTH-0001", type: "TRADITIONAL IRA" },
  secondAccount: { id: "FM-IRA-ALPHA-2", number: "SYNTH-0002", type: "ROTH IRA" },
  otherAccount: { id: "FM-IRA-BRAVO-1", number: "SYNTH-0003", type: "TRADITIONAL IRA" },
  taxableAccount: { id: "FM-TAXABLE-BRAVO-1", number: "SYN-00004", type: "INDIVIDUAL BROKERAGE" },
} as const;

type Environment = Record<string, string | undefined>;

/** No credentials or URL values are included in failures. Must run BEFORE connections/spawn. */
export function validateFormsDatabaseEnvironment(env: Environment = process.env) {
  if (["K_SERVICE", "CLOUD_RUN_SERVICE", "K_REVISION", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GCP_PROJECT"]
    .some((key) => Boolean(env[key])) || (env.APP_ENV && env.APP_ENV !== "local")) {
    throw new Error("forms_fixture_requires_local_environment");
  }
  const localUrl = (raw: string | undefined, role: string) => {
    let url: URL;
    try { url = new URL(raw ?? ""); } catch { throw new Error("forms_fixture_requires_explicit_local_database"); }
    const allowedQuery = new Set(["schema", "connection_limit", "pool_timeout"]);
    if (!['postgresql:', 'postgres:'].includes(url.protocol)
      || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.port !== DATABASE_PORT || url.pathname !== `/${DATABASE_NAME}`
      || url.username !== role || url.hash
      || [...url.searchParams.keys()].some((key) => !allowedQuery.has(key))) {
      throw new Error("forms_fixture_requires_isolated_loopback_database");
    }
    return url;
  };
  const directUrl = localUrl(env.DIRECT_DATABASE_URL, "aoa");
  const ingestUrl = localUrl(env.INGEST_DATABASE_URL, "ingest_rw");
  const runtimeUrl = localUrl(env.DATABASE_URL, "app_rw");
  if (directUrl.host !== runtimeUrl.host || directUrl.host !== ingestUrl.host) {
    throw new Error("forms_fixture_database_targets_differ");
  }
  return { directUrl, ingestUrl, runtimeUrl };
}

/** Playwright also inherits process.env, so config replaces it with this allowlist. */
export function formsBrowserEnvironment(env: Environment = process.env): Record<string, string> {
  const { directUrl, ingestUrl, runtimeUrl } = validateFormsDatabaseEnvironment(env);
  const result: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL", "TERM"]) {
    if (env[key]) result[key] = env[key];
  }
  return {
    ...result,
    DATABASE_URL: runtimeUrl.toString(),
    DIRECT_DATABASE_URL: directUrl.toString(),
    INGEST_DATABASE_URL: ingestUrl.toString(),
    APP_ENV: "local", AUTH_DEV_LOGIN: "1", NODE_ENV: "production",
    AUTH_SECRET: "forms-synthetic-local-only-not-a-secret",
    AUTH_URL: "http://127.0.0.1:3103", AUTH_TRUST_HOST: "true",
    NEXT_TELEMETRY_DISABLED: "1", CI: "true",
    CRM_IDENTITY_READS: "1", CRM_RELATIONSHIPS: "1",
    GOOGLE_APPLICATION_CREDENTIALS: "/dev/null", GCE_METADATA_HOST: "127.0.0.1:9",
    CLOUDSDK_CONFIG: "/dev/null",
    TRANSFER_TRACKER_URL: "http://127.0.0.1:9", TRADE_REQUEST_API_URL: "http://127.0.0.1:9",
    STATEMENT_PIPELINE_URL: "", WAREHOUSE_URL: "http://127.0.0.1:9", WAREHOUSE_API_KEY: "",
    AI_DRAFTING: "0", AI_MEETING_PREP: "0", SLACK_TRANSFER_CLOSEOUT: "0",
  };
}

export function assertNoFormsDotenvFiles(directory: string) {
  for (const name of [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local", ".env.test", ".env.test.local"]) {
    if (existsSync(resolve(directory, name))) throw new Error("forms_fixture_refuses_dotenv_files");
  }
}

/** Only this test run's explicit keys are removed; preexisting fixture IDs fail closed. */
export default async function formsFixture() {
  const { directUrl, ingestUrl, runtimeUrl } = validateFormsDatabaseEnvironment();
  const owner = new PrismaClient({ datasourceUrl: directUrl.toString(), log: [] });
  const ingest = new PrismaClient({ datasourceUrl: ingestUrl.toString(), log: [] });
  const runtime = new PrismaClient({ datasourceUrl: runtimeUrl.toString(), log: [] });
  const people = [FORM_FIXTURE.owner, FORM_FIXTURE.other, FORM_FIXTURE.empty];
  const accountIds = [FORM_FIXTURE.firstAccount.id, FORM_FIXTURE.secondAccount.id, FORM_FIXTURE.otherAccount.id, FORM_FIXTURE.taxableAccount.id];
  let insertedMirror = false;
  let insertedUser = false;
  const cleanup = async () => {
    await owner.$transaction(async (tx) => {
      if (insertedMirror) {
        await tx.$executeRaw(Prisma.sql`DELETE FROM mirror.client_account_aum WHERE custodian_account_id IN (${Prisma.join(accountIds)})`);
        await tx.$executeRaw(Prisma.sql`DELETE FROM mirror.client WHERE sf_id IN (${Prisma.join(people.map((p) => p.id))})`);
        await tx.$executeRaw(Prisma.sql`DELETE FROM mirror.household WHERE sf_id IN (${Prisma.join(people.map((p) => p.household))})`);
      }
      if (insertedUser) await tx.user.delete({ where: { id: OPERATIONS_ID } });
    });
  };
  const disconnect = () => Promise.all([owner.$disconnect(), ingest.$disconnect(), runtime.$disconnect()]);
  try {
    for (const [client, expectedRole] of [[owner, "aoa"], [ingest, "ingest_rw"], [runtime, "app_rw"]] as const) {
      const [target] = await client.$queryRaw<Array<{ database: string; role: string }>>`SELECT current_database()::text AS database, current_user::text AS role`;
      if (target?.database !== DATABASE_NAME || target.role !== expectedRole) throw new Error("forms_fixture_actual_database_or_role_mismatch");
    }
    const [conflicts] = await owner.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT (SELECT count(*) FROM mirror.household WHERE sf_id IN (${Prisma.join(people.map((p) => p.household))}))
           + (SELECT count(*) FROM mirror.client WHERE sf_id IN (${Prisma.join(people.map((p) => p.id))}))
           + (SELECT count(*) FROM mirror.client_account_aum WHERE custodian_account_id IN (${Prisma.join(accountIds)}))
           + (SELECT count(*) FROM app."User" WHERE id = ${OPERATIONS_ID} OR email = ${OPERATIONS_EMAIL}) AS count`);
    if (Number(conflicts?.count)) throw new Error("forms_fixture_id_collision_no_rows_changed");
    await ingest.$transaction(async (tx) => {
      for (const person of people) {
        await tx.$executeRaw`INSERT INTO mirror.household (sf_id, name, status, lead_advisor_email, stage)
          VALUES (${person.household}, ${`${person.first} ${person.last} Synthetic Household`}, 'Active', 'forms-advisor@example.test', 'Client')`;
        await tx.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
          VALUES (${person.id}, ${person.household}, ${person.first}, ${person.last}, 'forms-advisor@example.test')`;
      }
      for (const [account, person, value] of [
        [FORM_FIXTURE.firstAccount, FORM_FIXTURE.owner, 2000],
        [FORM_FIXTURE.secondAccount, FORM_FIXTURE.owner, 1000],
        [FORM_FIXTURE.otherAccount, FORM_FIXTURE.other, 1500],
        [FORM_FIXTURE.taxableAccount, FORM_FIXTURE.other, 1500],
      ] as const) {
        await tx.$executeRaw`INSERT INTO mirror.client_account_aum
          (custodian_account_id, apex_account_number, client_sf_id, household_sf_id, account_type, account_status, account_aum, is_managed, source_present)
          VALUES (${account.id}, ${account.number}, ${person.id}, ${person.household}, ${account.type}, 'OPEN', ${value}, false, true)`;
      }
    });
    insertedMirror = true;
    await owner.user.create({ data: { id: OPERATIONS_ID, email: OPERATIONS_EMAIL, name: "Riley Ops", role: "OPERATIONS" } });
    insertedUser = true;
  } catch (error) {
    try { await cleanup(); } finally { await disconnect(); }
    throw error;
  }
  return async () => { try { await cleanup(); } finally { await disconnect(); } };
}
