import "server-only";
import {
  computeTwr,
  hasClosingInKindTransfer,
  type TwrEngineInput,
} from "./engine";
import {
  fetchAccountCards,
  resolveAccount,
  buildBalanceSeries,
  detectTransientCashDuplicationFixes,
  applyBalanceFixes,
  classifyAccountActivities,
  sumCostBasis,
  realizedFromRows,
  isExternalCategory,
  isInKindCategory,
  day,
  num,
  str,
  yearAgo,
  isAdvisoryFeeRow,
  TwrDataError,
  type BalancePoint,
  type DatasetRow,
  type TwrIdentity,
} from "./warehouse";

// HOUSEHOLD-level TWR report data assembly. The methodology is
// AGGREGATE-THEN-CHAIN (settled with the owner — NOT an average of account TWRs):
//
//   r_t = (ΣMV_t − ΣCF_t − ΣMV_{t−1}) / ΣMV_{t−1}, geometrically linked
//
// i.e. the household is treated as ONE portfolio. Each day is automatically
// asset-weighted, and INTRA-household transfers need no flow adjustment at all
// — the MV sum is unchanged by money moving between member accounts. Only
// flows crossing the HOUSEHOLD boundary are external. The account-level engine
// (computeTwr) is reused UNCHANGED — this module only assembles a different
// input series (summed balances + boundary-classified flows).

/** One member account of the household (from the RLS-scoped
 *  mirror.client_account_aum seam — see lib/data/account-aum.ts). */
export type HouseholdMemberAccount = { apexAccountNumber: string };

/** Per-account row for the report's "Accounts" breakdown table. */
export type HouseholdMemberBreakdown = {
  apexAcct: string;
  /** Friendly label: account nickname, falling back to humanized type. */
  label: string;
  endingValue: number;
  /** Share of the household's ending value, in percent (0 when the household
   *  ending value is 0). */
  weightPct: number;
  /** The member's OWN account-level since-inception TWR (percent), computed
   *  with its own external flows/flowDates exactly as the account report does.
   *  null when the account has no funded return history (never-funded / too
  *  small to clear the engine's $1k denominator guard). */
  sinceInceptionTwr: number | null;
  /** True when a dated closing in-kind journal caused this member's stale
   *  open-lot basis to be excluded from household analytics. Stored in the
   *  immutable report snapshot; not rendered in the client account table. */
  costBasisExcluded: boolean;
};

/** Data-quality warning from the household series summation: a member's
 *  balance feed stopped a few days short of the household's latest date and
 *  its last MV was carried forward. Surfaced to the PAGE for a counts-only
 *  log marker — never rendered in the client-facing report body. */
export type HouseholdSeriesWarning = {
  type: "stale_member";
  acct: string;
  lastDate: string; // the member's last observed balance date
  lagDays: number; // calendar days behind the household's latest date
};

export type HouseholdReportData = {
  householdSfId: string;
  /** Members that actually contributed data (resolved + non-empty balances). */
  memberCount: number;
  /** Breakdown rows, largest ending value first. Weights sum to 100 (when the
   *  household ending value is non-zero). */
  members: HouseholdMemberBreakdown[];
  input: TwrEngineInput;
  /** Data-quality warnings from series summation (stale-member carry-forwards).
   *  The page logs counts only; the report body never shows them. */
  warnings: HouseholdSeriesWarning[];
};

// ---------------------------------------------------------------------------
// Boundary classification (household edition). Validated against real
// warehouse data (Friesen household — see a real-data fixture that is not published).
// ---------------------------------------------------------------------------

// "Journal from <ACCT> …" / "Journal to <ACCT> …" — the counterpart custodian
// account number of a $0 in-kind journal. Real examples:
//   "Journal from 3GT84775 Transfer from Victory Funds"  (transit acct — NOT a member)
//   "Journal to 9265A1A …"
const JOURNAL_COUNTERPART_RE = /\bJournal\s+(?:from|to)\s+([A-Za-z0-9]+)/i;

