import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Write half of the recorded parity suite (ticket, epic AC-14/AC-15): each standalone answer captured by
// scripts/trade-requests/capture-standalone-write-parity.mjs is fed through the delegated path (switch off), the same
// call is answered natively (switch on, AOA-served), and the two results and the saved fields must match.
// Opt-in: TRADE_REQUEST_COPY_TEST_DB=1 with local Postgres 16 (roles aoa, app_rw). Scratch database, synthetic rows.

const DB = "trb_wparity_tgt";
const g = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://app_rw@localhost:5432/trb_wparity_tgt?schema=app";
  return { auth: vi.fn(), emit: vi.fn(), fetch: vi.fn() };
});
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: g.auth }));
vi.mock("@/lib/trade-requests/native/side-effects", () => ({ emitTradeRequestEvent: g.emit }));
vi.mock("@/lib/trade-requests/native/reads/sources", () => ({
  ActiveAccountsLoadError: class extends Error {},
  tradeRequestWarehouseConfigured: () => false,
  getCachedClients: vi.fn(async () => []),
  loadMeridianActiveAccounts: vi.fn(),
  toHouseholdConfig: vi.fn(),
  machineAccountIdentityConfigured: () => false,
  getMachineAccountIdMap: vi.fn(async () => ({})),
}));

import { prisma } from "@/lib/db";
import {
  callTradeRequestService,
  resetDelegatedClientState,
  type TradeRequestCall,
  type TradeRequestOperation,
} from "@/lib/trade-requests/client";
import { EXCLUSIONS_COPY } from "@/lib/trade-requests/new-request-exclusions";
import { SUBMIT_COPY } from "@/lib/trade-requests/new-request-submit";
import { BELL_COPY } from "@/lib/trade-requests/notifications-model";
import { STATUS_ACTION_COPY } from "@/lib/trade-requests/status-view";
import {
  ACTORS,
  CASES,
  EXPECTED_EVENTS,
  normalize,
  normalizeSnapshot,
  snapshotQueries,
  usersByIdFromRaw,
} from "../scripts/trade-requests/write-parity-cases.mjs";

const suite = process.env.TRADE_REQUEST_COPY_TEST_DB === "1" ? describe : describe.skip;
const OWNER_URL = `postgresql://aoa@localhost:5432/${DB}`;
const DEFAULTS: Record<string, string> = {
  createRequest: SUBMIT_COPY.failed,
  resubmitRequest: SUBMIT_COPY.failed,
  statusChange: STATUS_ACTION_COPY.actionFailed,
  checklistSave: "Failed to save the checklist.",
  exclusionSave: EXCLUSIONS_COPY.applyFailed,
  markNotificationRead: BELL_COPY.unavailable,
  markAllNotificationsRead: BELL_COPY.unavailable,
};
const BELL = new Set(["markNotificationRead", "markAllNotificationsRead"]);
const AOA_USER_IDS: Record<string, string> = {
  advisor: "parity-aoa-advisor",
  advisor2: "parity-aoa-advisor2",
  ops: "parity-aoa-ops",
  admin: "parity-aoa-admin",
};
const ENV = ["EPIC_TRADE_REQUESTS_BACKEND_MOVE", "TRADE_REQUESTS_NATIVE", "TRADE_REQUEST_DELEGATED_LOCAL_KEY", "TRADE_REQUEST_API_URL"];

const sh = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { stdio: "pipe", env: { ...process.env, ...env } });
const respond = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status });

async function snapshotRaw(): Promise<Record<string, string[]>> {
  const raw: Record<string, string[]> = {};
  for (const [table, sql] of Object.entries(snapshotQueries("trade_request"))) {
    raw[table] = (await prisma.$queryRawUnsafe<Array<{ j: string }>>(sql)).map((row) => row.j);
  }
  return raw;
}

