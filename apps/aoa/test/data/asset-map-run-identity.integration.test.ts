import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseRunIdentity, type RunIdentityObservation } from "@/lib/data/asset-map-run-identity/contract";
import { persistRunIdentities } from "@/lib/data/asset-map-run-identity/persistence";
import {
  CrmSeed,
  cleanupRuns,
  clientLink,
  connectSyntheticDatabase,
  contactIdentityId,
  disconnectSyntheticDatabase,
  integrationDescribe,
  seedHouseholdRuns,
  syntheticRunId,
  type SyntheticDatabase,
} from "../asset-map-run-identity/fixtures";

const TABLES = [
  "mirror.acat_asset_map_run_identity",
  "mirror.acat_asset_map_run_person",
  "mirror.acat_asset_map_run_identity_history",
] as const;
const PUBLIC_PROBE = "r270_public_probe";

// Tables that the identity phase must never write (T2.7). Sibling test files
// run in parallel and seed/clean only their own namespaced rows (resolver "rs",
// persistence "ps" and its fixture runs); those rows are excluded so every
// other row, including this file's, is fingerprinted.
const SIBLING_RUNS = "(id ~ '^[1-8]{8}-' OR id LIKE '02700002-%')";
const PROTECTED: Record<string, string> = {
  "mirror.acat_asset_map_household": `NOT ${SIBLING_RUNS}`,
  "mirror.acat_asset_map_account": "true",
  "mirror.acat_asset_map_position": "true",
  "mirror.acat_asset_map_link": "true",
  "mirror.acat_asset_map_account_link": "true",
  "mirror.client": "sf_id !~ '^003R(rs|ps)'",
  "app.transfer": "true",
  "app.crm_identity": "id !~ '^(con|hld)_r270(rs|ps)'",
  "app.crm_source_mapping": "id !~ '^r270-(rs|ps)-'",
  "app.crm_duplicate_candidate": "id !~ '^dup_c0{15}270[12]'",
};

function observe(name: string, runId: string, overrides: Record<string, unknown> = {}): RunIdentityObservation {
  const parsed = parseRunIdentity(runId, clientLink(name, overrides));
  if (!parsed.ok) throw new Error(`invalid fixture ${name}`);
  return parsed.value;
}

async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    const meta = (error as { meta?: { code?: string } }).meta;
    const message = String((error as Error).message);
    return meta?.code ?? message.match(/\b(42501|23514|23503|23505|P0001)\b/)?.[1] ?? message;
  }
}

