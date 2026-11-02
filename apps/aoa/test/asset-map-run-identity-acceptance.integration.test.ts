import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("server-only", () => ({}));

// Keyless OIDC is the only stubbed seam: the token is minted for the requested
// audience and the request really travels over HTTP to the synthetic source,
// which authenticates it. Everything else (route, census, resolver, ingest
// transactions, audit) is production code against the dedicated database.
const { oidcAudiences } = vi.hoisted(() => ({ oidcAudiences: [] as string[] }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn(function () {
    return {
      getIdTokenClient: async (audience: string) => {
        oidcAudiences.push(audience);
        return {
          request: async ({ url, method }: { url: string; method: string }) => {
            const res = await fetch(url, { method, headers: { authorization: `Bearer synthetic-oidc:${audience}` } });
            const text = await res.text();
            let data: unknown = text;
            try {
              data = JSON.parse(text);
            } catch {
              // A non-JSON body is handed to the importer as-is.
            }
            return { status: res.status, data };
          },
        };
      },
    };
  }),
}));

import * as route from "@/app/api/cron/asset-map/route";
import {
  diagnosticEquationsHold,
  type RunIdentityDiagnostics,
} from "@/lib/data/asset-map-run-identity/diagnostic";
import { parseRunIdentity, type RunIdentityObservation } from "@/lib/data/asset-map-run-identity/contract";
import { persistRunIdentities, type RunIdentityPersistCounts } from "@/lib/data/asset-map-run-identity/persistence";
import { ingestPrisma } from "@/lib/ingest/db";

import {
  CrmSeed,
  connectSyntheticDatabase,
  contactIdentityId,
  contactKey,
  disconnectSyntheticDatabase,
  integrationDescribe,
  loadMachineExportFixture,
  requireSyntheticUrls,
  waitForAdvisoryWaiter,
  type SyntheticDatabase,
} from "./asset-map-run-identity/fixtures";

// ticket independent acceptance: producer contract → existing authenticated
// /api/cron/asset-map import → identity census → checked CRM resolution →
// ingest_rw writes, on PostgreSQL with the real role layout. Every id, name and
// account number is invented. Requires ASSET_MAP_RUN_IDENTITY_INTEGRATION=1 and
// the dedicated database below; once requested, missing prerequisites fail
// setup. The required CI job proves this file executed with zero skips.

const REQUESTED = process.env.ASSET_MAP_RUN_IDENTITY_INTEGRATION;
if (REQUESTED !== undefined && REQUESTED !== "" && REQUESTED !== "1") {
  throw new Error("ASSET_MAP_RUN_IDENTITY_INTEGRATION must be exactly 1 when set");
}

const ACCEPTANCE_DATABASE = "aoa_asset_map_identity_synthetic";
const ACCEPTANCE_PORT = "15543";
const URL_VARS = ["DIRECT_DATABASE_URL", "INGEST_DATABASE_URL", "DATABASE_URL", "INGEST_TEST_CLEANUP_URL"] as const;
const LIBPQ_FALLBACKS = ["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE"] as const;

/** Exact dedicated database, pinned port, loopback only, no routing overrides, no implicit fallback. */
function requireAcceptanceDatabase(): void {
  requireSyntheticUrls();
  for (const name of URL_VARS) {
    const url = new URL(process.env[name]!);
    if (url.pathname !== `/${ACCEPTANCE_DATABASE}`) throw new Error(`${name} must target ${ACCEPTANCE_DATABASE}`);
    if (url.port !== ACCEPTANCE_PORT) throw new Error(`${name} must use pinned port ${ACCEPTANCE_PORT}`);
    if ([...url.searchParams.keys()].some((key) => key !== "schema")) {
      throw new Error(`${name} may not carry connection overrides`);
    }
  }
  for (const name of LIBPQ_FALLBACKS) {
    if (process.env[name]) throw new Error(`${name} must be unset for the acceptance suite`);
  }
}

// ---------------------------------------------------------------------------
// Invented identifiers. Runs, accounts and positions all start with RUN_PREFIX.
// ---------------------------------------------------------------------------

const RUN_PREFIX = "02720000-";
const run = (n: number) => `${RUN_PREFIX}0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const decisionFor = (version: number) => `d2720000-0000-4000-8000-${version.toString(16).padStart(12, "0")}`;
const BASELINE = "ZZTEST-R272-";
const NS = "at";
const con = (n: number) => contactIdentityId(NS, n);
const TOKEN = "synthetic-ingest-token-r272";
const PUBLIC_PROBE = "r272_public_probe";

type ClientLink = Record<string, unknown>;

function linked(
  version: number,
  people: string[],
  options: { primary?: string; coverage?: "complete" | "partial"; flags?: string[] } = {},
): ClientLink {
  const peopleIds = [...people].sort();
  const coverage = options.coverage ?? "complete";
  const flags = [...(options.flags ?? [])].sort();
  const primary = options.primary ?? null;
  return {
    schema_version: 1,
    availability: "available",
    identity_version: version,
    decision_id: decisionFor(version),
    decision_state: "linked",
    people_ids: peopleIds,
    coverage,
    primary_user_id: primary,
    cedar_ridge_user_id: primary ?? (coverage === "complete" && peopleIds.length === 1 ? peopleIds[0] : null),
    review_state: flags.length > 0 ? "conflict" : coverage,
    conflict_flags: flags,
  };
}

function unlinked(version: number, decisionId: string | null = decisionFor(version)): ClientLink {
  return {
    schema_version: 1, availability: "available", identity_version: version, decision_id: decisionId,
    decision_state: "unlinked", people_ids: [], coverage: "partial", primary_user_id: null, cedar_ridge_user_id: null,
    review_state: "unresolved", conflict_flags: [],
  };
}

function unreviewed(version = 0): ClientLink {
  return { ...unlinked(version, null), decision_state: "unreviewed" };
}

const UNAVAILABLE: ClientLink = { schema_version: 1, availability: "unavailable", reason: "client_linking_disabled" };

type Household = Record<string, unknown>;

function household(id: string, clientLink?: ClientLink, extra: Household = {}): Household {
  const row: Household = {
    id, client_name: "Synthetic Run", run_number: 1, superseded_by: null, source_folder_id: null, accounts: [], ...extra,
  };
  if (clientLink !== undefined) row.client_link = clientLink;
  return row;
}

function withAccount(row: Household): Household {
  const id = row.id as string;
  return {
    ...row,
    accounts: [{
      id: `${id}:a1`, household_id: id, custodian: "Synthetic Custodian", account_number: "SYNTHETIC-R272-0001",
      assets: [{ id: `${id}:p1`, account_id: `${id}:a1`, symbol: "SYN", market_value: "10.00" }],
    }],
  };
}

// ---------------------------------------------------------------------------
// Synthetic source: the households endpoint of the producer, over real HTTP.
// ---------------------------------------------------------------------------

type SourceReply = { status: number; body: unknown };
type SourceRequest = { page: number; perPage: number; includeSuperseded: string | null; authorized: boolean };

class SyntheticSource {
  private readonly server = http.createServer((req, res) => this.handle(req, res));
  url = "";
  audience = "";
  households: Household[] = [];
  requests: SourceRequest[] = [];
  respond: ((page: number, perPage: number, index: number) => SourceReply) | null = null;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.audience = this.url;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  serve(households: Household[]): void {
    this.households = households;
    this.requests = [];
    this.respond = null;
    this.audience = this.url;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", this.url);
    const page = Number(url.searchParams.get("page"));
    const perPage = Number(url.searchParams.get("per_page"));
    const authorized = req.headers.authorization === `Bearer synthetic-oidc:${this.audience}`;
    const index = this.requests.length;
    this.requests.push({ page, perPage, includeSuperseded: url.searchParams.get("include_superseded"), authorized });
    let reply: SourceReply;
    if (req.method !== "GET" || url.pathname !== "/api/v1/households") reply = { status: 404, body: { error: "not_found" } };
    else if (!authorized) reply = { status: 401, body: { error: "unauthorized" } };
    else if (this.respond) reply = this.respond(page, perPage, index);
    else {
      const start = (page - 1) * perPage;
      reply = {
        status: 200,
        body: { page, per_page: perPage, total: this.households.length, households: this.households.slice(start, start + perPage) },
      };
    }
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    res.writeHead(reply.status, { "content-type": typeof reply.body === "string" ? "text/plain" : "application/json" });
    res.end(text);
  }
}

const envelope = (page: number, total: number, households: Household[], perPage = 200) =>
  ({ status: 200, body: { page, per_page: perPage, total, households } });

// ---------------------------------------------------------------------------
// Route invocation and modes.
// ---------------------------------------------------------------------------

type IdentityBody = {
  mode: string;
  status: string;
  reason?: string;
  reasons?: string[];
  counts?: RunIdentityPersistCounts;
  audited?: boolean;
  diagnostics?: RunIdentityDiagnostics;
  census?: { complete: boolean; reasons: string[]; runs: Record<string, number> };
};
type RouteBody = {
  error?: string;
  upserted?: Record<string, number>;
  would_upsert?: Record<string, number>;
  base_status?: string;
  identity?: IdentityBody;
};

const MODE_FLAGS = ["ASSET_MAP_RUN_IDENTITY_ENABLED", "ASSET_MAP_RUN_IDENTITY_WRITES_ENABLED"] as const;
type Mode = "off" | "writes_only" | "preview" | "write";

function setMode(mode: Mode): void {
  for (const flag of MODE_FLAGS) delete process.env[flag];
  if (mode === "preview" || mode === "write") process.env.ASSET_MAP_RUN_IDENTITY_ENABLED = "1";
  if (mode === "write" || mode === "writes_only") process.env.ASSET_MAP_RUN_IDENTITY_WRITES_ENABLED = "1";
}

async function pull(options: { dryRun?: boolean; auth?: string | null } = {}): Promise<{ status: number; body: RouteBody }> {
  const headers = new Headers();
  const auth = options.auth === undefined ? `Bearer ${TOKEN}` : options.auth;
  if (auth !== null) headers.set("authorization", auth);
  const res = await route.POST(new Request(
    `https://ops-portal.invalid/api/cron/asset-map${options.dryRun ? "?dryRun=1" : ""}`,
    { method: "POST", headers },
  ));
  return { status: res.status, body: (await res.json()) as RouteBody };
}

