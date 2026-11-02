import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { holder, sendSpy, authSpy } = vi.hoisted(() => ({
  holder: { client: null as unknown },
  sendSpy: vi.fn(),
  authSpy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  get prisma() {
    return holder.client;
  },
}));
vi.mock("@/lib/slack/trade-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/slack/trade-requests")>()),
  sendTradeRequestSlack: sendSpy,
}));
vi.mock("@/lib/cron/trade-request-digest-auth", () => ({ requireTradeRequestDigestCronAuth: authSpy }));

import { POST } from "@/app/api/cron/trade-request-digest/route";
import { collectDigestSummary, computeRunDate, runDailyDigest } from "@/lib/trade-requests/native/digest";

// Opt-in: needs local Postgres 16 with the aoa and app_rw roles (prerequisites in the ticket plan).
const suite = process.env.TRADE_REQUEST_COPY_TEST_DB === "1" ? describe : describe.skip;
const DB = "trb_digest_tgt";
const OWNER_URL = `postgresql://aoa@localhost:5432/${DB}`;
const APP_URL = `postgresql://app_rw@localhost:5432/${DB}`;
const ADVISOR = "00000000-0000-4000-8000-000000000386";

suite("Trade Request digest against a migrated scratch database", () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  const post = () => POST(new Request("https://x/api/cron/trade-request-digest", { method: "POST", headers: { authorization: "Bearer synthetic-jwt" } }));
  const claims = async () => owner.$queryRawUnsafe<Array<{ run_date: string; summary: unknown }>>(
    "SELECT run_date::text AS run_date, summary FROM trade_request.digest_runs ORDER BY run_date");

  beforeAll(() => {
    execFileSync("dropdb", ["--if-exists", DB]);
    execFileSync("createdb", ["-O", "aoa", DB]);
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DIRECT_DATABASE_URL: `${OWNER_URL}?schema=app`, DATABASE_URL: `${OWNER_URL}?schema=app` },
      stdio: "ignore",
    });
    owner = new PrismaClient({ datasourceUrl: OWNER_URL });
    app = new PrismaClient({ datasourceUrl: APP_URL });
    holder.client = app;
  }, 120_000);

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
    vi.stubEnv("TRADE_REQUESTS_DIGEST_JOB", "1");
    authSpy.mockResolvedValue(true);
    sendSpy.mockResolvedValue({ status: "sent" });
    await owner.$executeRawUnsafe("TRUNCATE trade_request.digest_runs, trade_request.trade_requests, trade_request.users CASCADE");
    await owner.$executeRawUnsafe("UPDATE trade_request.serving_state SET serving_source = 'standalone', digest_sender = 'standalone', drift_sender = 'standalone'");
    await owner.$executeRawUnsafe(
      "INSERT INTO trade_request.users (id, email, name, role) VALUES ($1::uuid, 'advisor-386@example.test', 'Fixture Advisor', 'advisor')",
      ADVISOR,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO trade_request.trade_requests (id, client_id, advisor_id, trade_type, status, priority, total_value, client_name, client_names, liquidity_deadline, created_at)
       VALUES
         ('REQ-38600001', 'C-1', $1::uuid, 'Rebalance', 'Pending Review', 'Urgent', 2500000, 'Alpha Fixture', '["Alpha Fixture", "Beta Fixture"]'::jsonb, NULL, now() - interval '50 hours'),
         ('REQ-38600002', 'C-2', NULL, 'Initial Funding', 'Needs Info', 'Standard', NULL, 'Gamma Fixture', NULL, current_date + 3, now() - interval '2 hours'),
         ('REQ-38600003', 'C-3', $1::uuid, 'Rebalance', 'Approved', 'Standard', 1000, 'Delta Fixture', NULL, NULL, now() - interval '1 hour')`,
      ADVISOR,
    );
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app?.$disconnect();
    await owner?.$disconnect();
    execFileSync("dropdb", ["--if-exists", DB]);
  });

  it("reads the queue through the AOA runtime role with the shapes the ported mapper expects", async () => {
    const summary = await collectDigestSummary(new Date());
    expect(summary).toMatchObject({ total: 2, urgent: 1, overdue48h: 1 });
    const [first] = summary.byStatus["Pending Review"]!;
    expect(first.clientNames).toEqual(["Alpha Fixture", "Beta Fixture"]);
    expect(first.totalValue).toBe(2500000);
    expect(first.submittedByName).toBe("Fixture Advisor");
    expect(first.waitingMinutes).toBeGreaterThanOrEqual(3000);
    expect(first.createdAt).toBeInstanceOf(Date);
    expect(summary.byStatus["Needs Info"]![0].liquidityDeadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("posts once per date: the second call returns already posted and posts nothing", async () => {
    const now = new Date();
    expect(await runDailyDigest(now)).toMatchObject({ sent: true, counts: { total: 2, urgent: 1, overdue48h: 1 } });
    expect(await runDailyDigest(now)).toMatchObject({ sent: false, reason: "already_posted" });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(await claims()).toEqual([{ run_date: computeRunDate(now), summary: { total: 2, urgent: 1, overdue48h: 1 } }]);
  });
  it("keeps the claim after a failed post, so a later call that date posts nothing", async () => {
    const now = new Date();
    sendSpy.mockResolvedValueOnce({ status: "failed", code: "timeout" });
    expect(await runDailyDigest(now)).toMatchObject({ sent: false, reason: "post_failed", code: "timeout" });
    expect(await runDailyDigest(now)).toMatchObject({ sent: false, reason: "already_posted" });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(await claims()).toHaveLength(1);
  });
  it("claims nothing until AOA is the digest sender, then posts once", async () => {
    const before = await post();
    expect(await before.json()).toEqual({ sent: false, reason: "not_sender" });
    expect(await claims()).toEqual([]);
    expect(sendSpy).not.toHaveBeenCalled();
    await owner.$executeRawUnsafe("UPDATE trade_request.serving_state SET digest_sender = 'aoa'");
    const after = await post();
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({ sent: true });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(await claims()).toHaveLength(1);
  });
});
