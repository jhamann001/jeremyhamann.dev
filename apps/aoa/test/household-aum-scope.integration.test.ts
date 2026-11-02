import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getHouseholdDirectory } from "@/lib/data/households";
import { directoryAumState } from "@/components/households/directory-aum";
import { FIRM_ACCOUNT_IDS, FIRM_HOUSEHOLD_ID } from "@/lib/data/firm-household";
import { investmentAccountsForClient, investmentAccountsForHouseholdSources, householdInvestmentAumStateForSources } from "@/lib/data/investment-accounts";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "aum-scope-ops@example.test" };
const ADVISOR = { role: "ADVISOR", email: "aum-scope-advisor@example.test" };
const hh = "001KPQ592791070AAA";
const otherHh = "001VQH607459583AAA";
const client = (n: number) => `003AUM00000000${n}AAA`;
const identity = (n: number) => `con_aumscope${n}`;
const filters = { query: "", stage: "all" as const, advisor: "", status: "", sortKey: "name" as const, sortDir: "asc" as const };
const upload = "aum-scope-upload";

gated("Household AUM corporate and employee scope (real PostgreSQL/RLS)", () => {
  let owner: PrismaClient;

  async function cleanup() {
    await owner.$executeRaw`DELETE FROM mirror.schwab_account_balance WHERE snapshot_run_id = 'aum-scope-schwab-test'`;
    await owner.$executeRaw`DELETE FROM mirror.client_account_aum WHERE snapshot_run_id = 'aum-scope-test'`;
    await owner.$executeRaw`DELETE FROM app.employee_client_status WHERE source_upload_id = ${upload}`;
    await owner.$executeRaw`DELETE FROM app.employee_contact_mapping WHERE id LIKE 'aum-scope-map-%'`;
    await owner.$executeRaw`DELETE FROM app.employee_roster_upload WHERE id = ${upload}`;
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id LIKE 'aum-scope-source-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id LIKE 'con_aumscope%'`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE '003AUM%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id IN (${hh}, ${otherHh})`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE 'aum-scope-%'
      OR row_pk LIKE 'con_aumscope%' OR row_pk LIKE '003AUM%' OR row_pk IN (${hh}, ${otherHh})`;
  }

  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!raw || !process.env.DATABASE_URL) throw new Error("Explicit synthetic database URLs required");
    const target = new URL(raw);
    for (const [value, user] of [[raw, "aoa"], [process.env.DATABASE_URL, "app_rw"]]) {
      const url = new URL(value);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        || !(url.pathname === "/aoa_aum_scope_synthetic" || (process.env.CI === "true" && url.pathname === "/aoa"))
        || url.username !== user || url.host !== target.host || url.pathname !== target.pathname
        || ["host", "hostaddr", "service", "servicefile"].some(key => url.searchParams.has(key))) {
        throw new Error("AUM test requires an isolated loopback synthetic database");
      }
    }
    owner = new PrismaClient({ datasourceUrl: raw });
    await cleanup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T16:00:00Z"));
    vi.stubEnv("CRM_IDENTITY_READS", "0");
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email) VALUES
      (${hh}, 'Invented AUM Household', 'Client', ${ADVISOR.email}),
      (${otherHh}, 'Invented Other AUM Household', 'Client', 'other-aum@example.test')`;
    await owner.$executeRaw`INSERT INTO app.employee_roster_upload
      (id, file_sha256, effective_date, parser_version, row_count, employee_count,
       dependent_row_count, active_count, former_count, uploaded_by, updated_at)
      VALUES (${upload}, ${"9".repeat(64)}, '2026-09-17', 'aum-test', 3, 3, 0, 2, 1, ${OPS.email}, now())`;
    // 1 = active employee, 2 = nonemployee in SAME household, 3 = former,
    // 4 = active employee in another advisor's book, 5 = unconfirmed badge.
    for (const n of [1, 2, 3, 4, 5]) {
      await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
        VALUES (${client(n)}, ${n === 4 ? otherHh : hh}, 'Invented', ${`AUM ${n}`},
                ${n === 4 ? 'other-aum@example.test' : ADVISOR.email})`;
      if (n !== 2) {
        await owner.crmIdentity.create({ data: { id: identity(n), identity_type: "CONTACT" } });
        await owner.crmSourceMapping.create({ data: {
          id: `aum-scope-source-${n}`, identity_id: identity(n), source_system: "CRM",
          source_namespace: "contact", source_key: client(n),
        } });
        if (n !== 5) await owner.employeeContactMapping.create({ data: {
          id: `aum-scope-map-${n}`, employee_id: `aum-scope-employee-${n}`, contact_identity_id: identity(n),
          client_sf_id: client(n), state: "CONFIRMED", evidence: "MANUAL_SEARCH", reviewed_by: OPS.email,
        } });
        await owner.employeeClientStatus.create({ data: {
          client_sf_id: client(n), employment_state: n === 3 ? "FORMER" : "ACTIVE",
          effective_date: new Date("2026-09-17"), source_upload_id: upload,
        } });
      }
      await owner.$executeRaw`INSERT INTO mirror.client_account_aum
        (custodian_account_id, apex_account_number, client_sf_id, household_sf_id, account_aum,
         account_status, balance_current, source_present, balance_as_of, snapshot_run_id)
        VALUES (${`aum-scope-account-${n}`}, ${`AUMTEST${n}`}, ${client(n).slice(0, 15)},
                ${n === 4 ? otherHh : hh}, ${n * 100}, 'OPEN', true, true, '2026-09-17', 'aum-scope-test')`;
    }
    // Duplicate 15/18-character badge keys must never multiply an account sum.
    await owner.employeeClientStatus.create({ data: {
      client_sf_id: client(1).slice(0, 15), employment_state: "ACTIVE",
      effective_date: new Date("2026-09-17"), source_upload_id: upload,
    } });
    for (const [i, id] of [...FIRM_ACCOUNT_IDS].entries()) {
      await owner.$executeRaw`INSERT INTO mirror.client_account_aum
        (custodian_account_id, client_sf_id, household_sf_id, account_aum,
         balance_current, source_present, balance_as_of, snapshot_run_id)
        VALUES (${id}, ${client(1)}, ${i === 0 ? null : FIRM_HOUSEHOLD_ID},
                ${10 * (i + 1)}, true, true, '2026-09-17', 'aum-scope-test')`;
    }
    // Closed historical and source-retired balances must not leak into totals.
    await owner.$executeRaw`INSERT INTO mirror.client_account_aum
      (custodian_account_id, household_sf_id, client_sf_id, account_aum,
       account_status, balance_current, source_present, snapshot_run_id) VALUES
      ('aum-scope-old', ${hh}, ${client(1)}, 999, 'CLOSED', false, true, 'aum-scope-test'),
      ('aum-scope-retired', ${hh}, ${client(1)}, 999, 'OPEN', false, false, 'aum-scope-test')`;
    for (const [n, value, clientId, household, scope, present] of [
      [1, 500.11, client(1), hh, 'CLIENT', true],
      [2, 700.22, client(2), hh, 'CLIENT', true],
      [3, 900.33, null, null, 'FIRM_OPERATING', true],
      [4, 0, null, hh, 'CLIENT', true],
      [5, 200.55, client(4), otherHh, 'CLIENT', true],
      [6, 999, client(1), hh, 'CLIENT', false],
    ] as const) {
      await owner.$executeRaw`INSERT INTO mirror.schwab_account_balance
        (account_id, account_number, account_number_last4, account_name, client_sf_id, household_sf_id,
         account_scope, account_type, account_aum, account_cash, account_securities, balance_as_of,
         balance_current, source_present, resolution_method, resolution_state, reviewed_mapping_version,
         source_key, source_sha256, snapshot_run_id, expected_snapshot_rows)
        VALUES (${`schw_${String(n).padStart(32, '0')}`}, ${`9900000${n}`}, ${`000${n}`},
          'Invented Corporation', ${clientId}, ${household}, ${scope}, 'Synthetic Trust', ${value}, 0, ${value},
          '2026-09-17', ${present}, ${present}, 'OPERATIONS_REVIEWED', 'CONFIRMED', 1,
          'synthetic/CRS20260917.RPS', ${'d'.repeat(64)}, 'aum-scope-schwab-test', 6)`;
    }
  });

  afterAll(async () => {
    if (owner) { await cleanup(); await owner.$disconnect(); }
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("excludes all four corporate IDs, keeps nonemployee household members/former employees, and never double-subtracts", async () => {
    const result = await getHouseholdDirectory(OPS, filters, 1, 100);
    expect(result.aumSplit).toMatchObject({ available: true, total: 3901.21, firm: 1000.33, employee: 1200.66, employeeScopeComplete: true });
    expect(directoryAumState(result.aumSplit).total).toBe(2900.88);
    expect(directoryAumState(result.aumSplit, true).total).toBe(1700.22);
    expect(result.rows.find(row => row.sf_id === hh)).toMatchObject({ aum: 2300.33, aum_source: "custodians" });
    expect(result.rows.find(row => row.sf_id === FIRM_HOUSEHOLD_ID)).toMatchObject({ aum: 1000.33 });
    expect(result.aumSplit.sources).toEqual([
      { custodian: "Apex", oldest: "2026-09-17", newest: "2026-09-17", pending: 0 },
      { custodian: "Schwab", oldest: "2026-09-17", newest: "2026-09-17", pending: 0 },
    ]);
    const filtered = await getHouseholdDirectory(OPS, { ...filters, query: 'no matching households' }, 1, 1);
    expect(filtered.rows).toEqual([]);
    expect(filtered.aumSplit).toEqual(result.aumSplit);
  });

  it("keeps the employee subtraction and raw total inside the caller's book", async () => {
    const result = await getHouseholdDirectory(ADVISOR, filters, 1, 100);
    expect(result.aumSplit).toMatchObject({ available: true, total: 2300.33, firm: 0, employee: 600.11 });
    expect(directoryAumState(result.aumSplit, true).total).toBe(1700.22);
    const empty = await getHouseholdDirectory({ role: 'ADVISOR', email: 'empty-aum@example.test' }, filters, 1, 100);
    expect(empty.aumSplit).toMatchObject({ available: false, total: null, firm: null, employee: null });
  });

  it("stops subtracting an invalidated match and changes the paging snapshot", async () => {
    const before = await getHouseholdDirectory(OPS, filters, 1, 100);
    try {
      await owner.employeeContactMapping.update({ where: { id: 'aum-scope-map-1' }, data: { state: 'INVALIDATED' } });
      const after = await getHouseholdDirectory(OPS, filters, 1, 100);
      expect(after.aumSplit.employee).toBe(600.55);
      expect(after.snapshot).not.toBe(before.snapshot);
    } finally {
      await owner.employeeContactMapping.update({ where: { id: 'aum-scope-map-1' }, data: { state: 'CONFIRMED' } });
    }
  });

  it("keeps incomplete current snapshots unavailable in either toggle state", async () => {
    try {
      await owner.$executeRaw`UPDATE mirror.client_account_aum SET balance_current = false
        WHERE custodian_account_id = 'aum-scope-account-1'`;
      const result = await getHouseholdDirectory(OPS, filters, 1, 100);
      expect(directoryAumState(result.aumSplit).available).toBe(false);
      expect(directoryAumState(result.aumSplit, true).available).toBe(false);
    } finally {
      await owner.$executeRaw`UPDATE mirror.client_account_aum SET balance_current = true
        WHERE custodian_account_id = 'aum-scope-account-1'`;
    }
  });

  it("renders masked Schwab numbers, preserves zero/joint accounts once and enforces own-book RLS", async () => {
    const accounts = await investmentAccountsForHouseholdSources(ADVISOR, [hh, hh.slice(0, 15)]);
    expect(accounts.filter(a => a.custodian === "Schwab")).toHaveLength(3);
    expect(accounts.find(a => a.num === "••••0004")).toMatchObject({ value: 0, clientSfId: null });
    expect(JSON.stringify(accounts)).not.toContain("99000001");
    expect(accounts.every(a => !a.firmOperating)).toBe(true);
    expect(await investmentAccountsForClient(ADVISOR, client(4))).toEqual([]);
    expect(await investmentAccountsForHouseholdSources({ role: "VIEWER", email: "viewer@example.test" }, [hh])).toEqual([]);
    const firstPersonAccounts = await investmentAccountsForClient(ADVISOR, client(1).slice(0, 15));
    const secondPersonAccounts = await investmentAccountsForClient(ADVISOR, client(2));
    expect(firstPersonAccounts.filter(a => a.custodian === "Schwab").map(a => a.num))
      .toEqual(["••••0001"]);
    expect(secondPersonAccounts.filter(a => a.custodian === "Schwab").map(a => a.num))
      .toEqual(["••••0002"]);
    // Household-only and another person's account cannot be copied to either
    // portrait just because both people belong to the same household.
    expect([...firstPersonAccounts, ...secondPersonAccounts].some(a => a.num === "••••0004"))
      .toBe(false);
    expect(await householdInvestmentAumStateForSources(OPS, [hh])).toMatchObject({ value: 2300.33, availability: "AVAILABLE" });
  });

  it("does not invent employee ownership for a nonzero household-only account", async () => {
    try {
      await owner.$executeRaw`UPDATE mirror.schwab_account_balance SET account_aum = 10, account_cash = 10
        WHERE snapshot_run_id = 'aum-scope-schwab-test' AND account_number_last4 = '0004'`;
      const result = await getHouseholdDirectory(OPS, filters, 1, 100);
      expect(directoryAumState(result.aumSplit).available).toBe(true);
      expect(result.aumSplit.employeeScopeComplete).toBe(false);
      expect(directoryAumState(result.aumSplit, true).available).toBe(false);
    } finally {
      await owner.$executeRaw`UPDATE mirror.schwab_account_balance SET account_aum = 0, account_cash = 0
        WHERE snapshot_run_id = 'aum-scope-schwab-test' AND account_number_last4 = '0004'`;
    }
  });

  it("withholds stale mixed-source totals without falling back to a plausible household estimate", async () => {
    try {
      vi.setSystemTime(new Date("2026-09-22T16:00:00Z"));
      const result = await getHouseholdDirectory(OPS, filters, 1, 100);
      expect(result.aumSplit.available).toBe(false);
      expect(result.rows.find(row => row.sf_id === hh)?.aum).toBeNull();
      expect(await householdInvestmentAumStateForSources(OPS, [hh])).toMatchObject({ value: null, availability: "PENDING" });
    } finally { vi.setSystemTime(new Date("2026-09-18T16:00:00Z")); }
  });

  it("blocks firmwide totals but does not attribute unresolved Schwab accounts to a client", async () => {
    try {
      await owner.$executeRaw`UPDATE mirror.schwab_account_balance SET
        resolution_state = 'UNMATCHED', resolution_method = 'UNMATCHED', account_scope = 'UNCLASSIFIED',
        reviewed_mapping_version = NULL, client_sf_id = NULL, household_sf_id = NULL
        WHERE snapshot_run_id = 'aum-scope-schwab-test' AND account_number_last4 = '0002'`;
      expect((await getHouseholdDirectory(OPS, filters, 1, 100)).aumSplit.available).toBe(false);
      expect((await investmentAccountsForClient(OPS, client(2))).filter(a => a.custodian === "Schwab")).toEqual([]);
    } finally {
      await owner.$executeRaw`UPDATE mirror.schwab_account_balance SET
        resolution_state = 'CONFIRMED', resolution_method = 'OPERATIONS_REVIEWED', account_scope = 'CLIENT',
        reviewed_mapping_version = 1, client_sf_id = ${client(2)}, household_sf_id = ${hh}
        WHERE snapshot_run_id = 'aum-scope-schwab-test' AND account_number_last4 = '0002'`;
    }
  });
});
