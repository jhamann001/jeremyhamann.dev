import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { listHouseholdPickerTargets } from "@/lib/data/household-picker";
import { FIRM_HOUSEHOLD_ID, FIRM_HOUSEHOLD_NAME } from "@/lib/data/firm-household";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const advisor = { role: "ADVISOR", email: "household-picker@example.invalid" };
const ops = { role: "OPERATIONS", email: advisor.email };
const hh = (n: number) => `001HHP${String(n).padStart(9, "0")}AAA`;
const client = (n: number) => `003HHP${String(n).padStart(9, "0")}AAA`;
const identity = (n: number) => `hld_hhpicker${n}`;
const candidate = `dup_c${"216729".padStart(24, "0")}`;

gated("Household picker identities under real PostgreSQL RLS", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM mirror.client_account_aum WHERE snapshot_run_id = 'household-picker-test'`;
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate_event WHERE candidate_id = ${candidate}`;
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate WHERE id = ${candidate}`;
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id LIKE 'hhpicker-map-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id LIKE 'hld_hhpicker%'`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE '003HHP%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001HHP%'`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE 'hhpicker-map-%' OR row_pk LIKE 'hld_hhpicker%' OR row_pk = ${candidate}`;
  }
  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL, reader = process.env.DATABASE_URL;
    if (!raw || !reader) throw new Error("explicit_synthetic_database_required");
    const target = new URL(raw);
    for (const [value, username] of [[raw, "aoa"], [reader, "app_rw"]]) {
      const url = new URL(value);
      if (!["postgres:", "postgresql:"].includes(url.protocol)
        || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || !(url.port === "55444" && url.pathname === "/aoa_pagination_synthetic"
          || process.env.CI === "true" && url.port === "5432" && url.pathname === "/aoa")
        || url.username !== username || url.host !== target.host || url.pathname !== target.pathname
        || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
        || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
        || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
        throw new Error("isolated_synthetic_database_required");
      }
    }
    owner = new PrismaClient({ datasourceUrl: raw });
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    await cleanup();
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      VALUES (${hh(1)}, 'Alex & Jordan Smith Household', ${advisor.email}),
        (${hh(2)}, 'Prior household label', ${advisor.email}),
        (${hh(3)}, 'Hidden Jones Household', 'hidden-picker@example.invalid'),
        (${hh(4)}, 'Business Trust Household', ${advisor.email})`;
    await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      VALUES (${client(1)}, ${hh(1)}, 'Alex', 'Smith', ${advisor.email}),
        (${client(2)}, ${hh(2)}, 'Jordan', 'Smith', ${advisor.email}),
        (${client(3)}, ${hh(3)}, 'Hidden', 'Jones', 'hidden-picker@example.invalid'),
        (${client(4)}, ${hh(4)}, 'Casey', 'Neil', ${advisor.email})`;
    await owner.$executeRaw`INSERT INTO app.crm_identity (id, identity_type, updated_at)
      VALUES (${identity(1)}, 'HOUSEHOLD', now()), (${identity(2)}, 'HOUSEHOLD', now())`;
    await owner.$executeRaw`INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, updated_at)
      VALUES ('hhpicker-map-1', ${identity(1)}, 'CRM', 'household', ${hh(1)}, now()),
        ('hhpicker-map-2', ${identity(2)}, 'CRM', 'household', ${hh(2)}, now())`;
    await owner.$executeRaw`INSERT INTO app.crm_duplicate_candidate
      (id, detector_key, entity_type, left_identity_id, right_identity_id, evidence_codes, status, canonical_identity_id, updated_at)
      VALUES (${candidate}, ${"216729".padStart(64, "0")}, 'HOUSEHOLD', ${identity(1)}, ${identity(2)},
        ARRAY['SHARED_CEDAR_RIDGE_USER_ID'], 'READY_FOR_FOLLOW_UP', ${identity(1)}, now())`;
  });
  afterAll(async () => {
    if (owner) { await cleanup(); await owner.$disconnect(); }
    vi.unstubAllEnvs();
  });

  it("preserves canonical IDs, all source aliases, role visibility and name ordering", async () => {
    expect(await listHouseholdPickerTargets(advisor)).toEqual([
      { sf_id: hh(4), name: "Business Trust Household", source_names: ["Business Trust Household"] },
      { sf_id: hh(1), name: "Smith Household", source_names: ["Alex & Jordan Smith Household", "Prior household label"] },
    ]);
    expect(await listHouseholdPickerTargets({ role: "VIEWER", email: advisor.email })).toEqual([]);
    vi.stubEnv("CRM_IDENTITY_READS", "0");
    try {
      expect((await listHouseholdPickerTargets(advisor)).map(row => row.sf_id).sort()).toEqual([hh(1), hh(2), hh(4)]);
    } finally { vi.stubEnv("CRM_IDENTITY_READS", "1"); }
  });

  it("retains a firm target for zero, closed, pending accounts and excludes it from advisor results", async () => {
    const baseline = (await listHouseholdPickerTargets(ops)).filter(row => row.sf_id === FIRM_HOUSEHOLD_ID);
    await owner.$executeRaw`INSERT INTO mirror.client_account_aum
      (custodian_account_id, household_sf_id, account_aum, account_status, balance_current, source_present, snapshot_run_id)
      VALUES ('HHPP-FIRM', ${FIRM_HOUSEHOLD_ID}, 0, 'CLOSED', false, false, 'household-picker-test')`;
    try {
      expect((await listHouseholdPickerTargets(ops)).filter(row => row.sf_id === FIRM_HOUSEHOLD_ID)).toEqual(baseline);
      await owner.$executeRaw`UPDATE mirror.client_account_aum SET source_present = true WHERE custodian_account_id = 'HHPP-FIRM'`;
      for (const status of ["CLOSED", "OPEN"]) {
        await owner.$executeRaw`UPDATE mirror.client_account_aum SET account_status = ${status} WHERE custodian_account_id = 'HHPP-FIRM'`;
        expect((await listHouseholdPickerTargets(ops)).filter(row => row.sf_id === FIRM_HOUSEHOLD_ID))
          .toEqual([{ sf_id: FIRM_HOUSEHOLD_ID, name: FIRM_HOUSEHOLD_NAME, source_names: [FIRM_HOUSEHOLD_NAME] }]);
        expect((await listHouseholdPickerTargets(advisor)).some(row => row.sf_id === FIRM_HOUSEHOLD_ID)).toBe(false);
      }
    } finally { await owner.$executeRaw`DELETE FROM mirror.client_account_aum WHERE custodian_account_id = 'HHPP-FIRM'`; }
    expect((await listHouseholdPickerTargets(ops)).filter(row => row.sf_id === FIRM_HOUSEHOLD_ID)).toEqual(baseline);
  });

  it("serves a populated 4,000-household book while deal and employee tables are locked", async () => {
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      SELECT '001HHP' || lpad(i::text, 9, '0') || 'AAA', 'Tom Delgado Household', ${advisor.email}
      FROM generate_series(100, 4099) i`;
    await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      SELECT '003HHP' || lpad(i::text, 9, '0') || 'AAA', '001HHP' || lpad(i::text, 9, '0') || 'AAA',
        'Alex', 'Smith', ${advisor.email} FROM generate_series(100, 4099) i`;
    await owner.$executeRaw`INSERT INTO mirror.client_account_aum
      (custodian_account_id, household_sf_id, client_sf_id, account_aum, account_status, balance_current, source_present, snapshot_run_id)
      SELECT 'HHPP-' || i, '001HHP' || lpad((100 + (i - 1) / 4)::text, 9, '0') || 'AAA',
        '003HHP' || lpad((100 + (i - 1) / 4)::text, 9, '0') || 'AAA',
        100, 'OPEN', true, true, 'household-picker-test' FROM generate_series(1, 16000) i`;
    for (const table of [Prisma.sql`mirror.household`, Prisma.sql`mirror.client`, Prisma.sql`mirror.client_account_aum`]) {
      await owner.$executeRaw(Prisma.sql`ANALYZE ${table}`);
    }
    let acquired!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const lock = owner.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
      await tx.$executeRaw`LOCK TABLE app.deal, app.employee_client_status IN ACCESS EXCLUSIVE MODE`;
      acquired(); await held;
    }, { timeout: 10_000 });
    try {
      await Promise.race([ready, lock]);
      const rows = await listHouseholdPickerTargets(ops);
      expect(rows.filter(row => row.sf_id.startsWith("001HHP"))).toHaveLength(4003);
      expect(rows.every(row => Object.keys(row).sort().join(",") === "name,sf_id,source_names")).toBe(true);
    } finally { release(); await lock; }
  }, 20_000);

  it("cancels a blocked household read before the transaction deadline and recovers", async () => {
    const expected = await listHouseholdPickerTargets(advisor);
    let acquired!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const lock = owner.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
      await tx.$executeRaw`LOCK TABLE mirror.household IN ACCESS EXCLUSIVE MODE`;
      acquired(); await held;
    }, { timeout: 10_000 });
    try {
      await Promise.race([ready, lock]);
      await expect(listHouseholdPickerTargets(advisor)).rejects.toMatchObject({ code: "P2010", meta: { code: "55P03" } });
    } finally { release(); await lock; }
    expect(await listHouseholdPickerTargets(advisor)).toEqual(expected);
  }, 15_000);
});
