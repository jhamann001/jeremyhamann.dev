import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// household.ts (and warehouse.ts underneath) import "server-only", which throws
// outside an RSC bundle — stub it so the modules load under the vitest node env.
vi.mock("server-only", () => ({}));

import {
  classifyHouseholdActivities,
  sumMemberSeries,
  memberWeights,
  fetchHouseholdReportData,
  type HouseholdMemberActivities,
} from "@/lib/twr/household";
import { TwrDataError, type DatasetRow } from "@/lib/twr/warehouse";
import { computeTwr } from "@/lib/twr/engine";

const MEMBERS = ["NPN1891", "XCR0208"];
const AS_OF = "2026-06-30";

const row = (
  apexAcct: string,
  d: string,
  cat: string,
  amt: number,
  desc: string,
  type = "MOVEMENT",
): { apexAcct: string; r: DatasetRow } => ({
  apexAcct,
  r: {
    d,
    type,
    sub_type: cat,
    subtype_category: cat,
    net_amount: amt,
    symbol: "",
    activity_description: desc,
    state: "CURRENT",
  },
});

function toMemberActivities(
  rows: { apexAcct: string; r: DatasetRow }[],
): HouseholdMemberActivities[] {
  const by = new Map<string, DatasetRow[]>();
  for (const { apexAcct, r } of rows) {
    by.set(apexAcct, [...(by.get(apexAcct) ?? []), r]);
  }
  return [...by.entries()].map(([apexAcct, rs]) => ({ apexAcct, rows: rs }));
}

