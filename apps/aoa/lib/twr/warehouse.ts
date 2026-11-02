import "server-only";
import {
  TWR_FUNDED_THRESHOLD,
  type TwrEngineInput,
} from "./engine";
import {
  queryWarehouseCard,
  type RuntimeWarehouseCardId,
} from "@/lib/warehouse/client";

// Server-only Warehouse client for the account-level TWR report. Reads
// WAREHOUSE_URL / WAREHOUSE_API_KEY from env (the SAME secrets the account-aum
// cron uses) — NEVER logged.
//
// ALL Warehouse access is via SAVED, parameterized cards (SQL is versioned in
// Warehouse, perms are narrow), called via POST /api/card/{id}/query/json:
//   • 6469 "AOA Daily Balances (TWR)" — daily NAV + positions + cash.
//   • 6470 "AOA Activities (TWR)"     — flows / dividends / fees / corp-actions
//                                       (TRADE/ALLOCATION already excluded).
//   • 6471 "AOA Cost Basis (TWR)"     — open lots at the weekly snapshot ≤ as-of.
//   • 6472 "AOA Account Number UULID Resolver" — maps the route param (custodian account
//                                       NUMBER, e.g. "KOSVLD5") → the ULID the
//                                       data cards key on, plus client identity.
//   • 6502 "AOA Realized G/L YTD"     — closed tax lots (latest snapshot, one row
//                                       per closed_lot_id — deduped INSIDE the
//                                       card; never re-dedupe app-side).
// The data cards take a REQUIRED `account_id` (the ULID) tag and an OPTIONAL
// `as_of` tag (omitted here → "through latest" report); the resolver takes an
// `account_number` tag. Every value is bound only as a parameter, never
// concatenated into SQL.

const CARD_DAILY_BALANCES = 6469;
const CARD_ACTIVITIES = 6470;
const CARD_COST_BASIS = 6471;
const CARD_RESOLVER = 6472;
const CARD_REALIZED = 6502;

// The current Warehouse card-query API validates each parameter against the
// saved question's immutable template-tag id. Supplying only target/type/value
// returns 400 before the card runs. These ids come from the reviewed production
// cards and are intentionally pinned alongside the card ids: recreating a
// template tag is a contract change that must be reviewed and updated here.
const CARD_PARAMETER_IDS = {
  [CARD_DAILY_BALANCES]: {
    accountId: "b100e07c-920d-43f0-8094-3a8d7d61e559",
    asOf: "edf25d8a-16c3-4df4-b11e-0526964a4347",
  },
  [CARD_ACTIVITIES]: {
    accountId: "8cee1877-ec10-451f-97a2-f671ebdc5bbf",
    asOf: "8690c455-4fd0-499c-9226-0c072c8471cc",
  },
  [CARD_COST_BASIS]: {
    accountId: "f2ff579f-31e5-463e-b755-efdd76718dc2",
    asOf: "d1c6180d-0e18-44be-92e3-06a40ecd36e7",
  },
  [CARD_REALIZED]: {
    accountId: "46e62f55-474f-4944-b16f-33ec34f078b0",
    asOf: "0662ce51-406f-471e-a3a3-5674a4c20013",
  },
} as const;
const CARD_RESOLVER_ACCOUNT_NUMBER_PARAMETER_ID =
  "5bd35b42-ee0d-4c56-9502-867fdfbff7eb";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// External (neutralized-in-TWR) flow categories. Internal activity
// (TRADE/ALLOCATION/CASH_DIVIDEND/INTEREST/CAPITAL_GAINS/FEE/corp-actions) stays
// in the return and is NOT summed into the external cash flow.
const EXTERNAL_CF_CATS = new Set([
  "DEPOSIT",
  "WITHDRAWAL",
  "TRANSFER",
  "ACCOUNT_TRANSFER",
  "CREDIT",
  "REDEMPTION_FULL",
  "LIQUIDATION",
]);
const IN_KIND_CATS = new Set(["DEPOSIT", "TRANSFER", "ACCOUNT_TRANSFER"]);