// "… Manual Adjustment TRANSFER #<ticket>" — back-office transfers that appear
// as PAIRS of $0 rows across two member accounts carrying the SAME ticket.
const MANUAL_ADJUSTMENT_TICKET_RE = /Manual Adjustment TRANSFER #(\d+)/i;

export type HouseholdMemberActivities = {
  apexAcct: string;
  rows: DatasetRow[]; // that member's card-6470 rows (state CURRENT)
};

export type HouseholdFlowClassification = {
  /** Signed external cash flow per date, summed across members. */
  cfByDate: Map<string, number>;
  /** Dates whose whole household equity step is an external in-kind flow. */
  flowDates: Set<string>;
  dividendTtm: number;
  advisoryFeeNet: number;
};

/**
 * Classify every member's activities against the HOUSEHOLD boundary. PURE.
 *
 * Rules (each validated against real warehouse rows):
 *  1. $0 "Manual Adjustment TRANSFER #<ticket>" rows are collected by ticket
 *     first. A ticket seen in TWO OR MORE member accounts is an
 *     intra-household transfer → skipped entirely (the MV sum nets it). A
 *     ticket seen in only ONE member account is conservatively treated as
 *     external: its dates become flowDates (the engine values the whole day's
 *     equity step as flow). CASH Manual-Adjustments (net_amount ≠ 0) are NOT
 *     diverted here — they flow through Rule 2 as ordinary signed cash, which
 *     is correct on whatever days they post (an intra-household cash pair
 *     nets to $0 in the same-day sum).
 *  2. Cash flows (net_amount ≠ 0 in an external category — DEPOSIT /
 *     WITHDRAWAL / CREDIT / ACATS / …) are ALWAYS external at the household
 *     level too: money enters or leaves the household → summed signed into the
 *     household CF by date. (An intra-household CASH journal would appear as a
 *     ± pair that nets to $0 in the same-day sum — still correct.)
 *  3. $0-value journals in an IN-KIND-capable category only
 *     (DEPOSIT/TRANSFER/ACCOUNT_TRANSFER — isInKindCategory, same gate as the
 *     account path): parse the counterpart account from "Journal from/to
 *     <ACCT>". Counterpart IS a member → INTERNAL, skip (the MV sum nets it).
 *     Counterpart NOT a member (e.g. transit account 3GT84775 receiving from
 *     BNY / Victory Funds) or unparseable → EXTERNAL in-kind → the date joins
 *     flowDates. A $0 row in any OTHER external category (a stray WITHDRAWAL/
 *     CREDIT/ACATS status row) is a no-op — it must NOT neutralize the whole
 *     household day.
 *  4. Dividend TTM and the netted advisory fee are summed across members with
 *     the same window/predicates the account path uses.
 */