async function fingerprint(client: PrismaClient): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [table, scope] of Object.entries(PROTECTED)) {
    const [row] = await client.$queryRawUnsafe<Array<{ digest: string | null; n: bigint }>>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest, count(*) AS n
         FROM ${table} t WHERE ${scope}`);
    out[table] = `${row.digest ?? ""}:${row.n}`;
  }
  return out;
}

integrationDescribe("asset-map run identity role and RLS boundaries", () => {
  let db: SyntheticDatabase | undefined;
  let seed: CrmSeed;
  const ns = "it";
  const runs = [syntheticRunId(4, 1), syntheticRunId(4, 2), syntheticRunId(4, 3)];

  beforeAll(async () => {
    db = await connectSyntheticDatabase();
    seed = new CrmSeed(db, ns, 0x270400000);
    await cleanupRuns(db, runs);
    await seed.cleanup();
    await seedHouseholdRuns(db, runs);
    await seed.contact({ n: 1, cedarRidgeUserId: "it-solo" });
    await db.fixture.$executeRawUnsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PUBLIC_PROBE}') THEN
        CREATE ROLE ${PUBLIC_PROBE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF; END $$`);
    await db.ingest.$transaction((tx) => persistRunIdentities(tx, [
      observe("singleton", runs[0], { people_ids: ["it-solo"], primary_user_id: "it-solo", cedar_ridge_user_id: "it-solo" }),
    ]));
  });

  afterAll(async () => {
    try {
      if (db) { await cleanupRuns(db, runs); await seed.cleanup(); }
    } finally { await disconnectSyntheticDatabase(db); }
  });

  it("lets ingest_rw read and write snapshots/members and append history (authorized control)", async () => {
    const counts = await db!.ingest.$queryRaw<Array<{ s: bigint; p: bigint; h: bigint }>>`
      SELECT (SELECT count(*) FROM mirror.acat_asset_map_run_identity WHERE run_id = ${runs[0]}) AS s,
             (SELECT count(*) FROM mirror.acat_asset_map_run_person WHERE run_id = ${runs[0]}) AS p,
             (SELECT count(*) FROM mirror.acat_asset_map_run_identity_history WHERE run_id = ${runs[0]}) AS h`;
    expect(counts.map((r) => [Number(r.s), Number(r.p), Number(r.h)])).toEqual([[1, 1, 1]]);
    const [resolved] = await db!.ingest.$queryRaw<Array<{ outcome: string; target: string }>>`
      SELECT outcome, canonical_contact_identity_id AS target
        FROM app.resolve_asset_map_run_people(ARRAY['it-solo']::text[])`;
    expect(resolved).toEqual({ outcome: "resolved", target: contactIdentityId(ns, 1) });
  });

  it("denies ingest_rw UPDATE/DELETE on history and DELETE on mutable tables", async () => {
    expect(await sqlState(db!.ingest.$executeRaw`
      UPDATE mirror.acat_asset_map_run_identity_history SET source_changed = source_changed WHERE run_id = ${runs[0]}`)).toBe("42501");
    expect(await sqlState(db!.ingest.$executeRaw`
      DELETE FROM mirror.acat_asset_map_run_identity_history WHERE run_id = ${runs[0]}`)).toBe("42501");
    expect(await sqlState(db!.ingest.$executeRaw`
      DELETE FROM mirror.acat_asset_map_run_person WHERE run_id = ${runs[0]}`)).toBe("42501");
    expect(await sqlState(db!.ingest.$executeRaw`
      DELETE FROM mirror.acat_asset_map_run_identity WHERE run_id = ${runs[0]}`)).toBe("42501");
    expect(await sqlState(db!.ingest.$executeRawUnsafe(`TRUNCATE mirror.acat_asset_map_run_identity_history`))).toBe("42501");
  });

  it("denies app_rw every read, write and resolver call even as OPERATIONS", async () => {
    // Authorized control: the same app_rw connection reads an existing Ops-visible mirror.
    const control = await db!.app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_role', 'OPERATIONS', true), set_config('app.user_email', 'ops@example.invalid', true)`;
      return tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM mirror.acat_asset_map_household WHERE id = ${runs[0]}`;
    });
    expect(Number(control[0].n)).toBe(1);
    for (const table of TABLES) {
      const state = await sqlState(db!.app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_role', 'OPERATIONS', true), set_config('app.user_email', 'ops@example.invalid', true)`;
        return tx.$queryRawUnsafe(`SELECT count(*) FROM ${table}`);
      }));
      expect(state, table).toBe("42501");
      expect(await sqlState(db!.app.$executeRawUnsafe(`INSERT INTO ${table} DEFAULT VALUES`)), table).toBe("42501");
    }
    expect(await sqlState(db!.app.$queryRaw`SELECT * FROM app.resolve_asset_map_run_people(ARRAY['it-solo']::text[])`)).toBe("42501");
  });

  it("denies a role holding only PUBLIC privileges", async () => {
    const asProbe = (statement: string) => db!.fixture.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PUBLIC_PROBE}`);
      return tx.$queryRawUnsafe(statement);
    });
    expect(await sqlState(asProbe("SELECT 1"))).toBe("ok");
    for (const table of TABLES) expect(await sqlState(asProbe(`SELECT count(*) FROM ${table}`)), table).toBe("42501");
    expect(await sqlState(asProbe(`SELECT * FROM app.resolve_asset_map_run_people(ARRAY['it-solo']::text[])`))).toBe("42501");
  });

  it("forces RLS on the non-superuser owner while its checked resolver policies still work", async () => {
    const [fixtureCount] = await db!.fixture.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM mirror.acat_asset_map_run_identity WHERE run_id = ${runs[0]}`;
    expect(Number(fixtureCount.n)).toBe(1);
    for (const table of TABLES) {
      const [row] = await db!.owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM ${table}`);
      expect(Number(row.n), table).toBe(0);
    }
    const [owned] = await db!.owner.$queryRaw<Array<{ outcome: string }>>`
      SELECT outcome FROM app.resolve_asset_map_run_people(ARRAY['it-solo']::text[])`;
    expect(owned.outcome).toBe("resolved");
  });

  it("keeps direct CRM registry reads denied to ingest_rw and PUBLIC", async () => {
    for (const table of ["app.crm_identity", "app.crm_source_mapping", "app.crm_duplicate_candidate"]) {
      expect(await sqlState(db!.ingest.$queryRawUnsafe(`SELECT count(*) FROM ${table}`)), table).toBe("42501");
      expect(await sqlState(db!.fixture.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PUBLIC_PROBE}`);
        return tx.$queryRawUnsafe(`SELECT count(*) FROM ${table}`);
      })), table).toBe("42501");
    }
  });

  it("rejects inconsistent snapshots at commit even from direct ingest SQL (T2.1)", async () => {
    const run = runs[1];
    const digest = "0".repeat(64);
    const insertSnapshot = (tx: Prisma.TransactionClient, people: string[], primary: string | null) => tx.$executeRaw`
      INSERT INTO mirror.acat_asset_map_run_identity
        (run_id, schema_version, identity_version, payload_digest, decision_id, decision_state, coverage, people_ids,
         primary_user_id, cedar_ridge_user_id, review_state, conflict_flags, consumer_revision, resolution_digest,
         last_observed_availability)
      VALUES (${run}, 1, 1, ${digest}, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'linked', 'complete', ${people}::text[],
              ${primary}, ${primary}, 'complete', ARRAY[]::text[], 1, ${digest}, 'available')`;
    // Snapshot names a member that has no membership row and no history row:
    // the deferred consistency trigger rejects it at commit.
    await expect(db!.ingest.$transaction((tx) => insertSnapshot(tx, ["it-x"], "it-x")))
      .rejects.toThrow(/active run membership must equal the accepted people set/);
    // Primary outside the accepted set fails its row check immediately.
    expect(await sqlState(db!.ingest.$transaction((tx) => insertSnapshot(tx, ["it-x"], "it-y")))).toBe("23514");
    // Unsorted people are rejected rather than coerced.
    expect(await sqlState(db!.ingest.$transaction((tx) => insertSnapshot(tx, ["it-y", "it-x"], null)))).toBe("23514");
    const [left] = await db!.fixture.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM mirror.acat_asset_map_run_identity WHERE run_id = ${run}`;
    expect(Number(left.n)).toBe(0);
  });

  it("rejects retiring a member outside a consistent snapshot update", async () => {
    const run = runs[0];
    expect(await sqlState(db!.ingest.$transaction((tx) => tx.$executeRaw`
      UPDATE mirror.acat_asset_map_run_person
         SET membership_state = 'retired', retired_identity_version = 2, retired_at = now()
       WHERE run_id = ${run}`))).toBe("23514");
  });

  it("never touches folder/account links, legacy scalars, transfers, financial fields or CRM rows (T2.7)", async () => {
    const before = await fingerprint(db!.fixture);
    await db!.ingest.$transaction((tx) => persistRunIdentities(tx, [
      observe("singleton", runs[0], { identity_version: 2, people_ids: ["it-solo"], primary_user_id: "it-solo", cedar_ridge_user_id: "it-solo" }),
      observe("shared_no_primary", runs[2], { people_ids: ["it-solo", "it-zed"] }),
    ]));
    await db!.ingest.$transaction((tx) => persistRunIdentities(tx, [
      observe("first_confirmation_reversal", runs[2], { identity_version: 3 }),
    ]));
    expect(await fingerprint(db!.fixture)).toEqual(before);
    const legacy = await db!.fixture.$queryRaw<Array<{ client_sf_id: string; cedar_ridge_user_id: string }>>`
      SELECT client_sf_id, cedar_ridge_user_id FROM mirror.acat_asset_map_household
       WHERE id IN (${Prisma.join(runs)}) ORDER BY id`;
    expect(legacy).toEqual(runs.map(() => ({ client_sf_id: "legacy-sf-untouched", cedar_ridge_user_id: "legacy-cr-untouched" })));

    // Control: the fingerprint does detect a legacy-scalar write.
    await db!.fixture.$executeRaw`UPDATE mirror.acat_asset_map_household SET client_sf_id = 'changed' WHERE id = ${runs[0]}`;
    try {
      expect((await fingerprint(db!.fixture))["mirror.acat_asset_map_household"])
        .not.toBe(before["mirror.acat_asset_map_household"]);
    } finally {
      await db!.fixture.$executeRaw`
        UPDATE mirror.acat_asset_map_household SET client_sf_id = 'legacy-sf-untouched' WHERE id = ${runs[0]}`;
    }
  });
});