/** External (TWR-neutralized) flow category test, shared with the household
 *  report's boundary classifier (lib/twr/household.ts). */
export const isExternalCategory = (cat: string): boolean =>
  EXTERNAL_CF_CATS.has(cat) || cat.startsWith("ACATS");

/** In-kind-capable ($0-journal) category test, shared with the household
 *  classifier. */
export const isInKindCategory = (cat: string): boolean => IN_KIND_CATS.has(cat);

/** Advisory-fee row test: FEE debits plus their reimbursement CREDITs (a
 *  reimbursed IRA fee nets to ~$0). Mirrors the approved SQL's OR conditions. */
export const isAdvisoryFeeRow = (
  cat: string,
  type: string,
  desc: string,
): boolean => cat === "FEE" || /advisor/i.test(type) || /advisor|fee reimb/i.test(desc);

/** Thrown for any data-layer failure the page renders as "report data
 *  unavailable" (config missing, Warehouse non-200, or an unknown account). */
export class TwrDataError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "config_error"
      | "warehouse_error"
      | "not_found"
      | "no_data",
  ) {
    super(message);
    this.name = "TwrDataError";
  }
}

// The env read + POST transport now live in lib/warehouse/client.ts (shared with
// the account-funding module so the secret handling can't drift). These thin
// wrappers pin this module's log prefix ("twr:warehouse") and its own
// TwrDataError type, keeping behavior byte-identical to the inlined originals.
const twrError = (reason: "config_error" | "warehouse_error", message: string) =>
  new TwrDataError(message, reason);

export type DatasetRow = Record<string, unknown>;

type ColumnKind =
  | "date"
  | "number"
  | "nullableNumber"
  | "nullableScalar"
  | "string"
  | "nullableString";
type CardSchema = Readonly<Record<string, ColumnKind>>;

const CARD_SCHEMAS: Readonly<Record<
  typeof CARD_DAILY_BALANCES | typeof CARD_ACTIVITIES | typeof CARD_COST_BASIS |
    typeof CARD_RESOLVER | typeof CARD_REALIZED,
  CardSchema
>> = {
  [CARD_DAILY_BALANCES]: {
    d: "date",
    total_equity: "number",
    position_market_value: "nullableNumber",
    cash: "nullableNumber",
  },
  [CARD_ACTIVITIES]: {
    d: "date",
    type: "nullableString",
    sub_type: "nullableString",
    subtype_category: "nullableString",
    net_amount: "nullableNumber",
    symbol: "nullableString",
    activity_description: "nullableString",
    state: "nullableString",
  },
  [CARD_COST_BASIS]: {
    snapshot_date: "date",
    symbol: "nullableString",
    cusip: "nullableString",
    quantity: "nullableNumber",
    cost_basis: "nullableNumber",
    term: "nullableString",
  },
  [CARD_RESOLVER]: {
    account_id: "string",
    apex_acct: "nullableString",
    account_type: "nullableString",
    account_nickname: "nullableString",
    client_name: "nullableString",
  },
  [CARD_REALIZED]: {
    disposal_date: "date",
    term: "nullableString",
    symbol: "nullableString",
    // Closed-lot fields retain the existing row-level defensive behavior:
    // scalar-but-non-numeric values are skipped and counted by computeRealizedGl.
    // Structured values still fail the response schema.
    gain_loss: "nullableScalar",
    wash_sale_adjustment: "nullableScalar",
    disallowed_loss: "nullableScalar",
  },
};

const isNumeric = (value: unknown): boolean =>
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));

function columnMatches(value: unknown, kind: ColumnKind): boolean {
  if (kind === "date") return typeof value === "string" && ISO_DATE.test(value.slice(0, 10));
  if (kind === "number") return isNumeric(value);
  if (kind === "nullableNumber") return value === null || isNumeric(value);
  if (kind === "nullableScalar") {
    return value === null || typeof value === "string" || typeof value === "number";
  }
  if (kind === "string") return typeof value === "string" && value.trim() !== "";
  return value === null || typeof value === "string";
}