export function classifyHouseholdActivities(
  memberActivities: HouseholdMemberActivities[],
  memberAccountNumbers: Iterable<string>,
  asOf: string,
): HouseholdFlowClassification {
  const memberSet = new Set(
    [...memberAccountNumbers].map((a) => a.trim().toUpperCase()),
  );
  const cutoff = yearAgo(asOf); // trailing-12-month boundary (exclusive)

  const cfByDate = new Map<string, number>();
  const flowDates = new Set<string>();
  let dividendTtm = 0;
  let advisoryFeeSum = 0;

  // Pass 1 defers Manual-Adjustment ticket rows so pairing can be decided
  // across ALL members; everything else classifies row-by-row.
  const tickets = new Map<string, { accts: Set<string>; dates: Set<string> }>();

  for (const member of memberActivities) {
    for (const r of member.rows) {
      const d = day(r.d);
      const cat = str(r.subtype_category);
      const type = str(r.type);
      const desc = str(r.activity_description);
      const amt = num(r.net_amount);

      // Dividend / advisory-fee sums are independent of boundary
      // classification (they are internal activity in the return either way).
      const inTtm = d > cutoff && d <= asOf;
      if (inTtm && cat === "CASH_DIVIDEND") dividendTtm += amt;
      if (inTtm && isAdvisoryFeeRow(cat, type, desc)) advisoryFeeSum += amt;

      if (!isExternalCategory(cat)) continue; // internal activity — stays in the return

      // Rule 2: any non-zero cash amount in an external category crosses the
      // household boundary (deposits, withdrawals, ACATS cash, credits, and
      // CASH Manual-Adjustments — see Rule 1's cash carve-out).
      if (amt !== 0) {
        cfByDate.set(d, (cfByDate.get(d) ?? 0) + amt);
        continue;
      }

      // Rule 1 (defer, $0 rows only): Manual-Adjustment TRANSFER tickets pair
      // across members.
      const ticket = desc.match(MANUAL_ADJUSTMENT_TICKET_RE)?.[1];
      if (ticket) {
        const t = tickets.get(ticket) ?? { accts: new Set(), dates: new Set() };
        t.accts.add(member.apexAcct.trim().toUpperCase());
        t.dates.add(d);
        tickets.set(ticket, t);
        continue;
      }

      // Rule 3 gate: only in-kind-capable categories can carry a $0 journal.
      // A stray $0 row in any other external category (WITHDRAWAL/CREDIT/
      // ACATS…) is a no-op, NOT a whole-day flow neutralization.
      if (!isInKindCategory(cat)) continue;

      // Rule 3: $0 in-kind journal — internal only when the parsed counterpart
      // is another member account; non-member or unparseable → external
      // in-kind (the day's whole equity step is valued as flow).
      const counterpart = desc.match(JOURNAL_COUNTERPART_RE)?.[1]?.toUpperCase();
      if (counterpart && memberSet.has(counterpart)) continue; // intra-household
      flowDates.add(d);
    }
  }

  // Pass 2: resolve the deferred tickets. Paired across ≥2 members → internal
  // (skip — the MV sum nets the same-day transfer). One-sided among members →
  // conservative external: neutralize those dates as in-kind flow days.
  for (const t of tickets.values()) {
    if (t.accts.size >= 2) continue;
    for (const d of t.dates) flowDates.add(d);
  }

  return { cfByDate, flowDates, dividendTtm, advisoryFeeNet: Math.abs(advisoryFeeSum) };
}

// ---------------------------------------------------------------------------
// Series summation
// ---------------------------------------------------------------------------

/** Mirrors the engine's THRESH tiny-denominator guard ($1k): a member whose
 *  LAST observed MV is at or under this is a closed/dust account (real
 *  closures emit explicit $0 rows anyway) — its trailing carry-forward is
 *  silent, never a data-quality event. */
const STALE_MV_THRESH = 1000;
/** A member lagging the household's latest date by more than this many
 *  calendar days is too stale to carry forward honestly → TwrDataError. */
const STALE_MAX_LAG_DAYS = 5;

/** Whole calendar days between two YYYY-MM-DD dates (from < to). */
const calendarDaysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );

/** One member's balance series, labeled for data-quality warnings. */
export type MemberBalanceSeries = { acct: string; series: BalancePoint[] };

/**
 * The household daily MV series: the UNION of member dates, summing
 * total_equity across members. A member contributes nothing BEFORE its first
 * row (accounts opened mid-period genuinely did not exist yet — never filled).
 * PURE — returns data-quality warnings alongside the series; never logs.
 *
 * Gap handling (a naive union-and-sum would fabricate household MV dips):
 *  • INTERIOR gap (rows before AND after a union date, none on it): carry the
 *    member's last observed MV forward — otherwise the household series shows
 *    a fake dip + rebound that poisons vol/Sharpe/maxDD and any period cell
 *    the pair straddles.
 *  • TRAILING lag (member's last row < the union's last date): a naive sum
 *    would show a fake terminal loss that never rebounds. If the member's
 *    last MV ≤ $1k (closed/dust) → carry forward silently. Otherwise, lag
 *    ≤ 5 calendar days → carry forward + a stale_member warning; lag > 5
 *    days → throw TwrDataError (the page renders the honest "report data
 *    unavailable" card instead of a wrong number).
 *
 * Duplicate (member, date) rows are deduped LAST-wins before summing, so a
 * doubled card row cannot double-count a day's MV.
 */
