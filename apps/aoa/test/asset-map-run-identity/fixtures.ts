import { readFileSync } from "node:fs";
import { Prisma, PrismaClient } from "@prisma/client";
import { describe } from "vitest";

// Synthetic fixture builder and dedicated-database harness for ticket.
//
// Every id here is invented. The required suite runs only when
// ASSET_MAP_RUN_IDENTITY_INTEGRATION=1; once requested it fails setup (never
// skips) when the dedicated synthetic database or its roles are missing.
//
// Roles (all against ONE dedicated loopback database named aoa_*_synthetic):
//   DIRECT_DATABASE_URL     non-superuser, non-BYPASSRLS migration owner
//   INGEST_DATABASE_URL     ingest_rw — the only runtime writer
//   DATABASE_URL            app_rw — must be denied everywhere new
//   INGEST_TEST_CLEANUP_URL BYPASSRLS fixture role: seeds CRM rows and cleans up

export const FIXTURE_PATH = new URL("./machine_export_v1.json", import.meta.url);

export type FixtureVector = { name: string; run_id: string; client_link: Record<string, unknown> };
export type MachineExportFixture = {
  contract: string;
  schema_version: number;
  unavailable: Record<string, unknown>;
  vectors: FixtureVector[];
};

export function loadMachineExportFixture(): MachineExportFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as MachineExportFixture;
}

export function fixtureVector(name: string): FixtureVector {
  const vector = loadMachineExportFixture().vectors.find((v) => v.name === name);
  if (!vector) throw new Error(`Unknown fixture vector ${name}`);
  return structuredClone(vector);
}

/** A copy of a vector's client_link with fields overridden. */
export function clientLink(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...fixtureVector(name).client_link, ...overrides };
}

export const INTEGRATION_REQUESTED = process.env.ASSET_MAP_RUN_IDENTITY_INTEGRATION === "1";

/** Required DB suites: run when requested, otherwise skipped with a logged reason. */
export const integrationDescribe = describe.runIf(INTEGRATION_REQUESTED);
if (!INTEGRATION_REQUESTED) {
  console.info("asset-map run identity DB suites skipped: ASSET_MAP_RUN_IDENTITY_INTEGRATION is not 1");
}

