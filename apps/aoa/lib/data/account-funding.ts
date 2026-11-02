import "server-only";
import { queryWarehouseCard } from "@/lib/warehouse/client";
import { resolveAccount } from "@/lib/twr/warehouse";

// Server-only data layer for the account-level "New Funding" section: external
// cash funding (ACH / Check / Wire) into an account over the trailing 12 months.
// First slice of the larger asset-transfer initiative — account-page only, no
// household roll-up yet.
//
// Sourced from SAVED, parameterized Warehouse card 6634 "New Funding
// (ACH/Check/Wire) - AOA v2 (Rebook-safe)" (database 4), called via POST
// /api/card/6634/query/json
// exactly like the TWR cards. The account ULID is bound ONLY as a parameter
// (`account_id`, required); the trailing-12mo window bound is bound as a
// validated ISO date literal (`start_date`, optional). Nothing is concatenated
// into SQL, and the url/key/body/response are NEVER logged (only static markers
// / status codes — see lib/warehouse/client.ts).

const CARD_NEW_FUNDING = 6634;
const CARD_ACTIVITY_FEED_SOURCE_DATE = 6700;
const CARD_NEW_FUNDING_PARAMETER_IDS = {
  accountId: "97a51ec7-bf66-4a41-8681-eafba99e1dc3",
  startDate: "2d59758c-1d07-41fe-b126-36c976d0c05f",
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Thrown for any funding data-layer failure so the page can catch it and
 *  render a small inline "unavailable" note WITHOUT taking down the TWR report
 *  (funding is supplementary this slice). Mirrors TwrDataError's shape. */
export class FundingDataError extends Error {
  constructor(
    message: string,
    readonly reason: "config_error" | "warehouse_error" | "bad_shape",
  ) {
    super(message);
    this.name = "FundingDataError";
  }
}

const fundingError = (
  reason: "config_error" | "warehouse_error",
  message: string,
) => new FundingDataError(message, reason);

// Local coercion helpers, mirroring lib/twr/warehouse.ts's num/day/str so the
// two modules normalize warehouse rows identically.
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN; // NaN here is intentional — the pure
  // aggregator treats a non-finite amount as a malformed row and skips it.
};
const day = (v: unknown): string => String(v ?? "").slice(0, 10);
const str = (v: unknown): string => String(v ?? "");

const inlineDate = (d: string): string => {
  if (!ISO_DATE.test(d)) throw new FundingDataError("bad date literal", "bad_shape");
  return d;
};

/** One year before an ISO date (trailing-12-month window boundary). Behaves
 *  like lib/twr/warehouse.ts's yearAgo. */
