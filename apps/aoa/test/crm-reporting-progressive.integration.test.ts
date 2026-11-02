import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
import { GET } from "@/app/api/navigation/reporting/route";
import { getCrmReportingDatasets } from "@/lib/data/crm-reporting";
import { parseCrmReportQuery } from "@/lib/crm/reporting-query";
import type { CrmReportDatasetId } from "@/lib/crm/reporting-contracts";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "report-progressive@example.test" };
const request = (query = "") => new Request(`https://example.test/api/navigation/reporting?${query}`);
const household = (n: number) => `001RPP${String(n).padStart(9, "0")}AAA`;
const DATASETS: CrmReportDatasetId[] = ["household_aum", "deal_pipeline", "client_engagement", "transfers_funding"];

gated("Progressive Reporting SQL projections and current access", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM app.transfer WHERE id LIKE 'RPP-TRANSFER-%'`;
    await owner.$executeRaw`DELETE FROM app.deal WHERE id LIKE 'RPP-DEAL-%'`;
    await owner.$executeRaw`DELETE FROM mirror.task WHERE sf_id LIKE 'RPP-TASK-%'`;
    await owner.$executeRaw`DELETE FROM mirror.client_account_aum WHERE custodian_account_id LIKE 'RPP-ACCOUNT-%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001RPP%'`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE
      (table_name = 'deal' AND row_pk LIKE 'RPP-DEAL-%') OR
      (table_name = 'transfer' AND row_pk LIKE 'RPP-TRANSFER-%')`;
  }
  beforeAll(async () => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!url) throw new Error("Reporting fixtures require explicit cleanup URL");
    const target = new URL(url);
    for (const [value, username] of [[url, "aoa"], [process.env.DATABASE_URL, "app_rw"]]) {
      if (!value) throw new Error("Reporting fixtures require explicit database URL");
      const parsed = new URL(value);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
        || !(parsed.pathname.endsWith("_synthetic") || (process.env.CI === "true" && parsed.pathname === "/aoa"))
        || parsed.username !== username || parsed.pathname !== target.pathname || parsed.hostname !== target.hostname || parsed.port !== target.port) {
        throw new Error("Reporting fixtures require one loopback synthetic database");
      }
    }
    owner = new PrismaClient({ datasourceUrl: url });
    await cleanup();
  });
  beforeEach(async () => {
    vi.stubEnv("CRM_REPORTING", "1");
    auth.mockResolvedValue({ user: OPS, navigationScope: "a".repeat(64) });
    await cleanup();
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email, household_kind)
      SELECT '001RPP' || lpad(i::text, 9, '0') || 'AAA', 'Progressive Reporting Household ' || lpad(i::text, 3, '0'),
        ${OPS.email}, 'CLIENT' FROM generate_series(1, 205) i`;
    await owner.$executeRaw`INSERT INTO mirror.client_account_aum
      (custodian_account_id, apex_account_number, household_sf_id, account_type, is_managed, account_status,
       account_aum, as_of, balance_as_of, source_snapshot_as_of, balance_current, source_present)
      SELECT 'RPP-ACCOUNT-' || i, 'RPP-' || i, '001RPP' || lpad(i::text, 9, '0') || 'AAA',
        'Individual', true, 'Open', i, now(), CURRENT_DATE, CURRENT_DATE, true, true
      FROM generate_series(1, 205) i`;
    await owner.$executeRaw`INSERT INTO app.deal
      (id, source, name, client_first_name, client_last_name, amount, stage, created_date, close_date, owner_name, updated_at)
      SELECT 'RPP-DEAL-' || i, 'APP', 'Progressive Reporting Deal ' || i, 'Synthetic', 'Report', i,
        'POTENTIAL', CURRENT_DATE - 10, CURRENT_DATE + 10, 'Progressive Reporting Owner ' || lpad(i::text, 3, '0'), now()
      FROM generate_series(1, 205) i`;
    await owner.$executeRaw`INSERT INTO app.transfer
      (id, source, client_first_name, client_last_name, household_name, household_sf_id, value, stage,
       stage_entered_at, owner_kind, owner_name, funding_type, deal_id, updated_at)
      SELECT 'RPP-TRANSFER-' || i, 'APP', 'Synthetic', 'Report', 'Progressive Reporting Household ' || i,
        '001RPP' || lpad(i::text, 9, '0') || 'AAA', i, 'IN_TRANSFER', CURRENT_DATE - interval '10 days',
        'OPERATIONS', 'Progressive Reporting Owner ' || lpad(i::text, 3, '0'), 'WIRE', 'RPP-DEAL-' || i, now()
      FROM generate_series(1, 205) i`;
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } });

  it.each(DATASETS)("continues %s through100/100/5 with unchanged all-result metrics", async (dataset) => {
    const base = `dataset=${dataset}&search=Progressive+Reporting`;
    const first = await GET(request(base));
    expect(first.status).toBe(200);
    const pages = [await first.json()];
    for (const page of [2, 3]) {
      const response = await GET(request(`${base}&page=${page}&snapshot=${pages[0].snapshot}`));
      expect(response.status).toBe(200);
      pages.push(await response.json());
    }
    expect(pages.map((page) => page.rows.length)).toEqual([100, 100, 5]);
    expect(pages.map((page) => page.snapshot)).toEqual(Array(3).fill(pages[0].snapshot));
    expect(pages.every((page) => page.total === 205 && JSON.stringify(page.meta.metrics) === JSON.stringify(pages[0].meta.metrics))).toBe(true);
    const ids = pages.flatMap((page) => page.rows.map((row: { id: string }) => row.id));
    expect(new Set(ids).size).toBe(205);
    expect(ids.every((id: string) => /^[a-z_]+:[a-f0-9]{64}$/.test(id))).toBe(true);
    const summary = pages[0].meta.metrics;
    if (dataset === "household_aum") expect(summary.find((item: { label: string }) => item.label === "Current AUM").value).toBe(21115);
    if (dataset === "deal_pipeline") expect(summary.find((item: { label: string }) => item.label === "Pipeline value").value).toBe(21115);
    if (dataset === "transfers_funding") expect(summary.find((item: { label: string }) => item.label === "In-flight value").value).toBe(21115);
    expect((await GET(request(`${base}&page=4&snapshot=${pages[0].snapshot}`))).status).toBe(416);
  });

  it("honors25/50 pages, filters and deterministic order without changing metrics", async () => {
    for (const pageSize of [25, 50]) {
      const response = await GET(request(`dataset=deal_pipeline&search=Progressive+Reporting&sort=owner&direction=asc&pageSize=${pageSize}&minValue=101`));
      const page = await response.json();
      expect(response.status).toBe(200);
      expect(page.rows.length).toBe(pageSize);
      expect(page.total).toBe(105);
      expect(page.rows[0].values.owner).toBe("Progressive Reporting Owner 101");
      const next = await GET(request(`dataset=deal_pipeline&search=Progressive+Reporting&sort=owner&direction=asc&pageSize=${pageSize}&minValue=101&page=2&snapshot=${page.snapshot}`));
      expect(next.status).toBe(200);
      expect((await next.json()).rows[0].values.owner).toBe(`Progressive Reporting Owner ${101 + pageSize}`);
    }
    const bounded = await getCrmReportingDatasets(OPS, { ...parseCrmReportQuery({}), pageSize: 500 as 100 });
    expect(bounded.ok && bounded.datasets[0].rows.length).toBe(100);
  });

  it.each(DATASETS)("rejects changes to the visible %s projection before appending", async (dataset) => {
    const base = `dataset=${dataset}&search=Progressive+Reporting`;
    const first = await GET(request(base));
    const { snapshot } = await first.json();
    if (dataset === "household_aum") await owner.$executeRaw`UPDATE mirror.client_account_aum SET account_aum = 9999 WHERE custodian_account_id = 'RPP-ACCOUNT-1'`;
    if (dataset === "deal_pipeline") await owner.$executeRaw`UPDATE app.deal SET amount = 9999 WHERE id = 'RPP-DEAL-1'`;
    if (dataset === "client_engagement") await owner.$executeRaw`INSERT INTO mirror.task (sf_id, household_sf_id, subject, status) VALUES ('RPP-TASK-1', ${household(1)}, 'Synthetic reporting task', 'Not Started')`;
    if (dataset === "transfers_funding") await owner.$executeRaw`UPDATE app.transfer SET funding_type = 'CHECK' WHERE id = 'RPP-TRANSFER-1'`;
    const changed = await GET(request(`${base}&page=2&snapshot=${snapshot}`));
    expect(changed.status).toBe(409);
    expect(await changed.json()).not.toHaveProperty("rows");
  });

  it("ignores source changes outside the filtered projection and rechecks authorization", async () => {
    const base = "dataset=deal_pipeline&owner=Progressive+Reporting+Owner+101";
    const first = await GET(request(base));
    const before = await first.json();
    await owner.$executeRaw`UPDATE app.deal SET amount = 9999 WHERE id = 'RPP-DEAL-1'`;
    const unchanged = await GET(request(`${base}&snapshot=${before.snapshot}`));
    expect(unchanged.status).toBe(200);
    expect((await unchanged.json()).snapshot).toBe(before.snapshot);
    auth.mockResolvedValue({ user: { ...OPS, role: "ADVISOR" }, navigationScope: "b".repeat(64) });
    const denied = await GET(request());
    expect(denied.status).toBe(403);
    expect(denied.headers.get("x-aoa-navigation-scope")).toBe("b".repeat(64));
    expect(await denied.json()).not.toHaveProperty("rows");
  });
});