suite("native Trade Request writes match the recorded standalone answers (ticket)", () => {
  const fixture = JSON.parse(readFileSync("test/fixtures/trade-request-write-parity-standalone.json", "utf8"));
  let expectedState: Record<string, string[]> = fixture.seed;

  beforeAll(() => {
    sh("dropdb", ["--if-exists", DB]);
    sh("createdb", ["-O", "aoa", DB]);
    sh("npx", ["prisma", "migrate", "deploy"], { DIRECT_DATABASE_URL: `${OWNER_URL}?schema=app`, DATABASE_URL: `${OWNER_URL}?schema=app` });
    sh("psql", ["-q", "-v", "ON_ERROR_STOP=1", "-d", OWNER_URL, "-f", "test/fixtures/trade-request-write-parity-seed.sql"], {
      PGOPTIONS: "-c search_path=trade_request",
    });
    const users = Object.entries(ACTORS)
      .map(([key, a]) => `('${AOA_USER_IDS[key]}', '${a.aoaName}', '${a.email}', '${a.aoaRole}')`)
      .join(", ");
    sh("psql", ["-q", "-v", "ON_ERROR_STOP=1", "-d", OWNER_URL, "-c",
      `INSERT INTO app."User" (id, name, email, role) VALUES ${users};
       UPDATE trade_request.serving_state SET serving_source = 'aoa', updated_by = 'ticket-test';`]);
    process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE = "1";
    process.env.TRADE_REQUEST_DELEGATED_LOCAL_KEY = "ticket-parity-local-key";
    process.env.TRADE_REQUEST_API_URL = "https://trade-request.parity.invalid";
    vi.stubGlobal("fetch", g.fetch);
  }, 180_000);

  afterAll(async () => {
    await prisma.$disconnect();
    vi.unstubAllGlobals();
    for (const name of ENV) delete process.env[name];
    sh("dropdb", ["--if-exists", DB]);
  });

  it("starts from the state the standalone capture started from", async () => {
    expect(normalizeSnapshot(await snapshotRaw())).toEqual(fixture.seed);
  });

  it.each(CASES.map((c, index) => [c.name, index] as const))("%s", async (_name, index) => {
    const c = CASES[index];
    const captured = fixture.cases[index];
    expect(captured.name).toBe(c.name);
    const actor = ACTORS[c.actor as keyof typeof ACTORS];
    g.auth.mockResolvedValue({ user: { id: AOA_USER_IDS[c.actor], email: actor.email, name: actor.aoaName } });
    const call: TradeRequestCall = {
      operation: c.op as TradeRequestOperation,
      method: c.method as TradeRequestCall["method"],
      path: c.path as `/${string}`,
      body: c.body,
      defaultMessage: DEFAULTS[c.op],
      ...(BELL.has(c.op) ? { channel: "bell" as const } : {}),
    };

    // What AOA shows for the standalone answer, through today's delegated path.
    delete process.env.TRADE_REQUESTS_NATIVE;
    resetDelegatedClientState();
    g.fetch.mockReset().mockImplementation(async () => respond(captured.status, captured.body));
    const expected = await callTradeRequestService(call);
    expect(g.fetch).toHaveBeenCalledTimes(1);

    // The same call answered natively: no standalone call at all.
    process.env.TRADE_REQUESTS_NATIVE = "1";
    g.fetch.mockReset();
    g.emit.mockClear();
    const actual = await callTradeRequestService(call);
    expect(g.fetch).not.toHaveBeenCalled();

    const raw = await snapshotRaw();
    const users = usersByIdFromRaw(raw);
    expect(normalize(actual, users)).toEqual(normalize(expected, users));
    expectedState = { ...expectedState, ...captured.changed };
    expect(normalizeSnapshot(raw)).toEqual(expectedState);
    const event = (EXPECTED_EVENTS as Record<string, string>)[c.name];
    expect(g.emit.mock.calls.map(([e]) => (e as { kind: string }).kind)).toEqual(event ? [event] : []);
  });
});