export function yearAgo(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/** Today's date (UTC) as an ISO YYYY-MM-DD — the default as-of. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The recognized external-funding methods, in display order. */
export const FUNDING_METHODS = ["ACH", "Check", "Wire"] as const;
export type FundingMethod = (typeof FUNDING_METHODS)[number];

/** One normalized funding event from card 6634. */
export type FundingRow = {
  accountId: string;
  activityDate: string; // YYYY-MM-DD
  settleDate: string; // YYYY-MM-DD ("" when absent)
  amount: number; // positive dollars (NaN if the warehouse value was malformed)
  method: string; // raw funding_method ('ACH' | 'Check' | 'Wire' | other)
  description: string;
  activityId: string;
  // Stable upstream transaction identity shared by an original booking and
  // any rebooked replacement. Two genuinely separate deposits have different
  // lineage IDs even when account/date/method/amount are identical.
  sourceApplicationId: string;
  generation: number;
  // Source custodian account NUMBER this event hit. Populated by
  // fetchClientFunding (which fans out over a client's Apex account numbers) so
  // the client-wide events table can show which account each deposit landed in.
  // Absent for the single-account path (fetchAccountFunding), which is keyed by
  // ULID only and never spans accounts.
  account?: string;
};

/** Per-method total over the trailing-12mo window. */
export type MethodTotal = { amount: number; count: number };

export type FundingSummary = {
  asOf: string; // the ISO as-of the windows were computed against
  windowStart: string; // trailing-12mo boundary (exclusive), = yearAgo(asOf)
  events: FundingRow[]; // trailing-12mo events, sorted DESC by activity date
  byMethod: Record<FundingMethod, MethodTotal>; // ACH / Check / Wire
  total: MethodTotal; // grand total over the window (all recognized methods)
  ytd: MethodTotal; // same-calendar-year-as-asOf events on/before asOf
  skipped: number; // rows dropped defensively (malformed / negative / unknown method)
};

function normalizeRow(r: Record<string, unknown>): FundingRow {
  return {
    accountId: str(r.account_id),
    activityDate: day(r.activity_date),
    settleDate: day(r.settle_date),
    amount: num(r.net_amount),
    method: str(r.funding_method),
    description: str(r.activity_description),
    activityId: str(r.activity_id),
    sourceApplicationId: str(r.source_application_id),
    generation: num(r.generation),
  };
}

/**
 * Keep only the newest row for each upstream transaction lineage. Apex rebooks
 * can leave both the original and replacement rows in state=CURRENT while the
 * reversing row is state=REBOOK. Counting CURRENT rows therefore doubles the
 * economic deposit. source_application_id is the durable lineage key; unlike a
 * date/amount heuristic it preserves two legitimate same-day, same-amount
 * deposits. Rows without a lineage key are retained independently.
 */
function latestFundingLineageRows(rows: FundingRow[]): FundingRow[] {
  const selected: FundingRow[] = [];
  const indexByLineage = new Map<string, number>();

  for (const row of rows) {
    const lineage = row.sourceApplicationId.trim();
    if (!lineage) {
      selected.push(row);
      continue;
    }

    const key = `${row.accountId}\u0000${lineage}`;
    const selectedIndex = indexByLineage.get(key);
    if (selectedIndex === undefined) {
      indexByLineage.set(key, selected.length);
      selected.push(row);
      continue;
    }

    const current = selected[selectedIndex];
    const currentGeneration = Number.isFinite(current.generation)
      ? current.generation
      : Number.NEGATIVE_INFINITY;
    const candidateGeneration = Number.isFinite(row.generation)
      ? row.generation
      : Number.NEGATIVE_INFINITY;
    if (
      candidateGeneration > currentGeneration ||
      (candidateGeneration === currentGeneration && row.activityId > current.activityId)
    ) {
      selected[selectedIndex] = row;
    }
  }

  return selected;
}

/** Map a raw funding_method string onto one of the recognized methods, or null
 *  when it isn't ACH/Check/Wire (case-insensitive). */
function canonicalMethod(raw: string): FundingMethod | null {
  const m = raw.trim().toLowerCase();
  if (m === "ach") return "ACH";
  if (m === "check") return "Check";
  if (m === "wire") return "Wire";
  return null;
}

function emptyByMethod(): Record<FundingMethod, MethodTotal> {
  return {
    ACH: { amount: 0, count: 0 },
    Check: { amount: 0, count: 0 },
    Wire: { amount: 0, count: 0 },
  };
}

/**
 * PURE, unit-testable classifier/aggregator. Folds normalized funding rows into
 * the trailing-12mo + YTD summary keyed off `asOfIso`:
 *   • trailing-12mo window = (yearAgo(asOf), asOf]  (start exclusive, as-of inclusive)
 *   • YTD = same calendar year as asOf AND on/before asOf
 * A malformed row (non-finite / negative amount, missing/unparseable date, or a
 * funding_method outside ACH/Check/Wire) is SKIPPED and counted in `skipped`
 * rather than NaN-ing a total. Zero matching rows is a REAL $0 (counts 0),
 * never null. `events` are the in-window rows sorted DESC by activity date.
 */
export function summarizeFunding(
  rows: FundingRow[],
  asOfIso: string,
): FundingSummary {
  const asOf = day(asOfIso);
  const windowStart = yearAgo(asOf);
  const year = asOf.slice(0, 4);

  const events: FundingRow[] = [];
  const byMethod = emptyByMethod();
  const total: MethodTotal = { amount: 0, count: 0 };
  const ytd: MethodTotal = { amount: 0, count: 0 };
  let skipped = 0;

  for (const r of latestFundingLineageRows(rows)) {
    const d = r.activityDate;
    const method = canonicalMethod(r.method);
    // Defensive guards: bad date, unknown method, non-finite or negative amount.
    if (!ISO_DATE.test(d) || method === null) {
      skipped++;
      continue;
    }
    if (!Number.isFinite(r.amount) || r.amount < 0) {
      skipped++;
      continue;
    }

    const inWindow = d > windowStart && d <= asOf;
    if (inWindow) {
      // Store the CANONICAL method on the event so the detail table and the
      // per-method tiles agree by construction (the table can never render a
      // non-canonical casing the saved card might emit).
      events.push({ ...r, method });
      byMethod[method].amount += r.amount;
      byMethod[method].count += 1;
      total.amount += r.amount;
      total.count += 1;
    }
    // YTD is its own window (same calendar year, on/before as-of) — independent
    // of the trailing-12mo window so a January as-of still reports correctly.
    if (d.slice(0, 4) === year && d <= asOf) {
      ytd.amount += r.amount;
      ytd.count += 1;
    }
  }

  events.sort((a, b) => b.activityDate.localeCompare(a.activityDate));

  return { asOf, windowStart, events, byMethod, total, ytd, skipped };
}

/**
 * Fetch trailing-12mo funding events for one account ULID from the corrected
 * saved funding card. Binds
 * the required `account_id` param and, by default, `start_date` = one year
 * before today (so the warehouse pre-filters to the trailing window). Returns
 * normalized rows; throws FundingDataError on a config/transport/shape failure
 * so the page can degrade gracefully.
 */
export async function fetchAccountFunding(
  accountUlid: string,
  opts?: { startDate?: string },
): Promise<FundingRow[]> {
  const startDate = opts?.startDate ?? yearAgo(todayIso());
  const parameters: unknown[] = [
    {
      id: CARD_NEW_FUNDING_PARAMETER_IDS.accountId,
      type: "string/=",
      target: ["variable", ["template-tag", "account_id"]],
      value: accountUlid,
    },
    {
      id: CARD_NEW_FUNDING_PARAMETER_IDS.startDate,
      type: "string/=",
      target: ["variable", ["template-tag", "start_date"]],
      value: inlineDate(startDate),
    },
  ];
  const payload = await queryWarehouseCard(
    CARD_NEW_FUNDING,
    parameters,
    "funding:warehouse",
    fundingError,
  );
  if (!Array.isArray(payload)) {
    console.error(`[funding:warehouse] card_bad_shape id=${CARD_NEW_FUNDING}`);
    throw new FundingDataError("Warehouse bad shape", "bad_shape");
  }
  return (payload as Record<string, unknown>[]).map(normalizeRow);
}

/**
 * PII-free availability probe for the Data Health page. The fixed value is not
 * a real Apex ULID and therefore cannot select a client's transactions. A
 * successful empty response proves only that Warehouse, card 6634, its template
 * parameters, and the underlying query are reachable right now; it does not
 * claim that the activity feed is globally fresh.
 */
export async function checkExternalFundingAvailability(): Promise<void> {
  await fetchAccountFunding("AOA-DATA-HEALTH-PROBE-NO-ACCOUNT", {
    startDate: todayIso(),
  });
}

/**
 * PII-free source-date read for Data Health. Card 6700 returns one aggregate
 * value — max(process_date) from the same Apex activity table that backs card
 * 6634 — and contains no client identifiers, transactions, or amounts.
 */
export async function getExternalFundingSourceDate(): Promise<string> {
  const payload = await queryWarehouseCard(
    CARD_ACTIVITY_FEED_SOURCE_DATE,
    [],
    "funding-health:warehouse",
    fundingError,
  );
  if (!Array.isArray(payload) || payload.length !== 1) {
    console.error("[funding-health:warehouse] source_date_bad_shape");
    throw new FundingDataError("Warehouse source date bad shape", "bad_shape");
  }
  const row = payload[0];
  if (!row || typeof row !== "object") {
    console.error("[funding-health:warehouse] source_date_bad_row");
    throw new FundingDataError("Warehouse source date bad row", "bad_shape");
  }
  const value = (row as Record<string, unknown>).as_of;
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    console.error("[funding-health:warehouse] source_date_invalid");
    throw new FundingDataError("Warehouse source date invalid", "bad_shape");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    console.error("[funding-health:warehouse] source_date_invalid");
    throw new FundingDataError("Warehouse source date invalid", "bad_shape");
  }
  return value;
}