function validateCardRows(cardId: keyof typeof CARD_SCHEMAS, payload: unknown): DatasetRow[] {
  if (!Array.isArray(payload)) throw new TwrDataError("Warehouse bad shape", "warehouse_error");
  const schema = CARD_SCHEMAS[cardId];
  const expected = Object.keys(schema).sort();
  for (const row of payload) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new TwrDataError("Warehouse bad shape", "warehouse_error");
    }
    const record = row as DatasetRow;
    const actual = Object.keys(record).sort();
    if (
      actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index]) ||
      expected.some((key) => !columnMatches(record[key], schema[key]))
    ) {
      throw new TwrDataError("Warehouse bad shape", "warehouse_error");
    }
  }
  return payload as DatasetRow[];
}

async function queryCard(
  cardId: keyof typeof CARD_SCHEMAS,
  parameters: readonly unknown[],
): Promise<DatasetRow[]> {
  const payload = await queryWarehouseCard(
    cardId as RuntimeWarehouseCardId,
    parameters,
    "twr:warehouse",
    twrError,
  );
  try {
    return validateCardRows(cardId, payload);
  } catch (error) {
    console.error(`[twr:warehouse] card_bad_shape id=${cardId}`);
    throw error;
  }
}

// Run a saved card and get back an array of row objects keyed by the card's
// SELECT aliases (the /query/json shape). `as_of` is included ONLY when set —
// omitting it makes the card report "through latest".
async function runCard(
  cardId:
    | typeof CARD_DAILY_BALANCES
    | typeof CARD_ACTIVITIES
    | typeof CARD_COST_BASIS
    | typeof CARD_REALIZED,
  accountId: string,
  asOf?: string,
): Promise<DatasetRow[]> {
  const parameterIds = CARD_PARAMETER_IDS[cardId];
  const parameters: unknown[] = [
    {
      id: parameterIds.accountId,
      type: "string/=",
      target: ["variable", ["template-tag", "account_id"]],
      value: accountId,
    },
  ];
  if (asOf) {
    parameters.push({
      id: parameterIds.asOf,
      type: "string/=",
      target: ["variable", ["template-tag", "as_of"]],
      value: inlineDate(asOf),
    });
  }
  return queryCard(cardId, parameters);
}