describe("classifyHouseholdActivities — household boundary rules", () => {
  it("cash flows (net_amount ≠ 0) are ALWAYS external, summed signed by date across members", () => {
    const out = classifyHouseholdActivities(
      toMemberActivities([
        row("NPN1891", "2026-02-02", "DEPOSIT", 1000, "Check Deposit"),
        row("XCR0208", "2026-02-02", "WITHDRAWAL", -250, "ACH Withdrawal"),
        row("NPN1891", "2026-03-01", "ACATS_CASH", 500, "ACATS cash"),
        // internal category — never a household flow
        row("NPN1891", "2026-02-02", "CASH_DIVIDEND", 12, "dividend", "DIVIDEND"),
      ]),
      MEMBERS,
      AS_OF,
    );
    expect(out.cfByDate.get("2026-02-02")).toBe(750); // 1000 − 250
    expect(out.cfByDate.get("2026-03-01")).toBe(500);
    expect(out.flowDates.size).toBe(0);
    expect(out.dividendTtm).toBe(12);
  });

  it("$0 journal whose counterpart IS a member account is INTERNAL (skipped — the MV sum nets it)", () => {
    const out = classifyHouseholdActivities(
      toMemberActivities([
        row("NPN1891", "2026-04-01", "DEPOSIT", 0, "Journal from XCR0208 rebalancing move"),
        row("XCR0208", "2026-04-01", "WITHDRAWAL", 0, "Journal to NPN1891 rebalancing move"),
      ]),
      MEMBERS,
      AS_OF,
    );
    expect(out.flowDates.size).toBe(0);
    expect(out.cfByDate.size).toBe(0);
  });

  it("member matching is case/whitespace-insensitive on the account number", () => {
    const out = classifyHouseholdActivities(
      toMemberActivities([
        row("NPN1891", "2026-04-01", "DEPOSIT", 0, "Journal from dzk1976 move"),
      ]),
      [" dzk1976 ", "NPN1891"],
      AS_OF,
    );
    expect(out.flowDates.size).toBe(0);
  });

  it("$0 journal from a NON-member (the real 3GT84775 transit account) is EXTERNAL in-kind → flowDate", () => {
    const out = classifyHouseholdActivities(
      toMemberActivities([
        // Real warehouse pattern: transit account receiving from Victory Funds.
        row("NPN1891", "2026-01-28", "DEPOSIT", 0, "Journal from 3GT84775 Transfer from Victory Funds"),
      ]),
      MEMBERS,
      AS_OF,
    );
    expect(out.flowDates.has("2026-01-28")).toBe(true);
    expect(out.cfByDate.size).toBe(0);
  });

  it("$0 in-kind row with an unparseable description is conservatively EXTERNAL → flowDate", () => {
    const out = classifyHouseholdActivities(
      toMemberActivities([
        // Real pattern: a merger share allocation with no journal counterpart.
        row("NPN1891", "2026-03-06", "TRANSFER", 0, "PALO ALTO NETWORKS INC COM Manual Adjustment PANW SHARES ALLOCATION THROUGH MERGER EFF 02/11/2026"),
      ]),
      MEMBERS,
      AS_OF,
    );
    expect(out.flowDates.has("2026-03-06")).toBe(true);
  });

  it("Manual Adjustment TRANSFER #<ticket> PAIRED across two members is INTERNAL (skipped)", () => {
    const out = classifyHouseholdActivities(
      toMemberActivities([
        row("NPN1891", "2026-03-25", "TRANSFER", 0, "CHUBB LTD SWITZ COM Manual Adjustment TRANSFER #2442090"),
        row("XCR0208", "2026-03-25", "TRANSFER", 0, "COCA COLA CO COM Manual Adjustment TRANSFER #2442090"),
        row("NPN1891", "2026-03-25", "TRANSFER", 0, "VISA INC COM CL A Manual Adjustment TRANSFER #2442090"),
      ]),
      MEMBERS,
      AS_OF,
    );
    expect(out.flowDates.size).toBe(0);
    expect(out.cfByDate.size).toBe(0);
  });

  it("a $0 row in a NON-in-kind external category (stray ACATS status row) is a NO-OP — not a flowDate", () => {
    const out = classifyHouseholdActivities(
      toMemberActivities([
        row("NPN1891", "2026-03-06", "ACATS_CASH", 0, "ACATS transfer status update"),
        row("XCR0208", "2026-03-06", "WITHDRAWAL", 0, "reversed withdrawal"),
        row("NPN1891", "2026-03-09", "CREDIT", 0, "zeroed credit memo"),
      ]),
      MEMBERS,
      AS_OF,
    );
    expect(out.flowDates.size).toBe(0);
    expect(out.cfByDate.size).toBe(0);
  });

  it("a $0 TRANSFER 'Journal from <non-member>' is STILL a flowDate (in-kind gate keeps TRANSFER)", () => {
    const out = classifyHouseholdActivities(
      toMemberActivities([
        row("NPN1891", "2026-03-06", "TRANSFER", 0, "Journal from 3GT84775 Transfer from Victory Funds"),
      ]),
      MEMBERS,
      AS_OF,
    );
    expect(out.flowDates.has("2026-03-06")).toBe(true);
  });

  it("a CASH Manual Adjustment (net_amount ≠ 0) is ordinary signed external cash — never ticket-diverted", () => {
    const out = classifyHouseholdActivities(
      toMemberActivities([
        // one-sided CASH manual adjustment: a real household boundary flow on
        // the day it posts, NOT a whole-day in-kind neutralization
        row("NPN1891", "2026-04-10", "TRANSFER", 500, "CASH Manual Adjustment TRANSFER #7777777"),
        // paired CASH manual adjustment: the ± pair nets to $0 in the same-day sum
        row("NPN1891", "2026-04-15", "TRANSFER", -2500, "CASH Manual Adjustment TRANSFER #8888888"),
        row("XCR0208", "2026-04-15", "TRANSFER", 2500, "CASH Manual Adjustment TRANSFER #8888888"),
      ]),
      MEMBERS,
      AS_OF,
    );
    expect(out.cfByDate.get("2026-04-10")).toBe(500);
    expect(out.cfByDate.get("2026-04-15")).toBe(0); // pair nets in the sum
    expect(out.flowDates.size).toBe(0); // no dates neutralized
  });

  it("a ONE-SIDED Manual Adjustment ticket (only one member) is conservatively EXTERNAL → flowDate", () => {
    const out = classifyHouseholdActivities(
      toMemberActivities([
        row("NPN1891", "2026-03-25", "TRANSFER", 0, "CHUBB LTD SWITZ COM Manual Adjustment TRANSFER #9999999"),
      ]),
      MEMBERS,
      AS_OF,
    );
    expect(out.flowDates.has("2026-03-25")).toBe(true);
  });

  it("distinct tickets pair independently (one paired + one one-sided on the same day)", () => {
    const out = classifyHouseholdActivities(
      toMemberActivities([
        row("NPN1891", "2026-03-25", "TRANSFER", 0, "X Manual Adjustment TRANSFER #111"),
        row("XCR0208", "2026-03-25", "TRANSFER", 0, "Y Manual Adjustment TRANSFER #111"),
        row("XCR0208", "2026-03-25", "TRANSFER", 0, "Z Manual Adjustment TRANSFER #222"),
      ]),
      MEMBERS,
      AS_OF,
    );
    // #111 internal; #222 one-sided → the date is neutralized.
    expect(out.flowDates.has("2026-03-25")).toBe(true);
  });

  it("sums dividend TTM and netted advisory fee across members with the account-path windows", () => {
    const out = classifyHouseholdActivities(
      toMemberActivities([
        row("NPN1891", "2026-05-15", "CASH_DIVIDEND", 12, "div", "DIVIDEND"),
        row("XCR0208", "2026-05-16", "CASH_DIVIDEND", 8, "div", "DIVIDEND"),
        // outside the trailing-12-month window → excluded
        row("NPN1891", "2025-05-15", "CASH_DIVIDEND", 99, "div", "DIVIDEND"),
        // fee debits net against the reimbursement credit: |−100 − 50 + 40| = 110
        row("NPN1891", "2026-05-31", "FEE", -100, "Advisory Fee AUM Fee May 2026", "FEE"),
        row("XCR0208", "2026-05-31", "FEE", -50, "Advisory Fee AUM Fee May 2026", "FEE"),
        row("NPN1891", "2026-06-02", "CREDIT", 40, "advisory fee reimbursement", "CREDIT"),
      ]),
      MEMBERS,
      AS_OF,
    );
    expect(out.dividendTtm).toBe(20);
    expect(out.advisoryFeeNet).toBe(110);
    // The reimbursement CREDIT is fee-netting, not a household cash flow twice —
    // it IS also an external CREDIT cash-wise? No: fee rows route to the fee sum
    // only when matched; the CREDIT row is amt≠0 in an external category, so it
    // also lands in the household CF (same as the account path, where CREDIT
    // rows feed cfByDate too).
    expect(out.cfByDate.get("2026-06-02")).toBe(40);
  });
});

