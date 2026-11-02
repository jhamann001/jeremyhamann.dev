import { describe, expect, it } from "vitest";
import type {
  AssetMapAccountView,
  AssetMapHouseholdLiveExtras,
  AssetMapHouseholdView,
  AssetMapPositionView,
  AssetMapRunSummary,
} from "@/lib/data/asset-map";
import {
  COPY,
  HOUSEHOLD_STATUS_LABEL,
  RUN_SEGMENT_LIMIT,
  clientServiceSummary,
  costBasisBanner,
  costBasisPillLabel,
  costBasisPillTone,
  docStatusTone,
  documentsNotProcessed,
  emptyStateTitle,
  filterClientNames,
  groupRunsByClient,
  hasTaxLots,
  householdProcessedLabel,
  householdTotalValue,
  initialWorkspaceState,
  lotTerm,
  ownerLabel,
  parseCalendarDay,
  parseRunParam,
  positionStatusTone,
  rolloverNoteFor,
  routingNotes,
  runHref,
  runLabel,
  runSwitcherMode,
  scheduleLabel,
  showRunCountBadge,
  showRunSwitcher,
  statusCounts,
  workspaceReducer,
  type WorkspaceState,
} from "@/components/asset-mapping/workspace/workspace-model";

function run(id: string, clientName: string, processedAt: string, extra: Partial<AssetMapRunSummary> = {}): AssetMapRunSummary {
  return { id, clientName, runNumber: null, processedAt, supersededBy: null, totalAccounts: 1, totalPositions: 2, status: "neutral", ...extra };
}

function position(id: string, extra: Partial<AssetMapPositionView> = {}): AssetMapPositionView {
  return {
    id, symbol: "SYNA", description: "Synthetic Fund A", assetType: "ETF", quantity: 10, marketValue: 100,
    transferEligible: "ACAT", effectiveStatus: null, transferNotes: null, effectiveNotes: null,
    costBasis: 50, costBasisGranularity: "position", transferring: null, lots: [], ...extra,
  };
}

function account(id: string, extra: Partial<AssetMapAccountView> = {}): AssetMapAccountView {
  return {
    id, custodian: "Synthetic Custodian", accountType: "Individual", accountTypeOther: null,
    accountNumberMasked: "••••1234", accountHolder: "Synthetic Client A", statementDate: "2026-09-01",
    statementAgeDays: 5, isStale: false, totalValue: 100, isRollover: false, isInherited: false,
    inheritedNotes: null, apexRestriction: null, costBasisStatus: "COMPLETE", validationStatus: "VALID",
    validationIssues: [], custodianIntel: null, positions: [position(`${id}-p1`)], ...extra,
  };
}

function household(accounts: AssetMapAccountView[]): AssetMapHouseholdView {
  return { id: "hh-1", clientName: "Synthetic Client A", processedAt: "2026-09-02T00:00:00.000Z", docsTotal: null, docsExtracted: null, accounts };
}

const RUNS = [
  run("a-old", "Synthetic Client A", "2026-08-01T00:00:00.000Z", { supersededBy: "a-new" }),
  run("a-new", "Synthetic Client A", "2026-09-01T00:00:00.000Z"),
  run("b-only", "Synthetic Client B", "2026-09-05T00:00:00.000Z"),
];

function loaded(initialRunId: string | null = null): WorkspaceState {
  return workspaceReducer(initialWorkspaceState(initialRunId), { type: "listLoaded", runs: RUNS });
}

