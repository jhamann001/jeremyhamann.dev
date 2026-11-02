import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { prisma } from "@/lib/db";
import { getHouseholdDirectory, getHouseholdDirectoryPreview } from "@/lib/data/households";
import { DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS } from "@/lib/navigation/household-query";
import { withUserScope, type Identity } from "@/lib/rls";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const ADVISOR_A = "planner-263-a@example.invalid";
const ADVISOR_B = "planner-263-b@example.invalid";
const OPERATIONS = { role: "OPERATIONS", email: ADVISOR_A };
const key = (n: number) => `001P263${String(n).padStart(8, "0")}AAA`;
const identityId = (n: number) => `hld_planner263${n}`;
const candidateId = (n: number) => `dup_c${(263000 + n).toString(16).padStart(24, "0")}`;
const name = (n: number) => `PlannerFixture263 ${String(n).padStart(3, "0")}`;
type Pair = { source_key: string; canonical_source_key: string };
const pair = (source: number, target: number): Pair => ({ source_key: key(source), canonical_source_key: key(target) });
const sortPairs = (pairs: Pair[]) => [...pairs].sort((a, b) => a.source_key.localeCompare(b.source_key));

// Separate chains exercise the exact eight-lookup bound; a raw 15/18-character
// target alias remains ambiguous even though both rows share a normalized key.
const householdNumbers = [
  1, 2, 3, 4, 6, 7, 8, ...Array.from({ length: 8 }, (_, i) => i + 10),
  ...Array.from({ length: 9 }, (_, i) => i + 20), ...Array.from({ length: 8 }, (_, i) => i + 30),
  ...Array.from({ length: 12 }, (_, i) => i + 40),
];
const identityNumbers = [...householdNumbers, 5, 38];
const households = [
  ...householdNumbers.map((n) => ({ sf_id: key(n), name: name(n), email: n === 41 ? ADVISOR_B : ADVISOR_A })),
  { sf_id: key(34).slice(0, 15), name: name(34), email: ADVISOR_A },
];
const edges: Array<[number, number]> = [
  [1, 2], [4, 5], [6, 7], [7, 8],
  ...Array.from({ length: 7 }, (_, i): [number, number] => [10 + i, 11 + i]),
  ...Array.from({ length: 8 }, (_, i): [number, number] => [20 + i, 21 + i]),
  [30, 31], [30, 32], [33, 34], [35, 36], [36, 35], [37, 38],
  [40, 41], [42, 43], [44, 45], [46, 47], [48, 49], [50, 51],
];
const expectedOverlays = sortPairs([
  pair(1, 2), pair(6, 8), pair(7, 8),
  ...Array.from({ length: 7 }, (_, i) => pair(10 + i, 17)),
  ...Array.from({ length: 7 }, (_, i) => pair(21 + i, 28)),
  pair(40, 41), pair(48, 49), pair(50, 51),
]);
const candidateIds = edges.map((_, i) => candidateId(i));
const mappingIds = [...identityNumbers.map((n) => `planner263-map-${n}`), "planner263-map-49-alias"];

function requireLocalDatabase(): string {
  const cleanup = new URL(process.env.AUDIT_TEST_CLEANUP_URL ?? "invalid:");
  const app = new URL(process.env.DATABASE_URL ?? "invalid:");
  const synthetic = /^\/aoa_[a-z0-9_]+_synthetic$/.test(cleanup.pathname);
  // The dedicated synthetic clone preserves FORCE RLS and a non-BYPASS aoa
  // function owner. Its explicit fixture bootstrap role may seed/clean only;
  // all resolver and directory assertions still execute as app_rw below.
  const fixtureOwner = cleanup.username === "aoa" ||
    (synthetic && cleanup.username === "probe_bootstrap");
  if (process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || process.env.CLOUD_RUN_JOB ||
    !["localhost", "127.0.0.1", "[::1]"].includes(cleanup.hostname) ||
    !(synthetic || (process.env.CI === "true" && cleanup.pathname === "/aoa")) ||
    !fixtureOwner || app.username !== "app_rw" ||
    app.hostname !== cleanup.hostname || app.port !== cleanup.port || app.pathname !== cleanup.pathname) {
    throw new Error("Planner integration tests require matching explicit loopback owner/app databases");
  }
  return cleanup.toString();
}

