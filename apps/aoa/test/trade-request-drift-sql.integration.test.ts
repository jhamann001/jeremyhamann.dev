import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDriftResult } from "@/lib/trade-requests/drift/position-drift-accounts";
import type { DriftHouseholdResult } from "@/lib/trade-requests/drift/drift-contract";

// ticket: every ported SQL statement through the pg-compat adapter against a migrated scratch AOA database,
// as the runtime role app_rw. Opt-in: TRADE_REQUEST_COPY_TEST_DB=1 (local Postgres 16, roles aoa and app_rw).
vi.mock("server-only", () => ({}));
vi.mock("@/lib/trade-requests/drift/slack", () => ({ sendDriftChannelMessage: vi.fn(async () => undefined), escapeSlack: (t: string) => t }));
vi.mock("@/lib/trade-requests/sources/warehouse", () => ({ getClientIdsByAccountUlid: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, ["client-1"]]))) }));
vi.mock("@/lib/trade-requests/log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const suite = process.env.TRADE_REQUEST_COPY_TEST_DB === "1" ? describe : describe.skip;
const DB = "trb_drift_sql";
const OWNER_URL = `postgresql://aoa@localhost:5432/${DB}?schema=app`;
const RUNTIME_URL = `postgresql://app_rw@localhost:5432/${DB}?schema=app`;
const TRADER_ID = "00000000-0000-4000-8000-0000000000aa";
const DAY = "2026-05-13";

const household = (name: string, accountCount = 1): DriftHouseholdResult => ({
  householdName: name,
  coverageStatus: "full",
  accountCount,
  maxDeltaPct: 6.25,
  breach: true,
  worstSymbol: "VOO",
  details: { accounts: [] },
});
const account = (id: string, over: Partial<AccountDriftResult> = {}): AccountDriftResult =>
  ({
    accountId: id,
    accountTitle: "Sample Client - Brokerage",
    household: "Sample Household",
    status: "out",
    totalValue: 100_000,
    maxBucketDeltaPct: 6.25,
    worstBucket: "equity",
    symbolBreachCount: 1,
    unmapped: false,
    templateMissing: false,
    details: {
      buckets: {
        cash: { positionPct: 0.5, templatePct: 0, deltaPct: 0.5 },
        fixed: { positionPct: 34.5, templatePct: 40, deltaPct: -5.5 },
        equity: { positionPct: 65, templatePct: 59.5, deltaPct: 5.5 },
      },
      symbolsWithTargets: [{ symbol: "VOO", positionPct: 65, targetPct: 59.5, breach: true }],
      equityHoldings: [],
    },
    ...over,
  }) as unknown as AccountDriftResult;

suite("drift SQL through pg-compat (app_rw)", () => {
  let owner: PrismaClient;
  let runtime: PrismaClient;
  let pool: import("@/lib/trade-requests/pg-compat").PgCompat;
  let mods: {
    runner: typeof import("@/lib/trade-requests/drift/registry-drift-runner");
    persistence: typeof import("@/lib/trade-requests/drift/position-drift-accounts-persistence");
    overrides: typeof import("@/lib/trade-requests/drift/drift-status-overrides");
    alert: typeof import("@/lib/trade-requests/drift/position-drift-accounts-alert");
    history: typeof import("@/lib/trade-requests/drift/drift-history-query");
    exclusions: typeof import("@/lib/trade-requests/drift/drift-exclusion-analysis");
    sector: typeof import("@/lib/trade-requests/sources/security-sector");
    targets: typeof import("@/lib/trade-requests/drift/targets");
    service: typeof import("@/lib/trade-requests/drift/overrides-service");
  };
  const count = async (table: string) => Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM trade_request.${table}`))[0].n);

  beforeAll(async () => {
    execFileSync("dropdb", ["--if-exists", DB]);
    execFileSync("createdb", ["-O", "aoa", DB]);
    execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DIRECT_DATABASE_URL: OWNER_URL, DATABASE_URL: OWNER_URL }, stdio: "ignore" });
    owner = new PrismaClient({ datasourceUrl: OWNER_URL });
    runtime = new PrismaClient({ datasourceUrl: RUNTIME_URL });
    // lib/db.ts builds its client at import: point it at the scratch database before loading the service.
    process.env.DATABASE_URL = RUNTIME_URL;
    vi.resetModules();
    const { pgCompat } = await import("@/lib/trade-requests/pg-compat");
    pool = pgCompat(runtime as never);
    mods = {
      runner: await import("@/lib/trade-requests/drift/registry-drift-runner"),
      persistence: await import("@/lib/trade-requests/drift/position-drift-accounts-persistence"),
      overrides: await import("@/lib/trade-requests/drift/drift-status-overrides"),
      alert: await import("@/lib/trade-requests/drift/position-drift-accounts-alert"),
      history: await import("@/lib/trade-requests/drift/drift-history-query"),
      exclusions: await import("@/lib/trade-requests/drift/drift-exclusion-analysis"),
      sector: await import("@/lib/trade-requests/sources/security-sector"),
      targets: await import("@/lib/trade-requests/drift/targets"),
      service: await import("@/lib/trade-requests/drift/overrides-service"),
    };
  }, 120_000);

  beforeEach(async () => {
    await owner.$executeRawUnsafe(`TRUNCATE trade_request.registry_drift_runs, trade_request.position_drift_accounts, trade_request.shadow_registry_drift_runs,
      trade_request.shadow_position_drift_accounts, trade_request.drift_alert_sends, trade_request.drift_status_overrides, trade_request.drift_override_changes,
      trade_request.notifications, trade_request.client_exclusions, trade_request.account_exclusions, trade_request.security_sector, trade_request.users CASCADE`);
    await owner.$executeRawUnsafe(`DELETE FROM app."User" WHERE email LIKE '%@example.test'`);
    await owner.$executeRawUnsafe(`INSERT INTO trade_request.users (id, email, name, role, is_active) VALUES ('${TRADER_ID}', 'trader@example.test', 'Sample Trader', 'trader', true)`);
  });

  afterAll(async () => {
    await owner?.$disconnect();
    await runtime?.$disconnect();
    const { prisma } = await import("@/lib/db");
    await prisma.$disconnect();
    execFileSync("dropdb", ["--if-exists", DB]);
  });

  it("persists household rows to the live or shadow table, once per date, refreshing the run time on a rerun", async () => {
    const { persistDriftRows } = mods.runner;
    const { LIVE_DRIFT_TABLES, SHADOW_DRIFT_TABLES } = mods.targets;
    const first = await persistDriftRows({ pool, runDateLocal: DAY, snapshotAsOf: "2026-05-13T00:00:00.000Z", households: [household("A"), household("B")] }, LIVE_DRIFT_TABLES);
    expect([...first].sort()).toEqual(["A", "B"]);
    const rerun = await persistDriftRows({ pool, runDateLocal: DAY, snapshotAsOf: "2026-05-13T00:00:00.000Z", households: [household("A")] }, LIVE_DRIFT_TABLES);
    expect(rerun.size).toBe(0);
    await persistDriftRows({ pool, runDateLocal: DAY, snapshotAsOf: "2026-05-13T00:00:00.000Z", households: [household("A")] }, SHADOW_DRIFT_TABLES);
    expect([await count("registry_drift_runs"), await count("shadow_registry_drift_runs")]).toEqual([2, 1]);
  });

  it("rolls back every household row when one row fails a CHECK", async () => {
    const { persistDriftRows } = mods.runner;
    await expect(
      persistDriftRows({ pool, runDateLocal: DAY, snapshotAsOf: "2026-05-13T00:00:00.000Z", households: [household("A"), household("B", -1)] }, mods.targets.LIVE_DRIFT_TABLES),
    ).rejects.toThrow();
    expect(await count("registry_drift_runs")).toBe(0);
  });

  it("persists account rows (live and shadow) with null template and as-of values, and reads back only live rows", async () => {
    const { persistAccountDriftRows, fetchAccountDriftHistory, fetchAccountDriftRun, fetchLatestDriftAllocationsByAccountId, ACCOUNT_DRIFT_SCHEMA_VERSION } = mods.persistence;
    const input = (accounts: AccountDriftResult[]) => ({ pool, runDateLocal: DAY, runStartedAt: new Date("2026-05-13T13:15:00.000Z"), snapshotSource: "s3", snapshotAsOf: null, tolerancePct: 5, uninvestedCashThresholdPct: 99, schemaVersion: ACCOUNT_DRIFT_SCHEMA_VERSION, accounts });
    const ins = await persistAccountDriftRows(input([account("ACCT-1"), account("ACCT-2", { status: "no_template", templateMissing: true, maxBucketDeltaPct: null, worstBucket: null })]), mods.targets.LIVE_DRIFT_TABLES);
    expect(ins.size).toBe(2);
    expect((await persistAccountDriftRows(input([account("ACCT-1")]), mods.targets.LIVE_DRIFT_TABLES)).size).toBe(0);
    await persistAccountDriftRows(input([account("ACCT-9")]), mods.targets.SHADOW_DRIFT_TABLES);
    await owner.$executeRawUnsafe(`UPDATE trade_request.position_drift_accounts SET run_date_local = CURRENT_DATE`);
    const history = await fetchAccountDriftHistory(pool, 30);
    expect(history.map((r) => r.accountId).sort()).toEqual(["ACCT-1", "ACCT-2"]);
    const today = history[0].runDateLocal;
    expect((await fetchAccountDriftRun(pool, today))?.accounts.map((a) => a.accountId).sort()).toEqual(["ACCT-1", "ACCT-2"]);
    expect([...(await fetchLatestDriftAllocationsByAccountId(pool, ["ACCT-1", "ACCT-9"])).keys()]).toEqual(["ACCT-1"]);
  });

  it("claims the alert date once, skips a second post and releases the claim when the post fails", async () => {
    const { postAccountDriftAlert } = mods.alert;
    const slack = await import("@/lib/trade-requests/drift/slack");
    const args = { accounts: [account("ACCT-1")], runDateLocal: DAY, pool, send: async () => true };
    expect((await postAccountDriftAlert(args)).sent).toBe(true);
    expect((await postAccountDriftAlert(args)).sent).toBe(false);
    expect(slack.sendDriftChannelMessage).toHaveBeenCalledTimes(1);
    await owner.$executeRawUnsafe(`TRUNCATE trade_request.drift_alert_sends`);
    vi.mocked(slack.sendDriftChannelMessage).mockRejectedValueOnce(new Error("drift Slack post failed: timeout"));
    expect((await postAccountDriftAlert(args)).sent).toBe(false);
    expect(await count("drift_alert_sends")).toBe(0);
  });

  it("releases the date claim when the drift post is skipped, so the alert is not lost", async () => {
    const slack = await import("@/lib/trade-requests/drift/slack");
    vi.mocked(slack.sendDriftChannelMessage).mockRejectedValueOnce(new Error("drift Slack post not sent: sender_skipped"));
    const result = await mods.alert.postAccountDriftAlert({ accounts: [account("ACCT-1")], runDateLocal: DAY, pool, send: async () => true });
    expect(result.sent).toBe(false);
    expect(await count("drift_alert_sends")).toBe(0);
  });

  it("upserts, reads and clears overrides; a due reminder is sent to its author exactly once", async () => {
    const { upsertOverride, fetchActiveOverrides, clearOverride, sweepOverrideRechecks } = mods.overrides;
    await upsertOverride(pool, { accountId: "ACCT-1", reason: "intentional_cash", note: "", expiresOn: "2026-01-02", setBy: TRADER_ID, setByName: "Sample Trader" });
    await upsertOverride(pool, { accountId: "ACCT-2", reason: "other", note: "n", expiresOn: null, setBy: TRADER_ID, setByName: "Sample Trader" });
    expect([...(await fetchActiveOverrides(pool)).keys()]).toEqual(["ACCT-2"]);
    expect(await sweepOverrideRechecks(pool)).toBe(1);
    expect(await sweepOverrideRechecks(pool)).toBe(0);
    expect(await count("notifications")).toBe(1);
    expect(await clearOverride(pool, "ACCT-2")).toBe(true);
    expect(await clearOverride(pool, "ACCT-2")).toBe(false);
  });

  it("records an AOA user's save and clear with their name and Trade Request identity", async () => {
    const actor = { aoaUserId: "aoa-user-1", email: "ops@example.test", name: "Ops Person" };
    const saved = await mods.service.saveDriftOverride(actor, "ACCT-7", { reason: "tax_constraint", note: "", expiresOn: null });
    expect(saved.setByName).toBe("Ops Person");
    expect(await mods.service.clearDriftOverride(actor, "ACCT-7")).toBe(true);
    const log = await owner.$queryRawUnsafe<Array<{ action: string; actor_name: string }>>(`SELECT action, actor_name FROM trade_request.drift_override_changes ORDER BY at`);
    expect(log).toEqual([{ action: "save", actor_name: "Ops Person" }, { action: "clear", actor_name: "Ops Person" }]);
    expect(await count("users")).toBe(2);
  });

  it("reads the household history and run detail, the classification cache and the exclusion overlap", async () => {
    await mods.runner.persistDriftRows({ pool, runDateLocal: DAY, snapshotAsOf: "2026-05-13T00:00:00.000Z", households: [household("A")] }, mods.targets.LIVE_DRIFT_TABLES);
    expect((await mods.history.fetchDriftRunDetail(pool, DAY, "A"))?.maxDeltaPct).toBe(6.25);
    await owner.$executeRawUnsafe(`UPDATE trade_request.registry_drift_runs SET run_date_local = CURRENT_DATE`);
    expect((await mods.history.fetchDriftHistory(pool, 7)).map((r) => r.householdName)).toEqual(["A"]);
    await owner.$executeRawUnsafe(`INSERT INTO trade_request.security_sector (ticker, source, asset_class) VALUES ('BND', 'seed', 'us_bond')`);
    expect((await mods.sector.getClassificationMap(pool, ["BND"])).get("BND")?.kind).toBe("fund");
    await mods.persistence.persistAccountDriftRows(
      { pool, runDateLocal: DAY, runStartedAt: new Date(), snapshotSource: "s3", snapshotAsOf: "2026-05-13T00:00:00.000Z", tolerancePct: 5, uninvestedCashThresholdPct: 99, schemaVersion: 1, accounts: [account("ACCT-1")] },
      mods.targets.LIVE_DRIFT_TABLES,
    );
    await owner.$executeRawUnsafe(`INSERT INTO trade_request.account_exclusions (account_id, ticker, kind, reason, no_buy, no_sell, created_by_name) VALUES ('ACCT-1', 'VOO', 'client', '', false, true, 'Sample Trader')`);
    const report = await mods.exclusions.analyzeExclusionOverlapForRun(pool, { runDateLocal: DAY });
    expect(report).toMatchObject({ runDateLocal: DAY, outAccounts: 1, totalBreaches: 1, lockedTotal: 1 });
  });
});