describe("asset-mapping workspace model", () => {
  it("groups runs by client and includes superseded runs", () => {
    const groups = groupRunsByClient(RUNS);
    expect(Object.keys(groups)).toEqual(["Synthetic Client A", "Synthetic Client B"]);
    expect(groups["Synthetic Client A"].map((r) => r.id)).toContain("a-old");
    expect(groups["Synthetic Client A"]).toHaveLength(2);
  });

  it("sorts each client's runs newest processedAt first", () => {
    expect(groupRunsByClient(RUNS)["Synthetic Client A"].map((r) => r.id)).toEqual(["a-new", "a-old"]);
  });

  it("runLabel returns Latest for index 0 and Run N counting down", () => {
    expect(runLabel(0, 3)).toBe("Latest");
    expect(runLabel(1, 3)).toBe("Run 2");
    expect(runLabel(2, 3)).toBe("Run 1");
  });

  it("shows the run switcher and run count badge only for more than one run", () => {
    const groups = groupRunsByClient(RUNS);
    expect(showRunSwitcher(groups["Synthetic Client A"])).toBe(true);
    expect(showRunCountBadge(groups["Synthetic Client A"])).toBe(true);
    expect(showRunSwitcher(groups["Synthetic Client B"])).toBe(false);
    expect(showRunCountBadge(groups["Synthetic Client B"])).toBe(false);
  });

  it("filters client names case-insensitively by substring", () => {
    expect(filterClientNames(["Synthetic Client A", "Synthetic Client B"], "client b")).toEqual(["Synthetic Client B"]);
    expect(filterClientNames(["Synthetic Client A", "Synthetic Client B"], "  ")).toHaveLength(2);
  });

  it("returns no client names when the search matches nobody", () => {
    expect(filterClientNames(["Synthetic Client A"], "zzz")).toEqual([]);
  });

  it("empty loaded list title is No asset mapping results", () => {
    expect(emptyStateTitle(0)).toBe("No asset mapping results");
  });

  it("non-empty loaded list title is Select a household even when search filters everyone out", () => {
    const state = workspaceReducer(loaded(), { type: "setSearch", query: "zzz" });
    expect(filterClientNames(Object.keys(state.groups), state.search)).toEqual([]);
    expect(emptyStateTitle(state.runs.length)).toBe("Select a household");
  });

  it("counts the five position statuses using effectiveStatus before transferEligible", () => {
    const counts = statusCounts(household([account("a1", { positions: [
      position("p1", { transferEligible: "ACAT", effectiveStatus: "REVIEW" }),
      position("p2", { transferEligible: "ACAT" }),
      position("p3", { transferEligible: "LIQUIDATE" }),
      position("p4", { transferEligible: "UNSUPPORTED" }),
      position("p5", { transferEligible: "ACH/WIRE" }),
    ] })]));
    expect(counts).toEqual({ total: 5, acat: 1, review: 1, unsupported: 1, liquidate: 1, transfer: 1 });
  });

  it("groups an account with an apex restriction as unsupported even with no UNSUPPORTED position", () => {
    const s = clientServiceSummary(household([account("a1", { apexRestriction: "Synthetic restriction" })]));
    expect(s.unsupported.map((i) => i.account.id)).toEqual(["a1"]);
    expect(s.ready).toEqual([]);
  });

  it("does not group an account as unsupported only because a position is UNSUPPORTED", () => {
    const s = clientServiceSummary(household([account("a1", { positions: [position("p1", { transferEligible: "UNSUPPORTED" })] })]));
    expect(s.unsupported).toEqual([]);
    expect(s.action.map((i) => i.account.id)).toEqual(["a1"]);
  });

  it("groups rollover, validation warning, ready, and action accounts in that precedence", () => {
    const s = clientServiceSummary(household([
      account("roll", { isRollover: true, validationStatus: "WARNING" }),
      account("warn", { validationStatus: "WARNING" }),
      account("ready"),
      account("act", { positions: [position("x", { transferEligible: "REVIEW" })] }),
    ]));
    expect(s.rollover.map((i) => i.account.id)).toEqual(["roll"]);
    expect(s.action.map((i) => i.account.id)).toEqual(["warn", "act"]);
    expect(s.ready.map((i) => i.account.id)).toEqual(["ready"]);
  });

  it("computes percentReady and transferReadyValue excluding rollover and warning accounts", () => {
    const s = clientServiceSummary(household([
      account("ready", { totalValue: 100, positions: [position("r1", { marketValue: 100 })] }),
      account("roll", { totalValue: 100, isRollover: true, positions: [position("o1", { marketValue: 100 })] }),
      account("warn", { totalValue: 200, validationStatus: "WARNING", positions: [position("w1", { marketValue: 200 })] }),
    ]));
    expect(s.transferReadyValue).toBe(100);
    expect(s.percentReady).toBe(25);
  });

  it("raises the extraction quality notice only for a WARNING account", () => {
    expect(clientServiceSummary(household([account("a1")])).hasExtractionQualityNotice).toBe(false);
    expect(clientServiceSummary(household([account("a1", { validationStatus: "ERROR" })])).hasExtractionQualityNotice).toBe(false);
    expect(clientServiceSummary(household([account("a1", { validationStatus: "WARNING" })])).hasExtractionQualityNotice).toBe(true);
  });

  it("sums household total value from account totals treating null as zero", () => {
    expect(householdTotalValue(household([account("a1", { totalValue: 120.5 }), account("a2", { totalValue: null })]))).toBe(120.5);
  });

  it("hasTaxLots is true only when lots are present", () => {
    expect(hasTaxLots(position("p1"))).toBe(false);
    expect(hasTaxLots(position("p2", { lots: [{ acquisitionDate: "2020-01-01", quantity: 1, costBasis: 5 }] }))).toBe(true);
  });

  it("runHref and parseRunParam round-trip a run id", () => {
    const href = runHref("run id/1");
    expect(href.startsWith("/asset-mapping?run=")).toBe(true);
    expect(parseRunParam(href.slice(href.indexOf("?")))).toBe("run id/1");
    expect(parseRunParam("")).toBeNull();
    expect(parseRunParam("?run=")).toBeNull();
  });

  it("retry clears error, open household, live extras, and selection and reloads the list", () => {
    let state = workspaceReducer(loaded(), { type: "selectClient", name: "Synthetic Client A" });
    state = workspaceReducer(state, { type: "householdLoaded", household: household([account("a1")]) });
    state = workspaceReducer(state, { type: "liveExtrasLoaded", extras: { docResults: [], rolloverNotes: {} } });
    state = workspaceReducer(state, { type: "householdFailed" });
    const next = workspaceReducer(state, { type: "retry" });
    expect(next.listStatus).toBe("loading");
    expect(next.householdStatus).toBe("idle");
    expect(next.household).toBeNull();
    expect(next.liveExtras).toBeNull();
    expect(next.selectedClient).toBeNull();
    expect(next.selectedId).toBeNull();
  });

  it("listReload keeps the selected run and reloads the list", () => {
    let state = workspaceReducer(loaded(), { type: "selectClient", name: "Synthetic Client A" });
    state = workspaceReducer(state, { type: "householdLoaded", household: household([account("a1")]) });
    const reloading = workspaceReducer(state, { type: "listReload" });
    expect(reloading.listStatus).toBe("loading");
    expect(reloading.pendingRunId).toBe("a-new");
    const next = workspaceReducer(reloading, { type: "listLoaded", runs: [...RUNS, run("c-new", "Synthetic Client C", "2026-10-04T00:00:00.000Z")] });
    expect(next.listStatus).toBe("loaded");
    expect(next.selectedId).toBe("a-new");
    expect(next.selectedClient).toBe("Synthetic Client A");
    expect(next.household?.id).toBe("hh-1");
    expect(Object.keys(next.groups)).toContain("Synthetic Client C");
  });

  it("list or household failure moves to the error state", () => {
    expect(workspaceReducer(initialWorkspaceState(null), { type: "listFailed" }).listStatus).toBe("failed");
    expect(workspaceReducer(loaded(), { type: "householdFailed" }).householdStatus).toBe("failed");
  });

  it("toggleRail keeps the selected household when expanding and collapsing", () => {
    const selected = workspaceReducer(loaded(), { type: "selectClient", name: "Synthetic Client B" });
    expect(selected.railOpen).toBe(false);
    const expanded = workspaceReducer(selected, { type: "toggleRail" });
    expect(expanded.railOpen).toBe(true);
    expect(expanded.selectedId).toBe("b-only");
    const collapsed = workspaceReducer(expanded, { type: "toggleRail" });
    expect(collapsed.railOpen).toBe(false);
    expect(collapsed.selectedId).toBe("b-only");
  });

  it("the household rail collapses whenever a household is selected and a list reload does not re-collapse it", () => {
    expect(loaded().railOpen).toBe(true);
    expect(workspaceReducer(loaded(), { type: "selectClient", name: "Synthetic Client A" }).railOpen).toBe(false);
    expect(workspaceReducer(loaded(), { type: "selectClient", name: "Synthetic Client Missing" }).railOpen).toBe(true);
    expect(loaded("b-only").railOpen).toBe(false);
    expect(loaded("missing-run").railOpen).toBe(true);
    expect(workspaceReducer(loaded(), { type: "popState", runId: "a-old" }).railOpen).toBe(false);
    let reopened = workspaceReducer(workspaceReducer(loaded(), { type: "selectClient", name: "Synthetic Client A" }), { type: "toggleRail" });
    reopened = workspaceReducer(workspaceReducer(reopened, { type: "listReload" }), { type: "listLoaded", runs: RUNS });
    expect(reopened.selectedId).toBe("a-new");
    expect(reopened.railOpen).toBe(true);
  });

  it("every scanned account starts expanded", () => {
    expect(initialWorkspaceState(null).collapsedAccounts).toEqual([]);
    expect(loaded().collapsedAccounts).toEqual([]);
  });

  it("status tone helpers map every routing and document status to its tone", () => {
    expect(["ACAT", "REVIEW", "LIQUIDATE", "UNSUPPORTED", "ACH/WIRE", "ACH", "WIRE", "OTHER", null].map(positionStatusTone))
      .toEqual(["ok", "caution", "attention", "blocked", "info", "info", "info", "neutral", "neutral"]);
    expect(["extracted", "stale", "rejected", "pending", null].map(docStatusTone)).toEqual(["ok", "caution", "danger", "neutral", "neutral"]);
    expect(Object.keys(HOUSEHOLD_STATUS_LABEL).sort()).toEqual(["attention", "blocked", "caution", "neutral", "ok"]);
  });

  it("runSwitcherMode hides one run, segments up to the limit, and selects above it", () => {
    const runs = (n: number) => Array.from({ length: n }, (_, i) => run(`r${i}`, "Synthetic Client A", "2026-09-01T00:00:00.000Z"));
    expect(RUN_SEGMENT_LIMIT).toBe(4);
    expect([1, 2, 4, 5, 9].map((n) => runSwitcherMode(runs(n)))).toEqual(["hidden", "segmented", "segmented", "select", "select"]);
  });

  it("setView switches operations to client-service and back for the same household", () => {
    const selected = workspaceReducer(loaded(), { type: "selectClient", name: "Synthetic Client B" });
    expect(selected.view).toBe("operations");
    const cs = workspaceReducer(selected, { type: "setView", view: "client-service" });
    expect(cs.view).toBe("client-service");
    expect(cs.selectedId).toBe("b-only");
    const ops = workspaceReducer(cs, { type: "setView", view: "operations" });
    expect(ops.view).toBe("operations");
    expect(ops.selectedId).toBe("b-only");
  });

  it("popState selects a known run and clears selection when the run param is gone", () => {
    const known = workspaceReducer(loaded(), { type: "popState", runId: "a-old" });
    expect(known.selectedClient).toBe("Synthetic Client A");
    expect(known.selectedId).toBe("a-old");
    const cleared = workspaceReducer(known, { type: "popState", runId: null });
    expect(cleared.selectedClient).toBeNull();
    expect(cleared.selectedId).toBeNull();
    expect(cleared.household).toBeNull();
  });

  it("toggleAccount collapses an expanded account and expands it again", () => {
    const collapsed = workspaceReducer(loaded(), { type: "toggleAccount", id: "a1" });
    expect(collapsed.collapsedAccounts).toEqual(["a1"]);
    expect(workspaceReducer(collapsed, { type: "toggleAccount", id: "a1" }).collapsedAccounts).toEqual([]);
  });

  it("toggleLots expands a position's lots and collapses them again", () => {
    const expanded = workspaceReducer(loaded(), { type: "toggleLots", id: "p1" });
    expect(expanded.expandedLots).toEqual(["p1"]);
    expect(workspaceReducer(expanded, { type: "toggleLots", id: "p1" }).expandedLots).toEqual([]);
  });

  it("listLoaded opens the run named in the shared link", () => {
    const state = loaded("a-old");
    expect(state.selectedClient).toBe("Synthetic Client A");
    expect(state.selectedId).toBe("a-old");
    expect(state.pendingRunId).toBeNull();
  });

  it("selectClient opens the Latest run of a client with several runs", () => {
    expect(workspaceReducer(loaded(), { type: "selectClient", name: "Synthetic Client A" }).selectedId).toBe("a-new");
  });

  it("routingNotes prefers effectiveNotes then transferNotes", () => {
    expect(routingNotes(position("p1", { effectiveNotes: "Synthetic effective", transferNotes: "Synthetic transfer" }))).toBe("Synthetic effective");
    expect(routingNotes(position("p2", { transferNotes: "Synthetic transfer" }))).toBe("Synthetic transfer");
    expect(routingNotes(position("p3"))).toBeNull();
  });

  it("scheduleLabel shows Live and the interval when the schedule is active", () => {
    expect(scheduleLabel({ active: true, scanIntervalMinutes: 15, businessDays: "Mon–Fri", businessHours: "8:00 AM – 7:00 PM ET" })).toBe("Live · every 15 min");
  });

  it("scheduleLabel shows Asleep, the business days, and the business start when inactive", () => {
    expect(scheduleLabel({ active: false, scanIntervalMinutes: 15, businessDays: "Mon–Fri", businessHours: "8:00 AM – 7:00 PM ET" })).toBe("Asleep · resumes Mon–Fri 8:00 AM");
  });

  it("documentsNotProcessed keeps only rejected and stale documents", () => {
    const doc = (filename: string, status: string) => ({ filename, status, reason: null, accountsExtracted: null, positionsExtracted: null });
    const extras: AssetMapHouseholdLiveExtras = {
      docResults: [doc("one.pdf", "extracted"), doc("two.pdf", "rejected"), doc("three.pdf", "stale"), doc("four.pdf", "pending")],
      rolloverNotes: {},
    };
    expect(documentsNotProcessed(extras).map((d) => d.filename)).toEqual(["two.pdf", "three.pdf"]);
    expect(documentsNotProcessed(null)).toEqual([]);
  });

  it("rolloverNoteFor uses the live note and falls back to the current app copy", () => {
    const extras: AssetMapHouseholdLiveExtras = { docResults: [], rolloverNotes: { a1: "Synthetic live rollover note" } };
    expect(rolloverNoteFor("a1", extras)).toBe("Synthetic live rollover note");
    expect(rolloverNoteFor("a2", extras)).toBe(COPY.rolloverFallback);
    expect(rolloverNoteFor("a1", null)).toBe(COPY.rolloverFallback);
  });
});

