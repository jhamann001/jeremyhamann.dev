import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));
import { reconciliationHistoryPage } from "@/lib/data/reconciliation-history";
import { tradeReconciliationPageData } from "@/lib/data/trade-reconciliation";
import { GET } from "@/app/api/operations/trade-reconciliation/history/route";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const identity = { role: "OPERATIONS", email: "recon-pagination@example.test" };
const id = (n: number) => `reconpaging${String(n).padStart(8, "0")}`;
const request = (query = "") => new Request(`https://example.test/api/operations/trade-reconciliation/history?${query}`);

gated("Reconciliation history: PostgreSQL pagination, rollups and RLS", () => {
  let owner: PrismaClient;
  const cleanup = async () => {
    await owner.$executeRaw`DELETE FROM app.trade_reconciliation_note_event WHERE run_id LIKE 'reconpaging%'`;
    await owner.$executeRaw`DELETE FROM app.trade_reconciliation_review_event WHERE run_id LIKE 'reconpaging%'`;
    await owner.$executeRaw`DELETE FROM app.trade_reconciliation_run WHERE id LIKE 'reconpaging%'`;
  };
  beforeAll(async () => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Reconciliation paging tests require an isolated loopback database");
    owner = new PrismaClient({ datasourceUrl: url });
    await cleanup();
    vi.stubEnv("APP_ENV", "dev");
    vi.stubEnv("OPERATIONS_TOOLS", "1");
    vi.stubEnv("OPERATIONS_TRADE_RECONCILIATION", "1");
    authMock.mockResolvedValue({ user: identity, navigationScope: "a".repeat(64) });
    await owner.$executeRaw`
      INSERT INTO app.trade_reconciliation_run (id, run_date, business_date, algorithm_version, source_scope_version, source_digest, source_commit_sha,
        apex_record_count, meridian_record_count, raw_match_count, exception_count, raw_match_rate, payload, completed_by, completed_at)
      SELECT 'reconpaging' || LPAD(i::text, 8, '0'), DATE '2035-01-01' + i, DATE '2035-01-01' + i,
        'account-aware-v2', 'synthetic-paging', LPAD(i::text, 64, '0'), 'synthetic', 10, 10, 8, 2, 80, '[]'::jsonb,
        ${identity.email}, TIMESTAMPTZ '2036-01-01 00:00:00Z'
      FROM generate_series(1, 315) i`;
  });
  afterAll(async () => { vi.unstubAllEnvs(); if (owner) { await cleanup(); await owner.$disconnect(); } });

  it("reaches all 315 runs in bounded stable pages and opens an old run directly", async () => {
    const pages = await Promise.all([1, 2, 3, 4].map((page) => reconciliationHistoryPage(identity, "daily", page)));
    expect(pages.map((page) => page.rows.length)).toEqual([100, 100, 100, 15]);
    expect(pages[0].total).toBe(315);
    const ids = pages.flatMap((page) => page.rows.map((row) => row.runId));
    expect(ids).toEqual(Array.from({ length: 315 }, (_, index) => id(315 - index)));
    expect(new Set(pages.map((page) => page.snapshot)).size).toBe(1);
    expect((await tradeReconciliationPageData(identity, id(1))).run?.id).toBe(id(1));
    expect((await tradeReconciliationPageData(identity)).run).toBeNull();
  });
  it("aggregates every trade date, not the first page, into monthly and quarterly periods", async () => {
    const monthly = await reconciliationHistoryPage(identity, "monthly", 1);
    const quarterly = await reconciliationHistoryPage(identity, "quarterly", 1);
    expect(monthly.rows.reduce((sum, row) => sum + row.matched, 0)).toBe(315 * 8);
    expect(quarterly.rows.reduce((sum, row) => sum + row.matched, 0)).toBe(315 * 8);
    expect(monthly.rows.every((row) => row.rate === "80.00%")).toBe(true);
    expect(quarterly.rows.map((row) => row.period)).toEqual(["2035 Q4", "2035 Q3", "2035 Q2", "2035 Q1"]);
  });
  it("denies non-Operations users in both the API and database", async () => {
    const denied = { role: "ADVISOR", email: identity.email };
    expect((await reconciliationHistoryPage(denied, "daily", 1)).rows).toEqual([]);
    authMock.mockResolvedValueOnce({ user: denied });
    expect((await GET(request())).status).toBe(403);
  });
  it("uses the ID tie-breaker for reruns and rejects a changed snapshot before appending", async () => {
    const first = await reconciliationHistoryPage(identity, "daily", 1);
    await owner.$executeRaw`
      INSERT INTO app.trade_reconciliation_run (id, run_date, business_date, algorithm_version, source_scope_version, source_digest, source_commit_sha,
        apex_record_count, meridian_record_count, raw_match_count, exception_count, raw_match_rate, payload, completed_by, completed_at)
      SELECT ${id(316)}, run_date, business_date, algorithm_version, source_scope_version, LPAD('316', 64, '0'), source_commit_sha,
        20, 20, 20, 0, 100, '[]'::jsonb, completed_by, completed_at FROM app.trade_reconciliation_run WHERE id = ${id(315)}`;
    expect((await GET(request(`page=2&snapshot=${first.snapshot}`))).status).toBe(409);
    const changed = await reconciliationHistoryPage(identity, "daily", 1);
    expect(changed.rows.slice(0, 2).map((row) => row.runId)).toEqual([id(316), id(315)]);
    const quarterly = await reconciliationHistoryPage(identity, "quarterly", 1);
    expect(quarterly.rows.reduce((sum, row) => sum + row.matched, 0)).toBe(314 * 8 + 20);
  });
  it("keeps imported summary-only values and notes without inventing trade details", async () => {
    await owner.$executeRaw`UPDATE app.trade_reconciliation_run SET legacy_source = 'fee_store_daily_reconciliation', legacy_source_id = 'synthetic-paging', legacy_unmatched_apex = 3, legacy_unmatched_alpha = 4, legacy_match_rate = 76.123456789 WHERE id = ${id(1)}`;
    await owner.$executeRaw`INSERT INTO app.trade_reconciliation_note_event (id, run_id, note, author_email) VALUES ('reconpagingnote', ${id(1)}, 'Synthetic retained note', ${identity.email})`;
    const selected = await tradeReconciliationPageData(identity, id(1));
    expect(selected.run?.rows).toEqual([]);
    expect(selected.run?.summary).toMatchObject({ summaryOnly: true, sourceBreaks: 2, unmatchedApex: 3, unmatchedMeridian: 4, rawMatchRate: 80 });
    expect(selected.run?.runNote).toBe("Synthetic retained note");
    const last = await reconciliationHistoryPage(identity, "daily", 4);
    expect(last.rows.at(-1)).toMatchObject({ runId: id(1), rate: "80.00%", unresolved: 9 });
  });
  it("recalculates saved rates from Meridian counts consistently in daily, monthly and quarterly history", async () => {
    await owner.$executeRaw`
      INSERT INTO app.trade_reconciliation_run (id, run_date, business_date, algorithm_version, source_scope_version, source_digest, source_commit_sha,
        apex_record_count, meridian_record_count, raw_match_count, exception_count, raw_match_rate, payload, completed_by, completed_at)
      VALUES
        (${id(401)}, DATE '2040-01-01', DATE '2040-01-01', 'account-aware-v2', 'synthetic-rate', LPAD('401',64,'0'), 'synthetic', 577, 1000, 577, 423, 100, '[]'::jsonb, ${identity.email}, NOW()),
        (${id(402)}, DATE '2040-01-02', DATE '2040-01-02', 'account-aware-v2', 'synthetic-rate', LPAD('402',64,'0'), 'synthetic', 1423, 1000, 1000, 423, 70, '[]'::jsonb, ${identity.email}, NOW()),
        (${id(403)}, DATE '2040-04-01', DATE '2040-04-01', 'account-aware-v2', 'synthetic-rate', LPAD('403',64,'0'), 'synthetic', 1, 0, 0, 1, 100, '[]'::jsonb, ${identity.email}, NOW()),
        (${id(404)}, DATE '2040-07-01', DATE '2040-07-01', 'account-aware-v2', 'synthetic-rate', LPAD('404',64,'0'), 'synthetic', 20000, 20001, 20000, 1, 100, '[]'::jsonb, ${identity.email}, NOW())`;
    const daily = await reconciliationHistoryPage(identity, "daily", 1);
    expect(daily.rows.find((row) => row.runId === id(401))).toMatchObject({ rate: "57.70%", unresolved: 423 });
    expect(daily.rows.find((row) => row.runId === id(402))).toMatchObject({ rate: "100.00%", unresolved: 423 });
    expect(daily.rows.find((row) => row.runId === id(403))).toMatchObject({ rate: "N/A" });
    expect(daily.rows.find((row) => row.runId === id(404))).toMatchObject({ rate: "99.99%" });
    expect((await tradeReconciliationPageData(identity, id(401))).run?.summary.rawMatchRate).toBeCloseTo(57.7);
    expect((await tradeReconciliationPageData(identity, id(402))).run?.summary.rawMatchRate).toBe(100);
    expect((await tradeReconciliationPageData(identity, id(403))).run?.summary.rawMatchRate).toBeNull();
    const monthly = await reconciliationHistoryPage(identity, "monthly", 1);
    const quarterly = await reconciliationHistoryPage(identity, "quarterly", 1);
    expect(monthly.rows.find((row) => row.period === "2040-01")).toMatchObject({ rate: "78.85%", matched: 1577 });
    expect(quarterly.rows.find((row) => row.period === "2040 Q1")).toMatchObject({ rate: "78.85%", matched: 1577 });
    expect((await owner.tradeReconciliationRun.findUnique({ where: { id: id(401) } }))?.raw_match_rate.toNumber()).toBe(100);
  });
});
