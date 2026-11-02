import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { driftSeedStatements, type DriftSeed } from "./e2e/trade-requests-drift-seed";
import {
  accountDriftHistoryResponseSchema, accountDriftRunResponseSchema, driftAllowListResponseSchema,
} from "@/lib/trade-requests/drift-view/schemas";

// ticket: ticket's drift read routes, run against a scratch database as the runtime role, answer what the
// Drift screen's schemas accept and what the standalone routes answered for the same synthetic seed
// (test/fixtures/trade-request-drift-view-parity.json). Opt-in: TRADE_REQUEST_COPY_TEST_DB=1.
vi.mock("server-only", () => ({}));
const session = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: session.auth }));

const RUN = process.env.TRADE_REQUEST_COPY_TEST_DB === "1";
const DB = "trb09_payload";
const OWNER_URL = `postgresql://aoa@localhost:5432/${DB}?schema=app`;
const RUNTIME_URL = `postgresql://app_rw@localhost:5432/${DB}?schema=app`;
const ADMIN_ID = "usr_trb09_payload_admin";
const SEED = JSON.parse(readFileSync("test/fixtures/trade-request-drift-view-seed.json", "utf8")) as DriftSeed;
const PARITY = JSON.parse(readFileSync("test/fixtures/trade-request-drift-view-parity.json", "utf8")) as {
  api: { history: { days: number; runs: Array<{ runDateLocal: string }> }; detail: Record<string, { runDateLocal: string; accounts: Array<{ runDateLocal: string }> }>; allowList: unknown };
};

type RouteGet = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
let routes: { history: RouteGet; run: RouteGet; allowList: RouteGet; overlapHead: RouteGet; disconnect: () => Promise<void> };
let owner: PrismaClient;

/** Run dates become D0 (latest), D1, … so a capture from another day compares equal. */
function byOffset<T>(value: T, dates: string[]): T {
  return JSON.parse(JSON.stringify(value), (key, v) => (key === "runDateLocal" && typeof v === "string" ? `D${dates.indexOf(v)}` : v));
}
const datesOf = (runs: Array<{ runDateLocal: string }>) => [...new Set(runs.map((r) => r.runDateLocal))].sort().reverse();
const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe.skipIf(!RUN)("Drift read routes answer the Drift screen's contract (ticket)", () => {
  beforeAll(async () => {
    execFileSync("dropdb", ["--if-exists", DB]);
    execFileSync("createdb", ["-O", "aoa", DB]);
    execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DIRECT_DATABASE_URL: OWNER_URL, DATABASE_URL: OWNER_URL }, stdio: "ignore" });
    owner = new PrismaClient({ datasourceUrl: OWNER_URL });
    await owner.user.create({ data: { id: ADMIN_ID, email: "admin.payload@example.test", name: "Synthetic Admin", role: "ADMIN" } });
    for (const sql of driftSeedStatements(SEED, "trade_request", { shadow: true })) await owner.$executeRawUnsafe(sql);
    await owner.$executeRawUnsafe(`UPDATE trade_request.serving_state SET serving_source = 'aoa', updated_by = 'ticket-test' WHERE id`);
    process.env.DATABASE_URL = RUNTIME_URL;
    process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE = "1";
    delete process.env.TRADE_REQUEST_DRIFT_EXCLUSION_OVERLAP_ENABLED;
    session.auth.mockResolvedValue({ user: { id: ADMIN_ID } });
    vi.resetModules();
    // lib/db.ts builds its client from DATABASE_URL at module load, so the routes are imported after it is set.
    const history = await import("@/app/api/trade-requests/drift/history/route");
    const run = await import("@/app/api/trade-requests/drift/runs/[runDateLocal]/route");
    const allowList = await import("@/app/api/trade-requests/drift/allow-list/route");
    const overlap = await import("@/app/api/trade-requests/drift/exclusion-overlap/route");
    const db = await import("@/lib/db");
    routes = {
      history: history.GET as RouteGet,
      run: run.GET as unknown as RouteGet,
      allowList: allowList.GET as RouteGet,
      overlapHead: overlap.HEAD as RouteGet,
      disconnect: () => db.prisma.$disconnect(),
    };
  }, 240_000);

  afterAll(async () => {
    await routes?.disconnect();
    await owner?.$disconnect();
    delete process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE;
    execFileSync("dropdb", ["--if-exists", DB]);
  });

  it("history: the screen's schema accepts it, it equals the standalone answer, and it holds no shadow result", async () => {
    const response = await routes.history(request("/api/trade-requests/drift/history?days=30"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(accountDriftHistoryResponseSchema.safeParse(body).success).toBe(true);
    expect(byOffset(body, datesOf(body.runs))).toEqual(byOffset(PARITY.api.history, datesOf(PARITY.api.history.runs)));
    expect(JSON.stringify(body)).not.toContain(SEED.shadowAccounts[0].accountId);
  });

  it("run detail for the latest date: the screen's schema accepts it and it equals the standalone answer", async () => {
    const history = await (await routes.history(request("/api/trade-requests/drift/history?days=30"))).json();
    const dates = datesOf(history.runs);
    const response = await routes.run(request(`/api/trade-requests/drift/runs/${dates[0]}`), { params: Promise.resolve({ runDateLocal: dates[0] }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(accountDriftRunResponseSchema.safeParse(body).success).toBe(true);
    const captured = datesOf(PARITY.api.history.runs);
    expect(byOffset(body, dates)).toEqual(byOffset(PARITY.api.detail[captured[0]], captured));
  });

  it("allow list equals the standalone answer; the overlap diagnostic answers 404 while its switch is off", async () => {
    const response = await routes.allowList(request("/api/trade-requests/drift/allow-list"));
    const body = await response.json();
    expect(driftAllowListResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual(PARITY.api.allowList);
    expect((await routes.overlapHead(request("/api/trade-requests/drift/exclusion-overlap", { method: "HEAD" }))).status).toBe(404);
  });
});
