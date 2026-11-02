// The demo seed's statement runs (lib/demo/seed/asset-maps-snapshot.ts): the Statement Analyzer demo's seed, placed on
// the seed's clock by the Statement Analyzer's own rules, then read back through AOA's own pipeline readers over the
// stand-in (an in-memory copy of demo.stand_in_record), as the asset-mapping pages read it.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { rows } = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/demo/outbox", () => ({ recordOutbox: async () => {} }));
vi.mock("@/lib/demo/stand-ins/store", () => {
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  return {
    listRecords: async (s: string, k: string) => [...rows.entries()]
      .filter(([id]) => id.startsWith(`${s}|${k}|`))
      .map(([id, doc]) => ({ id: id.split("|")[2], doc: copy(doc), updatedAt: new Date() })),
    readRecord: async (s: string, k: string, id: string) =>
      rows.has(`${s}|${k}|${id}`) ? { id, doc: copy(rows.get(`${s}|${k}|${id}`)), updatedAt: new Date() } : null,
    saveRecord: async () => {},
    changeRecord: async () => null,
  };
});

import { fetchHouseholdsPage, flattenHouseholds } from "@/lib/data/asset-map";
import { fetchAssetMapDestinations } from "@/lib/data/asset-map-destinations";
import {
  businessDayBefore, folderHousehold, planStatementRuns, replayShiftDays, runId,
} from "@/lib/demo/seed/asset-maps-snapshot";
import { loadUniverse } from "@/lib/demo/seed/universe";
import { normalizeAccountType, normalizeOwner, statementAgeDays } from "@/lib/demo/stand-ins/pipeline";

const PIPELINE = "https://statements.jeremyhamann.dev";
const universe = loadUniverse();
// The snapshot's own clock: Wednesday 28 October 2026, 03:00 in New York (the Statement Analyzer's nightly reset).
const CLOCK = new Date("2026-10-28T07:00:00Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/;

const run = (plan: ReturnType<typeof planStatementRuns>, folder: string, number: number) =>
  plan.households.find((h) => h.source_folder_id === folder && h.run_number === number)!;

function load(plan: ReturnType<typeof planStatementRuns>) {
  rows.clear();
  for (const h of plan.households) rows.set(`pipeline|household|${h.id}`, h);
  for (const d of plan.destinations) rows.set(`pipeline|destination|${d.id}`, d);
  plan.roster.forEach((r, i) => rows.set(`pipeline|roster|${i}`, r));
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
  vi.stubEnv("STATEMENT_PIPELINE_URL", PIPELINE);
});

describe("the Statement Analyzer's runs on the seed's clock", () => {
  it("lands each run where the Statement Analyzer's reset puts it", () => {
    const plan = planStatementRuns(universe, CLOCK);
    expect(plan.households).toHaveLength(48);
    expect(plan.households.filter((h) => !h.superseded_by)).toHaveLength(39);
    const okafor = run(plan, "sample-okafor", 2);
    // demo_reset.SAMPLE_RUN_DAYS["okafor"] = (1, 95): one business day back, 10:35 ET.
    expect(okafor.processed_at).toBe("2026-10-27T14:35:00.000Z");
    expect(run(plan, "sample-okafor", 1).superseded_by).toBe(okafor.id);
    expect(okafor.id).toBe(runId("sample-okafor#2"));
    for (const h of plan.households) {
      expect(h.id).toMatch(UUID);
      for (const a of h.accounts) {
        expect(a.id).toMatch(UUID);
        for (const p of a.assets) expect(p.id).toMatch(UUID);
      }
    }
  });

  it("keeps Jordan Reyes's edits after their runs", () => {
    const okafor = run(planStatementRuns(universe, CLOCK), "sample-okafor", 2);
    const positions = okafor.accounts.flatMap((a) => a.assets);
    const bridge = positions.find((p) => p.symbol === "BBGLX")!;
    expect(bridge).toMatchObject({ transfer_eligible: "REVIEW", override_status: "LIQUIDATE", overridden_by: "jordan.reyes@example.com" });
    expect(bridge.overridden_at).toBe("2026-10-27T16:35:00.000Z");
    expect(positions.find((p) => p.symbol === "VTI")).toMatchObject({ transferring: "YES" });
  });

  it("dates statements the way the Statement Analyzer shows them", () => {
    const later = new Date("2026-11-18T15:00:00Z"); // 26 days after the as-of date: a three-week replay shift
    expect(replayShiftDays(universe, CLOCK)).toBe(0);
    expect(replayShiftDays(universe, later)).toBe(21);
    const plan = planStatementRuns(universe, later);
    // A sample's own statement: its printed date, moved by the shift.
    expect(run(plan, "sample-okafor", 2).accounts.map((a) => a.statement_date)).toEqual(["10/21/2026", "10/21/2026", "10/21/2026"]);
    // An earlier quarter: the month that ended before its run.
    const earlier = run(plan, "sample-okafor", 1);
    const runMonth = new Date(earlier.processed_at);
    const monthEnd = new Date(Date.UTC(runMonth.getUTCFullYear(), runMonth.getUTCMonth(), 0));
    expect(earlier.accounts[0].statement_date).toBe(
      `${String(monthEnd.getUTCMonth() + 1).padStart(2, "0")}/${String(monthEnd.getUTCDate()).padStart(2, "0")}/${monthEnd.getUTCFullYear()}`);
  });

  it("counts business days as the reset does (weekdays only)", () => {
    const monday = new Date("2026-11-02T08:00:00Z");
    expect(businessDayBefore(monday, 1, 0).toISOString()).toBe("2026-10-30T13:00:00.000Z"); // Friday, 9:00 ET
    expect(businessDayBefore(monday, 5, 90).toISOString()).toBe("2026-10-26T14:30:00.000Z");
  });

  it("maps every client folder to a universe household", () => {
    const folders = new Set(planStatementRuns(universe, CLOCK).households.map((h) => h.source_folder_id!));
    const ids = new Set(universe.households.map((h) => h.id));
    for (const folder of folders) expect(ids.has(folderHousehold(folder)!), folder).toBe(true);
    expect(folderHousehold("sample-chen")).toBe("chen-ashby");
  });
});

