import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "@/lib/trade-requests/pg-compat";
import type { DriftRunTarget } from "@/lib/trade-requests/drift/targets";

// ticket: the ported runner with its real persistence, alert, claim and reminder modules; only the feeds,
// Warehouse and the Slack sender are stubbed. Mode, sender and input-failure behavior (WO-AC-1..8, 10, 11).
const m = vi.hoisted(() => ({
  positions: vi.fn(),
  templates: vi.fn(),
  activeAccounts: vi.fn(),
  send: vi.fn(async () => undefined),
}));

vi.mock("@/lib/trade-requests/sources/warehouse", () => ({
  fetchAccountPositions: m.positions,
  fetchAccountTitles: vi.fn(async () => new Map()),
  isWarehouseQueryConfigured: () => false,
  fetchCostBasisData: vi.fn(),
  fetchRealizedGainsYtd: vi.fn(),
  fetchOwnershipTypes: vi.fn(),
}));
vi.mock("@/lib/trade-requests/sources/meridian-templates", () => ({ loadMeridianTemplates: m.templates }));
vi.mock("@/lib/trade-requests/sources/meridian-active-accounts", async (orig) => ({
  ...(await orig<typeof import("@/lib/trade-requests/sources/meridian-active-accounts")>()),
  loadMeridianActiveAccounts: m.activeAccounts,
}));
vi.mock("@/lib/trade-requests/sources/meridian-transitions", () => ({ loadMeridianTransitions: vi.fn(async () => new Map()) }));
vi.mock("@/lib/trade-requests/sources/security-sector", () => ({ getClassificationMap: vi.fn(async () => new Map()) }));
vi.mock("@/lib/trade-requests/drift/slack", () => ({ sendDriftChannelMessage: m.send, escapeSlack: (t: string) => t }));
vi.mock("@/lib/trade-requests/log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { runDriftCheck } from "@/lib/trade-requests/drift/registry-drift-runner";
import { SnapshotLoadError } from "@/lib/trade-requests/sources/meridian-snapshot";
import { ActiveAccountsLoadError } from "@/lib/trade-requests/sources/meridian-active-accounts";
import { postCostBasisFreshnessAlert } from "@/lib/trade-requests/drift/cost-basis-freshness-alert";
import type { CostBasisFreshnessResult } from "@/lib/trade-requests/drift/cost-basis-freshness";

const NOW = new Date("2026-05-13T13:15:00.000Z");
const OUT_ACCOUNT = "01SYNTH14F7HAYDP2AD4SNVNAX";

function feeds() {
  m.positions.mockResolvedValue(
    new Map([[OUT_ACCOUNT, { accountId: OUT_ACCOUNT, positionsTotal: 99_500, totalEquity: 100_000, cashEquity: 500, positionsBySymbol: { VOO: 75_000, BND: 24_500 }, businessDate: "2026-05-13" }]]),
  );
  m.templates.mockResolvedValue({ generatedAt: "2026-05-13T00:00:00.000Z", entries: [{ account: OUT_ACCOUNT, weights: { VOO: 59.5, BND: 40 } }] });
  m.activeAccounts.mockResolvedValue({
    generatedAt: "2026-05-13T00:00:00.000Z",
    firmId: "t",
    accountCount: 1,
    rawRowCount: 1,
    accounts: [{ accountId: 1, tradingAccountNo: OUT_ACCOUNT, accountTitle: "Sample Client - Brokerage", accountType: "NA", cash: 500, equity: 99_500, total: 100_000, householdId: 1, householdName: "Sample Household" }],
  });
}

type Sql = { sql: string; params: readonly unknown[] };
function fakePool(opts: { claimWins?: boolean; dueReminder?: boolean } = {}) {
  const calls: Sql[] = [];
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("INSERT INTO trade_request.drift_alert_sends")) {
      return opts.claimWins === false ? { rows: [], rowCount: 0 } : { rows: [{ run_date_local: "2026-05-13" }], rowCount: 1 };
    }
    if (sql.includes("FROM trade_request.drift_status_overrides o") && opts.dueReminder) {
      return { rows: [{ account_id: OUT_ACCOUNT, account_title: "Sample Client - Brokerage", reason: "intentional_cash", set_by: "00000000-0000-4000-8000-000000000001", expires_on: "2026-05-13" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as Pool["query"];
  const pool: Pool = { query, transaction: async (fn) => fn(pool) };
  const writes = () => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/.test(c.sql)).map((c) => c.sql.replace(/\s+/g, " ").trim().split(" (")[0]);
  return { pool, calls, writes };
}
const LIVE = (stillSender: () => Promise<boolean> = async () => true): DriftRunTarget => ({ kind: "live", stillSender });

beforeEach(() => {
  vi.clearAllMocks();
  m.send.mockResolvedValue(undefined);
  feeds();
  // The drift channel is postable (driftChannelReady): epic master, ticket's bot token and channel, and the drift channel id.
  process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE = "1";
  process.env.TRADE_REQUEST_SLACK_BOT_TOKEN = "xoxb-fixture";
  process.env.TRADE_REQUEST_SLACK_CHANNEL_ID = "CTRADES123";
  process.env.TRADE_REQUEST_DRIFT_SLACK_CHANNEL_ID = "CDRIFT123";
});
afterEach(() => {
  for (const k of ["EPIC_TRADE_REQUESTS_BACKEND_MOVE", "TRADE_REQUEST_SLACK_BOT_TOKEN", "TRADE_REQUEST_SLACK_CHANNEL_ID", "TRADE_REQUEST_DRIFT_SLACK_CHANNEL_ID", "TRADE_REQUESTS_SLACK"]) delete process.env[k];
});

describe("drift run modes", () => {
  it("shadow writes only the shadow result tables and sends nothing, even with an out-of-tolerance account", async () => {
    const { pool, writes } = fakePool({ dueReminder: true });
    const summary = await runDriftCheck({ pool, now: NOW }, { kind: "shadow" });
    expect(summary.accountDrift.outAccounts).toBe(1);
    expect(new Set(writes())).toEqual(new Set(["INSERT INTO trade_request.shadow_registry_drift_runs", "INSERT INTO trade_request.shadow_position_drift_accounts"]));
    expect(m.send).not.toHaveBeenCalled();
  });

  it("live records the day's household and account results and posts one alert after winning the date claim", async () => {
    const { pool, writes, calls } = fakePool();
    const summary = await runDriftCheck({ pool, now: NOW }, LIVE());
    expect(writes()).toEqual(expect.arrayContaining(["INSERT INTO trade_request.registry_drift_runs", "INSERT INTO trade_request.position_drift_accounts", "INSERT INTO trade_request.drift_alert_sends"]));
    expect(calls.find((c) => c.sql.includes("drift_alert_sends"))?.params).toEqual(["2026-05-13"]);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(summary.accountDrift.alert.sent).toBe(true);
  });

  it("live posts nothing when the date is already claimed", async () => {
    const { pool } = fakePool({ claimWins: false });
    const summary = await runDriftCheck({ pool, now: NOW }, LIVE());
    expect(m.send).not.toHaveBeenCalled();
    expect(summary.accountDrift.alert.sent).toBe(false);
  });

  it("live releases the claim when the post fails so a later run that day can post", async () => {
    m.send.mockRejectedValue(new Error("drift Slack post failed: timeout"));
    const { pool, writes } = fakePool();
    await runDriftCheck({ pool, now: NOW }, LIVE());
    expect(writes()).toContain("DELETE FROM trade_request.drift_alert_sends WHERE run_date_local = $1::date");
  });

  it("live claims, posts and reminds nothing once AOA has stopped being the drift sender", async () => {
    const { pool, writes } = fakePool({ dueReminder: true });
    await runDriftCheck({ pool, now: NOW }, LIVE(async () => false));
    expect(writes().some((w) => w.includes("drift_alert_sends") || w.includes("notifications"))).toBe(false);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("live takes no claim and posts nothing while the drift channel cannot be posted to, and still sends reminders", async () => {
    process.env.TRADE_REQUESTS_SLACK = "0";
    const { pool, writes } = fakePool({ dueReminder: true });
    const summary = await runDriftCheck({ pool, now: NOW }, LIVE());
    expect(writes().some((w) => w.includes("drift_alert_sends"))).toBe(false);
    expect(writes()).toContain("INSERT INTO trade_request.notifications");
    expect(m.send).not.toHaveBeenCalled();
    expect(summary.accountDrift.alert.sent).toBe(false);
  });

  it("live sends the author of a due override one reminder and marks it sent", async () => {
    const { pool, calls } = fakePool({ dueReminder: true });
    await runDriftCheck({ pool, now: NOW }, LIVE());
    const bell = calls.filter((c) => c.sql.startsWith("INSERT INTO trade_request.notifications"));
    expect(bell).toHaveLength(1);
    expect(bell[0].params[0]).toBe("00000000-0000-4000-8000-000000000001");
    expect(calls.some((c) => c.sql.includes("UPDATE trade_request.drift_status_overrides SET recheck_notified_at = now()") && c.sql.includes("recheck_notified_at IS NULL"))).toBe(true);
  });

  it("persists nothing and throws when the Warehouse positions read fails", async () => {
    m.positions.mockRejectedValue(new Error("Warehouse question 6139 returned 502"));
    const { pool, writes } = fakePool();
    await expect(runDriftCheck({ pool, now: NOW }, LIVE())).rejects.toThrow(/returned 502/);
    expect(writes()).toEqual([]);
  });

  it("persists nothing and throws SnapshotLoadError when the templates feed is malformed", async () => {
    m.templates.mockRejectedValue(new SnapshotLoadError("templates file is not valid JSON", "s3"));
    const { pool, writes } = fakePool();
    await expect(runDriftCheck({ pool, now: NOW }, { kind: "shadow" })).rejects.toBeInstanceOf(SnapshotLoadError);
    expect(writes()).toEqual([]);
  });

  it("persists nothing and throws ActiveAccountsLoadError when the household feed is unavailable", async () => {
    m.activeAccounts.mockRejectedValue(new ActiveAccountsLoadError("no active_accounts file", "s3"));
    const { pool, writes } = fakePool();
    await expect(runDriftCheck({ pool, now: NOW }, LIVE())).rejects.toBeInstanceOf(ActiveAccountsLoadError);
    expect(writes()).toEqual([]);
  });
});

describe("cost-basis staleness notice", () => {
  const stale = { level: "warn", message: "Cost basis is 9 days old", full: { latest: "2026-05-04", ageDays: 9 }, daily: { latest: "2026-05-12", ageDays: 1 } } as unknown as CostBasisFreshnessResult;
  it("sends nothing while the run may not send", async () => {
    expect(await postCostBasisFreshnessAlert({ freshness: stale, runDateLocal: "2026-05-13", send: async () => false })).toEqual({ sent: false, level: "warn" });
    expect(m.send).not.toHaveBeenCalled();
  });
  it("posts once when the run may send", async () => {
    expect((await postCostBasisFreshnessAlert({ freshness: stale, runDateLocal: "2026-05-13", send: async () => true })).sent).toBe(true);
    expect(m.send).toHaveBeenCalledTimes(1);
  });
});