/**
 * Client-level funding: fan out over a client's Apex account NUMBERS, resolve
 * each to its ULID (card 6472, via resolveAccount) and pull its trailing-12mo
 * funding rows (card 6634), then fold the MERGED rows through the same pure
 * `summarizeFunding` so the by-method totals + YTD are client-wide.
 *
 * Each account is resolved+fetched in PARALLEL and its rows are tagged with the
 * source account number (`account`) so the combined events table can show which
 * account each deposit hit. A per-account THROW (resolve/fetch transport error)
 * is caught and SKIPPED so one flaky account never kills the section — BUT if
 * EVERY attempted account throws (a full Warehouse/config outage) we throw a
 * FundingDataError rather than returning an empty summary, so the caller renders
 * an honest "unavailable" note instead of a misleading "no funding" empty state
 * (a real $0-funding client is indistinguishable from an outage otherwise). A
 * resolver MISS (unknown account → null identity) is NOT an error: it's a real
 * "this account has no funding data", so it counts as a successful empty result.
 *
 * Scope is exactly the account numbers passed in (the caller derives them from
 * the RLS-scoped apexAccountsForClient) — this never widens beyond them. Account
 * numbers are de-duplicated first so a repeated number can't double-count. Does
 * up to 2 Warehouse calls per account (resolve + funding); acceptable for typical
 * small account counts. A single client-level card is a future optimization.
 */
