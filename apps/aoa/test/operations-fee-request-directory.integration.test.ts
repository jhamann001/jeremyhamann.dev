import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));
import { GET } from "@/app/api/operations/fee-requests/route";
import { operationsFeeRequestDirectory, transitionOperationsFeeRequest } from "@/lib/data/operations-fee-requests";
import { parseFeeRequestQuery } from "@/lib/operations/fee-request-query";
import { seedFeeRequests, cleanupFeeRequests, feeHistoryId } from "./e2e/operations-fee-fixture";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const IDENTITY = { role: "OPERATIONS", email: "fee-paging-synthetic@example.test" };
const query = (value = "") => parseFeeRequestQuery(new URLSearchParams(value));
const request = (value = "") => new Request(`https://example.test/api/operations/fee-requests?${value}`);
const search = "q=Fee+Paging";

gated("Fee request full history with actual PostgreSQL/RLS", () => {
  let owner: PrismaClient;
  beforeAll(async () => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!url || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) throw new Error("Requires disposable loopback PostgreSQL");
    owner = new PrismaClient({ datasourceUrl: url });
  });
  beforeEach(async () => {
    vi.stubEnv("APP_ENV", "dev"); vi.stubEnv("OPERATIONS_TOOLS", "1"); vi.stubEnv("OPERATIONS_FEE_REQUESTS", "1");
    authMock.mockResolvedValue({ user: IDENTITY, navigationScope: "a".repeat(64) });
    await seedFeeRequests(owner);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { if (owner) { await cleanupFeeRequests(owner); await owner.$disconnect(); } });

  it("loads all 215 credits in 100/100/15 pages with honest counts and stable equal-time ordering", async () => {
    const first = await operationsFeeRequestDirectory(IDENTITY, query(search));
    const second = await operationsFeeRequestDirectory(IDENTITY, query(`${search}&page=2&snapshot=${first.snapshot}`));
    const third = await operationsFeeRequestDirectory(IDENTITY, query(`${search}&page=3&snapshot=${first.snapshot}`));
    expect([first.rows.length, second.rows.length, third.rows.length]).toEqual([100, 100, 15]);
    expect(first.counts).toEqual({ total: 215, pending: 200, approved: 10, credited: 5, closed: 0 });
    expect([...first.rows, ...second.rows, ...third.rows].map((row) => row.id)).toEqual(Array.from({ length: 215 }, (_, index) => feeHistoryId(index + 1)));
    expect(third.rows.at(-1)?.submittedAt).toBe("2019-01-01T12:00:00.000Z");
    expect(first.rows[0]).toMatchObject({ clientName: "Fee Paging Synthetic client", feeAmount: "1.25", feeTypes: ["Wire", "Transaction"], accounts: [{ id: "fee-history-synthetic-account", label: "Brokerage · ••••0042", ownerName: "Fee Paging Synthetic client" }], events: [expect.objectContaining({ note: "Synthetic audit note" })] });
  });
  it("filters and sorts the whole population, separates exception subtypes, and includes both date endpoints", async () => {
    const credited = await operationsFeeRequestDirectory(IDENTITY, query(`${search}&status=CREDITED&sort=amount&dir=asc`));
    expect(credited.rows.map((row) => row.id)).toEqual([211, 212, 213, 214, 215].map(feeHistoryId));
    expect(credited.counts).toEqual({ total: 5, credited: 5, approved: 0, pending: 0, closed: 0 });
    expect((await operationsFeeRequestDirectory(IDENTITY, query(`${search}&tab=exceptions&type=SERVICE_GUARANTEE&sort=waiver`))).total).toBe(5);
    const range = await operationsFeeRequestDirectory(IDENTITY, query(`${search}&from=2026-09-17&to=2026-09-17`));
    expect(range.total).toBe(214);
    const exact = await operationsFeeRequestDirectory(IDENTITY, query(`q=${feeHistoryId(215)}`));
    expect(exact.total).toBe(1);
  });
  it("search treats wildcard input literally and searches full authorized household names", async () => {
    expect((await operationsFeeRequestDirectory(IDENTITY, query("q=Fee+Paging+Synthetic+household"))).total).toBe(215);
    expect((await operationsFeeRequestDirectory(IDENTITY, query("q=%25"))).total).toBe(0);
  });
  it("detects status and note changes before appending without exposing mixed rows", async () => {
    const first = await operationsFeeRequestDirectory(IDENTITY, query(search));
    await transitionOperationsFeeRequest(IDENTITY, { requestId: feeHistoryId(1), action: "APPROVE", note: "Synthetic review", creditedDate: null, apexRequestId: null });
    expect((await GET(request(`${search}&page=2&snapshot=${first.snapshot}`))).status).toBe(409);
    const fresh = await operationsFeeRequestDirectory(IDENTITY, query(search));
    await owner.operationsFeeRequestEvent.create({ data: { request_id: feeHistoryId(1), action: "APPROVED", actor_email: IDENTITY.email, actor_role: "OPERATIONS", from_status: "PENDING", to_status: "APPROVED", detail: { note: "New synthetic review note" } } });
    expect((await GET(request(`${search}&page=2&snapshot=${fresh.snapshot}`))).status).toBe(409);
  });
  it("returns an empty result under unauthorized RLS, denies API role changes, and rejects a page beyond the end", async () => {
    expect((await operationsFeeRequestDirectory({ role: "VIEWER", email: IDENTITY.email }, query(search))).rows).toEqual([]);
    const first = await operationsFeeRequestDirectory(IDENTITY, query(search));
    expect((await GET(request(`${search}&page=4&snapshot=${first.snapshot}`))).status).toBe(416);
    authMock.mockResolvedValue({ user: { ...IDENTITY, role: "ADVISOR" } });
    expect((await GET(request(`${search}&page=2&snapshot=${first.snapshot}`))).status).toBe(403);
  });
});
