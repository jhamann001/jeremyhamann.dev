import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

// Replays every recorded read-parity case (ticket) against the native handlers: the standalone seed is
// copied into AOA's trade_request records with ticket's copy engine, the serving state is set to AOA and the
// native switch is on. Opt-in (TRADE_REQUEST_COPY_TEST_DB=1, TRADE_REQUEST_SERVICE_DIR): scratch databases only,
// created and dropped here; synthetic data only.
const DB = vi.hoisted(() => {
  const src = "trb_parity_src";
  const tgt = "trb_parity_tgt";
  const tgtUrl = `postgresql://aoa@localhost:5432/${tgt}?schema=app`;
  // Native reads run as the runtime role; migrations and the copy run as the owner.
  if (process.env.TRADE_REQUEST_COPY_TEST_DB === "1") process.env.DATABASE_URL = `postgresql://app_rw@localhost:5432/${tgt}?schema=app`;
  return { src, tgt, tgtUrl, srcUrl: `postgresql://${process.env.USER}@localhost:5432/${src}` };
});
vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));

import { getTradeRequestsForUser } from "@/lib/data/trade-requests";
import { prisma } from "@/lib/db";
import { callTradeRequestService, type TradeRequestResult } from "@/lib/trade-requests/client";
import { machineAccountIdentityConfigured, tradeRequestWarehouseConfigured } from "@/lib/trade-requests/native/reads/sources";
import { runCopy } from "@/lib/trade-requests/records/copy-engine";
import { blankFeedEnv } from "./fixtures/trade-request-feed-env";
import { PARITY_ACTORS, PARITY_CASES, type ParityActor } from "./fixtures/trade-request-read-parity-cases";

const ENABLED = process.env.TRADE_REQUEST_COPY_TEST_DB === "1";
const RECORDED = JSON.parse(readFileSync("test/fixtures/trade-request-read-parity.json", "utf8")) as { cases: Record<string, unknown> };
const sh = (command: string, cwd?: string) => execSync(command, { cwd, stdio: "pipe" });

/** The one recorded divergence: native reads run no plan verifier, so no `validation` is added (TRB-06 scope, epic AC-91). */
function withoutValidation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutValidation);
  if (value == null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "validation" && "executionPlan" in value) continue;
    out[key] = withoutValidation(entry);
  }
  return out;
}

async function as<T>(actor: ParityActor, call: Parameters<typeof callTradeRequestService>[0]): Promise<TradeRequestResult<T>> {
  const who = PARITY_ACTORS[actor];
  m.auth.mockResolvedValue({ user: { id: who.id, email: who.email } });
  return callTradeRequestService<T>(call);
}

