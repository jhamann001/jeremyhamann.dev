import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const parity = vi.hoisted(() => ({ comparisons: 0 }));

// Exercise both complete queries under the same real RLS identity and MVCC
// snapshot. Only the test wrapper restores the old projection/rejoin. Its SQL
// hash is pinned to the pre-change 5c61c410 query, so unrelated candidate edits
// cannot silently alter both sides of the comparison. Values are unchanged.
vi.mock("@/lib/rls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rls")>();
  return {
    ...actual,
    withUserScope: ((identity, fn, options) => actual.withUserScope(identity, (tx) => fn(new Proxy(tx, {
      get(target, property) {
        if (property !== "$queryRaw") return Reflect.get(target, property);
        return async (input: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
          const query = Array.isArray(input)
            ? Prisma.sql(input as TemplateStringsArray, ...values) : input as Prisma.Sql;
          if (!query.text.includes("household_directory AS MATERIALIZED")) return target.$queryRaw(query);
          const legacy = legacyDirectoryQuery(query);
          const result = await target.$queryRaw(query);
          expect(await target.$queryRaw(legacy)).toEqual(result);
          parity.comparisons++;
          return result;
        };
      },
    })), { ...options, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })) as typeof actual.withUserScope,
  };
});

import { prisma } from "@/lib/db";
import { getHouseholdDirectory } from "@/lib/data/households";
import { DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS as DEFAULTS } from "@/lib/navigation/household-query";
import type { HouseholdDirectoryFilters } from "@/components/households/directory-results";

function legacyDirectoryQuery(query: Prisma.Sql): Prisma.Sql {
  const replacements = [
    ["\n             h.status, h.stage, h.aum,\n             h.lead_advisor_email, h.household_kind, h.canonical_sf_id,", ""],
    ["h.display_name AS name", "display.display_name AS name"],
    ["FROM household_display h\n          LEFT JOIN mirror.advisor", "FROM visible_household h\n          JOIN household_display display ON display.sf_id = h.sf_id\n          LEFT JOIN mirror.advisor"],
  ] as const;
  let strings = [...query.strings];
  for (const [candidate, legacy] of replacements) {
    expect(strings.reduce((n, part) => n + part.split(candidate).length - 1, 0)).toBe(1);
    strings = strings.map((part) => part.replace(candidate, legacy));
  }
  const legacy = Prisma.sql(strings, ...query.values);
  expect(createHash("sha256").update(legacy.text).digest("hex"))
    .toBe("fb7a3915f9a7715bd31a8ba19a760eb8af64b1a34c4acd7070ba7bc47b00111d");
  expect(legacy.values).toEqual(query.values);
  return legacy;
}

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const A = "projection263-a@example.invalid";
const B = "projection263-b@example.invalid";
const OPS = { role: "OPERATIONS", email: A };
const ADVISOR = { role: "ADVISOR", email: A };
const VIEWER = { role: "VIEWER", email: A };
const key = (n: number) => `001PJX${String(n).padStart(9, "0")}AAA`;
const clientKey = (n: number) => `003PJX${String(n).padStart(9, "0")}AAA`;
const opaqueA = "opaque-proj263-shared-alpha";
const opaqueB = "opaque-proj263-shared-bravo";
const identityKey = (n: number) => `hld_projection263${n}`;
const mappings = [2, 3, 5, 7, 12, 13];
const edges = [[2, 3], [5, 7], [12, 13]] as const;
const candidateKey = (n: number) => `dup_c${(263900 + n).toString(16).padStart(24, "0")}`;
const sourceKey = (n: number) => n === 12 ? opaqueA : n === 13 ? opaqueB : key(n);
const households = [
  ...Array.from({ length: 9 }, (_, i) => ({ id: key(i + 1), n: i + 1 })),
  { id: key(9).slice(0, 15), n: 9 }, { id: opaqueA, n: 12 }, { id: opaqueB, n: 13 },
];
const accounts = ["projection263-current", "projection263-pending", "projection263-hidden", "projection263-retired"];
const dealIds = Array.from({ length: 8 }, (_, i) => `projection263-deal-${i}`);
const advisorIds = ["projection263-advisor-a", "projection263-advisor-b"];
const filters: HouseholdDirectoryFilters = { ...DEFAULTS, stage: "all", query: "ProjectionFixture" };