export type SyntheticDatabase = {
  owner: PrismaClient;
  ingest: PrismaClient;
  app: PrismaClient;
  fixture: PrismaClient;
  ownerRole: string;
  urls: { owner: string; ingest: string; app: string; fixture: string };
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parse(name: string): URL {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required for the asset-map run identity suite`);
  return new URL(raw);
}

/** Validate the four URLs point at one dedicated synthetic loopback database. */
export function requireSyntheticUrls(): SyntheticDatabase["urls"] {
  if (process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || process.env.CLOUD_RUN_JOB) {
    throw new Error("asset-map run identity DB suite must never run inside Cloud Run");
  }
  const owner = parse("DIRECT_DATABASE_URL");
  const ingest = parse("INGEST_DATABASE_URL");
  const app = parse("DATABASE_URL");
  const fixture = parse("INGEST_TEST_CLEANUP_URL");
  const all = [owner, ingest, app, fixture];
  for (const url of all) {
    if (!LOOPBACK.has(url.hostname)) throw new Error("asset-map run identity DB suite requires loopback URLs");
    if (!/^\/aoa_[a-z0-9_]+_synthetic$/.test(url.pathname)) {
      throw new Error("asset-map run identity DB suite requires a dedicated aoa_*_synthetic database");
    }
    if (url.pathname !== owner.pathname || url.port !== owner.port || url.hostname !== owner.hostname) {
      throw new Error("asset-map run identity DB URLs must share one database");
    }
  }
  if (ingest.username !== "ingest_rw") throw new Error("INGEST_DATABASE_URL must use ingest_rw");
  if (app.username !== "app_rw") throw new Error("DATABASE_URL must use app_rw");
  const reserved = new Set(["ingest_rw", "app_rw", "identity_reconciler"]);
  if (reserved.has(owner.username) || reserved.has(fixture.username) || owner.username === fixture.username) {
    throw new Error("Owner and fixture roles must be distinct from runtime roles and each other");
  }
  return { owner: owner.toString(), ingest: ingest.toString(), app: app.toString(), fixture: fixture.toString() };
}

type RoleRow = { role: string; superuser: boolean; bypass: boolean };

async function currentRole(client: PrismaClient): Promise<RoleRow> {
  const [row] = await client.$queryRaw<RoleRow[]>`
    SELECT current_user::text AS role, rolsuper AS superuser, rolbypassrls AS bypass
      FROM pg_catalog.pg_roles WHERE rolname = current_user`;
  return row;
}

/** Connect all four roles and prove their attributes before any assertion runs. */
export async function connectSyntheticDatabase(): Promise<SyntheticDatabase> {
  const urls = requireSyntheticUrls();
  const db: SyntheticDatabase = {
    owner: new PrismaClient({ datasourceUrl: urls.owner }),
    ingest: new PrismaClient({ datasourceUrl: urls.ingest }),
    app: new PrismaClient({ datasourceUrl: urls.app }),
    fixture: new PrismaClient({ datasourceUrl: urls.fixture }),
    ownerRole: new URL(urls.owner).username,
    urls,
  };
  const [owner, ingest, app, fixture] = await Promise.all([
    currentRole(db.owner), currentRole(db.ingest), currentRole(db.app), currentRole(db.fixture),
  ]);
  if (owner.superuser || owner.bypass) throw new Error("Migration owner must be NOSUPERUSER NOBYPASSRLS so FORCE RLS applies");
  if (ingest.superuser || ingest.bypass || ingest.role !== "ingest_rw") throw new Error("ingest_rw must be unprivileged");
  if (app.superuser || app.bypass || app.role !== "app_rw") throw new Error("app_rw must be unprivileged");
  if (!fixture.superuser && !fixture.bypass) throw new Error("Fixture role must bypass RLS to seed and clean synthetic rows");
  const [owned] = await db.fixture.$queryRaw<Array<{ owner: string | null }>>`
    SELECT pg_catalog.pg_get_userbyid(c.relowner)::text AS owner
      FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('mirror.acat_asset_map_household')`;
  if (owned?.owner !== db.ownerRole) throw new Error("DIRECT_DATABASE_URL must be the migration owner of the mirror tables");
  return db;
}

export async function disconnectSyntheticDatabase(db: SyntheticDatabase | undefined): Promise<void> {
  if (!db) return;
  await Promise.all([db.owner.$disconnect(), db.ingest.$disconnect(), db.app.$disconnect(), db.fixture.$disconnect()]);
}

// ---------------------------------------------------------------------------
// Invented ids. Each test file passes its own short namespace so parallel files
// never share rows; the shared fixture vectors are used by one file only.
// ---------------------------------------------------------------------------

/** Deterministic lowercase UUID in an invented namespace. */
export function syntheticRunId(namespace: number, n: number): string {
  const ns = namespace.toString(16).padStart(4, "0");
  const tail = n.toString(16).padStart(12, "0");
  return `0270${ns}-0000-4000-8000-${tail}`;
}

/** Invented 18-character CRM-shaped contact source key. */
export function contactKey(namespace: string, n: number): string {
  return `003R${namespace}${String(n).padStart(8, "0")}AAA`.slice(0, 18).padEnd(18, "A");
}

export function contactIdentityId(namespace: string, n: number): string {
  return `con_r270${namespace}${n}`;
}

export type SeedContact = {
  n: number;
  cedarRidgeUserId: string | null;
  registry?: "active" | "none" | "archived" | "superseded" | "wrong_type" | "two_aliases";
};

export type SeedEdge = { from: number; to: number; status?: "READY_FOR_FOLLOW_UP" | "NEW" };

/** Track every synthetic row seeded so cleanup is exact. */
export class CrmSeed {
  readonly clientKeys = new Set<string>();
  readonly identityIds = new Set<string>();
  readonly mappingIds = new Set<string>();
  readonly candidateIds = new Set<string>();
  private candidateCounter = 0;

  constructor(private readonly db: SyntheticDatabase, readonly namespace: string, private readonly candidateBase: number) {}

  async contact(contact: SeedContact): Promise<void> {
    const key = contactKey(this.namespace, contact.n);
    const identity = contactIdentityId(this.namespace, contact.n);
    this.clientKeys.add(key);
    await this.db.fixture.$executeRaw`
      INSERT INTO mirror.client (sf_id, first_name, last_name, cedar_ridge_user_id, stage)
      VALUES (${key}, 'Synthetic', 'Person', ${contact.cedarRidgeUserId}, 'Client')`;
    const registry = contact.registry ?? "active";
    if (registry === "none") return;
    this.identityIds.add(identity);
    if (registry === "wrong_type") {
      const household = `hld_r270${this.namespace}${contact.n}`;
      this.identityIds.add(household);
      await this.db.fixture.$executeRaw`
        INSERT INTO app.crm_identity (id, identity_type, updated_at) VALUES (${household}, 'HOUSEHOLD', now())`;
      await this.mapping(`r270-${this.namespace}-map-${contact.n}`, household, key, "ACTIVE");
      // A valid CONTACT identity row still exists, but this alias maps elsewhere.
      await this.db.fixture.$executeRaw`
        INSERT INTO app.crm_identity (id, identity_type, updated_at) VALUES (${identity}, 'CONTACT', now())`;
      return;
    }
    await this.db.fixture.$executeRaw`
      INSERT INTO app.crm_identity (id, identity_type, lifecycle_state, updated_at)
      VALUES (${identity}, 'CONTACT', ${registry === "archived" ? "ARCHIVED" : "ACTIVE"}, now())`;
    await this.mapping(`r270-${this.namespace}-map-${contact.n}`, identity, key,
      registry === "superseded" ? "SUPERSEDED" : "ACTIVE");
    if (registry === "two_aliases") {
      await this.mapping(`r270-${this.namespace}-map-${contact.n}-alias`, identity, key.slice(0, 15), "ACTIVE");
    }
  }

  private async mapping(id: string, identity: string, key: string, state: "ACTIVE" | "SUPERSEDED"): Promise<void> {
    this.mappingIds.add(id);
    await this.db.fixture.$executeRaw`
      INSERT INTO app.crm_source_mapping
        (id, identity_id, source_system, source_namespace, source_key, mapping_state, superseded_at, updated_at)
      VALUES (${id}, ${identity}, 'CRM', 'contact', ${key}, ${state},
              CASE WHEN ${state} = 'SUPERSEDED' THEN now() END, now())`;
  }

  /** Confirmed contact duplicate: `from` is suppressed in favour of `to`. */
  async edge(edge: SeedEdge): Promise<string> {
    const from = contactIdentityId(this.namespace, edge.from);
    const to = contactIdentityId(this.namespace, edge.to);
    const [left, right] = [from, to].sort();
    const n = this.candidateBase + this.candidateCounter++;
    const id = `dup_c${n.toString(16).padStart(24, "0")}`;
    this.candidateIds.add(id);
    const status = edge.status ?? "READY_FOR_FOLLOW_UP";
    await this.db.fixture.$executeRaw`
      INSERT INTO app.crm_duplicate_candidate
        (id, detector_key, entity_type, left_identity_id, right_identity_id, evidence_codes,
         status, canonical_identity_id, updated_at)
      VALUES (${id}, ${n.toString(16).padStart(64, "0")}, 'CONTACT', ${left}, ${right},
              ARRAY['SHARED_CEDAR_RIDGE_USER_ID'], ${status}::app."CrmDuplicateReviewStatus",
              ${status === "READY_FOR_FOLLOW_UP" ? to : null}, now())`;
    return id;
  }

  /** Reopen a confirmed duplicate (review reversal) without deleting it. */
  async reopen(candidateId: string): Promise<void> {
    await this.db.fixture.$executeRaw`
      UPDATE app.crm_duplicate_candidate
         SET status = 'NEW'::app."CrmDuplicateReviewStatus", canonical_identity_id = NULL, updated_at = now()
       WHERE id = ${candidateId}`;
  }

  async setCedarRidgeUserId(n: number, cedarRidgeUserId: string | null): Promise<void> {
    await this.db.fixture.$executeRaw`
      UPDATE mirror.client SET cedar_ridge_user_id = ${cedarRidgeUserId} WHERE sf_id = ${contactKey(this.namespace, n)}`;
  }

  async archive(n: number): Promise<void> {
    await this.db.fixture.$executeRaw`
      UPDATE app.crm_identity SET lifecycle_state = 'ARCHIVED', updated_at = now()
       WHERE id = ${contactIdentityId(this.namespace, n)}`;
  }

  async cleanup(): Promise<void> {
    const f = this.db.fixture;
    const candidates = [...this.candidateIds];
    const mappings = [...this.mappingIds];
    const identities = [...this.identityIds];
    const clients = [...this.clientKeys];
    if (candidates.length) {
      await f.$executeRaw`DELETE FROM app.crm_duplicate_candidate_event WHERE candidate_id IN (${Prisma.join(candidates)})`;
      await f.$executeRaw`DELETE FROM app.crm_duplicate_candidate WHERE id IN (${Prisma.join(candidates)})`;
    }
    if (mappings.length) await f.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id IN (${Prisma.join(mappings)})`;
    if (identities.length) await f.$executeRaw`DELETE FROM app.crm_identity WHERE id IN (${Prisma.join(identities)})`;
    if (clients.length) await f.$executeRaw`DELETE FROM mirror.client WHERE sf_id IN (${Prisma.join(clients)})`;
    const pks = [...candidates, ...mappings, ...identities, ...clients];
    if (pks.length) await f.$executeRaw`DELETE FROM audit.row_change WHERE row_pk IN (${Prisma.join(pks)})`;
  }
}