describe.skipIf(!ENABLED)("native reads replay the recorded standalone results", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeAll(async () => {
    const dir = process.env.TRADE_REQUEST_SERVICE_DIR;
    if (!dir) throw new Error("TRADE_REQUEST_SERVICE_DIR is required");
    sh(`dropdb --if-exists ${DB.src} && createdb ${DB.src}`);
    sh(`DATABASE_URL=${DB.srcUrl} npx node-pg-migrate up --migrations-dir migrations`, `${dir}/server`);
    sh(`psql -q -v ON_ERROR_STOP=1 ${DB.srcUrl} -f test/fixtures/trade-request-read-parity-seed.sql`);
    sh(`dropdb --if-exists ${DB.tgt} && createdb -O aoa ${DB.tgt}`);
    sh(`DIRECT_DATABASE_URL="${DB.tgtUrl}" DATABASE_URL="${DB.tgtUrl}" npx prisma migrate deploy`);
    sh(`psql -q -v ON_ERROR_STOP=1 postgresql://aoa@localhost:5432/${DB.tgt} -f test/fixtures/trade-request-read-parity-aoa-users.sql`);
    const source = new PrismaClient({ datasourceUrl: DB.srcUrl });
    const target = new PrismaClient({ datasourceUrl: DB.tgtUrl });
    try {
      const copied = await runCopy({ source, target, mode: "full", actor: "parity-test" });
      if (copied.verdict !== "passed") throw new Error(`copy verdict ${copied.verdict}`);
      await target.$executeRawUnsafe(`UPDATE trade_request.serving_state SET serving_source = 'aoa', updated_by = 'parity-test'`);
    } finally {
      await source.$disconnect();
      await target.$disconnect();
    }
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
    vi.stubEnv("TRADE_REQUESTS_NATIVE", "1");
    vi.stubEnv("TRADE_REQUESTS_LOCAL_SOURCES", "1");
    blankFeedEnv();
    // Were the delegated path taken, it would reach this stub (and fail the zero-call check).
    vi.stubEnv("TRADE_REQUEST_API_URL", "http://127.0.0.1:9");
    vi.stubEnv("TRADE_REQUEST_DELEGATED_LOCAL_KEY", "parity-replay-unused-key");
    fetchSpy.mockImplementation(async () => new Response("{}", { status: 500 }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    fetchSpy.mockClear();
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.$disconnect();
    sh(`dropdb --if-exists ${DB.src}`);
    sh(`dropdb --if-exists ${DB.tgt}`);
  });

  it("runs with the ported feeds unconfigured", () => {
    expect([tradeRequestWarehouseConfigured(), machineAccountIdentityConfigured()]).toEqual([false, false]);
    markCase("trade-request-read-parity", "feeds-unconfigured", "integration");
  });

  it("has a recorded result for every case", () => {
    expect(Object.keys(RECORDED.cases).sort()).toEqual(PARITY_CASES.map((c) => c.id).sort());
    markCase("trade-request-read-parity", "recorded-cases-complete", "integration");
  });

  it.each(PARITY_CASES.map((c) => [c.id, c] as const))("%s", async (id, entry) => {
    const result = await as(entry.actor, entry.call);
    expect(withoutValidation(result)).toEqual(withoutValidation(RECORDED.cases[id]));
    markCase("trade-request-read-parity", id, "integration");
  });

  it("made no call to the standalone service", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    markCase("trade-request-read-parity", "zero-standalone-calls", "integration");
  });

  it("returns each moved audit entry with its original actor name", async () => {
    const result = await as<{ data: { auditLog: Array<{ id: string; user: string }> } }>("admin", {
      operation: "requestDetail", method: "GET", path: "/requests/REQ-P0000001", defaultMessage: "detail_failed",
    });
    expect(result.ok && result.data.data.auditLog.map((a) => [a.id.slice(-2), a.user])).toEqual([
      ["e2", "Tia Trader"], ["e3", "Orin O. (Trade Request)"], ["e1", "Avery A. (Trade Request)"],
    ]);
    markCase("trade-request-read-parity", "audit-original-actor-names", "integration");
  });

  it("lists in the Client Portrait the requests the native queue holds for the client", async () => {
    const queue = await as<{ data: Array<{ id: string; clientId: string; clientIds: string[] }> }>("ops", {
      operation: "listRequests", method: "GET", path: "/requests", query: { all: true }, defaultMessage: "export_failed",
    });
    expect(queue.ok).toBe(true);
    for (const client of ["user-10000000-0000-4000-8000-000000000001", "user-10000000-0000-4000-8000-000000000002", "user-10000000-0000-4000-8000-000000000003"]) {
      const portrait = await getTradeRequestsForUser(client);
      const expected = queue.ok ? queue.data.data.filter((r) => r.clientId === client || r.clientIds.includes(client)).map((r) => r.id) : [];
      expect([client, portrait.map((r) => r.id)]).toEqual([client, expected]);
    }
    markCase("trade-request-read-parity", "portrait-matches-queue", "integration");
  });

  it("treats the pre-move identity with the person's company email as theirs", async () => {
    const allocation = await as<{ riskProfile: number }>("avery", {
      operation: "lastAllocation", method: "GET", path: "/requests/last-allocation/user-10000000-0000-4000-8000-000000000001", defaultMessage: "allocation_failed",
    });
    const bell = await as<{ data: Array<{ id: string }> }>("avery", {
      operation: "notificationsList", method: "GET", path: "/notifications", query: { limit: 100 }, defaultMessage: "bell", channel: "bell",
    });
    expect(allocation).toMatchObject({ ok: true, data: { riskProfile: 9 } });
    expect(bell.ok && bell.data.data.map((n) => n.id.slice(-2))).toEqual(["f3", "f2", "f1"]);
    markCase("trade-request-read-parity", "pre-move-identity-is-theirs", "integration");
  });
});
