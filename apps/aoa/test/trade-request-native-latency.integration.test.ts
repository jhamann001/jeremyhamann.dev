import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

// WO-AC-9 pre-cutover proxy (ticket): list, detail and notification reads answered natively within 2 seconds
// at p95 on the production-sized synthetic dataset. Opt-in (TRADE_REQUEST_COPY_TEST_DB=1); scratch database.
const DB = vi.hoisted(() => {
  const name = "trb_latency_tgt";
  const url = `postgresql://aoa@localhost:5432/${name}?schema=app`;
  // Reads run as the runtime role; the migration and the dataset load run as the owner.
  if (process.env.TRADE_REQUEST_COPY_TEST_DB === "1") process.env.DATABASE_URL = `postgresql://app_rw@localhost:5432/${name}?schema=app`;
  return { name, url };
});
vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));

import { prisma } from "@/lib/db";
import { callTradeRequestService, type TradeRequestCall } from "@/lib/trade-requests/client";
import { tradeRequestWarehouseConfigured } from "@/lib/trade-requests/native/reads/sources";
import { blankFeedEnv } from "./fixtures/trade-request-feed-env";

const ENABLED = process.env.TRADE_REQUEST_COPY_TEST_DB === "1";
const RUNS = 20;
const P95_LIMIT_MS = 2_000;
const sh = (command: string) => execSync(command, { stdio: "pipe" });

const READS: Array<{ name: string; user: { id: string; email: string }; call: TradeRequestCall }> = [
  { name: "list.page", user: { id: "latency-ops", email: "ops.reader@example.test" }, call: { operation: "listRequests", method: "GET", path: "/requests", query: { limit: 50 }, defaultMessage: "x" } },
  { name: "list.search", user: { id: "latency-ops", email: "ops.reader@example.test" }, call: { operation: "listRequests", method: "GET", path: "/requests", query: { limit: 50, q: "Latency Client 0042" }, defaultMessage: "x" } },
  { name: "list.export", user: { id: "latency-ops", email: "ops.reader@example.test" }, call: { operation: "listRequests", method: "GET", path: "/requests", query: { all: true }, defaultMessage: "x" } },
  { name: "detail", user: { id: "latency-ops", email: "ops.reader@example.test" }, call: { operation: "requestDetail", method: "GET", path: "/requests/REQ-L4187940", defaultMessage: "x" } },
  { name: "notifications", user: { id: "latency-heavy", email: "heavy.reader@example.test" }, call: { operation: "notificationsList", method: "GET", path: "/notifications", query: { limit: 100 }, defaultMessage: "x", channel: "bell" } },
];

describe.skipIf(!ENABLED)("native read latency on the production-sized synthetic dataset", () => {
  beforeAll(() => {
    sh(`dropdb --if-exists ${DB.name} && createdb -O aoa ${DB.name}`);
    sh(`DIRECT_DATABASE_URL="${DB.url}" DATABASE_URL="${DB.url}" npx prisma migrate deploy`);
    sh(`psql -q -v ON_ERROR_STOP=1 postgresql://aoa@localhost:5432/${DB.name} -f test/fixtures/trade-request-latency-dataset.sql`);
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
    vi.stubEnv("TRADE_REQUESTS_NATIVE", "1");
    blankFeedEnv();
    if (tradeRequestWarehouseConfigured()) throw new Error("feeds must be unconfigured in the latency check");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.$disconnect();
    sh(`dropdb --if-exists ${DB.name}`);
  });

  it.each(READS.map((r) => [r.name, r] as const))("%s p95 under 2 s", async (name, read) => {
    m.auth.mockResolvedValue({ user: read.user });
    const first = await callTradeRequestService(read.call);
    expect(first.ok).toBe(true);
    const timings: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const started = performance.now();
      const result = await callTradeRequestService(read.call);
      timings.push(performance.now() - started);
      expect(result.ok).toBe(true);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.ceil(RUNS * 0.95) - 1];
    process.stdout.write(`${JSON.stringify({ event: "trade_request_native_latency", read: name, runs: RUNS, p95Ms: Math.round(p95) })}\n`);
    expect(p95).toBeLessThan(P95_LIMIT_MS);
    markCase("trade-request-native-latency", name, "integration");
  }, 120_000);
});