export function sumMemberSeries(
  memberSeries: MemberBalanceSeries[],
): { series: { date: string; mv: number }[]; warnings: HouseholdSeriesWarning[] } {
  // Dedupe per (member, date), last row wins; track each member's first/last
  // observed date for the fill rules below.
  const members = memberSeries
    .map(({ acct, series }) => {
      const mvByDate = new Map<string, number>();
      for (const p of series) mvByDate.set(p.date, p.mv);
      const dates = [...mvByDate.keys()].sort();
      return {
        acct,
        mvByDate,
        first: dates[0],
        last: dates[dates.length - 1],
        carry: 0, // last observed MV while walking the union in date order
      };
    })
    .filter((m) => m.first !== undefined);

  const union = [...new Set(members.flatMap((m) => [...m.mvByDate.keys()]))].sort();
  const warnings: HouseholdSeriesWarning[] = [];
  if (!union.length) return { series: [], warnings };
  const unionLast = union[union.length - 1];

  // Trailing-lag policy per member (checked up front so a too-stale member
  // fails the WHOLE report before any carried value is produced).
  for (const m of members) {
    if (m.last >= unionLast) continue;
    const lastMv = m.mvByDate.get(m.last) ?? 0;
    if (lastMv <= STALE_MV_THRESH) continue; // closed/dust — silent carry
    const lagDays = calendarDaysBetween(m.last, unionLast);
    if (lagDays > STALE_MAX_LAG_DAYS) {
      throw new TwrDataError("stale member series", "warehouse_error");
    }
    warnings.push({ type: "stale_member", acct: m.acct, lastDate: m.last, lagDays });
  }

  const series = union.map((date) => {
    let mv = 0;
    for (const m of members) {
      const own = m.mvByDate.get(date);
      if (own !== undefined) {
        m.carry = own;
        mv += own;
      } else if (date > m.first) {
        mv += m.carry; // interior gap or trailing lag — carry forward
      }
      // date < m.first → account not open yet: contributes nothing (no fill).
    }
    return { date, mv };
  });

  return { series, warnings };
}

/** Breakdown weights: each member's ending value over the household ending
 *  value, in percent. All-zero ending values → all weights 0 (never NaN). */
export function memberWeights(endingValues: number[]): number[] {
  const total = endingValues.reduce((s, v) => s + v, 0);
  return endingValues.map((v) => (total === 0 ? 0 : (v / total) * 100));
}

// ---------------------------------------------------------------------------
// Fetch + assemble
// ---------------------------------------------------------------------------

type MemberData = {
  identity: TwrIdentity;
  series: BalancePoint[];
  actRows: DatasetRow[];
  basisRows: DatasetRow[];
  realizedRows: DatasetRow[] | null;
};

/**
 * Pull + assemble the full household TWR input (through-latest) from the
 * household's member Apex accounts (the RLS-scoped seam provides the list; the
 * page has already authorized the household). Member accounts that the
 * warehouse resolver does not know, or that have no balance rows, contribute
 * nothing (they are still honored as INTERNAL counterparts for journal
 * classification). Throws TwrDataError("no_data") when no member has data and
 * TwrDataError("warehouse_error") when a funded member's balance feed is more
 * than 5 days stale (see sumMemberSeries).
 */