describe("account card details (ticket)", () => {
  it("ownerLabel shows Owner not identified for an empty holder", () => {
    expect(ownerLabel(account("a1", { accountHolder: null }))).toBe("Owner not identified");
    expect(ownerLabel(account("a1", { accountHolder: "" }))).toBe("Owner not identified");
    expect(ownerLabel(account("a1", { accountHolder: "   " }))).toBe("Owner not identified");
    expect(ownerLabel(account("a1", { accountHolder: "Synthetic Client A" }))).toBe("Synthetic Client A");
  });

  it("costBasisPillLabel and costBasisPillTone name complete and tax-advantaged accounts", () => {
    const complete = account("a1", { costBasisStatus: "COMPLETE" });
    const exempt = account("a1", { costBasisStatus: "NOT_APPLICABLE" });
    const missing = account("a1", { costBasisStatus: "MISSING" });
    expect([costBasisPillLabel(complete), costBasisPillTone(complete)]).toEqual(["Cost basis: complete", "ok"]);
    expect([costBasisPillLabel(exempt), costBasisPillTone(exempt)]).toEqual(["Cost basis: n/a · tax-advantaged", "neutral"]);
    expect([costBasisPillLabel(missing), costBasisPillTone(missing)]).toEqual(["Cost basis: missing", "caution"]);
    expect(costBasisPillLabel(account("a1", { costBasisStatus: null }))).toBeNull();
  });

  it("costBasisBanner names securities with no basis, skips cash, and caps names at 12", () => {
    const partial = account("a1", {
      costBasisStatus: "PARTIAL",
      positions: [
        position("p1"),
        position("p2", { symbol: "SYNB", costBasis: null, lots: [] }),
        position("p3", { symbol: "CASH", description: "Cash", costBasis: null }),
      ],
    });
    expect(costBasisBanner(partial)).toEqual({ names: ["SYNB"], more: 0, missing: 1, securities: 2 });
    const many = account("a1", {
      costBasisStatus: "MISSING",
      positions: Array.from({ length: 14 }, (_, i) => position(`p${i}`, { symbol: `SYN${i}`, costBasis: null })),
    });
    const banner = costBasisBanner(many);
    expect(banner?.names).toHaveLength(12);
    expect(banner?.more).toBe(2);
    expect(costBasisBanner(account("a1", { costBasisStatus: "COMPLETE" }))).toBeNull();
    expect(costBasisBanner(account("a1", { costBasisStatus: "PARTIAL" }))).toBeNull();
  });

  it("parseCalendarDay accepts only the pipeline's strict formats", () => {
    for (const value of ["2019-03-15", "3/15/2019", "03-15-2019", "March 15, 2019", "Mar 15, 2019"]) {
      expect(parseCalendarDay(value)).toEqual({ year: 2019, month: 3, day: 15 });
    }
    for (const value of ["Various", "2019-02-30", "02/30/2019", "13/01/2019", "03/15/19", "2019-03-15T00:00:00Z", "", null]) {
      expect(parseCalendarDay(value)).toBeNull();
    }
    expect(parseCalendarDay("2020-02-29")).toEqual({ year: 2020, month: 2, day: 29 });
    expect(parseCalendarDay("2019-02-29")).toBeNull();
  });

  it("lotTerm labels more than one year long term and exactly one year short term", () => {
    expect(lotTerm("2019-03-15", "2020-03-15")).toBe("short");
    expect(lotTerm("2019-03-14", "2020-03-15")).toBe("long");
    expect(lotTerm("2020-01-01", "2020-03-15")).toBe("short");
    expect(lotTerm("2020-02-29", "2021-02-28")).toBe("short");
    expect(lotTerm("2020-02-29", "2021-03-01")).toBe("long");
  });

  it("lotTerm gives no term for free text or a missing date", () => {
    expect(lotTerm("Various", "2020-03-15")).toBeNull();
    expect(lotTerm("2019-03-15", null)).toBeNull();
    expect(lotTerm(null, "2020-03-15")).toBeNull();
  });

  it("lotTerm keeps the pipeline's calendar day in a time zone west of UTC", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(new Date("2020-01-15").getDate()).toBe(14);
      expect(parseCalendarDay("2020-01-15")).toEqual({ year: 2020, month: 1, day: 15 });
      expect(lotTerm("2019-01-15", "2020-01-15")).toBe("short");
      expect(lotTerm("2019-01-14", "2020-01-15")).toBe("long");
    } finally {
      process.env.TZ = zone;
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
    }
  });

  it("householdProcessedLabel shows the date only while the run switcher is hidden", () => {
    const one = [run("r1", "Synthetic Client A", "2026-10-01T00:00:00.000Z")];
    const two = [...one, run("r2", "Synthetic Client A", "2026-09-01T00:00:00.000Z")];
    expect(householdProcessedLabel(one, "2026-10-01T00:00:00.000Z")).toBe("Processed 10/1/2026");
    expect(householdProcessedLabel(two, "2026-10-01T00:00:00.000Z")).toBeNull();
    expect(householdProcessedLabel(one, null)).toBeNull();
  });
});