/** Seed parent household runs with legacy scalars set, so T2.7 can prove they never change. */
export async function seedHouseholdRuns(db: SyntheticDatabase, runIds: readonly string[]): Promise<void> {
  for (const id of runIds) {
    await db.fixture.$executeRaw`
      INSERT INTO mirror.acat_asset_map_household (id, client_name, run_number, client_sf_id, cedar_ridge_user_id)
      VALUES (${id}, 'Synthetic Run', 1, 'legacy-sf-untouched', 'legacy-cr-untouched')`;
  }
}

/**
 * Remove identity rows for the given runs and then the parent runs. History is
 * append-only even for its owner, so cleanup disables user triggers for this
 * fixture session only (the fixture role is a dedicated synthetic superuser).
 */
export async function cleanupRuns(db: SyntheticDatabase, runIds: readonly string[]): Promise<void> {
  if (runIds.length === 0) return;
  const ids = [...runIds];
  const identityTables = await db.fixture.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('mirror.acat_asset_map_run_identity') IS NOT NULL AS present`;
  await db.fixture.$transaction(async (tx) => {
    if (identityTables[0]?.present) {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`DELETE FROM mirror.acat_asset_map_run_identity_history WHERE run_id IN (${Prisma.join(ids)})`;
      await tx.$executeRaw`DELETE FROM mirror.acat_asset_map_run_person WHERE run_id IN (${Prisma.join(ids)})`;
      await tx.$executeRaw`DELETE FROM mirror.acat_asset_map_run_identity WHERE run_id IN (${Prisma.join(ids)})`;
    }
    await tx.$executeRaw`DELETE FROM mirror.acat_asset_map_household WHERE id IN (${Prisma.join(ids)})`;
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until some backend is blocked on an advisory lock (the identity sync lock). */
export async function waitForAdvisoryWaiter(db: SyntheticDatabase, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db.fixture.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT count(*) AS waiting FROM pg_catalog.pg_locks
       WHERE locktype = 'advisory' AND NOT granted AND database = (
         SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())`;
    if (Number(row.waiting) > 0) return;
    await sleep(25);
  }
  throw new Error("No backend waited on the identity sync lock");
}