function scoped<T>(identity: Identity, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return withUserScope(identity, fn, {
    initialSettingsSql: Prisma.sql`, set_config('enable_nestloop', 'off', true),
      set_config('plan_cache_mode', 'force_generic_plan', true), set_config('jit', 'off', true)`,
  });
}

const scalar = async (source: string | null) => scoped(OPERATIONS, async (tx) => {
  const [row] = await tx.$queryRaw<Array<{ resolved: string | null }>>`
    SELECT app.resolve_crm_canonical_household_source_key(${source}::text) AS resolved`;
  return row.resolved;
});
const bulk = (keys: Array<string | null> | null, identity = OPERATIONS) => scoped(identity, (tx) =>
  tx.$queryRaw<Pair[]>`SELECT source_key, canonical_source_key
    FROM app.resolve_crm_canonical_household_overlays(${keys}::text[]) ORDER BY source_key`);

gated("Canonical household resolver planner scope under PostgreSQL RLS", () => {
  let owner: PrismaClient | undefined;

  async function cleanup() {
    if (!owner) return;
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate_event WHERE candidate_id IN (${Prisma.join(candidateIds)})`;
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate WHERE id IN (${Prisma.join(candidateIds)})`;
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id IN (${Prisma.join(mappingIds)})`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id IN (${Prisma.join(identityNumbers.map(identityId))})`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id IN (${Prisma.join(households.map((row) => row.sf_id))})`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk IN
      (${Prisma.join([...candidateIds, ...mappingIds, ...identityNumbers.map(identityId), ...households.map((row) => row.sf_id)])})`;
  }

  beforeAll(async () => {
    const cleanupUrl = requireLocalDatabase();
    const [reader] = await prisma.$queryRaw<Array<{ role: string; superuser: boolean; bypass: boolean }>>`
      SELECT current_user::text AS role, rolsuper AS superuser, rolbypassrls AS bypass
      FROM pg_catalog.pg_roles WHERE rolname = current_user`;
    expect(reader).toEqual({ role: "app_rw", superuser: false, bypass: false });
    owner = new PrismaClient({ datasourceUrl: cleanupUrl });
    await cleanup();
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, status, stage, lead_advisor_email)
      VALUES ${Prisma.join(households.map((row) => Prisma.sql`(${row.sf_id}, ${row.name}, 'Active', 'Client', ${row.email})`))}`;
    await owner.$executeRaw`INSERT INTO app.crm_identity (id, identity_type, updated_at)
      VALUES ${Prisma.join(identityNumbers.map((n) => Prisma.sql`(${identityId(n)}, 'HOUSEHOLD', now())`))}`;
    await owner.$executeRaw`INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, mapping_state, superseded_at, updated_at)
      VALUES ${Prisma.join(identityNumbers.map((n) => Prisma.sql`
        (${"planner263-map-" + n}, ${identityId(n)}, 'CRM', 'household',
         ${n === 38 ? key(37).slice(0, 15) : key(n)},
         ${[44, 47].includes(n) ? "SUPERSEDED" : "ACTIVE"},
         ${[44, 47].includes(n) ? Prisma.sql`now()` : Prisma.sql`NULL`}, now())`))}`;
    await owner.$executeRaw`INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, updated_at)
      VALUES ('planner263-map-49-alias', ${identityId(49)}, 'CRM', 'household', ${key(49).slice(0, 15)}, now())`;
    await owner.$executeRaw`INSERT INTO app.crm_duplicate_candidate
      (id, detector_key, entity_type, left_identity_id, right_identity_id, evidence_codes,
       status, canonical_identity_id, source_active, updated_at)
      VALUES ${Prisma.join(edges.map(([source, target], i) => {
        const [left, right] = [identityId(source), identityId(target)].sort();
        return Prisma.sql`(${candidateId(i)}, ${(263000 + i).toString(16).padStart(64, "0")}, 'HOUSEHOLD',
          ${left}, ${right}, ARRAY['SHARED_CEDAR_RIDGE_USER_ID'],
          ${source === 42 ? "NEW" : "READY_FOR_FOLLOW_UP"}::app."CrmDuplicateReviewStatus",
          ${source === 42 ? null : identityId(target)}, ${source !== 50}, now())`;
      }))}`;
  });

  afterAll(async () => {
    try { await cleanup(); } finally {
      await owner?.$disconnect();
      await prisma.$disconnect();
      vi.unstubAllEnvs();
    }
  });

  it("uses a scalar-only planner override while preserving the function security contract", async () => {
    const rows = await prisma.$queryRaw<Array<{
      name: string; config: string[]; definer: boolean; volatility: string;
      app_execute: boolean; ingest_execute: boolean; reconciler_execute: boolean;
    }>>`SELECT proname AS name, proconfig AS config, prosecdef AS definer, provolatile::text AS volatility,
        has_function_privilege('app_rw', oid, 'EXECUTE') AS app_execute,
        has_function_privilege('ingest_rw', oid, 'EXECUTE') AS ingest_execute,
        has_function_privilege('identity_reconciler', oid, 'EXECUTE') AS reconciler_execute
      FROM pg_catalog.pg_proc WHERE oid IN (
        'app.resolve_crm_canonical_household_source_key(text)'::regprocedure,
        'app.resolve_crm_canonical_household_overlays(text[])'::regprocedure)
      ORDER BY proname`;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ definer: true, volatility: "s", app_execute: true });
    // Later contact-review and ingestion migrations intentionally grant these
    // roles the scalar resolver; the bounded bulk helper remains app-only.
    expect(rows.find((row) => row.name.endsWith("source_key")))
      .toMatchObject({ ingest_execute: true, reconciler_execute: true });
    expect(rows.find((row) => row.name.endsWith("overlays")))
      .toMatchObject({ ingest_execute: false, reconciler_execute: false });
    expect(rows.find((row) => row.name.endsWith("source_key"))?.config)
      .toEqual(expect.arrayContaining(["search_path=pg_catalog, app", "enable_nestloop=on"]));
    expect(rows.find((row) => row.name.endsWith("overlays"))?.config)
      .toEqual(["search_path=pg_catalog, app, mirror"]);
  });

  const scalarCases: Array<[string, string | null, string | null]> = [
    ["null", null, null], ["empty", "", ""], ["whitespace", "  ", "  "],
    ["unknown", "planner263-unknown", "planner263-unknown"],
    ...([
      ["direct", 1, 2], ["unmapped", 3, 3], ["missing target", 4, 4], ["two-edge chain", 6, 8],
      ["seven-edge chain", 10, 17], ["eight-edge original fallback", 20, 20],
      ["seven-edge suffix of long chain", 21, 28], ["ambiguous targets", 30, 30],
      ["ambiguous raw target aliases", 33, 33], ["cycle", 35, 35], ["reverse cycle", 36, 36],
      ["raw-alias self-cycle", 37, 37], ["unconfirmed choice", 42, 42],
      ["superseded source", 44, 44], ["superseded target", 46, 46],
      ["duplicate mapping to one target", 48, 49], ["existing inactive-source rule", 50, 51],
    ] satisfies Array<[string, number, number]>).map(([label, source, target]): [string, string, string] => [label, key(source), key(target)]),
    ["15-character source", key(1).slice(0, 15), key(2)],
    ["exact original 15-character cycle fallback", key(35).slice(0, 15), key(35).slice(0, 15)],
  ];
  it.each(scalarCases)("preserves scalar resolution: %s", async (_label, source, expected) => {
    expect(await scalar(source)).toBe(expected);
  });

  it("retains raw source aliases, visible terminal guards and duplicate/null/blank handling in bulk", async () => {
    expect(await bulk([key(1), key(2)])).toEqual([pair(1, 2)]);
    expect(await bulk([key(1)])).toEqual([]);
    expect(await bulk([key(6), key(7)])).toEqual([]);
    expect(await bulk([key(1), key(1).slice(0, 15), key(2).slice(0, 15)]))
      .toEqual(sortPairs([pair(1, 2), { source_key: key(1).slice(0, 15), canonical_source_key: key(2) }]));
    expect(await bulk([key(1), key(1), null, "", "  ", key(2)])).toEqual([pair(1, 2)]);
    expect(await bulk([])).toEqual([]);
    expect(await bulk(null)).toEqual([]);
    expect(await bulk(households.map((row) => row.sf_id))).toEqual(expectedOverlays);
  });

  it("enforces the original 10,000-entry bound before deduplication or blank removal", async () => {
    expect(await bulk([...Array<string>(9_999).fill(key(1)), key(2)])).toEqual([pair(1, 2)]);
    expect(await bulk([...Array<string>(10_000).fill(key(1)), key(2)])).toEqual([]);
    expect(await bulk([...Array<string>(10_000).fill(""), key(1), key(2)])).toEqual([]);
  });

  it.each([
    { nestloop: "off", cache: "force_generic_plan" }, { nestloop: "on", cache: "auto" },
  ])("restores caller settings after scalar and bulk calls: $nestloop / $cache", async (settings) => {
    await withUserScope(OPERATIONS, async (tx) => {
      await tx.$executeRaw`SELECT set_config('enable_nestloop', ${settings.nestloop}, true),
        set_config('plan_cache_mode', ${settings.cache}, true), set_config('jit', 'off', true)`;
      const readSettings = async () => (await tx.$queryRaw<Array<typeof settings>>`
        SELECT current_setting('enable_nestloop') AS nestloop, current_setting('plan_cache_mode') AS cache`)[0];
      expect(await readSettings()).toEqual(settings);
      for (const source of [key(1), key(20), key(30), key(35)]) {
        const [row] = await tx.$queryRaw<Array<{ resolved: string }>>`
          SELECT app.resolve_crm_canonical_household_source_key(${source}) AS resolved`;
        expect(row.resolved).toBe(source === key(1) ? key(2) : source);
        expect(await readSettings()).toEqual(settings);
      }
      expect(await tx.$queryRaw<Pair[]>`SELECT source_key, canonical_source_key
        FROM app.resolve_crm_canonical_household_overlays(${households.map((row) => row.sf_id)}::text[]) ORDER BY source_key`)
        .toEqual(expectedOverlays);
      expect(await readSettings()).toEqual(settings);
    });
  });

  it.each([
    OPERATIONS, { role: "ADVISOR", email: ADVISOR_A },
    { role: "ADVISOR", email: ADVISOR_B }, { role: "VIEWER", email: ADVISOR_A },
  ])("preserves visible-target RLS and canonical-on/off directory order for $role / $email", async (actor) => {
    const visible = households.filter((row) => actor.role === "OPERATIONS" ||
      (actor.role === "ADVISOR" && row.email === actor.email));
    const visibleKeys = await scoped(actor, (tx) => tx.$queryRaw<Array<{ sf_id: string }>>`
      SELECT sf_id FROM mirror.household WHERE sf_id IN (${Prisma.join(households.map((row) => row.sf_id))}) ORDER BY sf_id`);
    expect(visibleKeys.map((row) => row.sf_id)).toEqual(visible.map((row) => row.sf_id).sort());
    const normalizedVisible = new Set(visible.map((row) => row.sf_id.slice(0, 15)));
    const overlays = expectedOverlays.filter((row) => visible.some((source) => source.sf_id === row.source_key) &&
      normalizedVisible.has(row.canonical_source_key.slice(0, 15)));
    expect(await bulk(visibleKeys.map((row) => row.sf_id), actor)).toEqual(overlays);
    // The scalar definer can resolve an opaque key beyond the advisor's book;
    // the bulk helper must suppress that overlay when its target is not visible.
    if (actor.role === "ADVISOR" && actor.email === ADVISOR_A) {
      const [row] = await scoped(actor, (tx) => tx.$queryRaw<Array<{ resolved: string }>>`
        SELECT app.resolve_crm_canonical_household_source_key(${key(40)}) AS resolved`);
      expect(row.resolved).toBe(key(41));
      expect(overlays.some((overlay) => overlay.source_key === key(40))).toBe(false);
    }
    for (const flag of ["0", "1"]) {
      vi.stubEnv("CRM_IDENTITY_READS", flag);
      const expected = visible.filter((row) => flag === "0" || !overlays.some((overlay) => overlay.source_key === row.sf_id))
        .map(({ sf_id, name: displayName }) => ({ sf_id, name: displayName }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.sf_id.localeCompare(b.sf_id));
      const result = await getHouseholdDirectory(actor,
        { ...DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS, query: "PlannerFixture263" }, 1, 100);
      expect(result.total).toBe(expected.length);
      expect(result.rows.map(({ sf_id, name: displayName }) => ({ sf_id, name: displayName }))).toEqual(expected);
      // Exercise the actual preview caller, which disables nested loops for its
      // outer query, against the exact directory's default first-page contract.
      const preview = await getHouseholdDirectoryPreview(actor);
      const exact = await getHouseholdDirectory(actor, DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS, 1, 100);
      const projection = (rows: Array<{ sf_id: string; name: string }>) =>
        rows.map(({ sf_id, name: displayName }) => ({ sf_id, name: displayName }));
      expect(projection(preview)).toEqual(projection(exact.rows));
      expect(preview).toHaveLength(Math.min(100, exact.total));
    }
  });
});
