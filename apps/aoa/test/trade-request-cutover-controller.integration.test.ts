import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCutoverController, CONTROLLER_LOCK_KEY, type ControllerDeps, type CopyClients } from "@/lib/trade-requests/cutover-controller";
import { runCopy } from "@/lib/trade-requests/records/copy-engine";
import { changeServingState, ServingStateRefused } from "@/lib/trade-requests/serving-state-admin";
import {
  StandaloneUnavailable,
  type EngineUseReport,
  type StandaloneChange,
  type StandaloneControl,
  type StandaloneMode,
  type StandaloneState,
  type SenderSwitch,
} from "@/lib/trade-requests/standalone-control";

// Opt-in (TRADE_REQUEST_COPY_TEST_DB=1, TRADE_REQUEST_SERVICE_DIR set): two scratch databases (standalone migrations
// and AOA migrations), a stubbed standalone service and a controllable clock. Synthetic rows only.
const suite = process.env.TRADE_REQUEST_COPY_TEST_DB === "1" ? describe : describe.skip;

const SRC = "trb_cutover_src";
const TGT = "trb_cutover_tgt";
const SRC_URL = `postgresql://${process.env.PGUSER ?? process.env.USER}@localhost:5432/${SRC}`;
const TGT_URL = `postgresql://aoa@localhost:5432/${TGT}`;
const REF = "https://linear.app/cedar-ridge-money/issue/ticket/trb-11-aoa-cutover-and-rollback-controller#comment-0a1b2c3d";
// Tuesday 2026-10-20 (EDT, UTC-4): 05:00 local is outside every window; 06:45 local reaches 07:30 within 60 minutes;
// 08:00 local is inside the morning window.
const TUE_0500 = "2026-10-20T09:00:00.000Z";
const TUE_0645 = "2026-10-20T10:45:00.000Z";
const TUE_0800 = "2026-10-20T12:00:00.000Z";
const TUE_1000 = "2026-10-20T14:00:00.000Z";

const sh = (cmd: string, env: Record<string, string> = {}) => execSync(cmd, { stdio: "pipe", env: { ...process.env, ...env } });

const SOURCE_SEED = `
INSERT INTO users (id, email, name, role) VALUES
  ('00000000-0000-4000-8000-000000000001', 'trader1@example.test', 'Synthetic Trader', 'trader'),
  ('00000000-0000-4000-8000-000000000002', 'advisor1@example.test', 'Synthetic Advisor', 'advisor');
INSERT INTO clients (id, name) VALUES ('client-0001', 'Synthetic Household A');
INSERT INTO accounts (id, client_id, account_number, account_type)
  VALUES ('00000000-0000-4000-8000-000000000101', 'client-0001', 'SYN0001', 'Taxable');
INSERT INTO trade_requests (id, client_id, trade_type) VALUES ('REQ-SYN00001', 'client-0001', 'Rebalance');
INSERT INTO audit_logs (request_id, user_name, action) VALUES ('REQ-SYN00001', 'Synthetic Advisor', 'submitted');
INSERT INTO notifications (user_id, body) VALUES ('00000000-0000-4000-8000-000000000001', 'Synthetic notification');
`;
const SOURCE_TABLES =
  "users, clients, accounts, trade_requests, audit_logs, notifications, client_exclusions, account_exclusions, digest_runs, registry_drift_runs, position_drift_accounts, drift_alert_sends, drift_status_overrides";

function report(patch: Partial<EngineUseReport> = {}): EngineUseReport {
  const day = (d: string) => ({ day: d, mcp: { ran: 2, refused: 0 }, service: { ran: 0, refused: 0 } });
  return {
    planGeneration: "off", windowDays: 7, coveredDays: 7, countingStarted: "2026-10-01", planGenerationOffSince: "2026-10-02",
    days: ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"].map(day),
    today: day("2026-10-20"), ...patch,
  };
}

/** In-memory stand-in for the standalone service's machine API (ticket, ticket). */
class StubStandalone implements StandaloneControl {
  mode: StandaloneMode = "active";
  digestSender: SenderSwitch = "on";
  driftSender: SenderSwitch = "on";
  modeChangedAt: string | null = null;
  override: StandaloneMode | null = null;
  settleMs = 0;
  engineUse: EngineUseReport | "unavailable" = report();
  ignoreModeChanges = false;
  ignoreSenderChanges = false;
  calls: Array<{ at: string; change: StandaloneChange }> = [];
  constructor(private readonly now: () => Date) {}
  private view(): StandaloneState {
    const mode = this.override ?? this.mode;
    const settled = mode !== "active" && this.override === null && this.modeChangedAt
      ? new Date(Date.parse(this.modeChangedAt) + this.settleMs).toISOString() : null;
    return { mode, persistedMode: this.mode, override: this.override, digestSender: this.digestSender, driftSender: this.driftSender, modeChangedAt: this.modeChangedAt, writesSettledAt: settled };
  }
  async readState() { return this.view(); }
  async changeState(change: StandaloneChange) {
    this.calls.push({ at: this.now().toISOString(), change });
    if (change.mode && !this.ignoreModeChanges && change.mode !== this.mode) { this.mode = change.mode; this.modeChangedAt = this.now().toISOString(); }
    if (!this.ignoreSenderChanges) {
      if (change.digestSender) this.digestSender = change.digestSender;
      if (change.driftSender) this.driftSender = change.driftSender;
    }
    return this.view();
  }
  async readEngineUse() {
    if (this.engineUse === "unavailable") throw new StandaloneUnavailable("status_503");
    return this.engineUse;
  }
}

