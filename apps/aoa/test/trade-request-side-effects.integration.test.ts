// Opt-in (TRADE_REQUEST_COPY_TEST_DB=1) side-effects suite on a scratch local Postgres 16 database, trb_side_tgt,
// migrated with `prisma migrate deploy` and dropped in teardown. Synthetic @example.test identities only; Slack is a
// stubbed fetch.
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const enabled = process.env.TRADE_REQUEST_COPY_TEST_DB === "1";
const suite = enabled ? describe : describe.skip;
const ROOT = join(import.meta.dirname, "..");
const DB = "trb_side_tgt";
const URL = `postgresql://aoa@localhost:5432/${DB}?schema=app`;
const OWNER_URL = `postgresql://${userInfo().username}@localhost:5432/${DB}`;
const T_OPS = "00000000-0000-4000-8000-000000000301";
const T_ADV = "00000000-0000-4000-8000-000000000302";
const SUBMITTER = "00000000-0000-4000-8000-000000000303";

type SideEffectsModule = typeof import("@/lib/trade-requests/native/side-effects");

function psql(sql: string): string {
  return execFileSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", OWNER_URL, "-c", sql], {
    encoding: "utf8",
    env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" },
  }).trim();
}

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
}

function reseed(servingSource: "aoa" | "standalone"): void {
  psql(`TRUNCATE trade_request.notifications, trade_request.trade_requests, trade_request.clients, trade_request.users CASCADE;
    DELETE FROM app."User" WHERE email LIKE '%@example.test';
    INSERT INTO app."User" (id, name, email, role) VALUES
      ('usr_ops', 'Ops One', 'ops@example.test', 'OPERATIONS'),
      ('usr_adv', 'Advisor One', 'adv@example.test', 'ADVISOR');
    INSERT INTO trade_request.users (id, email, name, role, is_active) VALUES
      ('${T_OPS}', 'ops@example.test', 'Ops Trader', 'trader', true),
      ('${T_ADV}', 'adv@example.test', 'Advisor Trader', 'trader', true),
      ('${SUBMITTER}', 'sub@example.test', 'Sub Advisor', 'advisor', true);
    INSERT INTO trade_request.clients (id, name) VALUES ('C-1', 'Sample');
    INSERT INTO trade_request.trade_requests (id, client_id, advisor_id, trade_type, client_name)
      VALUES ('REQ-00000001', 'C-1', '${SUBMITTER}', 'Rebalance', 'Sample');
    UPDATE trade_request.serving_state SET serving_source = '${servingSource}';`);
}

const notificationUsers = () => psql("SELECT coalesce(string_agg(user_id::text, ',' ORDER BY user_id), '') FROM trade_request.notifications");

suite("Trade Request side effects (scratch database)", () => {
  let sideEffects: SideEffectsModule;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    run("dropdb", ["--if-exists", "--force", DB]);
    run("createdb", ["-O", "aoa", DB]);
    run("npx", ["prisma", "migrate", "deploy"], { DIRECT_DATABASE_URL: URL, DATABASE_URL: URL });
    process.env.DATABASE_URL = URL;
    delete (globalThis as { prisma?: unknown }).prisma;
    vi.resetModules();
    sideEffects = await import("@/lib/trade-requests/native/side-effects");
  }, 180_000);

  beforeEach(() => {
    reseed("aoa");
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
    vi.stubEnv("TRADE_REQUEST_SLACK_BOT_TOKEN", "xoxb-000000000-synthetic");
    vi.stubEnv("TRADE_REQUEST_SLACK_CHANNEL_ID", "CFIXTURE");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.$disconnect();
    run("dropdb", ["--if-exists", "--force", DB]);
  }, 60_000);

  const submitted = {
    kind: "submitted" as const,
    request: { requestId: "REQ-00000001", clientName: "Sample", tradeType: "Rebalance", priority: "Standard", submittedBy: "Sub Advisor", totalValue: 10, accounts: ["ACCT-1"] },
  };

  it("submitted notifies the OPERATIONS-matched trader and not the ADVISOR-matched one", async () => {
    await sideEffects.emitTradeRequestEvent(submitted);
    expect(notificationUsers()).toBe(T_OPS);
    expect(psql("SELECT body || '|' || request_id FROM trade_request.notifications")).toBe(
      "New trade request REQ-00000001 submitted for Sample|REQ-00000001",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("status_changed notifies the submitter once", async () => {
    await sideEffects.emitTradeRequestEvent({
      kind: "status_changed", requestId: "REQ-00000001", clientName: "Sample", newStatus: "Approved", note: "", changedBy: "Ops Trader",
      submitterId: SUBMITTER, submitterSlackId: null,
    });
    expect(notificationUsers()).toBe(SUBMITTER);
    expect(psql("SELECT body FROM trade_request.notifications")).toBe("Trade request REQ-00000001 status updated to: Approved");
  });

  it("inserts nothing while standalone-served", async () => {
    reseed("standalone");
    await sideEffects.emitTradeRequestEvent(submitted);
    expect(psql("SELECT count(*) FROM trade_request.notifications")).toBe("0");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