describe("sumMemberSeries — dates union, gap fill, stale-member policy", () => {
  const pt = (date: string, mv: number) => ({ date, mv, positionsMv: mv });

  it("sums member MV by date over the union; a mid-period opener is NEVER filled before its first row", () => {
    const { series, warnings } = sumMemberSeries([
      {
        acct: "NPN1891",
        series: [pt("2026-01-02", 100000), pt("2026-01-05", 101000), pt("2026-01-06", 102000)],
      },
      {
        // opens mid-period: pre-opening dates add NOTHING (genuinely absent)
        acct: "XCR0208",
        series: [pt("2026-01-05", 50000), pt("2026-01-06", 50500)],
      },
    ]);
    expect(series).toEqual([
      { date: "2026-01-02", mv: 100000 }, // opening unchanged — no back-fill
      { date: "2026-01-05", mv: 151000 },
      { date: "2026-01-06", mv: 152500 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("INTERIOR gap: carries the member's last MV forward — series and TWR identical to the no-gap equivalent (no spurious daily return)", () => {
    const A = [
      pt("2026-01-02", 100000),
      pt("2026-01-05", 101000),
      pt("2026-01-06", 102000),
      pt("2026-01-07", 103000),
    ];
    // B has rows before AND after 01-05/01-06 but none ON them (feed gap).
    const gapped = sumMemberSeries([
      { acct: "NPN1891", series: A },
      { acct: "XCR0208", series: [pt("2026-01-02", 50000), pt("2026-01-07", 50600)] },
    ]);
    // The no-gap equivalent: B explicitly flat at its last observed MV.
    const flat = sumMemberSeries([
      { acct: "NPN1891", series: A },
      {
        acct: "XCR0208",
        series: [
          pt("2026-01-02", 50000),
          pt("2026-01-05", 50000),
          pt("2026-01-06", 50000),
          pt("2026-01-07", 50600),
        ],
      },
    ]);
    expect(gapped.series).toEqual(flat.series);
    expect(gapped.warnings).toEqual([]);

    const engineInput = (s: { date: string; mv: number }[]) => ({
      daily: s.map((p) => ({ ...p, externalCf: 0 })),
      asOf: "2026-01-07",
      costBasis: 0,
      costBasisAsOf: "2026-01-07",
      positionsMv: 0,
      dividendTtm: 0,
      advisoryFeeNet: 0,
      realizedSt: null,
      realizedLt: null,
    });
    const twrGapped = computeTwr(engineInput(gapped.series));
    const twrFlat = computeTwr(engineInput(flat.series));
    expect(twrGapped.twrSinceInception).toBe(twrFlat.twrSinceInception);
    expect(twrGapped.risk.vol).toBe(twrFlat.risk.vol);
    expect(twrGapped.risk.maxDrawdown).toBe(twrFlat.risk.maxDrawdown);
    // risk-stats v2 (docs/blueprints/twr-risk-stats-v2.md §6.2-3): with only 3
    // counted returns both sides' vol is null under the min-observation floor,
    // so the vol equality above passes vacuously — pin the null explicitly and
    // keep the gap-invariance signal on a descriptive stat that still computes.
    expect(twrGapped.risk.vol).toBeNull();
    expect(twrGapped.risk.bestDay).toBe(twrFlat.risk.bestDay);
  });

  it("TRAILING lag ≤ 5 days with a funded last MV: carries forward to the union end + a stale_member warning", () => {
    const { series, warnings } = sumMemberSeries([
      {
        acct: "NPN1891",
        series: [pt("2026-01-05", 100000), pt("2026-01-08", 101000), pt("2026-01-09", 102000)],
      },
      { acct: "XCR0208", series: [pt("2026-01-05", 50000), pt("2026-01-07", 50500)] },
    ]);
    expect(series).toEqual([
      { date: "2026-01-05", mv: 150000 },
      { date: "2026-01-07", mv: 150500 }, // A's 100000 carried over its own interior gap
      { date: "2026-01-08", mv: 151500 }, // B's 50500 carried — no fake terminal loss
      { date: "2026-01-09", mv: 152500 },
    ]);
    expect(warnings).toEqual([
      { type: "stale_member", acct: "XCR0208", lastDate: "2026-01-07", lagDays: 2 },
    ]);
  });

  it("TRAILING lag > 5 days with a funded last MV: throws TwrDataError (honest unavailable beats a wrong number)", () => {
    expect(() =>
      sumMemberSeries([
        {
          acct: "NPN1891",
          series: [pt("2026-01-02", 100000), pt("2026-01-09", 101000)],
        },
        { acct: "XCR0208", series: [pt("2026-01-02", 50000)] }, // 7 days stale
      ]),
    ).toThrowError(TwrDataError);
    try {
      sumMemberSeries([
        { acct: "NPN1891", series: [pt("2026-01-02", 100000), pt("2026-01-09", 101000)] },
        { acct: "XCR0208", series: [pt("2026-01-02", 50000)] },
      ]);
    } catch (e) {
      expect((e as TwrDataError).reason).toBe("warehouse_error");
    }
  });

  it("TRAILING lag on a closed/dust member (last MV ≤ $1k): carried forward silently, any lag, no warning", () => {
    const { series, warnings } = sumMemberSeries([
      {
        acct: "NPN1891",
        series: [pt("2026-01-02", 100000), pt("2026-01-30", 101000)],
      },
      { acct: "XCR0208", series: [pt("2026-01-02", 0)] }, // closed 28 days ago
    ]);
    expect(series).toEqual([
      { date: "2026-01-02", mv: 100000 },
      { date: "2026-01-30", mv: 101000 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("duplicate (member, date) rows dedupe LAST-wins — never double-counted", () => {
    const { series, warnings } = sumMemberSeries([
      {
        acct: "NPN1891",
        series: [
          { date: "2026-01-02", mv: 100000, positionsMv: 99000 },
          { date: "2026-01-02", mv: 100500, positionsMv: 99500 }, // duplicated card row
          { date: "2026-01-05", mv: 101000, positionsMv: 100000 },
        ],
      },
    ]);
    expect(series).toEqual([
      { date: "2026-01-02", mv: 100500 }, // last wins — NOT 200500
      { date: "2026-01-05", mv: 101000 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("returns an empty series for no members", () => {
    expect(sumMemberSeries([])).toEqual({ series: [], warnings: [] });
  });
});

describe("memberWeights", () => {
  it("weights sum to 100 over a non-zero household", () => {
    const w = memberWeights([750, 250]);
    expect(w[0]).toBeCloseTo(75);
    expect(w[1]).toBeCloseTo(25);
    expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(100);
  });

  it("all-zero ending values yield all-zero weights (never NaN)", () => {
    expect(memberWeights([0, 0])).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Multi-account card fan-out (mock fetch): per-member parameter binding.
// ---------------------------------------------------------------------------

type FetchCall = { url: string; body: { parameters: { target: unknown[]; value: string }[] } };

const RESOLVER: Record<string, DatasetRow> = {
  NPN1891: {
    account_id: "01SYNTH14F7HAYDP2AD4SNVNAX",
    apex_acct: "NPN1891",
    account_type: "BROKERAGE",
    account_nickname: "Individual Brokerage",
    client_name: "Pat Example",
  },
  XCR0208: {
    account_id: "01SYNTHPK50T47E6KZ9NPQ66XH",
    apex_acct: "XCR0208",
    account_type: "ROTH_IRA",
    account_nickname: "",
    client_name: "Pat Example",
  },
};

const BAL: Record<string, DatasetRow[]> = {
  "01SYNTH14F7HAYDP2AD4SNVNAX": [
    { d: "2026-06-26", total_equity: 100000, position_market_value: 99000, cash: 1000 },
    { d: "2026-06-29", total_equity: 101000, position_market_value: 100000, cash: 1000 },
    { d: "2026-06-30", total_equity: 102000, position_market_value: 101000, cash: 1000 },
  ],
  "01SYNTHPK50T47E6KZ9NPQ66XH": [
    { d: "2026-06-26", total_equity: 50000, position_market_value: 49000, cash: 1000 },
    { d: "2026-06-29", total_equity: 50500, position_market_value: 49500, cash: 1000 },
    { d: "2026-06-30", total_equity: 51000, position_market_value: 50000, cash: 1000 },
  ],
};

describe("fetchHouseholdReportData — multi-account card fan-out (mock fetch)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.WAREHOUSE_URL = "https://warehouse.example";
    process.env.WAREHOUSE_API_KEY = "secret-key";
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string) as FetchCall["body"];
      const value = body.parameters[0].value;
      const ok = (rows: unknown[]) =>
        ({ ok: true, status: 200, json: async () => rows }) as unknown as Response;
      if (url.includes("/api/card/6472/query/json")) {
        return ok(RESOLVER[value] ? [RESOLVER[value]] : []);
      }
      if (url.includes("/api/card/6469/query/json")) return ok(BAL[value] ?? []);
      if (url.includes("/api/card/6470/query/json")) return ok([]);
      if (url.includes("/api/card/6471/query/json"))
        return ok([{
          snapshot_date: "2026-06-26",
          symbol: "TEST",
          cusip: null,
          quantity: 1,
          cost_basis: value === "01SYNTH14F7HAYDP2AD4SNVNAX" ? 3000 : 1500,
          term: null,
        }]);
      if (url.includes("/api/card/6502/query/json"))
        return ok([
          {
            disposal_date: "2026-03-15",
            term: "SHORT_TERM",
            symbol: "TEST",
            gain_loss: value === "01SYNTH14F7HAYDP2AD4SNVNAX" ? 40 : 10,
            wash_sale_adjustment: 0,
            disallowed_loss: 0,
          },
        ]);
      throw new Error(`unexpected url ${url}`);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const members = [{ apexAccountNumber: "NPN1891" }, { apexAccountNumber: "XCR0208" }];

  it("binds EACH member's ULID to each data card and assembles the summed household input", async () => {
    const data = await fetchHouseholdReportData("001QQ3080882984", members);

    // Fan-out: both resolver calls (by NUMBER) and per-ULID data-card calls.
    const calls = fetchMock.mock.calls.map(([url, opts]) => ({
      url: String(url),
      body: JSON.parse((opts as RequestInit).body as string),
    })) as FetchCall[];
    const balCalls = calls.filter((c) => c.url.includes("/api/card/6469/"));
    expect(balCalls.map((c) => c.body.parameters[0].value).sort()).toEqual([
      "01SYNTH14F7HAYDP2AD4SNVNAX",
      "01SYNTHPK50T47E6KZ9NPQ66XH",
    ]);
    for (const c of balCalls) {
      expect(c.body.parameters[0].target).toEqual([
        "variable",
        ["template-tag", "account_id"],
      ]);
      expect(c.body.parameters).toHaveLength(1); // through-latest → no as_of
    }
    // Every data card fanned out per member (4 cards × 2 members + 2 resolver).
    expect(calls).toHaveLength(10);

    // Household series = member sums; analytics = member sums.
    expect(data.input.asOf).toBe("2026-06-30");
    expect(data.input.daily).toEqual([
      { date: "2026-06-26", mv: 150000, externalCf: 0 },
      { date: "2026-06-29", mv: 151500, externalCf: 0 },
      { date: "2026-06-30", mv: 153000, externalCf: 0 },
    ]);
    expect(data.input.costBasis).toBe(4500);
    expect(data.input.positionsMv).toBe(151000);
    expect(data.input.realizedSt).toBe(50); // 40 + 10 through the shared fold
    expect(data.input.realizedLt).toBe(0);

    // Breakdown: labels (nickname / humanized type), weights, per-member TWR.
    expect(data.memberCount).toBe(2);
    expect(data.members[0]).toMatchObject({
      apexAcct: "NPN1891",
      label: "Individual Brokerage",
      endingValue: 102000,
    });
    expect(data.members[1]).toMatchObject({ apexAcct: "XCR0208", label: "Roth IRA" });
    expect(data.members.reduce((s, m) => s + m.weightPct, 0)).toBeCloseTo(100);
    // A: 102000/100000 − 1 = 2%; B: 51000/50000 − 1 = 2%.
    expect(data.members[0].sinceInceptionTwr).toBeCloseTo(2, 6);
    expect(data.members[1].sinceInceptionTwr).toBeCloseTo(2, 6);

    // Both members share every balance date → no stale-member warnings.
    expect(data.warnings).toEqual([]);
  });

  it("skips a resolver-miss member but keeps the rest (and still reports)", async () => {
    const data = await fetchHouseholdReportData("001QQ3080882984", [
      ...members,
      { apexAccountNumber: "VRCD789" },
    ]);
    expect(data.memberCount).toBe(2);
  });

  it("throws no_data when NO member resolves", async () => {
    await expect(
      fetchHouseholdReportData("001QQ3080882984", [{ apexAccountNumber: "VRCD789" }]),
    ).rejects.toMatchObject({ reason: "no_data" });
  });

  it("throws no_data for an empty member list without touching Warehouse", async () => {
    await expect(fetchHouseholdReportData("001QQ3080882984", [])).rejects.toBeInstanceOf(
      TwrDataError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades realized to null when ANY member's card-6502 pull fails", async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string) as FetchCall["body"];
      if (
        url.includes("/api/card/6502/query/json") &&
        body.parameters[0].value === "01SYNTHPK50T47E6KZ9NPQ66XH"
      ) {
        return { ok: false, status: 502, json: async () => ({}) } as unknown as Response;
      }
      return base(url, opts);
    });
    const data = await fetchHouseholdReportData("001QQ3080882984", members);
    expect(data.input.realizedSt).toBeNull();
    expect(data.input.realizedLt).toBeNull();
  });

  it("excludes stale open-lot basis from a closed companion after an internal journal", async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string) as FetchCall["body"];
      const value = body.parameters[0].value;
      if (
        url.includes("/api/card/6469/query/json") &&
        value === "01SYNTHPK50T47E6KZ9NPQ66XH"
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { d: "2026-06-26", total_equity: 50000, position_market_value: 49000, cash: 1000 },
            { d: "2026-06-29", total_equity: 50500, position_market_value: 49500, cash: 1000 },
            { d: "2026-06-30", total_equity: 412, position_market_value: 0, cash: 412 },
          ],
        } as unknown as Response;
      }
      if (
        url.includes("/api/card/6470/query/json") &&
        value === "01SYNTHPK50T47E6KZ9NPQ66XH"
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              d: "2026-06-30",
              type: "JOURNAL",
              sub_type: null,
              subtype_category: "TRANSFER",
              net_amount: 0,
              symbol: null,
              activity_description: "Journal to NPN1891",
              state: null,
            },
          ],
        } as unknown as Response;
      }
      return base(url, opts);
    });

    const data = await fetchHouseholdReportData("001QQ3080882984", members);
    // AAA's $3,000 remains. BBB's stale $1,500 lot snapshot is excluded because
    // its funded series now ends at a $412 closing stub.
    expect(data.input.costBasis).toBe(3000);
    expect(data.input.positionsMv).toBe(101000);
    expect(data.members.find((m) => m.apexAcct === "NPN1891")?.costBasisExcluded).toBe(
      false,
    );
    expect(data.members.find((m) => m.apexAcct === "XCR0208")).toMatchObject({
      endingValue: 412,
      costBasisExcluded: true,
    });
  });
});