suite("cutover and rollback controller (local databases, stubbed standalone service)", () => {
  let aoa: PrismaClient;
  let source: PrismaClient;
  let clock: Date;
  let sleeps: number[];
  let events: Array<Record<string, unknown>>;
  let stub: StubStandalone;

  const now = () => clock;
  const fakeSleep = async (ms: number) => { sleeps.push(ms); clock = new Date(clock.getTime() + ms); };
  const openCopyClients = async (): Promise<CopyClients> => {
    const target = new PrismaClient({ datasourceUrl: `${TGT_URL}?connection_limit=1&max_idle_connection_lifetime=0` });
    const copySource = new PrismaClient({ datasourceUrl: `${SRC_URL}?connection_limit=1&max_idle_connection_lifetime=0` });
    return { target, source: copySource, close: async () => { await target.$disconnect(); await copySource.$disconnect(); } };
  };
  const controller = (patch: Partial<ControllerDeps> = {}) =>
    createCutoverController({ aoa, source, openCopyClients, standalone: stub, actor: "test:cutover", exemption: null, now, sleep: fakeSleep, log: (e) => events.push(e), retryIntervalMs: 15 * 60_000, ...patch });
  const serving = async () => (await aoa.$queryRawUnsafe<Array<{ s: string; d: string; r: string }>>(
    `SELECT serving_source AS s, digest_sender AS d, drift_sender AS r FROM trade_request.serving_state WHERE id`))[0];
  const setServing = (s: string, d: string, r: string) =>
    aoa.$executeRawUnsafe(`UPDATE trade_request.serving_state SET serving_source = '${s}', digest_sender = '${d}', drift_sender = '${r}' WHERE id`);
  // Both logs in one timeline: AOA serving-state changes and the standalone levers.
  const transitions = () => aoa.$queryRawUnsafe<Array<{ reason: string; from_state: Record<string, unknown>; to_state: Record<string, unknown> }>>(
    `SELECT reason, from_state, to_state FROM (
       SELECT at, id, reason, from_state, to_state FROM trade_request.serving_state_transitions
       UNION ALL SELECT at, id, reason, from_state, to_state FROM trade_request.standalone_transitions) t ORDER BY at, id`);
  const servingTransitions = async () => (await aoa.$queryRawUnsafe<Array<{ reason: string }>>(
    `SELECT reason FROM trade_request.serving_state_transitions ORDER BY at, id`)).map((t) => t.reason);
  const copyRuns = () => aoa.$queryRawUnsafe<Array<{ mode: string; verdict: string | null }>>(
    `SELECT mode, verdict FROM trade_request.copy_runs ORDER BY started_at`);
  const accountsSnapshot = async () => aoa.$queryRawUnsafe<Array<{ u: number; a: number; hu: string; ha: string }>>(
    `SELECT (SELECT count(*)::int FROM app."User") AS u, (SELECT count(*)::int FROM app."Account") AS a,
            (SELECT coalesce(md5(string_agg(to_jsonb(t)::text, '' ORDER BY id)), '') FROM app."User" t) AS hu,
            (SELECT coalesce(md5(string_agg(to_jsonb(t)::text, '' ORDER BY id)), '') FROM app."Account" t) AS ha`);
  const statusOf = (gates: Array<{ gate: string; status: string }>, name: string) => gates.filter((g) => g.gate === name).map((g) => g.status);

  beforeAll(() => {
    const dir = process.env.TRADE_REQUEST_SERVICE_DIR;
    if (!dir) throw new Error("TRADE_REQUEST_SERVICE_DIR is required");
    sh(`dropdb --if-exists --force ${SRC} && createdb ${SRC}`);
    sh(`cd "${dir}/server" && npx node-pg-migrate up --migrations-dir migrations`, { DATABASE_URL: `postgres://localhost:5432/${SRC}` });
    sh(`dropdb --if-exists --force ${TGT} && createdb -O aoa ${TGT}`);
    sh("npx prisma migrate deploy", { DIRECT_DATABASE_URL: `${TGT_URL}?schema=app`, DATABASE_URL: `${TGT_URL}?schema=app` });
    aoa = new PrismaClient({ datasourceUrl: `${TGT_URL}?connection_limit=1&max_idle_connection_lifetime=0` });
    source = new PrismaClient({ datasourceUrl: `${SRC_URL}?connection_limit=1&max_idle_connection_lifetime=0` });
  }, 180_000);

  beforeEach(async () => {
    await source.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trb_fail ON trade_requests`);
    await source.$executeRawUnsafe(`TRUNCATE ${SOURCE_TABLES} CASCADE`);
    for (const stmt of SOURCE_SEED.split(";").map((s) => s.trim()).filter(Boolean)) await source.$executeRawUnsafe(stmt);
    await aoa.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trb_fail ON trade_request.notifications`);
    await aoa.$executeRawUnsafe(`DROP FUNCTION IF EXISTS trade_request.trb_fail()`);
    await aoa.$executeRawUnsafe(`TRUNCATE trade_request.${SOURCE_TABLES.split(", ").join(", trade_request.")}, trade_request.security_sector,
      trade_request.copy_runs, trade_request.serving_state_transitions, trade_request.standalone_transitions, trade_request.reconciliation_runs, trade_request.drift_readiness_runs CASCADE`);
    await aoa.$executeRawUnsafe(`DELETE FROM app."Account" WHERE "userId" = 'usr_cutover_1'`);
    await aoa.$executeRawUnsafe(`DELETE FROM app."User" WHERE id = 'usr_cutover_1'`);
    await aoa.$executeRawUnsafe(`INSERT INTO app."User" (id, email, name, role) VALUES ('usr_cutover_1', 'aoa-user@example.test', 'Synthetic AOA User', 'ADVISOR')`);
    await aoa.$executeRawUnsafe(`INSERT INTO app."Account" (id, "userId", type, provider, "providerAccountId") VALUES ('acc_cutover_1', 'usr_cutover_1', 'oidc', 'okta', 'synthetic-1')`);
    await setServing("standalone", "standalone", "standalone");
    clock = new Date(TUE_0500);
    sleeps = [];
    events = [];
    stub = new StubStandalone(now);
  });

  afterAll(async () => {
    await aoa?.$disconnect();
    await source?.$disconnect();
    sh(`dropdb --if-exists --force ${SRC} && dropdb --if-exists --force ${TGT}`);
  });

  it("refuses to freeze or switch when the service does not report plan generation off (AC-3)", async () => {
    stub.engineUse = report({ planGeneration: "on", coveredDays: 0 });
    const r = await controller().cutover();
    expect(r.outcome).toBe("refused");
    expect(statusOf(r.gates, "plan_generation_off")).toEqual(["refused"]);
    expect(stub.calls).toEqual([]);
    expect(await serving()).toEqual({ s: "standalone", d: "standalone", r: "standalone" });
  });

  it("refuses on any non-MCP engine call or refused attempt in the seven days (AC-1)", async () => {
    stub.engineUse = report({ days: report().days.map((d, i) => (i === 2 ? { ...d, service: { ran: 1, refused: 0 } } : d)) });
    expect(statusOf((await controller().cutover()).gates, "engine_use_activity")).toEqual(["refused"]);
    stub.engineUse = report({ days: report().days.map((d, i) => (i === 5 ? { ...d, mcp: { ran: 0, refused: 1 } } : d)) });
    expect((await controller().cutover()).outcome).toBe("refused");
    expect(stub.calls).toEqual([]);
    expect((await serving()).s).toBe("standalone");
  });

  it("refuses when the report covers fewer than seven days (AC-2)", async () => {
    stub.engineUse = report({ coveredDays: 6 });
    const r = await controller().cutover();
    expect(statusOf(r.gates, "engine_use_coverage")).toEqual(["refused"]);
    expect(stub.calls).toEqual([]);
  });

  it("refuses to start a freeze whose 60-minute window reaches the morning window (AC-6)", async () => {
    clock = new Date(TUE_0645);
    const r = await controller().cutover();
    expect(r.outcome).toBe("refused");
    expect(statusOf(r.gates, "freeze_window")).toEqual(["refused"]);
    expect(stub.mode).toBe("active");
    expect(stub.calls).toEqual([]);
  });

  it("freezes, change-copies, verifies and switches only while the service reports frozen (AC-4, AC-5 allowed)", async () => {
    const r = await controller().cutover();
    expect(r.outcome).toBe("done");
    expect(await serving()).toEqual({ s: "aoa", d: "standalone", r: "standalone" });
    expect(stub.mode).toBe("frozen");
    expect(await copyRuns()).toEqual([{ mode: "change", verdict: "passed" }]);
    expect((await transitions()).map((t) => t.reason)).toEqual(["standalone: cutover: freeze", "cutover: switch to AOA-served"]);
    expect(statusOf(r.gates, "standalone_frozen")).toEqual(["passed", "passed"]);
    expect(statusOf(r.gates, "copy_verification")).toEqual(["passed", "passed"]);
  });

  it("waits until writes admitted before the freeze have settled before the change copy (epic AC-96)", async () => {
    stub.settleMs = 2_000;
    const start = Date.now();
    const realSleep = async (ms: number) => { sleeps.push(ms); await new Promise((res) => setTimeout(res, ms)); clock = new Date(clock.getTime() + ms); };
    const r = await controller({ sleep: realSleep }).cutover();
    expect(r.outcome).toBe("done");
    expect(sleeps[0]).toBeGreaterThan(1_500);
    expect(sleeps[0]).toBeLessThanOrEqual(2_000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(1_500);
    const [{ gap }] = await aoa.$queryRawUnsafe<Array<{ gap: number }>>(
      `SELECT extract(epoch FROM (SELECT started_at FROM trade_request.copy_runs) - (SELECT at FROM trade_request.standalone_transitions ORDER BY at LIMIT 1))::float8 AS gap`);
    expect(gap).toBeGreaterThanOrEqual(2);
  });

  it("does not count a copy that passed before the freeze, and refuses the switch without a passed copy since (AC-4)", async () => {
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.copy_runs (mode, actor, serving_source_at_start, finished_at, verdict) VALUES ('change', 'test', 'standalone', NOW(), 'passed')`);
    const noCopy = (async () => { throw new Error("copy unavailable"); }) as unknown as ControllerDeps["copy"];
    const r = await controller({ copy: noCopy }).cutover();
    expect(r.outcome).toBe("abandoned");
    expect(r.gates.find((g) => g.gate === "copy_verification")?.detail).toMatch(/no copy verification has run since/);
    expect((await serving()).s).toBe("standalone");
  });

  it("returns the service to active with the serving source unchanged when verification has not passed in 60 minutes (AC-7)", async () => {
    await aoa.$executeRawUnsafe(`CREATE FUNCTION trade_request.trb_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`);
    await aoa.$executeRawUnsafe(`CREATE TRIGGER trb_fail BEFORE INSERT ON trade_request.notifications FOR EACH ROW EXECUTE FUNCTION trade_request.trb_fail()`);
    const r = await controller().cutover();
    expect(r.outcome).toBe("abandoned");
    expect(stub.mode).toBe("active");
    expect(await serving()).toEqual({ s: "standalone", d: "standalone", r: "standalone" });
    expect((await copyRuns()).every((c) => c.verdict === "failed")).toBe(true);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(60 * 60_000);
    expect(stub.calls.map((c) => c.change.mode)).toEqual(["frozen", "active"]);
  });

  it("refuses the switch when the service does not report frozen (AC-5)", async () => {
    stub.ignoreModeChanges = true;
    const r = await controller().cutover();
    expect(r.outcome).toBe("refused");
    expect(statusOf(r.gates, "standalone_frozen")).toEqual(["refused"]);
    expect((await serving()).s).toBe("standalone");
    expect(await copyRuns()).toEqual([]);
  });

  it("hands the digest to AOA with the standalone sender off first (AC-10), and refuses if it stays on (AC-8)", async () => {
    await setServing("aoa", "standalone", "standalone");
    stub.mode = "frozen";
    stub.ignoreSenderChanges = true;
    const refused = await controller().handoff("digest", "aoa");
    expect(refused.outcome).toBe("refused");
    expect(statusOf(refused.gates, "standalone_sender_off")).toEqual(["refused"]);
    expect((await serving()).d).toBe("standalone");
    stub.ignoreSenderChanges = false;
    const r = await controller().handoff("digest", "aoa");
    expect(r.outcome).toBe("done");
    expect((await serving()).d).toBe("aoa");
    expect(stub.digestSender).toBe("off");
    const reasons = (await transitions()).map((t) => t.reason);
    expect(reasons.slice(-2)).toEqual(["standalone: digest sender to AOA: standalone sender off", "digest sender to AOA"]);
  });

  it("refuses a drift handoff that would leave the standalone drift switch on (AC-9)", async () => {
    await setServing("aoa", "aoa", "standalone");
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.drift_readiness_runs (actor, verdict) VALUES ('test', 'ready')`);
    stub.mode = "frozen";
    stub.ignoreSenderChanges = true;
    const r = await controller().handoff("drift", "aoa");
    expect(r.outcome).toBe("refused");
    expect(statusOf(r.gates, "standalone_sender_off")).toEqual(["refused"]);
    expect((await serving()).r).toBe("standalone");
  });

  it("refuses to make AOA the drift sender unless the latest readiness verdict is ready (AC-19)", async () => {
    await setServing("aoa", "aoa", "standalone");
    stub.mode = "frozen";
    expect(statusOf((await controller().handoff("drift", "aoa")).gates, "drift_readiness")).toEqual(["refused"]);
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.drift_readiness_runs (ran_at, actor, verdict) VALUES (NOW() - interval '1 day', 'test', 'ready'), (NOW(), 'test', 'not_ready')`);
    expect(statusOf((await controller().handoff("drift", "aoa")).gates, "drift_readiness")).toEqual(["refused"]);
    expect(stub.calls).toEqual([]);
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.drift_readiness_runs (ran_at, actor, verdict) VALUES (NOW() + interval '1 second', 'test', 'ready')`);
    const r = await controller().handoff("drift", "aoa");
    expect(r.outcome).toBe("done");
    expect([(await serving()).r, stub.driftSender]).toEqual(["aoa", "off"]);
  });

  it("refuses sender handoffs inside the weekday morning window", async () => {
    await setServing("aoa", "standalone", "standalone");
    clock = new Date(TUE_0800);
    const r = await controller().handoff("digest", "aoa");
    expect(statusOf(r.gates, "morning_window")).toEqual(["refused"]);
    expect(stub.calls).toEqual([]);
  });

  it("refuses MCP-only unless the latest access reconciliation passed (AC-11)", async () => {
    await setServing("aoa", "aoa", "aoa");
    stub.mode = "frozen"; stub.digestSender = "off"; stub.driftSender = "off";
    expect(statusOf((await controller().retire()).gates, "access_reconciliation")).toEqual(["refused"]);
    const counts = (active: number, none: number) => `'{"standaloneActive":${active},"noStandaloneIdentities":${none}}'`;
    const detail = async () => (await controller().retire()).gates.find((g) => g.gate === "access_reconciliation")?.detail;
    // A passed reconciliation taken before the final change copy does not count, nor does one with no copy at all.
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.reconciliation_runs (at, verdict, counts) VALUES (NOW() - interval '2 minutes', 'passed', ${counts(2, 0)})`);
    expect(await detail()).toBe("no forward copy is recorded");
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.copy_runs (mode, actor, serving_source_at_start, started_at, finished_at, verdict) VALUES ('change', 'test', 'standalone', NOW() - interval '1 minute', NOW() - interval '1 minute', 'passed')`);
    expect(await detail()).toMatch(/before the final forward copy/);
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.reconciliation_runs (verdict, counts) VALUES ('failed', ${counts(2, 0)})`);
    expect((await controller().retire()).outcome).toBe("refused");
    expect(stub.mode).toBe("frozen");
    // A passed verdict with no standalone identities, or with the empty-set marker, does not count.
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.reconciliation_runs (at, verdict, counts) VALUES (NOW() + interval '1 second', 'passed', ${counts(0, 0)})`);
    expect(await detail()).toMatch(/standalone active identities: 0/);
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.reconciliation_runs (at, verdict, counts) VALUES (NOW() + interval '2 seconds', 'passed', ${counts(2, 1)})`);
    expect(await detail()).toMatch(/no standalone identities: 1/);
    // A killed forward copy (no verdict) after the reconciliation counts as the final copy.
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.reconciliation_runs (at, verdict, counts) VALUES (NOW() + interval '3 seconds', 'passed', ${counts(2, 0)})`);
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.copy_runs (mode, actor, serving_source_at_start, started_at) VALUES ('full', 'test', 'standalone', NOW() + interval '4 seconds')`);
    expect(await detail()).toMatch(/before the final forward copy/);
    expect(stub.calls).toEqual([]);
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.reconciliation_runs (at, verdict, counts) VALUES (NOW() + interval '5 seconds', 'passed', ${counts(2, 0)})`);
    expect((await controller().retire()).outcome).toBe("done");
    expect(stub.mode).toBe("mcp-only");
  });

  it("rehearses cutover, handoffs, MCP-only and a rollback after new AOA writes with zero AOA account writes (AC-12 to AC-16, AC-20)", async () => {
    const before = await accountsSnapshot();
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.drift_readiness_runs (actor, verdict) VALUES ('test', 'ready')`);
    expect((await controller().cutover()).outcome).toBe("done");
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.reconciliation_runs (verdict, counts) VALUES ('passed', '{"standaloneActive":2,"noStandaloneIdentities":0}')`);
    expect((await controller().handoff("digest", "aoa")).outcome).toBe("done");
    expect((await controller().handoff("drift", "aoa")).outcome).toBe("done");
    expect((await controller().retire()).outcome).toBe("done");
    // A native AOA write after the cutover.
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.trade_requests (id, client_id, trade_type) VALUES ('REQ-SYN00002', 'client-0001', 'Cash Deposit')`);
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.audit_logs (request_id, user_name, action, channel) VALUES ('REQ-SYN00002', 'Synthetic Advisor', 'submitted', 'aoa')`);
    // First rollback: the copy-back fails, so the service stays frozen and standalone-served (AC-12, AC-13).
    await source.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION trb_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`);
    await source.$executeRawUnsafe(`CREATE TRIGGER trb_fail BEFORE INSERT ON trade_requests FOR EACH ROW EXECUTE FUNCTION trb_fail()`);
    const first = await controller().rollback();
    expect(first.outcome).toBe("refused");
    expect(statusOf(first.gates, "copy_back_verification")).toEqual(["refused"]);
    expect([stub.mode, (await serving()).s]).toEqual(["frozen", "standalone"]);
    expect(stub.calls.map((c) => c.change.mode).filter(Boolean)).toEqual(["frozen", "mcp-only", "frozen"]);
    // Second rollback: the copy-back passes, the service is active again (AC-14) and both senders return,
    // AOA's sender off before the standalone sender on (AC-10, AC-15, AC-16).
    await source.$executeRawUnsafe(`DROP TRIGGER trb_fail ON trade_requests`);
    const second = await controller().rollback();
    expect(second.outcome).toBe("done");
    expect(stub.mode).toBe("active");
    expect(await serving()).toEqual({ s: "standalone", d: "standalone", r: "standalone" });
    expect([stub.digestSender, stub.driftSender]).toEqual(["on", "on"]);
    expect((await copyRuns()).map((c) => `${c.mode}:${c.verdict}`)).toEqual(["change:passed", "copy_back:failed", "copy_back:passed"]);
    const [{ n }] = await source.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM audit_logs WHERE request_id = 'REQ-SYN00002' AND channel = 'aoa'`);
    expect(n).toBe(1);
    const reasons = (await transitions()).map((t) => t.reason);
    const tail = reasons.slice(reasons.indexOf("standalone: rollback: copy-back verified; standalone writes resume"));
    expect(tail).toEqual([
      "standalone: rollback: copy-back verified; standalone writes resume",
      "digest sender to standalone: AOA sender off",
      "standalone: digest sender to standalone: standalone sender on",
      "drift sender to standalone: AOA sender off",
      "standalone: drift sender to standalone: standalone sender on",
    ]);
    expect(reasons.indexOf("rollback: standalone-served while the standalone service is frozen")).toBeLessThan(reasons.indexOf(tail[0]));
    expect(sleeps).toEqual([]);
    expect(await accountsSnapshot()).toEqual(before);
  });

  it("holds both sender returns until 10:00 when the copy-back passes inside the morning window (AC-17, AC-18)", async () => {
    expect((await controller().cutover()).outcome).toBe("done");
    await setServing("aoa", "aoa", "aoa");
    stub.digestSender = "off"; stub.driftSender = "off";
    clock = new Date(TUE_0800);
    const r = await controller().rollback();
    expect(r.outcome).toBe("done");
    expect(sleeps).toEqual([2 * 60 * 60_000]);
    const senderCalls = stub.calls.filter((c) => c.change.digestSender || c.change.driftSender);
    expect(senderCalls.map((c) => c.at)).toEqual([TUE_1000, TUE_1000]);
    const unfreeze = stub.calls.find((c) => c.change.mode === "active");
    expect(unfreeze?.at).toBe(TUE_0800);
    expect(await serving()).toEqual({ s: "standalone", d: "standalone", r: "standalone" });
  });

  it("never changes the serving source while a copy-back is in progress; sender fields still change", async () => {
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.copy_runs (mode, actor, serving_source_at_start) VALUES ('copy_back', 'test', 'standalone')`);
    await expect(changeServingState(aoa, { servingSource: "aoa" }, "test", "probe")).rejects.toBeInstanceOf(ServingStateRefused);
    expect((await serving()).s).toBe("standalone");
    expect((await changeServingState(aoa, { digestSender: "aoa" }, "test", "probe")).changed).toBe(true);
    await aoa.$executeRawUnsafe(`UPDATE trade_request.copy_runs SET started_at = NOW() - interval '96 minutes'`);
    expect((await changeServingState(aoa, { servingSource: "aoa" }, "test", "probe")).to.servingSource).toBe("aoa");
  });

  it("waits for in-flight native writes holding the shared serving-state lock before switching (ticket contract)", async () => {
    const writer = new PrismaClient({ datasourceUrl: `${TGT_URL}?connection_limit=1` });
    try {
      let released = 0;
      const inFlight = writer.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(hashtext('trade_request.serving_state'))`);
        await new Promise((res) => setTimeout(res, 1_500));
        released = Date.now();
      }, { timeout: 15_000 });
      await new Promise((res) => setTimeout(res, 200));
      await changeServingState(aoa, { servingSource: "aoa" }, "test", "probe");
      const changed = Date.now();
      await inFlight;
      expect(released).toBeGreaterThan(0);
      expect(changed).toBeGreaterThanOrEqual(released);
      expect((await serving()).s).toBe("aoa");
    } finally {
      await writer.$disconnect();
    }
  });

  it("allows one controller run at a time", async () => {
    const other = new PrismaClient({ datasourceUrl: `${TGT_URL}?connection_limit=1` });
    try {
      await other.$executeRawUnsafe(`SELECT pg_advisory_lock(${CONTROLLER_LOCK_KEY})`);
      const r = await controller().preflight();
      expect(statusOf(r.gates, "controller_lock")).toEqual(["refused"]);
      await other.$queryRawUnsafe(`SELECT pg_advisory_unlock(${CONTROLLER_LOCK_KEY})`);
      expect((await controller().preflight()).outcome).toBe("done");
    } finally {
      await other.$disconnect();
    }
  });

  it("recovers to the last safe state: unfreezes an interrupted cutover, keeps an open rollback frozen, removes a second writer or sender", async () => {
    // Interrupted forward cutover: frozen, standalone-served, no switch.
    stub.mode = "frozen"; stub.modeChangedAt = TUE_0500;
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.standalone_transitions (actor, from_state, to_state, reason) VALUES ('test', '{"standalone":{"mode":"active"}}', '{"standalone":{"mode":"frozen"}}', 'standalone: cutover: freeze')`);
    expect((await controller().recover()).outcome).toBe("done");
    expect(stub.mode).toBe("active");
    // Open rollback: the serving source went back to standalone after the freeze and no copy-back has passed.
    stub.mode = "frozen";
    await changeServingState(aoa, { servingSource: "aoa" }, "test", "probe");
    await changeServingState(aoa, { servingSource: "standalone" }, "test", "rollback probe");
    const open = await controller().recover();
    expect(statusOf(open.gates, "rollback_in_progress")).toEqual(["refused"]);
    expect(stub.mode).toBe("frozen");
    // Two writers, then two digest senders while AOA-served.
    await setServing("aoa", "aoa", "standalone");
    stub.mode = "active"; stub.digestSender = "on"; stub.driftSender = "on";
    expect((await controller().recover()).outcome).toBe("done");
    expect([stub.mode, stub.digestSender, (await serving()).d]).toEqual(["frozen", "off", "aoa"]);
  });

  it("records the engine-use gate as exempt only under the dev exemption and names it on the switch", async () => {
    stub.engineUse = "unavailable";
    expect(statusOf((await controller().cutover()).gates, "engine_use_activity")).toEqual(["refused"]);
    expect(stub.calls).toEqual([]);
    const r = await controller({ exemption: REF }).cutover();
    expect(r.outcome).toBe("done");
    expect(statusOf(r.gates, "engine_use_coverage")).toEqual(["exempt", "exempt"]);
    expect(events.some((e) => e.event === "engine_use_gate_exempted" && e.reference === REF)).toBe(true);
    expect((await transitions()).at(-1)?.reason).toBe(`cutover: switch to AOA-served (engine-use gate exempted: ${REF})`);
  });

  it("never resumes or abandons a rollback's freeze from cutover (WO-AC-13)", async () => {
    expect((await controller().cutover()).outcome).toBe("done");
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.trade_requests (id, client_id, trade_type) VALUES ('REQ-SYN00003', 'client-0001', 'Cash Deposit')`);
    await source.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION trb_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`);
    await source.$executeRawUnsafe(`CREATE TRIGGER trb_fail BEFORE INSERT ON trade_requests FOR EACH ROW EXECUTE FUNCTION trb_fail()`);
    expect((await controller().rollback()).outcome).toBe("refused");
    expect([stub.mode, (await serving()).s]).toEqual(["frozen", "standalone"]);
    stub.engineUse = report({ planGeneration: "on", coveredDays: 0 });
    const r = await controller().cutover();
    expect(r.outcome).toBe("refused");
    expect(statusOf(r.gates, "freeze_owner")).toEqual(["refused"]);
    expect(stub.mode).toBe("frozen");
    expect(stub.calls.map((c) => c.change.mode).filter(Boolean)).toEqual(["frozen"]);
    const [{ n }] = await source.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM trade_requests WHERE id = 'REQ-SYN00003'`);
    expect(n).toBe(0);
  });

  it("fails closed when its lock connection was recycled during a wait", async () => {
    const recycling = new PrismaClient({ datasourceUrl: `${TGT_URL}?connection_limit=1&max_idle_connection_lifetime=2` });
    try {
      stub.settleMs = 3_500;
      const realSleep = async (ms: number) => { sleeps.push(ms); await new Promise((res) => setTimeout(res, ms)); clock = new Date(clock.getTime() + ms); };
      const r = await controller({ aoa: recycling, sleep: realSleep }).cutover();
      expect(r.outcome).toBe("refused");
      expect(r.gates.find((g) => g.gate === "controller_lock")?.detail).toMatch(/lock was lost/);
      expect(await copyRuns()).toEqual([]);
      expect((await serving()).s).toBe("standalone");
    } finally {
      await recycling.$disconnect();
    }
  }, 30_000);

  it("stops a change copy at the end of the freeze window and returns the service to active (WO-AC-6, WO-AC-7)", async () => {
    const slowCopy = (async ({ target }: { target: PrismaClient }) => {
      clock = new Date(clock.getTime() + 61 * 60_000);
      await target.$executeRawUnsafe("SELECT pg_sleep(30)");
      throw new Error("not reached");
    }) as unknown as ControllerDeps["copy"];
    const started = Date.now();
    const r = await controller({ copy: slowCopy, copyDeadlineMs: () => 1_000 }).cutover();
    expect(r.outcome).toBe("abandoned");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.steps.some((t) => t.includes("stopped at the end of the 60-minute freeze window"))).toBe(true);
    expect([stub.mode, (await serving()).s]).toEqual(["active", "standalone"]);
    const [{ n }] = await aoa.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%pg_sleep(30)%' AND pid <> pg_backend_pid()`);
    expect(n).toBe(0);
  }, 30_000);

  it("waits for writes admitted before the rollback's own freeze before the copy-back", async () => {
    expect((await controller().cutover()).outcome).toBe("done");
    stub.mode = "active";
    stub.settleMs = 2_000;
    const realSleep = async (ms: number) => { sleeps.push(ms); await new Promise((res) => setTimeout(res, ms)); clock = new Date(clock.getTime() + ms); };
    const r = await controller({ sleep: realSleep }).rollback();
    expect(r.outcome).toBe("done");
    expect(sleeps[0]).toBeGreaterThan(1_500);
    expect(sleeps[0]).toBeLessThanOrEqual(2_000);
    const [{ gap }] = await aoa.$queryRawUnsafe<Array<{ gap: number }>>(
      `SELECT extract(epoch FROM (SELECT started_at FROM trade_request.copy_runs WHERE mode = 'copy_back') -
              (SELECT at FROM trade_request.standalone_transitions WHERE reason = 'standalone: rollback: freeze'))::float8 AS gap`);
    expect(gap).toBeGreaterThanOrEqual(2);
    expect([stub.mode, (await serving()).s]).toEqual(["active", "standalone"]);
  }, 30_000);

  it("terminates a change copy that is idle inside its transaction at the deadline before unfreezing", async () => {
    const idleCopy = (async ({ target }: { target: PrismaClient }) => {
      clock = new Date(clock.getTime() + 61 * 60_000);
      await target.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SELECT 1");
          await new Promise((res) => setTimeout(res, 20_000));
          await tx.$executeRawUnsafe("SELECT 2");
        },
        { maxWait: 5_000, timeout: 60_000 },
      );
      throw new Error("not reached");
    }) as unknown as ControllerDeps["copy"];
    const started = Date.now();
    const r = await controller({ copy: idleCopy, copyDeadlineMs: () => 1_000 }).cutover();
    expect(r.outcome).toBe("abandoned");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.steps.filter((t) => t.includes("had not unwound 5 s after cancellation; terminating its backends") || t.includes("backends stopped"))).toHaveLength(2);
    const [{ n }] = await aoa.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`);
    expect(n).toBe(0);
    expect([stub.mode, (await serving()).s]).toEqual(["active", "standalone"]);
  }, 30_000);

  it("keeps a rollback open when the service was made MCP-only by hand and the rollback re-froze it (WO-AC-13)", async () => {
    expect((await controller().cutover()).outcome).toBe("done");
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.trade_requests (id, client_id, trade_type) VALUES ('REQ-SYN00004', 'client-0001', 'Cash Deposit')`);
    await source.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION trb_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`);
    await source.$executeRawUnsafe(`CREATE TRIGGER trb_fail BEFORE INSERT ON trade_requests FOR EACH ROW EXECUTE FUNCTION trb_fail()`);
    expect((await controller().rollback()).outcome).toBe("refused");
    stub.mode = "mcp-only";
    expect((await controller().rollback()).outcome).toBe("refused");
    expect(stub.mode).toBe("frozen");
    const recovered = await controller().recover();
    expect(recovered.outcome).toBe("refused");
    expect(statusOf(recovered.gates, "rollback_in_progress")).toEqual(["refused"]);
    const resumed = await controller().cutover();
    expect(statusOf(resumed.gates, "freeze_owner")).toEqual(["refused"]);
    expect([stub.mode, (await serving()).s]).toEqual(["frozen", "standalone"]);
  });

  it("keeps the standalone levers out of the serving-state log, so the copy engine's guards admit the cutover's copies", async () => {
    // An abandoned cutover leaves only standalone levers behind, so the next cutover's change copy is still admitted.
    await aoa.$executeRawUnsafe(`CREATE FUNCTION trade_request.trb_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`);
    await aoa.$executeRawUnsafe(`CREATE TRIGGER trb_fail BEFORE INSERT ON trade_request.notifications FOR EACH ROW EXECUTE FUNCTION trade_request.trb_fail()`);
    expect((await controller().cutover()).outcome).toBe("abandoned");
    await aoa.$executeRawUnsafe(`DROP TRIGGER trb_fail ON trade_request.notifications`);
    expect(await servingTransitions()).toEqual([]);
    expect((await controller().cutover()).outcome).toBe("done");
    expect(await servingTransitions()).toEqual(["cutover: switch to AOA-served"]);
    // The switch admits the rollback's copy-back; with no serving-state change after it, a later cutover copies again.
    expect((await controller().rollback()).outcome).toBe("done");
    expect(await servingTransitions()).toEqual(["cutover: switch to AOA-served", "rollback: standalone-served while the standalone service is frozen"]);
    expect((await controller().cutover()).outcome).toBe("done");
    expect((await copyRuns()).map((c) => `${c.mode}:${c.verdict}`).filter((c) => !c.endsWith(":failed"))).toEqual(["change:passed", "copy_back:passed", "change:passed"]);
    expect((await serving()).s).toBe("aoa");
  });

  it("cuts over again after a rollback that returned a sender, carrying the standalone writes made since", async () => {
    expect((await controller().cutover()).outcome).toBe("done");
    expect((await controller().handoff("digest", "aoa")).outcome).toBe("done");
    expect((await controller().rollback()).outcome).toBe("done");
    expect(await serving()).toEqual({ s: "standalone", d: "standalone", r: "standalone" });
    expect((await servingTransitions()).at(-1)).toBe("digest sender to standalone: AOA sender off");
    await source.$executeRawUnsafe(`INSERT INTO trade_requests (id, client_id, trade_type) VALUES ('REQ-SYN00005', 'client-0001', 'Rebalance')`);
    const again = await controller().cutover();
    expect(again.outcome).toBe("done");
    expect(statusOf(again.gates, "forward_copy_admitted")).toEqual(["passed"]);
    expect((await copyRuns()).map((c) => `${c.mode}:${c.verdict}`)).toEqual(["change:passed", "copy_back:passed", "change:passed"]);
    const count = async (db: PrismaClient, table: string) =>
      (await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${table} WHERE id = 'REQ-SYN00005'`))[0].n;
    expect([await count(source, "trade_requests"), await count(aoa, "trade_request.trade_requests")]).toEqual([1, 1]);
    expect(sleeps).toEqual([]);
  });

  it("keeps forward copies refused after a rollback whose copy-back has not passed, and refuses before freezing", async () => {
    expect((await controller().cutover()).outcome).toBe("done");
    await source.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION trb_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`);
    await source.$executeRawUnsafe(`CREATE TRIGGER trb_fail BEFORE INSERT ON trade_requests FOR EACH ROW EXECUTE FUNCTION trb_fail()`);
    await aoa.$executeRawUnsafe(`INSERT INTO trade_request.trade_requests (id, client_id, trade_type) VALUES ('REQ-SYN00006', 'client-0001', 'Cash Deposit')`);
    expect((await controller().rollback()).outcome).toBe("refused");
    const clients = await openCopyClients();
    try {
      await expect(runCopy({ source: clients.source, target: clients.target, mode: "change", actor: "test" })).rejects.toThrow(
        "change copy requires a passed copy_back after the last serving-state transition",
      );
    } finally {
      await clients.close();
    }
    const [{ n }] = await aoa.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM trade_request.trade_requests WHERE id = 'REQ-SYN00006'`);
    expect(n).toBe(1);
    // Unfrozen by hand: rollback still returns no sender, and cutover refuses before freezing (no 60-minute hold).
    stub.mode = "active";
    const callsBefore = stub.calls.length;
    const held = await controller().rollback();
    expect(held.outcome).toBe("refused");
    expect(held.gates.find((g) => g.gate === "copy_back_verification")?.detail).toMatch(/do not run another copy-back/);
    const preflight = await controller().preflight();
    expect(statusOf(preflight.gates, "forward_copy_admitted")).toEqual(["refused"]);
    const cut = await controller().cutover();
    expect(cut.outcome).toBe("refused");
    expect(statusOf(cut.gates, "forward_copy_admitted")).toEqual(["refused"]);
    expect(stub.calls.length).toBe(callsBefore);
    expect(sleeps).toEqual([]);
  });

  it("re-checks the morning window at the AOA sender change itself (ticket claims the digest 07:55-08:10)", async () => {
    await setServing("aoa", "standalone", "standalone");
    stub.mode = "frozen";
    clock = new Date("2026-10-20T11:29:50.000Z");
    // The standalone call returns at 07:56 local, inside the digest's read-then-claim window.
    const slow: StandaloneControl = {
      readState: () => stub.readState(),
      readEngineUse: () => stub.readEngineUse(),
      changeState: async (change) => {
        clock = new Date("2026-10-20T11:56:00.000Z");
        return stub.changeState(change);
      },
    };
    const r = await controller({ standalone: slow }).handoff("digest", "aoa");
    expect(r.outcome).toBe("refused");
    expect(r.gates.find((g) => g.gate === "lever")?.detail).toMatch(/never change inside 07:30-10:00/);
    expect([(await serving()).d, stub.digestSender]).toEqual(["standalone", "off"]);
    clock = new Date(TUE_1000);
    expect((await controller().handoff("digest", "aoa")).outcome).toBe("done");
    expect((await serving()).d).toBe("aoa");
  });
});