export async function fetchClientFunding(
  accountNumbers: string[],
  asOfIso: string,
  opts?: { startDate?: string },
): Promise<FundingSummary> {
  const startDate = opts?.startDate ?? yearAgo(day(asOfIso));
  // De-dupe: two identical numbers (or the same account listed twice) must not
  // have their funding rows counted twice in the merged total.
  const numbers = [...new Set(accountNumbers)];

  const OUTAGE = Symbol("outage"); // per-account transport failure sentinel
  const perAccount = await Promise.all(
    numbers.map(async (number): Promise<FundingRow[] | typeof OUTAGE> => {
      try {
        const identity = await resolveAccount(number);
        if (!identity?.accountId) return []; // resolver miss → real "no data", not an outage
        const rows = await fetchAccountFunding(identity.accountId, { startDate });
        // Tag each row with its SOURCE account number (the human-readable
        // custodian number, not the ULID) for the client-wide events table.
        return rows.map((r) => ({ ...r, account: number }));
      } catch {
        // Resolve/fetch transport failure for one account — the data layer
        // already logged a static marker/status. Mark it as an outage.
        return OUTAGE;
      }
    }),
  );

  // If we attempted ≥1 account and EVERY one hit a transport failure, this is an
  // outage, not a $0-funding client — throw so the caller shows "unavailable".
  const failures = perAccount.filter((r) => r === OUTAGE).length;
  if (numbers.length > 0 && failures === numbers.length) {
    throw fundingError("warehouse_error", "all client funding accounts failed");
  }

  const merged = perAccount
    .filter((r): r is FundingRow[] => r !== OUTAGE)
    .flat();
  return summarizeFunding(merged, asOfIso);
}