export const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const day = (v: unknown): string => String(v ?? "").slice(0, 10);
export const str = (v: unknown): string => String(v ?? "");
const inlineDate = (d: string): string => {
  if (!ISO_DATE.test(d)) throw new TwrDataError("bad date literal", "no_data");
  return d;
};
// One year before an ISO date (trailing-12-month window boundary, exclusive).
export function yearAgo(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

export type RealizedGl = {
  realizedSt: number;
  realizedLt: number;
  skipped: number; // rows dropped defensively (non-numeric gain_loss / unknown term)
};

/**
 * Fold the card-6502 closed-lot rows into the YTD realized short/long-term
 * totals. PURE (unit-testable): the YTD window is disposals in the SAME
 * CALENDAR YEAR as `asOf` (derived, never hardcoded) AND on/before `asOf`.
 * A non-numeric gain_loss or an unknown term skips the row (counted in
 * `skipped`) rather than NaN-ing the sum. Zero matching rows is a REAL
 * "no realized gains this year" → {0, 0}, not null.
 */
export function computeRealizedGl(
  rows: Record<string, unknown>[],
  asOf: string,
): RealizedGl {
  const year = asOf.slice(0, 4);
  let realizedSt = 0;
  let realizedLt = 0;
  let skipped = 0;
  for (const r of rows) {
    const d = day(r.disposal_date);
    if (d.slice(0, 4) !== year || d > asOf) continue; // outside the YTD window
    const gl = Number(r.gain_loss);
    if (!Number.isFinite(gl)) {
      skipped++;
      continue;
    }
    const term = str(r.term);
    if (term === "SHORT_TERM") realizedSt += gl;
    else if (term === "LONG_TERM") realizedLt += gl;
    else skipped++;
  }
  return { realizedSt, realizedLt, skipped };
}

export type TwrIdentity = {
  accountId: string; // the ULID the Apex cards key on
  apexAcct: string; // custodian account number (the route param)
  clientName: string;
  accountType: string;
  strategy: string;
};

export type AccountReportData = {
  identity: TwrIdentity;
  input: TwrEngineInput;
};

// Humanize an Apex account_type code (e.g. "TRADITIONAL_IRA" → "Traditional
// IRA") when there is no friendlier nickname.
function humanizeType(t: string): string {
  return t
    .toLowerCase()
    .split(/[_\s]+/)
    .map((w) => (w === "ira" ? "IRA" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Resolve the route param (custodian account NUMBER) → the ULID + client
 * identity. Returns null when no such account exists (page → notFound).
 */
export async function resolveAccount(
  apexAccountNumber: string,
): Promise<TwrIdentity | null> {
  // Saved card 6472 takes the custodian account NUMBER as its `account_number`
  // tag and returns account_id (the ULID the data cards key on) + client identity.
  // The number is bound only as a parameter, never concatenated into SQL.
  const payload = await queryCard(CARD_RESOLVER, [
    {
      id: CARD_RESOLVER_ACCOUNT_NUMBER_PARAMETER_ID,
      type: "string/=",
      target: ["variable", ["template-tag", "account_number"]],
      value: apexAccountNumber,
    },
  ]);
  const r = payload[0];
  if (!r || !r.account_id) return null;

  const accountType = str(r.account_type);
  // No dedicated strategy feed exists in this warehouse (the approved standalone
  // report sourced it from an Meridian export not mirrored here); fall back to
  // the account nickname, then a humanized account type.
  const nickname = str(r.account_nickname).trim();
  const strategy =
    nickname || (accountType ? humanizeType(accountType) : "Managed portfolio");

  return {
    accountId: str(r.account_id),
    apexAcct: str(r.apex_acct) || apexAccountNumber,
    clientName: str(r.client_name).trim() || "Client",
    accountType: accountType ? humanizeType(accountType) : "Account",
    strategy,
  };
}

/** The four data-card pulls for one account ULID (through-latest). Shared by
 *  the account report and the household report's per-member fan-out. */
export type AccountCardRows = {
  balRows: DatasetRow[];
  actRows: DatasetRow[];
  basisRows: DatasetRow[];
  realizedRows: DatasetRow[] | null; // null = pull failed (degrades to the "—" row)
};

/**
 * Fire the four card pulls together (all through-latest → no as_of param).
 * The realized pull degrades to null (the "—" row) on failure instead of
 * taking down the whole report — realized G/L is supplementary.
 */
export async function fetchAccountCards(accountId: string): Promise<AccountCardRows> {
  const [balRows, actRows, basisRows, realizedRows] = await Promise.all([
    runCard(CARD_DAILY_BALANCES, accountId),
    runCard(CARD_ACTIVITIES, accountId),
    runCard(CARD_COST_BASIS, accountId),
    runCard(CARD_REALIZED, accountId).catch((): null => {
      // STATIC marker only (runCard/postJson already logged the status).
      console.error("[twr:warehouse] realized_unavailable");
      return null;
    }),
  ]);
  return { balRows, actRows, basisRows, realizedRows };
}

/** One day of an account's balance series (card 6469), normalized + sorted. */
export type BalancePoint = {
  date: string;
  mv: number;
  positionsMv: number;
  /** Custodial cash component. Optional only for synthetic/test callers. */
  cash?: number;
};

export function buildBalanceSeries(balRows: DatasetRow[]): BalancePoint[] {
  return balRows
    .map((r) => ({
      date: day(r.d),
      mv: num(r.total_equity),
      positionsMv: num(r.position_market_value),
      cash: num(r.cash),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const CASH_DUPLICATION_TOLERANCE = 0.02;
const MIN_DUPLICATION_CASH = 1;
const MIN_TRANSIENT_MOVE = 0.03;
const MAX_REPAIRED_MOVE = 0.1;

/**
 * Detect the narrow custodial defect where one overnight snapshot contains
 * exactly twice the stable cash balance and the next snapshot reverts.
 *
 * This is deliberately NOT a general outlier filter. A repair is emitted only
 * when all independent evidence agrees: stable neighbouring cash, an exact
 * doubled middle cash value, no external/in-kind flow on either leg, an
 * offsetting total-equity spike/reversal, and ordinary total-equity movement
 * after replacing the duplicate cash. Legitimate large market days therefore
 * remain untouched.
 */
export function detectTransientCashDuplicationFixes(
  series: readonly BalancePoint[],
  cfByDate: ReadonlyMap<string, number>,
  flowDates: ReadonlySet<string>,
): Record<string, number> {
  const fixes: Record<string, number> = {};

  for (let i = 1; i < series.length - 1; i++) {
    const previous = series[i - 1];
    const current = series[i];
    const next = series[i + 1];
    const previousCash = previous.cash;
    const currentCash = current.cash;
    const nextCash = next.cash;

    if (
      previousCash == null ||
      currentCash == null ||
      nextCash == null ||
      Math.abs(previousCash) < MIN_DUPLICATION_CASH ||
      previous.mv <= TWR_FUNDED_THRESHOLD ||
      current.mv <= TWR_FUNDED_THRESHOLD ||
      next.mv <= TWR_FUNDED_THRESHOLD
    ) {
      continue;
    }

    const stableCash = (previousCash + nextCash) / 2;
    const neighboursMatch =
      Math.abs(previousCash - nextCash) <= CASH_DUPLICATION_TOLERANCE;
    const middleIsDoubled =
      Math.abs(currentCash - 2 * stableCash) <= CASH_DUPLICATION_TOLERANCE;
    const componentReconciles =
      Math.abs(current.mv - (current.positionsMv + currentCash)) <=
      CASH_DUPLICATION_TOLERANCE;
    const hasFlowEvidence =
      Math.abs(cfByDate.get(current.date) ?? 0) > CASH_DUPLICATION_TOLERANCE ||
      Math.abs(cfByDate.get(next.date) ?? 0) > CASH_DUPLICATION_TOLERANCE ||
      flowDates.has(current.date) ||
      flowDates.has(next.date);

    if (!neighboursMatch || !middleIsDoubled || !componentReconciles || hasFlowEvidence) {
      continue;
    }

    const firstMove = (current.mv - previous.mv) / previous.mv;
    const reversal = (next.mv - current.mv) / current.mv;
    if (
      Math.abs(firstMove) < MIN_TRANSIENT_MOVE ||
      Math.abs(reversal) < MIN_TRANSIENT_MOVE ||
      Math.sign(firstMove) === Math.sign(reversal)
    ) {
      continue;
    }

    const correctedMv = current.positionsMv + stableCash;
    const repairedFirstMove = (correctedMv - previous.mv) / previous.mv;
    const repairedSecondMove = (next.mv - correctedMv) / correctedMv;
    if (
      correctedMv <= TWR_FUNDED_THRESHOLD ||
      Math.abs(repairedFirstMove) > MAX_REPAIRED_MOVE ||
      Math.abs(repairedSecondMove) > MAX_REPAIRED_MOVE
    ) {
      continue;
    }

    fixes[current.date] = correctedMv;
  }

  return fixes;
}

/** Apply detected repairs before household member balances are summed. */
export function applyBalanceFixes(
  series: readonly BalancePoint[],
  fixes: Readonly<Record<string, number>>,
): BalancePoint[] {
  return series.map((point) => {
    const correctedMv = fixes[point.date];
    if (correctedMv == null) return { ...point };
    return {
      ...point,
      mv: correctedMv,
      cash: Math.round((correctedMv - point.positionsMv) * 100) / 100,
    };
  });
}

/** Decide whether the first funded balance should be presented as a
 * contribution instead of an unexplained beginning value. The return chain is
 * unchanged; this only frames the waterfall/cash-flow disclosure. The engine's
 * inception base is the first point in the first consecutive pair whose two
 * endpoints clear the $1k denominator guard. */
export function inceptionFundingFrame(
  series: BalancePoint[],
  cfByDate: ReadonlyMap<string, number>,
  flowDates: ReadonlySet<string>,
): { beginningZero: boolean; contribInkind: boolean } {
  const base = series.find(
    (point, index) =>
      index < series.length - 1 &&
      point.mv > TWR_FUNDED_THRESHOLD &&
      series[index + 1].mv > TWR_FUNDED_THRESHOLD,
  );
  if (!base) return { beginningZero: false, contribInkind: false };

  const contribInkind = flowDates.has(base.date);
  const fundedByCash = (cfByDate.get(base.date) ?? 0) > 0;
  return {
    beginningZero: contribInkind || fundedByCash,
    contribInkind,
  };
}

/** Account-level activity classification (card 6470): external flows
 *  (neutralized), in-kind $0-journal dates, dividend TTM, and the netted
 *  advisory fee. PURE — shared by the account report and by the household
 *  report's per-member breakdown TWRs. */
export type ActivityClassification = {
  cfByDate: Map<string, number>;
  flowDates: Set<string>;
  dividendTtm: number;
  advisoryFeeNet: number; // |FEE debits netted against reimbursement CREDITs|
};

export function classifyAccountActivities(
  actRows: DatasetRow[],
  asOf: string,
): ActivityClassification {
  const cutoff = yearAgo(asOf); // trailing-12-month boundary (exclusive)
  // Internal activity (dividends/interest/gains/fees/corp-actions) stays in the
  // return, so only external categories feed the cash-flow neutralization.
  const cfByDate = new Map<string, number>();
  const flowDates = new Set<string>();
  let dividendTtm = 0;
  let advisoryFeeSum = 0;
  for (const r of actRows) {
    const d = day(r.d);
    const cat = str(r.subtype_category);
    const type = str(r.type);
    const desc = str(r.activity_description);
    const amt = num(r.net_amount);
    if (isExternalCategory(cat)) cfByDate.set(d, (cfByDate.get(d) ?? 0) + amt);
    if (isInKindCategory(cat) && amt === 0) flowDates.add(d);
    const inTtm = d > cutoff && d <= asOf;
    if (inTtm && cat === "CASH_DIVIDEND") dividendTtm += amt;
    if (inTtm && isAdvisoryFeeRow(cat, type, desc)) advisoryFeeSum += amt;
  }
  return { cfByDate, flowDates, dividendTtm, advisoryFeeNet: Math.abs(advisoryFeeSum) };
}

/** Cost basis = SUM(open-lot cost_basis) at the weekly snapshot ≤ as-of
 *  (card 6471). Falls back to `fallbackAsOf` when the account has no lots.
 *  `zeroBasisLots` counts open lots with $0/missing recorded basis
 *  (cost_basis <= 0) — very common for IRAs (brokers aren't required to track
 *  IRA basis; ACAT'd-in lots often import at $0). When > 0 the summed
 *  `costBasis` is understated, so the engine treats the unrealized % as
 *  unreliable (see TwrAnalytics.basisIncomplete). */
export function sumCostBasis(
  basisRows: DatasetRow[],
  fallbackAsOf: string,
): { costBasis: number; costBasisAsOf: string; zeroBasisLots: number } {
  return {
    costBasis: basisRows.reduce((s, r) => s + num(r.cost_basis), 0),
    costBasisAsOf: basisRows.length ? day(basisRows[0].snapshot_date) : fallbackAsOf,
    zeroBasisLots: basisRows.reduce((n, r) => n + (num(r.cost_basis) <= 0 ? 1 : 0), 0),
  };
}

/** Fold a card-6502 pull into the nullable realized ST/LT pair. A successful
 *  pull with zero in-window rows is a real $0; only a failed pull (null rows)
 *  leaves null (→ the single "—" row). */
export function realizedFromRows(
  realizedRows: DatasetRow[] | null,
  asOf: string,
): { realizedSt: number | null; realizedLt: number | null } {
  if (realizedRows === null) return { realizedSt: null, realizedLt: null };
  const rgl = computeRealizedGl(realizedRows, asOf);
  if (rgl.skipped > 0) {
    // COUNT only — never row contents.
    console.error(`[twr:warehouse] realized_rows_skipped count=${rgl.skipped}`);
  }
  return { realizedSt: rgl.realizedSt, realizedLt: rgl.realizedLt };
}

/**
 * Pull the full TWR input for one account (through-latest), keyed by its ULID.
 * Throws TwrDataError("no_data") when the balance series is empty.
 */
export async function fetchAccountReportData(
  apexAccountNumber: string,
): Promise<AccountReportData> {
  const identity = await resolveAccount(apexAccountNumber);
  if (!identity) throw new TwrDataError("account not found", "not_found");

  const { balRows, actRows, basisRows, realizedRows } = await fetchAccountCards(
    identity.accountId,
  );

  if (!balRows.length) throw new TwrDataError("no balance series", "no_data");
  const series = buildBalanceSeries(balRows);
  const asOf = series[series.length - 1].date; // latest custodial snapshot

  const { cfByDate, flowDates, dividendTtm, advisoryFeeNet } =
    classifyAccountActivities(actRows, asOf);
  const glitchFix = detectTransientCashDuplicationFixes(
    series,
    cfByDate,
    flowDates,
  );
  const repairedCount = Object.keys(glitchFix).length;
  if (repairedCount > 0) {
    // Count only: never put account identifiers or report dates in logs.
    console.warn(
      `[twr:warehouse] transient_cash_snapshot_repaired count=${repairedCount}`,
    );
  }
  const fundingFrame = inceptionFundingFrame(series, cfByDate, flowDates);

  const daily = series.map((s) => ({
    date: s.date,
    mv: s.mv,
    externalCf: cfByDate.get(s.date) ?? 0,
  }));
  const last = series[series.length - 1];

  const { costBasis, costBasisAsOf, zeroBasisLots } = sumCostBasis(basisRows, asOf);
  const { realizedSt, realizedLt } = realizedFromRows(realizedRows, asOf);

  const input: TwrEngineInput = {
    daily,
    asOf,
    // NO rfAnnual here. It used to be a hard-coded `rfAnnual: 0.042`, kept in sync
    // BY HAND with the identical literal in lib/twr/household.ts and with
    // engine.ts's DEFAULT_RF — the one manually-maintained assumption inside the
    // calculation path, and ~30bp stale by the time a compliance review flagged
    // it. The rate is now DATA: the caller resolves the MEAN 3-month Treasury par
    // yield over the report's risk window via computeTwrWithMarketRf
    // (lib/data/risk-free-rate.ts). Leaving it absent here is deliberate — an
    // unresolved rate SUPPRESSES the Sharpe rather than silently reinstating a
    // constant. Do NOT reintroduce a literal.
    flowDates: [...flowDates],
    glitchFix: repairedCount > 0 ? glitchFix : undefined,
    balanceRepairCount: repairedCount > 0 ? repairedCount : undefined,
    beginningZero: fundingFrame.beginningZero,
    contribInkind: fundingFrame.contribInkind,
    costBasis,
    costBasisAsOf,
    zeroBasisLots,
    positionsMv: last.positionsMv,
    dividendTtm,
    advisoryFeeNet,
    realizedSt,
    realizedLt,
  };

  return { identity, input };
}
