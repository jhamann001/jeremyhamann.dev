import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
import { getTransferDirectory, searchTransferDirectory } from "@/lib/data/transfer-directory";
import { parseTransferBoardQuery } from "@/lib/navigation/transfer-query";
import { GET } from "@/app/api/navigation/transfers/route";
const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "synthetic-transfer@example.invalid" };
const query = (value = "") => parseTransferBoardQuery(new URLSearchParams(`q=PT%20Fixture&${value}`));
const request = (value: string) => new Request(`https://example.test/api/navigation/transfers?${value}`);

gated("Transfer board bounded SQL with current RLS", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM app.transfer WHERE id LIKE 'PT-SYN-%'`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE 'PT-SYN-%' AND table_name IN ('transfer', 'transfer_task')`;
  }
  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!raw) throw new Error("synthetic_database_required");
    const target = new URL(raw);
    for (const [value, username] of [[raw, "aoa"], [process.env.DATABASE_URL, "app_rw"]]) {
      if (!value) throw new Error("explicit_synthetic_database_required");
      const url = new URL(value);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || !(url.pathname.endsWith("_synthetic") || (process.env.CI === "true" && url.pathname === "/aoa"))
        || url.username !== username || url.pathname !== target.pathname || url.hostname !== target.hostname || url.port !== target.port) {
        throw new Error("isolated_synthetic_database_required");
      }
    }
    owner = new PrismaClient({ datasourceUrl: raw }); await cleanup();
    await owner.$executeRaw`
      INSERT INTO app.transfer (id, source, client_first_name, client_last_name, household_name, value, stage, stage_entered_at, owner_kind, updated_at)
      SELECT 'PT-SYN-' || lpad(i::text, 4, '0'), 'APP', 'PT Fixture', lpad(i::text, 4, '0'),
        'PT Fixture Household', i, (CASE WHEN i % 3 = 0 THEN 'FUNDED' WHEN i % 3 = 1 THEN 'DECISION' ELSE 'IN_TRANSFER' END)::app."TransferStage",
        '2026-09-01'::timestamptz, 'OPERATIONS', now() FROM generate_series(1, 405) i`;
    auth.mockResolvedValue({ user: OPS, navigationScope: "a".repeat(64) });
  });
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } });
  it("renders150 interleaved cards with50perlane and full totals, then150/105 unique continuation", async () => {
    const pages = await Promise.all([1, 2, 3].map(number => getTransferDirectory(OPS, query(`page=${number}`))));
    expect(pages.map(page => page.rows.length)).toEqual([150, 150, 105]);
    expect(pages[0].meta.lanes).toEqual({ DECISION: 135, IN_TRANSFER: 135, FUNDED: 135 });
    for (const lane of ["DECISION", "IN_TRANSFER", "FUNDED"]) expect(pages[0].rows.filter(row => row.stage === lane)).toHaveLength(50);
    expect(new Set(pages.flatMap(page => page.rows.map(row => row.id))).size).toBe(405);
    expect(new Set(pages.map(page => page.snapshot)).size).toBe(1);
    expect(pages[0].meta.stats).toEqual(pages[2].meta.stats);
    expect(JSON.stringify(pages)).not.toContain("asset_map_account_number");
  });
  it("keeps independent server lane sort and exact full search counts beyond the first page", async () => {
    const first = await getTransferDirectory(OPS, query("decisionSort=desc&transferSort=asc"));
    expect(first.rows.find(row => row.stage === "DECISION")?.id).toBe("PT-SYN-0403");
    expect(first.rows.find(row => row.stage === "IN_TRANSFER")?.id).toBe("PT-SYN-0002");
    const search = await searchTransferDirectory(OPS, "PT Fixture");
    expect(search.individuals).toHaveLength(50);
    expect(search.households).toEqual([{ key: "PT Fixture Household", name: "PT Fixture Household", count: 405, total: 82215 }]);
    const last = await searchTransferDirectory(OPS, "PT Fixture 0405");
    expect(last.individuals[0].id).toBe("PT-SYN-0405");
  });
  it("reveals completed under focus but excludes completed unfocused rows; owner filters do not change global stats", async () => {
    const focused = await getTransferDirectory(OPS, query());
    expect(focused.meta.hiddenCompleted).toBe(135);
    const normal = await getTransferDirectory(OPS, parseTransferBoardQuery(new URLSearchParams()));
    expect(normal.rows.filter(row => row.id.startsWith("PT-SYN-") && row.stage === "FUNDED")).toHaveLength(0);
    const other = await getTransferDirectory(OPS, query("owner=CLIENT_SERVICE"));
    expect(other.total).toBe(0); expect(other.meta.stats).toEqual(focused.meta.stats);
  });
  it("new values invalidate sequence and expired sessions return no rows", async () => {
    const first = await getTransferDirectory(OPS, query());
    await owner.$executeRaw`UPDATE app.transfer SET value = 777 WHERE id = 'PT-SYN-0405'`;
    const response = await GET(request(`q=PT+Fixture&page=2&pageSize=150&snapshot=${first.snapshot}`));
    expect(response.status).toBe(409); expect(await response.json()).not.toHaveProperty("rows");
    auth.mockResolvedValue(null);
    const absent = await GET(request("")); expect(absent.status).toBe(401);
    expect(absent.headers.get("cache-control")).toBe("private, no-store");
  });
  it("groups differently named snapshots by the same stable household key", async () => {
    await owner.$executeRaw`UPDATE app.transfer SET household_sf_id = 'PT-GROUP', household_name = 'First alias' WHERE id = 'PT-SYN-0404'`;
    await owner.$executeRaw`UPDATE app.transfer SET household_sf_id = 'PT-GROUP', household_name = 'Second alias' WHERE id = 'PT-SYN-0405'`;
    const search = await searchTransferDirectory(OPS, "PT Fixture");
    expect(search.households.filter(row => row.key === "PT-GROUP")).toHaveLength(1);
    expect(search.households.find(row => row.key === "PT-GROUP")?.count).toBe(2);
  });
});
