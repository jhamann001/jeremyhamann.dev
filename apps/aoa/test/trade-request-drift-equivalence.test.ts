import { describe, it, expect, vi, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "@/lib/trade-requests/pg-compat";
import type { AccountPositions } from "@/lib/trade-requests/sources/warehouse";
import type { MeridianSnapshot } from "@/lib/trade-requests/sources/meridian-snapshot";
import type { HouseholdConfig } from "@/lib/trade-requests/sources/household-config";
import type { DriftRunTarget } from "@/lib/trade-requests/drift/targets";

// ticket (WO-AC-12): the recorded input sets and baseline of ticket's driftEquivalence.test.ts, replayed
// against the AOA port. I/O is mocked exactly as there; the comparators and the runner are real.
const io = vi.hoisted(() => ({
  positions: new Map<string, unknown>(),
  snapshot: { generatedAt: "2026-05-13T00:00:00.000Z", entries: [] as unknown[] },
  householdConfig: null as unknown,
  persistArgs: [] as unknown[],
  persistTables: [] as unknown[],
  alertArgs: [] as unknown[],
  sweeps: 0,
}));

vi.mock("@/lib/trade-requests/sources/warehouse", () => ({
  fetchAccountPositions: vi.fn(async () => io.positions),
  fetchAccountTitles: vi.fn(async () => new Map()),
  isWarehouseQueryConfigured: () => false,
  fetchCostBasisData: vi.fn(),
  fetchRealizedGainsYtd: vi.fn(),
  fetchOwnershipTypes: vi.fn(),
}));
vi.mock("@/lib/trade-requests/sources/meridian-templates", () => ({ loadMeridianTemplates: vi.fn(async () => io.snapshot) }));
vi.mock("@/lib/trade-requests/sources/meridian-active-accounts", async (orig) => ({
  ...(await orig<typeof import("@/lib/trade-requests/sources/meridian-active-accounts")>()),
  loadMeridianActiveAccounts: vi.fn(async () => ({ generatedAt: "2026-05-13T00:00:00.000Z", firmId: "t", accountCount: 0, rawRowCount: 0, accounts: [] })),
  toHouseholdConfig: vi.fn(() => io.householdConfig),
}));
vi.mock("@/lib/trade-requests/sources/meridian-transitions", () => ({
  loadMeridianTransitions: vi.fn(async () => {
    throw new Error("transitions not configured in test");
  }),
}));
vi.mock("@/lib/trade-requests/sources/security-sector", () => ({ getClassificationMap: vi.fn(async () => new Map()) }));
vi.mock("@/lib/trade-requests/drift/position-drift-accounts-persistence", () => ({
  ACCOUNT_DRIFT_SCHEMA_VERSION: 1,
  persistAccountDriftRows: vi.fn(async (args: unknown, tables: unknown) => {
    io.persistArgs.push(args);
    io.persistTables.push(tables);
    return new Set<string>();
  }),
}));
vi.mock("@/lib/trade-requests/drift/position-drift-accounts-alert", () => ({
  postAccountDriftAlert: vi.fn(async (args: { accounts: unknown }) => {
    io.alertArgs.push(args.accounts);
    return { sent: false, alertingAccountIds: [], suppressedAllowListed: [] };
  }),
}));
vi.mock("@/lib/trade-requests/drift/drift-status-overrides", () => ({
  sweepOverrideRechecks: vi.fn(async () => {
    io.sweeps += 1;
    return 0;
  }),
}));
vi.mock("@/lib/trade-requests/log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { runDriftCheck } from "@/lib/trade-requests/drift/registry-drift-runner";

const BASELINE = path.join(process.cwd(), "test", "fixtures", "trade-request-drift-equivalence-baseline.json");
const NOW = new Date("2026-05-13T13:15:00.000Z");
const LIVE: DriftRunTarget = { kind: "live", stillSender: async () => true };
const SHADOW: DriftRunTarget = { kind: "shadow" };

function hh(entries: Array<[string, string]>): HouseholdConfig {
  return {
    byAccountNumber: new Map(entries.map(([accountNumber, householdName]) => [accountNumber, { accountNumber, householdName }])),
    householdNames: new Set(entries.map(([, h]) => h)),
    entries: entries.map(([accountNumber, householdName]) => ({ accountNumber, householdName })),
  };
}
function pos(accountId: string, totalEquity: number, cashEquity: number, positionsBySymbol: Record<string, number>): AccountPositions {
  const positionsTotal = Object.values(positionsBySymbol).reduce((s, v) => s + v, 0);
  return { accountId, positionsTotal, totalEquity, cashEquity, positionsBySymbol, businessDate: "2026-05-13" };
}
const snap = (entries: MeridianSnapshot["entries"]): MeridianSnapshot => ({ generatedAt: "2026-05-13T00:00:00.000Z", entries });

// Byte-for-byte the input sets of ticket (synthetic only).
const SETS: Record<string, { positions: Map<string, AccountPositions>; snapshot: MeridianSnapshot; householdConfig: HouseholdConfig }> = {
  inTolerance: {
    positions: new Map([["A1", pos("A1", 100_000, 1_000, { VOO: 59_000, BND: 40_000 })]]),
    snapshot: snap([{ account: "A1", weights: { VOO: 60, BND: 40 } }]),
    householdConfig: hh([["A1", "Household One"]]),
  },
  justOver: {
    positions: new Map([["B1", pos("B1", 100_000, 500, { VOO: 65_000, BND: 34_500 })]]),
    snapshot: snap([{ account: "B1", weights: { VOO: 59.5, BND: 40 } }]),
    householdConfig: hh([["B1", "Household Two"]]),
  },
  uninvestedAndUnmapped: {
    positions: new Map([
      ["C1", pos("C1", 80_000, 79_500, { VOO: 500 })],
      ["C9", pos("C9", 10_000, 0, { VOO: 10_000 })],
    ]),
    snapshot: snap([{ account: "C1", weights: { VOO: 95, BND: 5 } }]),
    householdConfig: hh([["C1", "Household Three"]]),
  },
};

function fakePool(table: string): { pool: Pool; inserts: unknown[]; writes: string[] } {
  const inserts: unknown[] = [];
  const writes: string[] = [];
  const client: Pool = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (/^\s*INSERT INTO /.test(sql)) writes.push(sql.split("(")[0].trim());
      if (sql.includes(`INSERT INTO ${table} (`)) inserts.push(params);
      return { rows: [], rowCount: 0 };
    }) as Pool["query"],
    transaction: async (fn) => fn(client),
  };
  return { pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) as Pool["query"], transaction: async (fn) => fn(client) }, inserts, writes };
}