function requireLocalDatabase(): string {
  const raw = process.env.AUDIT_TEST_CLEANUP_URL;
  if (!raw || !process.env.DATABASE_URL || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || process.env.CLOUD_RUN_JOB ||
    ["dev", "development", "prod", "production"].includes(process.env.APP_ENV ?? "")) {
    throw new Error("Projection integration requires explicit isolated local databases");
  }
  const owner = new URL(raw);
  const synthetic = (owner.pathname === "/aoa_display_projection_tests_synthetic" && owner.port === "55447") ||
    (owner.pathname === "/aoa_pagination_synthetic" && owner.port === "55444");
  const ci = process.env.CI === "true" && owner.pathname === "/aoa" && ["", "5432"].includes(owner.port);
  const databases: Array<[URL, string[]]> = [[owner, ["aoa"]],
    [new URL(process.env.DATABASE_URL), ["app_rw"]]];
  for (const [url, users] of databases) {
    if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !(synthetic || ci) ||
      !users.includes(url.username) || url.host !== owner.host || url.pathname !== owner.pathname ||
      [...url.searchParams.keys()].some((name) => !["schema", "connection_limit", "pool_timeout"].includes(name))) {
      throw new Error("Projection integration requires matching loopback owner/app synthetic databases");
    }
  }
  return raw;
}