export async function fetchHouseholdReportData(
  householdSfId: string,
  memberAccounts: HouseholdMemberAccount[],
): Promise<HouseholdReportData> {
  if (!memberAccounts.length) {
    throw new TwrDataError("household has no member accounts", "no_data");
  }

  // Resolve every member number → ULID + identity, in parallel. A resolver
  // miss (account unknown to the warehouse) is skipped, not fatal — but its
  // NUMBER stays in the member set below so journals against it classify as
  // intra-household.
  const identities = await Promise.all(
    memberAccounts.map((m) => resolveAccount(m.apexAccountNumber)),
  );
  const resolved = identities.filter((i): i is TwrIdentity => i !== null);
  if (!resolved.length) {
    throw new TwrDataError("no member account resolved", "no_data");
  }

  // Per-member card fan-out (each member fires its four pulls in parallel).
  const cardRows = await Promise.all(
    resolved.map((identity) => fetchAccountCards(identity.accountId)),
  );
  const members: MemberData[] = resolved
    .map((identity, i) => ({
      identity,
      series: buildBalanceSeries(cardRows[i].balRows),
      actRows: cardRows[i].actRows,
      basisRows: cardRows[i].basisRows,
      realizedRows: cardRows[i].realizedRows,
    }))
    .filter((m) => m.series.length > 0);
  if (!members.length) throw new TwrDataError("no balance series", "no_data");

  // Repair the same narrowly-proven duplicate-cash snapshot defect on each
  // member BEFORE summing the household. This preserves aggregate-then-chain:
  // a bad member snapshot cannot contaminate household risk statistics or a
  // member's own breakdown return. No broad market-return outlier is filtered.
  let repairedSnapshots = 0;
  for (const member of members) {
    const memberAsOf = member.series[member.series.length - 1].date;
    const own = classifyAccountActivities(member.actRows, memberAsOf);
    const fixes = detectTransientCashDuplicationFixes(
      member.series,
      own.cfByDate,
      own.flowDates,
    );
    const count = Object.keys(fixes).length;
    if (count > 0) {
      member.series = applyBalanceFixes(member.series, fixes);
      repairedSnapshots += count;
    }
  }
  if (repairedSnapshots > 0) {
    // Count only: never put household/account identifiers or dates in logs.
    console.warn(
      `[twr:household] transient_cash_snapshot_repaired count=${repairedSnapshots}`,
    );
  }

  // Household series = sum of member total_equity by date (dates union, with
  // gap/lag carry-forward — see sumMemberSeries); as-of = the latest custodial
  // snapshot across members. A member lagging > 5 days throws (honest
  // "unavailable" beats a fake terminal loss).
  const { series: household, warnings } = sumMemberSeries(
    members.map((m) => ({ acct: m.identity.apexAcct, series: m.series })),
  );
  const asOf = household[household.length - 1].date;

  // Boundary classification across ALL member accounts — including the
  // unresolved ones, whose numbers still identify intra-household journals.
  const { cfByDate, flowDates, dividendTtm, advisoryFeeNet } =
    classifyHouseholdActivities(
      members.map((m) => ({ apexAcct: m.identity.apexAcct, rows: m.actRows })),
      memberAccounts.map((m) => m.apexAccountNumber),
      asOf,
    );

  const daily = household.map((p) => ({
    date: p.date,
    mv: p.mv,
    externalCf: cfByDate.get(p.date) ?? 0,
  }));

  // Analytics = sums across members. Cost basis: per-member open-lot sums;
  // the as-of label is the LATEST member snapshot date (weekly snapshots — all
  // members normally share it). When they don't, the label shows the FRESHEST
  // included member's snapshot date while older members' lots may lag up to a
  // week. A funded member that now ends as a <=$1k closing stub contributes no
  // open-lot analytics: custodial weekly lots can remain on the source account
  // after an internal journal and would otherwise duplicate basis on both the
  // closed companion and its surviving account.
  // positionsMv: each member's own last row.
  let costBasis = 0;
  let costBasisAsOf = "";
  let positionsMv = 0;
  let zeroBasisLots = 0;
  const costBasisExcludedAccounts = new Set<string>();
  for (const m of members) {
    const b = sumCostBasis(m.basisRows, asOf);
    const ownActivity = classifyAccountActivities(m.actRows, asOf);
    const staleClosedBasis =
      hasClosingInKindTransfer(m.series, ownActivity.flowDates) && b.costBasis > 0;
    if (staleClosedBasis) {
      costBasisExcludedAccounts.add(m.identity.apexAcct);
    } else {
      costBasis += b.costBasis;
      zeroBasisLots += b.zeroBasisLots;
      if (m.basisRows.length && b.costBasisAsOf > costBasisAsOf) {
        costBasisAsOf = b.costBasisAsOf;
      }
    }
    positionsMv += m.series[m.series.length - 1].positionsMv;
  }
  if (!costBasisAsOf) costBasisAsOf = asOf;

  // Realized ST/LT — YTD: fold ALL members' closed-lot rows through the shared
  // realized helper (computeRealizedGl inside). If ANY member's pull failed
  // the household totals would understate → degrade to null (the "—" row),
  // same posture as the account report's failed pull.
  const anyRealizedFailed = members.some((m) => m.realizedRows === null);
  const { realizedSt, realizedLt } = anyRealizedFailed
    ? { realizedSt: null, realizedLt: null }
    : realizedFromRows(
        members.flatMap((m) => m.realizedRows as DatasetRow[]),
        asOf,
      );

  // Per-member breakdown: each account's OWN TWR on its own series with its
  // own account-level external flows/flowDates — exactly the account report's
  // math (cheap: everything is already fetched). Engine throws on a series
  // with no funded daily returns (e.g. never cleared the $1k guard) → null.
  const endingValues = members.map((m) => m.series[m.series.length - 1].mv);
  const weights = memberWeights(endingValues);
  const breakdown: HouseholdMemberBreakdown[] = members.map((m, i) => {
    let sinceInceptionTwr: number | null = null;
    try {
      const own = classifyAccountActivities(m.actRows, asOf);
      const result = computeTwr({
        daily: m.series.map((s) => ({
          date: s.date,
          mv: s.mv,
          externalCf: own.cfByDate.get(s.date) ?? 0,
        })),
        asOf,
        flowDates: [...own.flowDates],
        // Analytics scalars are irrelevant to the return chain — zeros.
        costBasis: 0,
        costBasisAsOf: asOf,
        positionsMv: 0,
        dividendTtm: 0,
        advisoryFeeNet: 0,
        realizedSt: null,
        realizedLt: null,
      });
      sinceInceptionTwr = result.twrSinceInception;
    } catch {
      sinceInceptionTwr = null; // no funded return history
    }
    return {
      apexAcct: m.identity.apexAcct,
      label: m.identity.strategy, // nickname, falling back to humanized type
      endingValue: endingValues[i],
      weightPct: weights[i],
      sinceInceptionTwr,
      costBasisExcluded: costBasisExcludedAccounts.has(m.identity.apexAcct),
    };
  });
  breakdown.sort((a, b) => b.endingValue - a.endingValue);

  const input: TwrEngineInput = {
    daily,
    asOf,
    // NO rfAnnual here — see the identical note in lib/twr/warehouse.ts. This was
    // the SECOND hard-coded `rfAnnual: 0.042`, kept in sync with the first by
    // hand. The rate is now DATA, resolved by the caller over the report's risk
    // window (computeTwrWithMarketRf, lib/data/risk-free-rate.ts). Do NOT
    // reintroduce a literal.
    flowDates: [...flowDates],
    balanceRepairCount: repairedSnapshots > 0 ? repairedSnapshots : undefined,
    costBasis,
    costBasisAsOf,
    zeroBasisLots,
    positionsMv,
    dividendTtm,
    advisoryFeeNet,
    realizedSt,
    realizedLt,
  };

  return {
    householdSfId,
    memberCount: members.length,
    members: breakdown,
    input,
    warnings,
  };
}