type Run = { summary: unknown; householdInserts: unknown[]; accountPersist: unknown[]; alertAccounts: unknown[]; tables: unknown[]; writes: string[]; sweeps: number };

async function runSet(name: string, target: DriftRunTarget): Promise<Run> {
  const set = SETS[name];
  io.positions = set.positions;
  io.snapshot = set.snapshot as typeof io.snapshot;
  io.householdConfig = set.householdConfig;
  io.persistArgs = [];
  io.persistTables = [];
  io.alertArgs = [];
  io.sweeps = 0;
  const table = target.kind === "live" ? "trade_request.registry_drift_runs" : "trade_request.shadow_registry_drift_runs";
  const { pool, inserts, writes } = fakePool(table);
  const summary = await runDriftCheck({ pool, now: NOW }, target);
  return JSON.parse(JSON.stringify({ summary, householdInserts: inserts, accountPersist: io.persistArgs, alertAccounts: io.alertArgs, tables: io.persistTables, writes, sweeps: io.sweeps }));
}

const live: Record<string, Run> = {};
const shadow: Record<string, Run> = {};
beforeAll(async () => {
  for (const name of Object.keys(SETS)) {
    live[name] = await runSet(name, LIVE);
    shadow[name] = await runSet(name, SHADOW);
  }
});

describe("AOA drift port against the ticket baseline", () => {
  const baseline = () => JSON.parse(fs.readFileSync(BASELINE, "utf8"));

  it("live mode persists the same household rows for every recorded input set", () => {
    for (const name of Object.keys(SETS)) expect(live[name].householdInserts).toEqual(baseline()[name].householdInserts);
  });
  it("live mode persists the same account rows, tolerance, schema version and summary", () => {
    for (const name of Object.keys(SETS)) {
      expect(live[name].accountPersist).toEqual(baseline()[name].accountPersist);
      expect(live[name].summary).toEqual(baseline()[name].summary);
    }
  });
  it("live mode passes the same accounts to the alert decision", () => {
    for (const name of Object.keys(SETS)) expect(live[name].alertAccounts).toEqual(baseline()[name].alertAccounts);
  });
  it("shadow mode persists the same rows and summary, into the shadow tables only", () => {
    for (const name of Object.keys(SETS)) {
      expect(shadow[name].householdInserts).toEqual(baseline()[name].householdInserts);
      expect(shadow[name].accountPersist).toEqual(baseline()[name].accountPersist);
      expect(shadow[name].summary).toEqual(baseline()[name].summary);
      expect(shadow[name].tables).toEqual([{ householdRuns: "trade_request.shadow_registry_drift_runs", accountRuns: "trade_request.shadow_position_drift_accounts" }]);
      expect(shadow[name].writes).toEqual(shadow[name].writes.map(() => "INSERT INTO trade_request.shadow_registry_drift_runs"));
    }
  });
  it("shadow mode never runs the override reminder sweep; live mode runs it once", () => {
    for (const name of Object.keys(SETS)) {
      expect(shadow[name].sweeps).toBe(0);
      expect(live[name].sweeps).toBe(1);
    }
  });
});