describe("through AOA's own pipeline readers", () => {
  it("imports every run, with the effective status and today's statement freshness", async () => {
    const plan = planStatementRuns(universe, CLOCK);
    load(plan);
    const page = await fetchHouseholdsPage(PIPELINE, 1, 200);
    expect(page.total).toBe(48);
    const flat = flattenHouseholds(page.households, undefined, { transferringText: true });
    expect(flat.rejected).toEqual([]);
    expect(flat.positions).toHaveLength(741); // one position was removed in review
    const okafor = run(plan, "sample-okafor", 2);
    const bridge = flat.positions.find((p) => p.symbol === "BBGLX" && okafor.accounts.some((a) => a.id === p.account_id))!;
    expect(bridge).toMatchObject({ effective_status: "LIQUIDATE", original_transfer_eligible: null });
    const accounts = flat.accounts.filter((a) => a.household_id === okafor.id);
    expect(accounts.map((a) => a.account_number).sort()).toEqual(["DEMO-4417-7781", "DEMO-4417-7790", "DEMO-4417-7802"]);
    expect(accounts.every((a) => a.statement_age_days != null && a.is_stale === false)).toBe(true);
    const nakamura = flat.accounts.find((a) => a.account_number === "DEMO-2241-5518")!;
    expect(nakamura.is_stale).toBe(true); // the March statement
  });

  it("suggests the receiving custodian's existing account from the roster", async () => {
    load(planStatementRuns(universe, CLOCK));
    const destinations = (await fetchAssetMapDestinations(PIPELINE, "sample-okafor"))!;
    const joint = destinations.find((d) => d.targetAccountType === "Joint")!;
    expect(joint).toMatchObject({ existingCount: 1, suggestedApexNumber: "DEMO-142290", needsToBeOpened: false });
    expect(destinations.find((d) => d.targetAccountType === "Roth IRA")).toMatchObject({ existingCount: 0, suggestedApexNumber: null });
  });
});

describe("the pipeline's own normalizing, ported", () => {
  it("ages a statement in days since its date in New York", () => {
    const now = new Date("2026-10-28T07:00:00Z");
    expect(statementAgeDays("09/30/2026", now)).toBe(28);
    expect(statementAgeDays("2026-09-30", now)).toBe(28);
    expect(statementAgeDays("September 1-30, 2026", now)).toBe(28);
    expect(statementAgeDays("Sept 30, 2026", now)).toBeNull();
    expect(statementAgeDays(null, now)).toBeNull();
  });

  it("normalizes owners and account types as the roster stores them", () => {
    expect(normalizeOwner("KOFI M OKAFOR-ALVAREZ")).toBe("kofi okafor alvarez");
    expect(normalizeOwner("Kofi Okafor, Ada Okafor")).toBe("kofi okafor ada okafor");
    expect(normalizeAccountType("Joint Tenants with Right of Survivorship")).toBe("JOINT");
    expect(normalizeAccountType("Rollover IRA")).toBe("TRAD IRA");
    expect(normalizeAccountType("401k")).toBe("TRAD IRA");
    expect(normalizeAccountType("Inherited Roth IRA")).toBe("ROTH IRA INHERITED");
    expect(normalizeAccountType("Checking")).toBe("CHECKING");
  });
});
