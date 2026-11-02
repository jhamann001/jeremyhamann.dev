import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
import { getDealDirectory, exportMatchingDeals, getDealSuggestions } from "@/lib/data/deals";
import { GET } from "@/app/api/navigation/deals/route";
import { sortDeals, SORTABLE_COLUMNS } from "@/components/deals/deal-sort";
import { filterDeals } from "@/components/deals/deal-filter";
import { buildDealSuggestions } from "@/components/deals/deal-form";
import type { DealDirectoryFilters } from "@/lib/navigation/deals-query";

const gated = process.env.DEALS_TEST_DB_URL || (process.env.CI === "true" && process.env.AUDIT_TEST_DB_URL) ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "deals-synthetic@example.invalid" };
const VIEWER = { role: "VIEWER", email: "viewer-synthetic@example.invalid" };
const defaults: DealDirectoryFilters = { query: "", stage: "all", sortKey: null, sortDir: "asc", archived: false };

gated("Deals progressive SQL against isolated synthetic PostgreSQL", () => {
  let owner: PrismaClient, runtime: PrismaClient;
  const ids = Array.from({ length: 352 }, (_, index) => `DP-SYN-${String(index + 1).padStart(4, "0")}`);
  async function cleanup() {
    await owner.deal.deleteMany({ where: { id: { in: ids } } });
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE table_name = 'deal' AND row_pk LIKE 'DP-SYN-%'`;
  }
  beforeAll(async () => {
    const raw = process.env.DIRECT_DATABASE_URL, app = process.env.DATABASE_URL;
    if (!raw || !app) throw new Error("explicit_synthetic_database_required");
    for (const [value, username] of [[raw, "aoa"], [app, "app_rw"]]) {
      const url = new URL(value);
      const ciDatabase = process.env.CI === "true" && url.pathname === "/aoa";
      if (!["postgresql:", "postgres:"].includes(url.protocol) ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        (!["/aoa_deals_synthetic", "/aoa_rollout_synthetic", "/aoa_pagination_synthetic"].includes(url.pathname) && !ciDatabase) || url.username !== username ||
        ["host", "hostaddr", "service", "servicefile"].some(key => url.searchParams.has(key)) ||
        process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || ["prod", "dev"].includes(process.env.APP_ENV ?? "")) throw new Error("isolated_deals_synthetic_database_required");
    }
    if (new URL(raw).host !== new URL(app).host || new URL(raw).pathname !== new URL(app).pathname) throw new Error("deals_fixture_database_mismatch");
    owner = new PrismaClient({ datasourceUrl: raw }); runtime = new PrismaClient({ datasourceUrl: app });
    await cleanup();
  });
  beforeEach(async () => {
    await cleanup();
    auth.mockResolvedValue({ user: OPS, navigationScope: "a".repeat(64) });
    await owner.$executeRaw`
      INSERT INTO app.deal (id, source, name, client_first_name, client_last_name,
        household_name, household_sf_id, amount, stage, created_date, close_date,
        statements, account_type, account_last4, transferring_firm, cedar_ridge_user_id,
        owner_name, archived_at, archived_by, archived_reason, updated_at)
      SELECT 'DP-SYN-' || lpad(i::text, 4, '0'), 'APP', 'Invented deal ' || i,
        'Invented', CASE WHEN i = 350 THEN 'Beyond Page One' ELSE 'Person ' || (i % 7) END,
        'Invented household ' || (i % 9), 'DP-HH-' || (i % 9), i * 100,
        (ARRAY['POTENTIAL','COMMITTED','FUNDING','WON','LOST'])[1 + (i % 5)]::app."DealStage",
        '2026-09-01'::date, CASE WHEN i % 2 = 0 THEN '2026-10-01'::date ELSE NULL END,
        i % 3 <> 0, CASE WHEN i % 2 = 0 THEN 'Cash' ELSE 'IRA' END, lpad((i % 100)::text, 4, '0'),
        CASE WHEN i = 349 THEN 'Literal%Firm_' ELSE 'Invented Firm' END, 'synthetic-private-' || i,
        'Never Search This Owner', CASE WHEN i > 350 THEN '2026-09-02'::timestamptz ELSE NULL END,
        CASE WHEN i > 350 THEN 'synthetic@example.invalid' ELSE NULL END,
        CASE WHEN i > 350 THEN 'Synthetic removal reason' ELSE NULL END, '2026-09-01'::timestamptz
      FROM generate_series(1, 352) i`;
  });
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } if (runtime) await runtime.$disconnect(); });

  it("returns 100/100/100/50 unique ordered rows with identical full-scope metadata", async () => {
    const pages = await Promise.all([1, 2, 3, 4].map(page => getDealDirectory(OPS, defaults, page)));
    expect(pages.map(page => page.rows.length)).toEqual([100, 100, 100, 50]);
    expect(pages.flatMap(page => page.rows.map(row => row.id))).toEqual(ids.slice(0, 350));
    expect(new Set(pages.map(page => page.snapshot)).size).toBe(1);
    for (const page of pages) {
      expect(page.total).toBe(350); expect(page.pageCount).toBe(4);
      expect(page.meta.counts).toEqual({ all: 350, no_statements: 116, POTENTIAL: 70, COMMITTED: 70, FUNDING: 70, WON: 70, LOST: 70 });
      expect(page.meta.archivedCount).toBe(2);
      expect(page.meta.kpis.reduce((sum, kpi) => sum + kpi.totalAmount, 0)).toBe(6_142_500);
    }
    expect((await getDealDirectory(OPS, defaults, 1, 999)).rows).toHaveLength(200);
  });
  it("preserves server-side search/stage behavior and never searches hidden owners", async () => {
    const all = await exportMatchingDeals(OPS, defaults);
    for (const query of ["person 1", "Invented household 3", "Cash", "Literal%Firm_", "Never Search This Owner"]) {
      const filters = { ...defaults, query };
      const result = await getDealDirectory(OPS, filters);
      expect(result.total).toBe(filterDeals(all, "all", query).length);
      expect(result.rows.map(row => row.id)).toEqual(filterDeals(all, "all", query).slice(0, 100).map(row => row.id));
    }
    const missing = await getDealDirectory(OPS, { ...defaults, stage: "no_statements" });
    expect(missing.total).toBe(116); expect(missing.meta.counts.all).toBe(350);
  });
  it.each(SORTABLE_COLUMNS)("matches existing %s sort semantics across page boundaries", async sortKey => {
    const all = await exportMatchingDeals(OPS, defaults);
    for (const sortDir of ["asc", "desc"] as const) {
      const expected = sortDeals(all, { key: sortKey, dir: sortDir === "asc" ? 1 : -1 });
      const pages = await Promise.all([1, 2, 3, 4].map(page => getDealDirectory(OPS, { ...defaults, sortKey, sortDir }, page)));
      expect(pages.flatMap(page => page.rows.map(row => row.id))).toEqual(expected.map(row => row.id));
    }
  });
  it("exports every match beyond the mounted page and keeps role masking", async () => {
    const rows = await exportMatchingDeals(VIEWER, defaults);
    expect(rows).toHaveLength(350);
    expect(JSON.stringify(rows)).not.toContain("synthetic-private-");
    expect(rows.every(row => row.cedar_ridge_user_id_masked)).toBe(true);
    expect((await getDealDirectory(VIEWER, defaults)).meta.archivedCount).toBeNull();
    await expect(getDealDirectory(VIEWER, { ...defaults, archived: true })).rejects.toThrow("forbidden");
    await expect(exportMatchingDeals(OPS, { ...defaults, archived: true })).rejects.toThrow("forbidden");
    auth.mockResolvedValue({ user: VIEWER, navigationScope: "a".repeat(64) });
    const response = await GET(new Request("https://example.test/api/navigation/deals?format=csv"));
    const csv = await response.text();
    expect(csv).toContain("Invented deal 350"); expect(csv).not.toContain("Invented deal 351");
    expect(csv).not.toContain("synthetic-private-");
  });
  it("uses the complete active population for distinct form suggestions", async () => {
    // The newest matching client has no household; the next populated one
    // must backfill it exactly as the original suggestion contract did.
    await owner.$executeRaw`UPDATE app.deal SET household_name = NULL, household_sf_id = NULL WHERE id = 'DP-SYN-0001'`;
    const expected = buildDealSuggestions(await exportMatchingDeals(OPS, defaults));
    const result = await getDealSuggestions(OPS);
    expect(result.clients).toEqual(expected.clients);
    expect(result.households).toEqual(expected.households);
    expect(result.clients.some(client => client.full === "Invented Beyond Page One")).toBe(true);
  });
  it("keeps Removed rows separate with full active KPIs and no implicit new page", async () => {
    const result = await getDealDirectory(OPS, { ...defaults, archived: true });
    expect(result.rows.map(row => row.id)).toEqual(ids.slice(350));
    expect(result.total).toBe(2); expect(result.meta.counts.all).toBe(350);
    const outside = await getDealDirectory(OPS, defaults, 5);
    expect(outside.rows).toEqual([]);
    expect((await GET(new Request(`https://example.test/api/navigation/deals?page=5&snapshot=${outside.snapshot}`))).status).toBe(416);
  });
  it("rejects edits/metadata-only changes between pages instead of duplicate appends", async () => {
    const first = await getDealDirectory(OPS, { ...defaults, stage: "WON" });
    await owner.$executeRaw`UPDATE app.deal SET amount = amount + 1 WHERE id = 'DP-SYN-0001'`;
    const next = await getDealDirectory(OPS, { ...defaults, stage: "WON" });
    expect(next.snapshot).not.toBe(first.snapshot);
    expect(next.rows).toEqual(first.rows);
    expect((await GET(new Request(`https://example.test/api/navigation/deals?stage=WON&page=2&snapshot=${first.snapshot}`))).status).toBe(409);
  });
  it("executes each read under existing locked deal RLS, with no outside-scope read", async () => {
    const raw = await runtime.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM app.deal`;
    expect(Number(raw[0].count)).toBe(0);
    const advisor = await getDealDirectory({ role: "ADVISOR", email: "another-synthetic@example.invalid" }, defaults);
    // Current deal_read_all_roles policy is deliberately firmwide for valid roles.
    expect(advisor.total).toBe(350);
    auth.mockResolvedValue(null);
    const response = await GET(new Request("https://example.test/api/navigation/deals"));
    expect(response.status).toBe(401); expect(await response.json()).not.toHaveProperty("rows");
  });
});