gated("Exact household directory metadata projection matches the complete legacy envelope", () => {
  let owner: PrismaClient | undefined;

  async function cleanup() {
    if (!owner) return;
    const candidates = edges.map((_, i) => candidateKey(i));
    const mapIds = mappings.map((n) => `projection263-map-${n}`);
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate_event WHERE candidate_id IN (${Prisma.join(candidates)})`;
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate WHERE id IN (${Prisma.join(candidates)})`;
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id IN (${Prisma.join(mapIds)})`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id IN (${Prisma.join(mappings.map(identityKey))})`;
    await owner.$executeRaw`DELETE FROM app.deal WHERE id IN (${Prisma.join(dealIds)})`;
    await owner.$executeRaw`DELETE FROM mirror.client_account_aum WHERE custodian_account_id IN (${Prisma.join(accounts)})`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id IN (${Prisma.join(Array.from({ length: 11 }, (_, i) => clientKey(i + 1)))})`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id IN (${Prisma.join(households.map((row) => row.id))})`;
    await owner.$executeRaw`DELETE FROM mirror.advisor WHERE sf_id IN (${Prisma.join(advisorIds)})`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk IN (${Prisma.join([
      ...candidates, ...mapIds, ...mappings.map(identityKey), ...dealIds, ...accounts, ...advisorIds,
      ...households.map((row) => row.id), ...Array.from({ length: 11 }, (_, i) => clientKey(i + 1)),
    ])})`;
  }

  beforeAll(async () => {
    const cleanupUrl = requireLocalDatabase();
    const [reader] = await prisma.$queryRaw<Array<{ role: string; superuser: boolean; bypass: boolean }>>`
      SELECT current_user::text AS role, rolsuper AS superuser, rolbypassrls AS bypass
      FROM pg_catalog.pg_roles WHERE rolname = current_user`;
    expect(reader).toEqual({ role: "app_rw", superuser: false, bypass: false });
    owner = new PrismaClient({ datasourceUrl: cleanupUrl });
    await cleanup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T16:00:00Z"));
    await owner.$executeRaw`INSERT INTO mirror.advisor (sf_id, name, email) VALUES
      (${advisorIds[0]}, 'Projection Advisor A', ${A}), (${advisorIds[1]}, 'Projection Advisor B', ${B})`;
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, status, stage, lead_advisor_email, aum)
      VALUES ${Prisma.join(households.map(({ id, n }) => Prisma.sql`(${id},
        ${n === 1 ? "Alex ProjectionFixture Household" : `ProjectionFixture ${String(n).padStart(2, "0")}`},
        ${n === 8 ? "Inactive" : n === 9 ? null : "Active"},
        ${n === 4 ? "Prospect" : n === 8 ? "Lost Client" : n === 9 ? null : "Client"},
        ${n === 7 ? B : A}, ${n === 9 ? null : n * 11})`))}`;
    await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      VALUES ${Prisma.join(Array.from({ length: 9 }, (_, i) => i + 1).map((n) => Prisma.sql`
        (${clientKey(n)}, ${key(n)}, ${n === 1 ? "Alex" : "Blair"},
         ${n === 1 ? "ProjectionFixture" : `Member ${n}`}, ${n === 7 ? B : A})`))},
      (${clientKey(10)}, ${key(4)}, 'Casey', 'Second Member', ${A}),
      (${clientKey(11)}, ${key(1)}, 'Hidden', 'Other Book Member', ${B})`;
    await owner.$executeRaw`INSERT INTO app.crm_identity (id, identity_type, updated_at)
      VALUES ${Prisma.join(mappings.map((n) => Prisma.sql`(${identityKey(n)}, 'HOUSEHOLD', now())`))}`;
    await owner.$executeRaw`INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, updated_at)
      VALUES ${Prisma.join(mappings.map((n) => Prisma.sql`(${"projection263-map-" + n}, ${identityKey(n)},
        'CRM', 'household', ${sourceKey(n)}, now())`))}`;
    await owner.$executeRaw`INSERT INTO app.crm_duplicate_candidate
      (id, detector_key, entity_type, left_identity_id, right_identity_id, evidence_codes,
       status, canonical_identity_id, source_active, updated_at)
      VALUES ${Prisma.join(edges.map(([source, target], i) => {
        const [left, right] = [identityKey(source), identityKey(target)].sort();
        return Prisma.sql`(${candidateKey(i)}, ${(263900 + i).toString(16).padStart(64, "0")}, 'HOUSEHOLD',
          ${left}, ${right}, ARRAY['SHARED_CEDAR_RIDGE_USER_ID'], 'READY_FOR_FOLLOW_UP', ${identityKey(target)}, true, now())`;
      }))}`;
    await owner.$executeRaw`INSERT INTO mirror.client_account_aum
      (custodian_account_id, client_sf_id, household_sf_id, account_aum, account_status,
       balance_current, source_present, balance_as_of, snapshot_run_id) VALUES
      (${accounts[0]}, ${clientKey(1)}, ${key(1)}, 300, 'OPEN', true, true, '2026-09-30', 'projection263'),
      (${accounts[1]}, ${clientKey(6)}, ${key(6)}, 600, 'OPEN', false, true, '2026-09-30', 'projection263'),
      (${accounts[2]}, ${clientKey(7)}, ${key(7)}, 700, 'OPEN', true, true, '2026-09-30', 'projection263'),
      (${accounts[3]}, ${clientKey(1)}, ${key(1)}, 9000, 'OPEN', false, false, '2026-09-30', 'projection263')`;
    // Complete per-client deals deduplicate by MAX before summing; a missing
    // client makes the deal total incomplete and retains the mirror fallback.
    await owner.deal.createMany({ data: [
      [1, 1, 900, false], [4, 4, 100, false], [4, 4, 120, false], [4, 10, 80, false],
      [5, null, 500, false], [6, 6, 600, false], [7, 7, 9999, false], [4, 4, 9999, true],
    ].map(([household, client, value, archived], i) => ({
      id: dealIds[i], source: "APP", name: `ProjectionFixture deal ${i}`,
      client_first_name: "Synthetic", client_last_name: "ProjectionFixture",
      household_sf_id: key(Number(household)), client_sf_id: client === null ? null : clientKey(Number(client)),
      amount: 0, stage: "POTENTIAL", created_date: new Date("2026-09-01"), person_aum: Number(value),
      archived_at: archived ? new Date("2026-09-02") : null,
    })) });
  });

  beforeEach(() => { parity.comparisons = 0; });
  afterAll(async () => {
    try { await cleanup(); } finally {
      await owner?.$disconnect();
      await prisma.$disconnect();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it.each([OPS, ADVISOR, VIEWER].flatMap((actor) => ["0", "1"].map((canonical) => ({ actor, canonical }))))
  ("preserves full envelopes, aliases and scope for $actor.role / canonical=$canonical", async ({ actor, canonical }) => {
    vi.stubEnv("CRM_IDENTITY_READS", canonical);
    // The bulk resolver's established left-15 comparison treats these opaque
    // keys as a no-op overlay; naming still keeps their complete keys distinct.
    // Preserve that existing behavior rather than inventing new normalization.
    const expected = households.filter(({ id, n }) => actor.role !== "VIEWER" &&
      (actor.role === "OPERATIONS" || n !== 7) && (canonical === "0" ||
        !(id === key(2) || (actor.role === "OPERATIONS" && id === key(5)))));
    const all = await getHouseholdDirectory(actor, filters, 1, 100);
    expect(all.total).toBe(expected.length);
    expect(all.rows.map((row) => row.sf_id).sort()).toEqual(expected.map((row) => row.id).sort());
    for (const row of all.rows) {
      expect(Object.keys(row).sort()).toEqual([
        "sf_id", "name", "status", "stage", "aum", "lead_advisor_email", "household_kind",
        "advisor_name", "aum_source", "member_count", "employeeStatus",
      ].sort());
    }
    if (actor.role === "ADVISOR") {
      expect(all.rows.find((row) => row.sf_id === key(1)))
        .toMatchObject({ name: "ProjectionFixture Household", member_count: 1 });
      expect(all.advisorOptions.some((option) => option.value === B)).toBe(false);
      expect(JSON.stringify(all)).not.toContain("Other Book Member");
    }
    if (actor.role === "VIEWER") expect(all.aumSplit.available).toBe(false);
    const variants: Array<Partial<HouseholdDirectoryFilters>> = [
      { stage: "client" }, { stage: "lost_client" }, { status: "active" }, { advisor: B },
      { query: "Member 2" }, { query: "no projection match" },
      { sortKey: "name", sortDir: "desc" }, { sortKey: "stage", sortDir: "asc" },
      { sortKey: "stage", sortDir: "desc" }, { sortKey: "aum", sortDir: "asc" },
      { sortKey: "aum", sortDir: "desc" },
    ];
    for (const variant of variants) await getHouseholdDirectory(actor, { ...filters, ...variant }, 1, 3);
    const first = await getHouseholdDirectory(actor, filters, 1, 3);
    const second = await getHouseholdDirectory(actor, filters, 2, 3);
    const last = await getHouseholdDirectory(actor, filters, 999, 3);
    expect([first.snapshot, second.snapshot, last.snapshot]).toEqual(Array(3).fill(all.snapshot));
    expect(first.rows).toEqual(all.rows.slice(0, 3));
    expect(second.rows).toEqual(all.rows.slice(expected.length > 3 ? 3 : 0, expected.length > 3 ? 6 : 3));
    expect(last.page).toBe(Math.max(1, Math.ceil(expected.length / 3)));
    expect(parity.comparisons).toBe(15);
  });

  it.each(["0", "1"])("preserves balances and source precedence with canonical=%s", async (canonical) => {
    vi.stubEnv("CRM_IDENTITY_READS", canonical);
    const result = await getHouseholdDirectory(ADVISOR, filters, 1, 100);
    const row = (n: number) => result.rows.find((item) => item.sf_id === key(n));
    expect(row(1)).toMatchObject({ aum: 300, aum_source: "apex" });
    expect(row(4)).toMatchObject({ aum: 200, aum_source: "deals" });
    expect(row(5)).toMatchObject({ aum: 55, aum_source: "mirror" });
    expect(row(6)).toMatchObject({ aum: null, aum_source: null });
    expect(row(9)).toMatchObject({ aum: null, aum_source: null, status: null, stage: null });
    expect(parity.comparisons).toBe(1);
  });

  it("keeps page snapshots stable across hidden edits and invalidates them after a visible change", async () => {
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    const before = await getHouseholdDirectory(ADVISOR, filters, 1, 100);
    try {
      await owner!.$executeRaw`UPDATE mirror.household SET name = 'ProjectionFixture hidden changed', aum = 99999
        WHERE sf_id = ${key(7)}`;
      expect(await getHouseholdDirectory(ADVISOR, filters, 1, 100)).toEqual(before);
      await owner!.deal.update({ where: { id: dealIds[2] }, data: { person_aum: 140 } });
      const after = await getHouseholdDirectory(ADVISOR, filters, 1, 100);
      expect(after.snapshot).not.toBe(before.snapshot);
      expect(after.rows.find((row) => row.sf_id === key(4))?.aum).toBe(220);
      expect(parity.comparisons).toBe(3);
    } finally {
      await owner!.$executeRaw`UPDATE mirror.household SET name = 'ProjectionFixture 07', aum = 77 WHERE sf_id = ${key(7)}`;
      await owner!.deal.update({ where: { id: dealIds[2] }, data: { person_aum: 120 } });
    }
  });
});