// ---------------------------------------------------------------------------
// Readers (fixture role bypasses RLS; it never writes during an assertion).
// ---------------------------------------------------------------------------

type Snapshot = {
  version: number;
  decision_id: string | null;
  decision_state: string;
  people_ids: string[];
  coverage: string;
  primary_user_id: string | null;
  cedar_ridge_user_id: string | null;
  review_state: string;
  conflict_flags: string[];
  consumer_revision: number;
  quarantine_reason: string | null;
  last_observed_availability: string;
};
type Member = {
  cedar_ridge_user_id: string;
  membership_state: string;
  resolution_outcome: string | null;
  canonical_contact_identity_id: string | null;
};
type History = { consumer_revision: number; version: number; source_changed: boolean; resolution_changed: boolean };

integrationDescribe("asset-map run identity acceptance (ticket)", () => {
  let db: SyntheticDatabase;
  let seed: CrmSeed;
  const source = new SyntheticSource();
  const logs: string[] = [];
  const spies: MockInstance[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["INGEST_TOKEN", "STATEMENT_PIPELINE_URL", "AOA_WRITES_PAUSED", ...MODE_FLAGS];

  const snapshot = async (id: string): Promise<Snapshot | undefined> => (await db.fixture.$queryRaw<Snapshot[]>`
    SELECT identity_version::int AS version, decision_id, decision_state, people_ids, coverage, primary_user_id,
           cedar_ridge_user_id, review_state, conflict_flags, consumer_revision, quarantine_reason,
           last_observed_availability
      FROM mirror.acat_asset_map_run_identity WHERE run_id = ${id}`)[0];
  const members = (id: string) => db.fixture.$queryRaw<Member[]>`
    SELECT cedar_ridge_user_id, membership_state, resolution_outcome, canonical_contact_identity_id
      FROM mirror.acat_asset_map_run_person WHERE run_id = ${id} ORDER BY cedar_ridge_user_id COLLATE "C"`;
  const active = async (id: string) =>
    (await members(id)).filter((m) => m.membership_state === "active").map((m) => m.cedar_ridge_user_id);
  const history = (id: string) => db.fixture.$queryRaw<History[]>`
    SELECT consumer_revision, identity_version::int AS version, source_changed, resolution_changed
      FROM mirror.acat_asset_map_run_identity_history WHERE run_id = ${id} ORDER BY consumer_revision`;
  const householdExists = async (id: string) => (await db.fixture.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM mirror.acat_asset_map_household WHERE id = ${id}`)[0].n > 0n;

  /** Digest of every identity row; any write (even a timestamp touch) changes it. */
  async function identityDigest(): Promise<string> {
    const parts: string[] = [];
    for (const table of ["acat_asset_map_run_identity", "acat_asset_map_run_person", "acat_asset_map_run_identity_history"]) {
      const [row] = await db.fixture.$queryRawUnsafe<Array<{ d: string; n: bigint }>>(
        `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d, count(*) AS n FROM mirror.${table} t`);
      parts.push(`${table}:${row.n}:${row.d}`);
    }
    return parts.join(";");
  }

  async function auditMark(): Promise<bigint> {
    const [row] = await db.fixture.$queryRaw<Array<{ id: bigint }>>`SELECT coalesce(max(id), 0)::bigint AS id FROM audit."AuditLog"`;
    return row.id;
  }
  async function auditsSince(mark: bigint): Promise<Array<{ action: string; detail: string | null }>> {
    return db.fixture.$queryRaw`SELECT action, detail FROM audit."AuditLog" WHERE id > ${mark} AND action LIKE 'ingest.asset_map%' ORDER BY id`;
  }

  async function purgeRuns(): Promise<void> {
    const prefix = `${RUN_PREFIX}%`;
    await db.fixture.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`DELETE FROM mirror.acat_asset_map_run_identity_history WHERE run_id LIKE ${prefix}`;
      await tx.$executeRaw`DELETE FROM mirror.acat_asset_map_run_person WHERE run_id LIKE ${prefix}`;
      await tx.$executeRaw`DELETE FROM mirror.acat_asset_map_run_identity WHERE run_id LIKE ${prefix}`;
      await tx.$executeRaw`DELETE FROM mirror.acat_asset_map_position WHERE account_id LIKE ${prefix}`;
      await tx.$executeRaw`DELETE FROM mirror.acat_asset_map_account WHERE household_id LIKE ${prefix}`;
      await tx.$executeRaw`DELETE FROM mirror.acat_asset_map_household WHERE id LIKE ${prefix}`;
    });
  }

  async function dropInjections(): Promise<void> {
    await db.fixture.$executeRawUnsafe(`DROP TRIGGER IF EXISTS r272_inject ON audit."AuditLog"`);
    await db.fixture.$executeRawUnsafe(`DROP TRIGGER IF EXISTS r272_inject ON mirror.acat_asset_map_run_person`);
    await db.fixture.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.r272_injected_failure()`);
  }

  async function inject(table: string, when: string): Promise<void> {
    await db.fixture.$executeRawUnsafe(`CREATE FUNCTION public.r272_injected_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'r272 injected failure'; END $$`);
    await db.fixture.$executeRawUnsafe(`CREATE TRIGGER r272_inject BEFORE INSERT OR UPDATE ON ${table}
      FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION public.r272_injected_failure()`);
  }

  /** Serve households and pull in write mode; the identity phase must apply. */
  async function apply(households: Household[]): Promise<RunIdentityPersistCounts> {
    setMode("write");
    source.serve(households);
    const { status, body } = await pull();
    expect(status, JSON.stringify(body.identity)).toBe(200);
    expect(body.identity?.status).toBe("applied");
    return body.identity!.counts!;
  }

  beforeAll(async () => {
    requireAcceptanceDatabase();
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    db = await connectSyntheticDatabase();
    seed = new CrmSeed(db, NS, 0x272000000);
    await dropInjections();
    await purgeRuns();
    await seed.cleanup();
    await source.start();
    process.env.INGEST_TOKEN = TOKEN;
    process.env.STATEMENT_PIPELINE_URL = source.url;
    delete process.env.AOA_WRITES_PAUSED;
    spies.push(
      vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void logs.push(a.join(" "))),
      vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" "))),
      vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void logs.push(a.join(" "))),
    );

    // Canonical CRM fixtures for every resolver outcome (all invented).
    const contacts: Array<[number, string | null, ("archived" | "superseded" | "none" | "two_aliases")?]> = [
      [1, "at-solo"], [2, "at-two"], [3, "at-two"], [4, "at-merged"], [5, "at-merged"], [6, "at-alias", "two_aliases"],
      [7, "at-chain"], [8, null], [9, "at-chain"], [10, "at-branch"], [11, null], [12, null], [13, "at-cycle"], [14, null],
      [41, "at-archived", "archived"], [42, "at-superseded", "superseded"], [43, "at-unregistered", "none"],
      [44, "at-conflicting"], [45, "at-someone-else"],
      [50, "at-a"], [51, "at-b"], [52, "at-c1"], [53, "at-c2"], [54, "at-c3"], [55, "at-x"], [56, "at-y"],
      [57, "at-old"], [58, "at-new"], [59, "at-poison"], [60, "at-merge"],
      [70, "cr-solo"], [71, "cr-a"], [72, "cr-primary"], [73, "cr-secondary"], [74, "cr-partial"], [75, "cr-conflict"],
    ];
    for (const [n, cedarRidgeUserId, registry] of contacts) await seed.contact({ n, cedarRidgeUserId, registry });
    for (let n = 20; n <= 28; n++) await seed.contact({ n, cedarRidgeUserId: n === 20 ? "at-deep" : null });
    for (let n = 30; n <= 37; n++) await seed.contact({ n, cedarRidgeUserId: n === 30 ? "at-bound" : null });
    await seed.edge({ from: 4, to: 5 });
    await seed.edge({ from: 7, to: 8 });
    await seed.edge({ from: 8, to: 9 });
    await seed.edge({ from: 10, to: 11 });
    await seed.edge({ from: 10, to: 12 });
    await seed.edge({ from: 13, to: 14 });
    await seed.edge({ from: 14, to: 13 });
    for (let n = 20; n < 28; n++) await seed.edge({ from: n, to: n + 1 });
    for (let n = 30; n < 37; n++) await seed.edge({ from: n, to: n + 1 });
    await seed.edge({ from: 44, to: 45 });
    await db.fixture.$executeRawUnsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PUBLIC_PROBE}') THEN
        CREATE ROLE ${PUBLIC_PROBE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF; END $$`);
  }, 60_000);

  afterAll(async () => {
    try {
      for (const spy of spies) spy.mockRestore();
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      await source.stop();
      if (db) {
        await dropInjections();
        await purgeRuns();
        await seed.cleanup();
        await db.fixture.$executeRawUnsafe(`DROP ROLE IF EXISTS ${PUBLIC_PROBE}`);
      }
    } finally {
      await ingestPrisma.$disconnect();
      await disconnectSyntheticDatabase(db);
    }
  }, 60_000);

  beforeEach(() => {
    source.serve([]);
    setMode("off");
    process.env.INGEST_TOKEN = TOKEN;
    process.env.STATEMENT_PIPELINE_URL = source.url;
  });

  // -------------------------------------------------------------------------
  describe("T4.4 dedicated database, authentication and real roles", () => {
    it("pins one loopback synthetic database and port, rejecting overrides and fallbacks", async () => {
      expect(() => requireAcceptanceDatabase()).not.toThrow();
      const owner = process.env.DIRECT_DATABASE_URL!;
      const swap = (value: string | undefined, fn: () => void) => {
        if (value === undefined) delete process.env.DIRECT_DATABASE_URL;
        else process.env.DIRECT_DATABASE_URL = value;
        try { fn(); } finally { process.env.DIRECT_DATABASE_URL = owner; }
      };
      const bad = (mutate: (url: URL) => void) => {
        const url = new URL(owner);
        mutate(url);
        return url.toString();
      };
      for (const value of [
        undefined,
        bad((u) => { u.hostname = "aoa-prod.example.invalid"; }),
        bad((u) => { u.pathname = "/aoa"; }),
        bad((u) => { u.pathname = "/aoa_other_synthetic"; }),
        bad((u) => { u.port = "5432"; }),
        bad((u) => { u.searchParams.set("host", "/cloudsql/aoa-prod"); }),
        bad((u) => { u.searchParams.set("service", "prod"); }),
      ]) {
        swap(value, () => expect(() => requireAcceptanceDatabase()).toThrow());
      }
      process.env.PGSERVICE = "prod";
      try { expect(() => requireAcceptanceDatabase()).toThrow(/PGSERVICE/); } finally { delete process.env.PGSERVICE; }

      for (const name of URL_VARS) {
        const url = new URL(process.env[name]!);
        expect({ name, host: url.hostname, port: url.port, path: url.pathname }).toEqual({
          name,
          host: "127.0.0.1",
          port: ACCEPTANCE_PORT,
          path: `/${ACCEPTANCE_DATABASE}`,
        });
      }

      // The route's own ingest client is bound to exactly this database as ingest_rw. The server-side
      // port is not compared: CI publishes host 15543 onto container port 5432.
      const [bound] = await ingestPrisma.$queryRaw<Array<{ who: string; dbname: string; su: boolean }>>`
        SELECT current_user::text AS who, current_database()::text AS dbname,
               (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`;
      expect(bound).toEqual({ who: "ingest_rw", dbname: ACCEPTANCE_DATABASE, su: false });
    });

    it("rejects unauthenticated ingest callers before any source read or write", async () => {
      setMode("write");
      source.serve([household(run(0x401), linked(1, ["at-a"]))]);
      const before = await identityDigest();
      const mark = await auditMark();
      for (const auth of [null, "Bearer wrong-token", `Basic ${TOKEN}`, "Bearer"]) {
        expect((await pull({ auth })).status).toBe(401);
      }
      delete process.env.INGEST_TOKEN;
      expect((await pull()).status).toBe(401);
      process.env.INGEST_TOKEN = TOKEN;
      process.env.AOA_WRITES_PAUSED = "1";
      try { expect((await pull()).status).toBe(401); } finally { delete process.env.AOA_WRITES_PAUSED; }
      expect(source.requests).toHaveLength(0);
      expect(await householdExists(run(0x401))).toBe(false);
      expect(await identityDigest()).toBe(before);
      expect(await auditsSince(mark)).toEqual([]);
    });

    it("never falls back when the source URL is unset and stops on source authentication failure", async () => {
      setMode("write");
      const id = run(0x402);
      source.serve([household(id, linked(1, ["at-a"]))]);
      const before = await identityDigest();
      const mark = await auditMark();

      delete process.env.STATEMENT_PIPELINE_URL;
      expect(await pull()).toEqual({ status: 503, body: { error: "config_error" } });
      expect(source.requests).toHaveLength(0);
      process.env.STATEMENT_PIPELINE_URL = source.url;

      source.audience = "https://statement-pipeline.example.invalid";
      const rejected = await pull();
      expect(rejected).toEqual({
        status: 502,
        body: { error: "pipeline_error", identity: { mode: "write", status: "not_attempted", reason: "fetch_failed" } },
      });
      expect(source.requests.map((r) => r.authorized)).toEqual([false]);
      expect(await householdExists(id)).toBe(false);
      expect(await identityDigest()).toBe(before);
      expect(await auditsSince(mark)).toEqual([]);

      // Positive control: the same request with the audience the source expects.
      source.audience = source.url;
      oidcAudiences.length = 0;
      expect((await pull()).body.identity?.status).toBe("applied");
      expect(oidcAudiences).toEqual([source.url]);
      expect(source.requests.at(-1)).toEqual({ page: 1, perPage: 200, includeSuperseded: "true", authorized: true });
      expect(await active(id)).toEqual(["at-a"]);
    });

    it("lets only ingest_rw use identity data; app_rw and PUBLIC are denied; FORCE RLS binds the non-superuser definer owner", async () => {
      const id = run(0x403);
      await apply([household(id, linked(1, ["at-solo"]))]);
      const sqlState = async (promise: Promise<unknown>) => {
        try { await promise; return "ok"; } catch (error) {
          return (error as { meta?: { code?: string } }).meta?.code ?? String((error as Error).message).match(/\b42501\b/)?.[0] ?? "error";
        }
      };
      const tables = ["mirror.acat_asset_map_run_identity", "mirror.acat_asset_map_run_person", "mirror.acat_asset_map_run_identity_history"];

      // Authorized ingest path.
      for (const table of tables) {
        const [row] = await db.ingest.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM ${table} WHERE run_id = $1`, id);
        expect(Number(row.n), table).toBeGreaterThan(0);
      }
      const [resolved] = await db.ingest.$queryRaw<Array<{ outcome: string; target: string }>>`
        SELECT outcome, canonical_contact_identity_id AS target FROM app.resolve_asset_map_run_people(ARRAY['at-solo']::text[])`;
      expect(resolved).toEqual({ outcome: "resolved", target: con(1) });

      // Runtime app_rw, even as OPERATIONS, after a control read it is allowed.
      const asOps = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
        db.app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.user_role', 'OPERATIONS', true), set_config('app.user_email', 'ops@example.invalid', true)`;
          return fn(tx);
        });
      const control = await asOps((tx) => tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM mirror.acat_asset_map_household WHERE id = ${id}`);
      expect(Number(control[0].n)).toBe(1);
      for (const table of tables) {
        expect(await sqlState(asOps((tx) => tx.$queryRawUnsafe(`SELECT count(*) FROM ${table}`))), table).toBe("42501");
        expect(await sqlState(db.app.$executeRawUnsafe(`INSERT INTO ${table} DEFAULT VALUES`)), table).toBe("42501");
      }
      expect(await sqlState(db.app.$queryRaw`SELECT * FROM app.resolve_asset_map_run_people(ARRAY['at-solo']::text[])`)).toBe("42501");

      // A role holding only PUBLIC privileges.
      const asPublic = (statement: string) => db.fixture.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PUBLIC_PROBE}`);
        return tx.$queryRawUnsafe(statement);
      });
      expect(await sqlState(asPublic("SELECT 1"))).toBe("ok");
      for (const table of tables) expect(await sqlState(asPublic(`SELECT count(*) FROM ${table}`)), table).toBe("42501");
      expect(await sqlState(asPublic(`SELECT * FROM app.resolve_asset_map_run_people(ARRAY['at-solo']::text[])`))).toBe("42501");

      // Non-superuser owner: FORCE RLS hides every row from it, yet its SECURITY DEFINER resolver works.
      const [definer] = await db.fixture.$queryRaw<Array<{ secdef: boolean; owner: string; su: boolean; bypass: boolean }>>`
        SELECT p.prosecdef AS secdef, r.rolname::text AS owner, r.rolsuper AS su, r.rolbypassrls AS bypass
          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.oid = 'app.resolve_asset_map_run_people(text[])'::regprocedure`;
      expect(definer).toEqual({ secdef: true, owner: db.ownerRole, su: false, bypass: false });
      for (const table of tables) {
        const [flags] = await db.fixture.$queryRawUnsafe<Array<{ rls: boolean; forced: boolean }>>(
          `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE oid = '${table}'::regclass`);
        expect(flags, table).toEqual({ rls: true, forced: true });
        const [row] = await db.owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM ${table}`);
        expect(Number(row.n), table).toBe(0);
      }
      const [owned] = await db.owner.$queryRaw<Array<{ outcome: string }>>`
        SELECT outcome FROM app.resolve_asset_map_run_people(ARRAY['at-solo']::text[])`;
      expect(owned.outcome).toBe("resolved");
    });

    it("keeps client names, person ids and account numbers out of responses, logs and audit", async () => {
      logs.length = 0;
      const mark = await auditMark();
      setMode("preview");
      source.serve([withAccount(household(run(0x404), linked(1, ["at-solo", "at-two"])))]);
      const preview = await pull();
      const written = await apply([withAccount(household(run(0x404), linked(1, ["at-solo", "at-two"])))]);
      expect(written.inserted).toBe(1);
      const audits = await auditsSince(mark);
      expect(audits.map((a) => a.action)).toContain("ingest.asset_map_run_identity");
      const surface = JSON.stringify([preview.body, written, logs, audits]);
      for (const secret of ["at-solo", "at-two", "Synthetic Run", "SYNTHETIC-R272-0001", con(1), contactKey(NS, 1)]) {
        expect(surface).not.toContain(secret);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("T4.1 accepted relationships end to end", () => {
    it("applies every frozen producer vector, served verbatim, with the expected stored state and targets", async () => {
      const vectors = loadMachineExportFixture().vectors;
      const runs = vectors.map((_, i) => run(0x100 + i));
      const counts = await apply(vectors.map((v, i) => household(runs[i], structuredClone(v.client_link))));
      expect(counts).toMatchObject({ observed: 8, inserted: 8, historyRows: 8, missingParent: 0 });
      for (const [i, vector] of vectors.entries()) {
        const link = vector.client_link;
        expect(await snapshot(runs[i]), vector.name).toMatchObject({
          version: link.identity_version, decision_id: link.decision_id, decision_state: link.decision_state,
          people_ids: link.people_ids, coverage: link.coverage, primary_user_id: link.primary_user_id,
          cedar_ridge_user_id: link.cedar_ridge_user_id, review_state: link.review_state, conflict_flags: link.conflict_flags,
        });
      }
      const outcomes = async (id: string) =>
        (await members(id)).map((m) => [m.cedar_ridge_user_id, m.resolution_outcome, m.canonical_contact_identity_id]);
      expect(await outcomes(runs[0])).toEqual([["cr-solo", "resolved", con(70)]]);
      // Shared, no primary: every accepted person kept; one has no AoA client yet.
      expect(await outcomes(runs[1])).toEqual([["cr-a", "resolved", con(71)], ["cr-b", "missing", null]]);
      expect(await outcomes(runs[2])).toEqual([["cr-primary", "resolved", con(72)], ["cr-secondary", "resolved", con(73)]]);
      expect(await outcomes(runs[3])).toEqual([["cr-partial", "resolved", con(74)]]);
      // A source conflict keeps the person but blocks the (resolvable) target.
      expect(await outcomes(runs[4])).toEqual([["cr-conflict", "conflict", null]]);
      for (const id of runs.slice(5)) expect(await members(id)).toEqual([]);
      expect((await snapshot(runs[7]))?.decision_id).toBeNull();
    });

    it("stores superseded runs independently even when their identities differ", async () => {
      const [current, old] = [run(0x110), run(0x111)];
      await apply([
        household(current, linked(1, ["at-new"]), { source_folder_id: `${BASELINE}folder-history`, run_number: 2 }),
        household(old, linked(4, ["at-old"]), { source_folder_id: `${BASELINE}folder-history`, superseded_by: current }),
      ]);
      expect(await active(old)).toEqual(["at-old"]);
      expect(await active(current)).toEqual(["at-new"]);
      await apply([
        household(current, linked(2, ["at-new", "at-a"]), { source_folder_id: `${BASELINE}folder-history`, run_number: 2 }),
        household(old, linked(4, ["at-old"]), { source_folder_id: `${BASELINE}folder-history`, superseded_by: current }),
      ]);
      expect(await active(current)).toEqual(["at-a", "at-new"]);
      expect(await active(old)).toEqual(["at-old"]);
      expect((await history(old)).map((h) => h.version)).toEqual([4]);
      const [mirror] = await db.fixture.$queryRaw<Array<{ superseded_by: string | null }>>`
        SELECT superseded_by FROM mirror.acat_asset_map_household WHERE id = ${old}`;
      expect(mirror.superseded_by).toBe(current);
    });

    it("follows confirm → correction → explicit unlink → relink with retained history", async () => {
      const id = run(0x120);
      await apply([household(id, linked(1, ["at-x"]))]);
      expect(await active(id)).toEqual(["at-x"]);
      await apply([household(id, linked(2, ["at-y"]))]);
      expect(await members(id)).toEqual([
        expect.objectContaining({ cedar_ridge_user_id: "at-x", membership_state: "retired", resolution_outcome: null }),
        expect.objectContaining({ cedar_ridge_user_id: "at-y", membership_state: "active", canonical_contact_identity_id: con(56) }),
      ]);
      await apply([household(id, unlinked(3))]);
      expect(await active(id)).toEqual([]);
      expect(await snapshot(id)).toMatchObject({ decision_state: "unlinked", decision_id: decisionFor(3), people_ids: [] });
      await apply([household(id, linked(4, ["at-x"]))]);
      expect(await active(id)).toEqual(["at-x"]);
      expect((await members(id)).find((m) => m.cedar_ridge_user_id === "at-x")?.canonical_contact_identity_id).toBe(con(55));
      expect((await history(id)).map((h) => [h.consumer_revision, h.version, h.source_changed]))
        .toEqual([[1, 1, true], [2, 2, true], [3, 3, true], [4, 4, true]]);
    });

    it("reverts a first confirmation to the initial empty state with a null decision", async () => {
      const id = run(0x121);
      await apply([household(id, unreviewed(0))]);
      expect(await snapshot(id)).toMatchObject({ decision_state: "unreviewed", decision_id: null, people_ids: [] });
      await apply([household(id, linked(1, ["at-solo"]))]);
      expect(await active(id)).toEqual(["at-solo"]);
      await apply([household(id, unlinked(2, null))]);
      expect(await snapshot(id)).toMatchObject({ version: 2, decision_state: "unlinked", decision_id: null, people_ids: [] });
      expect(await members(id)).toEqual([expect.objectContaining({ cedar_ridge_user_id: "at-solo", membership_state: "retired" })]);
    });

    it("preserves accepted state when the extension is unavailable or missing", async () => {
      const id = run(0x122);
      await apply([household(id, linked(1, ["at-solo"]))]);
      const unavailable = await apply([household(id, UNAVAILABLE)]);
      expect(unavailable).toMatchObject({ observed: 1, unavailablePreserved: 1, historyRows: 0, membersRetired: 0 });
      expect(await snapshot(id)).toMatchObject({ version: 1, people_ids: ["at-solo"], last_observed_availability: "unavailable" });

      setMode("write");
      source.serve([household(id)]);
      const missing = await pull();
      expect(missing.body.identity).toMatchObject({ status: "applied", counts: { observed: 0 } });
      expect(missing.body.identity?.census?.runs).toMatchObject({ observed: 1, unavailableMissing: 1, available: 0 });
      expect(await active(id)).toEqual(["at-solo"]);
      expect(await history(id)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("T4.2 failures preserve the last accepted state", () => {
    const sentinel = run(0x200);
    const accepted = linked(3, ["at-x"]);
    const newer = linked(9, ["at-y"]);
    const filler = Array.from({ length: 199 }, (_, i) => household(run(0x1000 + i)));
    const fullPage = (link: ClientLink = newer) => [household(sentinel, link), ...filler];

    beforeAll(async () => {
      await apply([household(sentinel, accepted)]);
    });

    async function expectSentinelPreserved() {
      expect(await snapshot(sentinel)).toMatchObject({ version: 3, people_ids: ["at-x"], quarantine_reason: null });
      expect(await active(sentinel)).toEqual(["at-x"]);
      expect((await history(sentinel)).map((h) => h.version)).toEqual([3]);
    }

    const pages: Array<[string, (page: number) => SourceReply, string]> = [
      ["short page", (p) => envelope(p, 3, p === 1 ? [household(sentinel, newer)] : p === 2 ? [filler[0]] : []), "short_page"],
      ["missing page", (p) => envelope(p, 201, p === 1 ? fullPage() : []), "short_page"],
      ["duplicate page", (p) => envelope(p, 201, p === 1 ? fullPage() : [household(sentinel, newer)]), "duplicate_run"],
      ["conflicting duplicate", (p) => envelope(p, 201, p === 1 ? fullPage() : [household(sentinel, linked(9, ["at-x"]))]), "conflicting_duplicate"],
      ["drifting total", (p) => envelope(p, p === 1 ? 201 : 202, p === 1 ? fullPage() : p === 2 ? [household(run(0x1100))] : []), "total_changed"],
      ["page safety cap", (p) => envelope(p, 50 * 200 + 1, p === 1 ? fullPage() : []), "safety_cap"],
      ["over-reported page", (p) => envelope(p, 0, [household(sentinel, newer)]), "over_total"],
      ["page sequence", (p) => envelope(p + 1, 1, [household(sentinel, newer)]), "page_sequence"],
      ["per_page mismatch", (p) => envelope(p, 1, [household(sentinel, newer)], 100), "per_page_mismatch"],
      ["malformed envelope", (p) => ({ status: 200, body: { page: p, per_page: "200", total: 1, households: [household(sentinel, newer)] } }), "envelope_invalid"],
      ["non-JSON body", () => ({ status: 200, body: "<html>not json</html>" }), "envelope_invalid"],
    ];

    it.each(pages)("blocks the identity phase on a %s while the base import still commits", async (_label, reply, reason) => {
      setMode("write");
      source.serve([]);
      source.respond = (page) => reply(page);
      const mark = await auditMark();
      const { status, body } = await pull();
      expect(status).toBe(200);
      expect(body.base_status).toBe("committed");
      expect(body.identity).toMatchObject({ mode: "write", status: "blocked" });
      expect(body.identity?.reasons).toContain(reason);
      expect((await auditsSince(mark)).map((a) => a.action)).toEqual(["ingest.asset_map"]);
      await expectSentinelPreserved();
    });

    it("fails the whole pull on a failed page with no base or identity writes", async () => {
      setMode("write");
      const fresh = run(0x201);
      source.respond = (page) => page === 1
        ? envelope(1, 201, [household(fresh, linked(1, ["at-a"])), household(sentinel, newer), ...filler.slice(1)])
        : { status: 500, body: { error: "boom" } };
      const mark = await auditMark();
      expect(await pull()).toEqual({
        status: 502,
        body: { error: "pipeline_error", identity: { mode: "write", status: "not_attempted", reason: "fetch_failed" } },
      });
      expect(await householdExists(fresh)).toBe(false);
      expect(await auditsSince(mark)).toEqual([]);
      await expectSentinelPreserved();
    });

    it("rejects an over-cap response before any write", async () => {
      setMode("write");
      const giant = run(0x202);
      const positions = Array.from({ length: 20_001 }, (_, i) => ({ id: `${giant}:p${i}`, account_id: `${giant}:a1` }));
      source.serve([
        household(sentinel, newer),
        household(giant, linked(1, ["at-a"]), { accounts: [{ id: `${giant}:a1`, household_id: giant, assets: positions }] }),
      ]);
      expect(await pull()).toEqual({
        status: 413,
        body: { error: "too_large", identity: { mode: "write", status: "not_attempted", reason: "row_cap" } },
      });
      expect(await householdExists(giant)).toBe(false);
      await expectSentinelPreserved();
    });

    it("quarantines malformed, over-cap and unsupported runs individually while valid runs advance", async () => {
      const [malformed, overCap, unsupported, valid] = [run(0x203), run(0x204), run(0x205), run(0x206)];
      await apply([household(unsupported, linked(1, ["at-b"]))]);
      setMode("write");
      source.serve([
        household(sentinel, { ...newer, schema_version: 2 }),
        household(unsupported, { ...linked(2, ["at-c1"]), schema_version: 2 }),
        household(malformed, { ...linked(1, ["at-a", "at-b"]), people_ids: ["at-b", "at-a"] }),
        household(overCap, linked(1, Array.from({ length: 101 }, (_, i) => `at-cap-${String(i).padStart(3, "0")}`))),
        household(valid, linked(1, ["at-a"])),
      ]);
      const { body } = await pull();
      expect(body.identity).toMatchObject({ status: "applied", census: { complete: true, reasons: [] } });
      expect(body.identity?.census?.runs).toMatchObject({ observed: 5, quarantined: 2, unavailableUnsupported: 2, available: 1 });
      expect(body.identity?.counts).toMatchObject({ observed: 1, inserted: 1 });
      for (const id of [malformed, overCap]) expect(await snapshot(id)).toBeUndefined();
      expect(await active(unsupported)).toEqual(["at-b"]);
      expect(await active(valid)).toEqual(["at-a"]);
      await expectSentinelPreserved();
    });

    it("rejects stale versions, quarantines equal-version changes and recovers on a newer valid version", async () => {
      const id = run(0x207);
      await apply([household(id, linked(5, ["at-x"]))]);
      expect((await apply([household(id, linked(4, ["at-y"]))]))).toMatchObject({ staleRejected: 1, historyRows: 0 });
      expect(await snapshot(id)).toMatchObject({ version: 5, people_ids: ["at-x"], quarantine_reason: null });

      expect(await apply([household(id, linked(5, ["at-y"]))])).toMatchObject({ quarantinedEqualVersion: 1, historyRows: 0 });
      expect(await snapshot(id)).toMatchObject({ version: 5, people_ids: ["at-x"], quarantine_reason: "equal_version_mutation" });
      expect(await active(id)).toEqual(["at-x"]);

      expect(await apply([household(id, unreviewed(6))])).toMatchObject({ quarantinedUnreviewed: 1, membersRetired: 0 });
      expect(await snapshot(id)).toMatchObject({ people_ids: ["at-x"], quarantine_reason: "unreviewed_after_accepted" });

      expect(await apply([household(id, linked(7, ["at-y"]))])).toMatchObject({ sourceApplied: 1, membersRetired: 1 });
      expect(await snapshot(id)).toMatchObject({ version: 7, people_ids: ["at-y"], quarantine_reason: null });
      expect((await history(id)).map((h) => h.version)).toEqual([5, 7]);
    });

    it("never retires a run missing from a pull, while a valid explicit unlink does retire", async () => {
      const [a, b] = [run(0x208), run(0x209)];
      await apply([household(a, linked(1, ["at-a"])), household(b, linked(1, ["at-b"]))]);
      expect(await apply([household(b, linked(1, ["at-b"]))])).toMatchObject({ observed: 1, membersRetired: 0 });
      expect(await active(a)).toEqual(["at-a"]);
      expect(await history(a)).toHaveLength(1);
      expect(await apply([household(a, unlinked(2)), household(b, linked(1, ["at-b"]))]))
        .toMatchObject({ sourceApplied: 1, membersRetired: 1 });
      expect(await active(a)).toEqual([]);
      expect(await active(b)).toEqual(["at-b"]);
    });

    it("serializes concurrent workers so the newest version wins regardless of lock order", async () => {
      const id = run(0x20a);
      await apply([household(id, linked(1, ["at-c1"]))]);
      setMode("write");
      for (const [lower, higher] of [[2, 3], [4, 5]]) {
        source.serve([]);
        const start = source.requests.length;
        source.respond = (page, _perPage, index) => envelope(page, 1, [household(id,
          index === start ? linked(lower, ["at-c2"]) : linked(higher, ["at-c3"]))]);
        const results = await Promise.all([pull(), pull()]);
        for (const r of results) expect(r.body.identity?.status).toBe("applied");
        const applied = results.reduce((n, r) => n + r.body.identity!.counts!.sourceApplied, 0);
        const stale = results.reduce((n, r) => n + r.body.identity!.counts!.staleRejected, 0);
        expect(applied + stale).toBe(2);
        expect(applied).toBeGreaterThanOrEqual(1);
        expect(await snapshot(id)).toMatchObject({ version: higher, people_ids: ["at-c3"] });
        expect(await active(id)).toEqual(["at-c3"]);
      }
      const versions = (await history(id)).map((h) => h.version);
      expect(versions).toEqual([...versions].sort((x, y) => x - y));
      expect(versions.at(-1)).toBe(5);
      expect((await history(id)).map((h) => h.consumer_revision)).toEqual(versions.map((_, i) => i + 1));
    });

    it("inserts a run observed by two concurrent first workers exactly once", async () => {
      const id = run(0x20b);
      setMode("write");
      source.serve([household(id, linked(1, ["at-a", "at-b"]))]);
      const results = await Promise.all([pull(), pull()]);
      const counts = results.map((r) => r.body.identity!.counts!);
      expect(counts.reduce((n, c) => n + c.inserted, 0)).toBe(1);
      expect(counts.reduce((n, c) => n + c.unchanged, 0)).toBe(1);
      expect(await history(id)).toHaveLength(1);
      expect(await active(id)).toEqual(["at-a", "at-b"]);
    });

    it("makes a worker that waited on the identity lock re-plan against the newer commit", async () => {
      const id = run(0x20c);
      await apply([household(id, linked(1, ["at-a"]))]);
      const parsed = parseRunIdentity(id, linked(5, ["at-c1"]));
      if (!parsed.ok) throw new Error("invalid synthetic observation");
      const newerObservation: RunIdentityObservation = parsed.value;
      let release!: () => void;
      let holding!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const held = new Promise<void>((resolve) => { holding = resolve; });
      const holder = db.ingest.$transaction(async (tx) => {
        await persistRunIdentities(tx, [newerObservation]);
        holding();
        await gate;
      }, { timeout: 30_000 });
      await held;
      setMode("write");
      source.serve([household(id, linked(4, ["at-b"]))]);
      const worker = pull();
      await waitForAdvisoryWaiter(db);
      release();
      await holder;
      const { body } = await worker;
      expect(body.identity?.counts).toMatchObject({ staleRejected: 1, sourceApplied: 0 });
      expect(await snapshot(id)).toMatchObject({ version: 5, people_ids: ["at-c1"] });
      expect((await history(id)).map((h) => h.version)).toEqual([1, 5]);
    });

    describe("injected failures", () => {
      const id = run(0x20d);
      const added = run(0x20e);

      beforeAll(async () => {
        await apply([household(id, linked(1, ["at-a"]))]);
      });

      it.each([
        ["identity member write", "mirror.acat_asset_map_run_person", "NEW.cedar_ridge_user_id = 'at-poison'"],
        ["identity audit write", 'audit."AuditLog"', "NEW.action = 'ingest.asset_map_run_identity'"],
      ])("rolls back the whole identity phase on an injected %s failure, keeping the base import", async (_label, table, when) => {
        const mark = await auditMark();
        await inject(table, when);
        try {
          setMode("write");
          source.serve([household(id, linked(2, ["at-poison"])), household(added, linked(1, ["at-b"]))]);
          const { status, body } = await pull();
          expect(status).toBe(500);
          expect(body).toMatchObject({ base_status: "committed", identity: { status: "failed", reason: "transaction_failed" } });
        } finally {
          await dropInjections();
        }
        expect(await householdExists(added)).toBe(true);
        expect(await snapshot(added)).toBeUndefined();
        expect(await snapshot(id)).toMatchObject({ version: 1, people_ids: ["at-a"] });
        expect((await history(id)).map((h) => h.version)).toEqual([1]);
        expect((await auditsSince(mark)).map((a) => a.action)).toEqual(["ingest.asset_map"]);
      });

      it("permits no identity writes when the base import fails, even for existing parents", async () => {
        const mark = await auditMark();
        await inject('audit."AuditLog"', "NEW.action = 'ingest.asset_map'");
        try {
          setMode("write");
          source.serve([household(id, linked(3, ["at-b"]))]);
          expect(await pull()).toEqual({
            status: 500,
            body: { error: "internal", identity: { mode: "write", status: "not_attempted", reason: "base_failed" } },
          });
        } finally {
          await dropInjections();
        }
        expect(await snapshot(id)).toMatchObject({ version: 1, people_ids: ["at-a"] });
        expect(await auditsSince(mark)).toEqual([]);
      });

      it("applies the same pull once the fault is removed (positive control)", async () => {
        const counts = await apply([household(id, linked(2, ["at-poison"])), household(added, linked(1, ["at-b"]))]);
        expect(counts).toMatchObject({ sourceApplied: 1, inserted: 1 });
        expect(await active(id)).toEqual(["at-poison"]);
        expect(await active(added)).toEqual(["at-b"]);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("T4.3 canonical CRM resolution end to end", () => {
    it("reports missing, ambiguous and conflict explicitly and converges aliases on one survivor", async () => {
      const cases: Array<[string, string, string | null]> = [
        ["at-solo", "resolved", con(1)],
        ["at-merged", "resolved", con(5)],
        ["at-alias", "resolved", con(6)],
        ["at-chain", "resolved", con(9)],
        ["at-bound", "resolved", con(37)],
        ["at-nobody", "missing", null],
        ["AT-SOLO", "missing", null],
        ["at-two", "ambiguous", null],
        ["at-branch", "conflict", null],
        ["at-cycle", "conflict", null],
        ["at-deep", "conflict", null],
        ["at-conflicting", "conflict", null],
        ["at-archived", "conflict", null],
        ["at-superseded", "conflict", null],
        ["at-unregistered", "conflict", null],
      ];
      const runs = cases.map((_, i) => run(0x300 + i));
      const counts = await apply(cases.map(([person], i) => household(runs[i], linked(1, [person]))));
      expect(counts).toMatchObject({ inserted: cases.length, resolved: 5, missing: 2, ambiguous: 1, conflict: 7 });
      for (const [i, [person, outcome, target]] of cases.entries()) {
        expect(await members(runs[i]), person).toEqual([{
          cedar_ridge_user_id: person, membership_state: "active", resolution_outcome: outcome, canonical_contact_identity_id: target,
        }]);
      }
    });

    it("re-resolves CRM merge, revocation, removal and deactivation with an unchanged source version", async () => {
      const id = run(0x320);
      const pullSame = () => apply([household(id, linked(1, ["at-merge"]))]);
      const target = async () => (await members(id))[0];
      await pullSame();
      expect(await target()).toMatchObject({ resolution_outcome: "resolved", canonical_contact_identity_id: con(60) });

      expect(await pullSame()).toMatchObject({ unchanged: 1, historyRows: 0 });

      await seed.contact({ n: 61, cedarRidgeUserId: "at-merge" });
      const merge = await seed.edge({ from: 60, to: 61 });
      expect(await pullSame()).toMatchObject({ unchanged: 1, resolutionRefreshed: 1, historyRows: 1 });
      expect(await target()).toMatchObject({ membership_state: "active", resolution_outcome: "resolved", canonical_contact_identity_id: con(61) });

      await seed.reopen(merge);
      await pullSame();
      expect(await target()).toMatchObject({ membership_state: "active", resolution_outcome: "ambiguous", canonical_contact_identity_id: null });

      await seed.setCedarRidgeUserId(61, null);
      await pullSame();
      expect(await target()).toMatchObject({ resolution_outcome: "resolved", canonical_contact_identity_id: con(60) });

      await seed.archive(60);
      await pullSame();
      expect(await target()).toMatchObject({ resolution_outcome: "conflict", canonical_contact_identity_id: null });

      await seed.setCedarRidgeUserId(60, null);
      await pullSame();
      expect(await target()).toMatchObject({ membership_state: "active", resolution_outcome: "missing", canonical_contact_identity_id: null });

      const rows = await history(id);
      expect(rows.map((h) => [h.consumer_revision, h.version, h.source_changed, h.resolution_changed])).toEqual([
        [1, 1, true, true], [2, 1, false, true], [3, 1, false, true], [4, 1, false, true], [5, 1, false, true], [6, 1, false, true],
      ]);
      expect(await snapshot(id)).toMatchObject({ version: 1, consumer_revision: 6 });
    });
  });

  // -------------------------------------------------------------------------
  describe("T4.5 modes, rollback controls and baseline relations", () => {
    const [legacy, p1, p2, p3] = [run(0x500), run(0x501), run(0x502), run(0x503)];
    const sourceFor = (p1Link: ClientLink | undefined, withP3: boolean, includeLinks = true) => [
      withAccount(household(legacy, includeLinks ? linked(1, ["at-solo"]) : undefined)),
      withAccount(household(p1, includeLinks ? p1Link : undefined)),
      withAccount(household(p2, includeLinks ? linked(1, ["at-b", "at-c1"]) : undefined)),
      ...(withP3 ? [withAccount(household(p3, includeLinks ? unreviewed(0) : undefined))] : []),
    ];
    const BASELINE_SCOPES: Record<string, string> = {
      "mirror.acat_asset_map_link": "true",
      "mirror.acat_asset_map_account_link": "true",
      "app.transfer": "true",
      "mirror.household": "true",
      "mirror.client": "true",
      "app.crm_identity": "true",
      "app.crm_source_mapping": "true",
      "app.crm_duplicate_candidate": "true",
      "mirror.acat_asset_map_household": `id NOT LIKE '${RUN_PREFIX}%'`,
      "mirror.acat_asset_map_account": `household_id NOT LIKE '${RUN_PREFIX}%'`,
      "mirror.acat_asset_map_position": `account_id NOT LIKE '${RUN_PREFIX}%'`,
    };

    async function baseline(): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      for (const [table, scope] of Object.entries(BASELINE_SCOPES)) {
        const [row] = await db.fixture.$queryRawUnsafe<Array<{ d: string; n: bigint }>>(
          `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d, count(*) AS n FROM ${table} t WHERE ${scope}`);
        out[table] = `${row.n}:${row.d}`;
      }
      return out;
    }

    async function cleanupBaseline(): Promise<void> {
      const like = `${BASELINE}%`;
      await db.fixture.$executeRaw`DELETE FROM app.transfer WHERE id LIKE ${like}`;
      await db.fixture.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE ${like}`;
      await db.fixture.$executeRaw`DELETE FROM mirror.acat_asset_map_account_link WHERE source_folder_id LIKE ${like}`;
      await db.fixture.$executeRaw`DELETE FROM mirror.acat_asset_map_link WHERE source_folder_id LIKE ${like}`;
      await db.fixture.$executeRaw`DELETE FROM mirror.acat_asset_map_household WHERE id LIKE ${like}`;
      await db.fixture.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE ${like}`;
      await db.fixture.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE ${like}`;
    }

    beforeAll(async () => {
      await cleanupBaseline();
      const b = (s: string) => `${BASELINE}${s}`;
      await db.fixture.$executeRaw`INSERT INTO mirror.household (sf_id, name) VALUES (${b("crm-household")}, 'Synthetic Household')`;
      await db.fixture.$executeRaw`
        INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, cedar_ridge_user_id)
        VALUES (${b("client")}, ${b("crm-household")}, 'Synthetic', 'Baseline', 'at-solo-baseline')`;
      await db.fixture.$executeRaw`
        INSERT INTO mirror.acat_asset_map_household (id, source_folder_id, client_name, client_sf_id, cedar_ridge_user_id)
        VALUES (${b("run")}, ${b("folder")}, 'Synthetic Baseline', ${b("client")}, 'at-solo-baseline')`;
      await db.fixture.$executeRaw`
        INSERT INTO mirror.acat_asset_map_account (id, household_id, custodian, account_number)
        VALUES (${b("account")}, ${b("run")}, 'Synthetic Custodian', 'SYNTHETIC-R272-9999')`;
      await db.fixture.$executeRaw`
        INSERT INTO mirror.acat_asset_map_link (source_folder_id, household_sf_id, match_status)
        VALUES (${b("folder")}, ${b("crm-household")}, 'CONFIRMED')`;
      await db.fixture.$executeRaw`
        INSERT INTO mirror.acat_asset_map_account_link
          (source_folder_id, custodian, account_number, client_sf_id, cedar_ridge_user_id, ownership_role, is_entity, match_status)
        VALUES (${b("folder")}, 'Synthetic Custodian', 'SYNTHETIC-R272-9999', ${b("client")}, 'at-solo-baseline', 'PRIMARY', false, 'CONFIRMED')`;
      await db.fixture.$executeRaw`
        INSERT INTO app.transfer (id, source, client_first_name, client_last_name, value, updated_at,
                                  asset_map_folder_id, asset_map_custodian, asset_map_account_number)
        VALUES (${b("transfer")}, 'APP', 'Synthetic', 'Baseline', 1, now(), ${b("folder")}, 'Synthetic Custodian', 'SYNTHETIC-R272-9999')`;
      // A run that already exists with legacy scalars before identity sync touches it.
      await db.fixture.$executeRaw`
        INSERT INTO mirror.acat_asset_map_household (id, client_name, run_number, client_sf_id, cedar_ridge_user_id)
        VALUES (${legacy}, 'Synthetic Run', 1, 'legacy-sf-untouched', 'legacy-cr-untouched')`;
    });

    afterAll(async () => {
      await cleanupBaseline();
    });

    it("walks off → writes-only → dry-run → preview → write → rollback with exact writes, reads and baseline", async () => {
      const before = await baseline();
      const reads = () => source.requests.length;
      const step = async (mode: Mode, households: Household[], dryRun = false) => {
        setMode(mode);
        source.serve(households);
        const readsBefore = reads();
        const digestBefore = await identityDigest();
        const mark = await auditMark();
        const result = await pull({ dryRun });
        expect(result.status).toBe(200);
        expect(reads() - readsBefore).toBe(1);
        const actions = (await auditsSince(mark)).map((a) => a.action);
        return { ...result, actions, identityChanged: (await identityDigest()) !== digestBefore };
      };

      for (const mode of ["off", "writes_only"] as const) {
        const off = await step(mode, sourceFor(linked(1, ["at-a"]), false));
        expect(off.body.identity).toBeUndefined();
        expect(off.body.upserted).toEqual({ households: 3, accounts: 3, positions: 3 });
        expect(off.identityChanged).toBe(false);
        expect(off.actions).toEqual(["ingest.asset_map"]);
      }

      const dry = await step("write", sourceFor(linked(1, ["at-a"]), true), true);
      expect(dry.body.would_upsert).toEqual({ households: 4, accounts: 4, positions: 4 });
      expect(dry.body.identity).toMatchObject({ mode: "write", status: "previewed", diagnostics: { dryRun: true } });
      expect(await householdExists(p3)).toBe(false);
      expect(dry.identityChanged).toBe(false);
      expect(dry.actions).toEqual([]);

      const preview = await step("preview", sourceFor(linked(1, ["at-a"]), true));
      expect(preview.body.base_status).toBe("committed");
      expect(preview.body.identity?.diagnostics?.plan).toMatchObject({ status: "available", wouldAdd: 4, transitions: { inserted: 4 } });
      expect(await householdExists(p3)).toBe(true);
      expect(preview.identityChanged).toBe(false);
      expect(preview.actions).toEqual(["ingest.asset_map"]);

      // Positive control: the same pull in write mode does write and audit.
      const write = await step("write", sourceFor(linked(1, ["at-a"]), true));
      expect(write.body.identity).toMatchObject({ status: "applied", audited: true, counts: { inserted: 4, membersActivated: 4 } });
      expect(write.identityChanged).toBe(true);
      expect(write.actions).toEqual(["ingest.asset_map", "ingest.asset_map_run_identity"]);
      expect(await active(p1)).toEqual(["at-a"]);

      // Rollback control 1: writes gate off → a correction is previewed, not applied.
      const correction = linked(2, ["at-c2"]);
      const paused = await step("preview", sourceFor(correction, true));
      expect(paused.body.identity?.diagnostics?.plan).toMatchObject({ transitions: { source_applied: 1, unchanged: 3 }, wouldRetire: 1 });
      expect(paused.identityChanged).toBe(false);
      // Rollback control 2: identity off → legacy import only, stored relationships kept.
      const disabled = await step("off", sourceFor(correction, true));
      expect(disabled.body.identity).toBeUndefined();
      expect(disabled.identityChanged).toBe(false);
      // Rollback control 3: source export off (extension omitted) under write mode → preserved.
      const exportOff = await step("write", sourceFor(undefined, true, false));
      expect(exportOff.body.identity).toMatchObject({ status: "applied", audited: false, counts: { observed: 0 } });
      expect(await active(p1)).toEqual(["at-a"]);
      expect(await active(p2)).toEqual(["at-b", "at-c1"]);

      // Re-enable: the pending correction now applies.
      const resumed = await step("write", sourceFor(correction, true));
      expect(resumed.body.identity?.counts).toMatchObject({ sourceApplied: 1, unchanged: 3, membersRetired: 1 });
      expect(await active(p1)).toEqual(["at-c2"]);

      // Existing folder/account/transfer/CRM relations are untouched; only the
      // served runs changed, exactly as the ordinary base import defines.
      expect(await baseline()).toEqual(before);
      const [legacyRow] = await db.fixture.$queryRaw<Array<{ client_sf_id: string; cedar_ridge_user_id: string }>>`
        SELECT client_sf_id, cedar_ridge_user_id FROM mirror.acat_asset_map_household WHERE id = ${legacy}`;
      expect(legacyRow).toEqual({ client_sf_id: "legacy-sf-untouched", cedar_ridge_user_id: "legacy-cr-untouched" });
      const [served] = await db.fixture.$queryRaw<Array<{ h: bigint; a: bigint; p: bigint }>>`
        SELECT (SELECT count(*) FROM mirror.acat_asset_map_household WHERE id IN (${legacy}, ${p1}, ${p2}, ${p3})) AS h,
               (SELECT count(*) FROM mirror.acat_asset_map_account WHERE household_id IN (${legacy}, ${p1}, ${p2}, ${p3})) AS a,
               (SELECT count(*) FROM mirror.acat_asset_map_position WHERE account_id LIKE ${`${RUN_PREFIX}%`}
                   AND split_part(account_id, ':', 1) IN (${legacy}, ${p1}, ${p2}, ${p3})) AS p`;
      expect([served.h, served.a, served.p].map(Number)).toEqual([4, 4, 4]);
    });

    it("detects a baseline relation change (fingerprint positive control)", async () => {
      const before = await baseline();
      const folder = `${BASELINE}folder`;
      await db.fixture.$executeRaw`UPDATE mirror.acat_asset_map_link SET match_status = 'NEEDS_REVIEW' WHERE source_folder_id = ${folder}`;
      try {
        expect((await baseline())["mirror.acat_asset_map_link"]).not.toBe(before["mirror.acat_asset_map_link"]);
      } finally {
        await db.fixture.$executeRaw`UPDATE mirror.acat_asset_map_link SET match_status = 'CONFIRMED' WHERE source_folder_id = ${folder}`;
      }
      expect(await baseline()).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------
  describe("T4.6 aggregate accounting, replay and CRM-only revisions", () => {
    const ids = Array.from({ length: 11 }, (_, i) => run(0x600 + i));
    const households = () => [
      household(ids[0], linked(1, ["at-solo"])),
      household(ids[1], linked(1, ["at-a", "at-late"])),
      household(ids[2], linked(1, ["at-two"])),
      household(ids[3], linked(1, ["at-cycle"])),
      household(ids[4], linked(1, ["at-b"], { flags: ["folder_holder_mismatch"] })),
      household(ids[5], unreviewed(0)),
      household(ids[6], unlinked(1)),
      household(ids[7], UNAVAILABLE),
      household(ids[8]),
      household(ids[9], { ...linked(1, ["at-c1"]), schema_version: 2 }),
      household(ids[10], { ...linked(1, ["at-c1"]), coverage: "sideways" }),
    ];

    it("balances census and people counts, separating missing/ambiguous/conflict from expected no-ID runs", async () => {
      setMode("preview");
      source.serve(households());
      const { body } = await pull();
      const diagnostics = body.identity!.diagnostics!;
      expect(diagnosticEquationsHold(diagnostics)).toBe(true);
      expect(diagnostics.runs).toEqual({
        observed: 11, available: 7, unavailable: 3, quarantined: 1,
        unavailableBreakdown: { disabled: 1, missing: 1, unsupported: 1 },
        linked: 5, unlinked: 1, unreviewed: 1,
      });
      expect(diagnostics.people).toEqual({
        status: "available", accepted: 6, resolved: 2, missing: 1, ambiguous: 1, sourceConflict: 1, crmConflict: 1,
      });

      const counts = await apply(households());
      expect(counts).toMatchObject({
        observed: 8, inserted: 7, unavailablePreserved: 1, historyRows: 7, membersActivated: 6,
        resolved: 2, missing: 1, ambiguous: 1, conflict: 2,
      });
      const transitions = counts.inserted + counts.sourceApplied + counts.unchanged + counts.staleRejected +
        counts.quarantinedEqualVersion + counts.quarantinedUnreviewed + counts.unavailablePreserved + counts.missingParent;
      expect(transitions).toBe(counts.observed);
      const [stored] = await db.fixture.$queryRaw<Array<{ resolved: bigint; missing: bigint; ambiguous: bigint; conflict: bigint; bartell: bigint }>>`
        SELECT count(*) FILTER (WHERE p.resolution_outcome = 'resolved') AS resolved,
               count(*) FILTER (WHERE p.resolution_outcome = 'missing') AS missing,
               count(*) FILTER (WHERE p.resolution_outcome = 'ambiguous') AS ambiguous,
               count(*) FILTER (WHERE p.resolution_outcome = 'conflict') AS conflict,
               (SELECT count(*) FROM mirror.acat_asset_map_run_identity i
                 WHERE i.run_id = ANY(${ids}::text[]) AND cardinality(i.people_ids) = 0) AS bartell
          FROM mirror.acat_asset_map_run_person p
         WHERE p.run_id = ANY(${ids}::text[]) AND p.membership_state = 'active'`;
      expect([stored.resolved, stored.missing, stored.ambiguous, stored.conflict, stored.bartell].map(Number)).toEqual([2, 1, 1, 2, 2]);
    });

    it("treats an identical replay as zero source changes and zero history additions", async () => {
      const historyBefore = await Promise.all(ids.map(history));
      const mark = await auditMark();
      setMode("preview");
      source.serve(households());
      const preview = (await pull()).body.identity!.diagnostics!;
      expect(preview.plan).toMatchObject({ wouldAdd: 0, wouldRetire: 0, wouldRemap: 0, unchanged: 6, persistedDrift: 0 });
      const replay = await apply(households());
      expect(replay).toMatchObject({
        inserted: 0, sourceApplied: 0, unchanged: 7, unavailablePreserved: 1, historyRows: 0,
        membersActivated: 0, membersRetired: 0, resolutionRefreshed: 0,
      });
      expect(await Promise.all(ids.map(history))).toEqual(historyBefore);
      expect((await auditsSince(mark)).map((a) => a.action)).toEqual(["ingest.asset_map", "ingest.asset_map"]);
    });

    it("produces only the necessary consumer revision when CRM alone changes", async () => {
      const revisions = async () => Promise.all(ids.map(async (id) => (await snapshot(id))?.consumer_revision ?? null));
      const before = await revisions();
      await seed.contact({ n: 62, cedarRidgeUserId: "at-late" });
      setMode("preview");
      source.serve(households());
      expect((await pull()).body.identity!.diagnostics!.plan).toMatchObject({ wouldRemap: 1, persistedDrift: 1, wouldAdd: 0 });
      const counts = await apply(households());
      expect(counts).toMatchObject({ inserted: 0, sourceApplied: 0, resolutionRefreshed: 1, historyRows: 1, resolved: 3, missing: 0 });
      const after = await revisions();
      expect(after).toEqual(before.map((r, i) => (i === 1 ? r! + 1 : r)));
      expect((await history(ids[1])).at(-1)).toMatchObject({ source_changed: false, resolution_changed: true, version: 1 });
      expect((await members(ids[1])).find((m) => m.cedar_ridge_user_id === "at-late"))
        .toMatchObject({ resolution_outcome: "resolved", canonical_contact_identity_id: con(62) });
    });
  });
});
