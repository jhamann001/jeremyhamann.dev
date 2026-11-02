// Pure normalizers for the risk-free-rate ingest (US Treasury daily par yield
// curve, "3 Mo" column). Lives OUTSIDE the route module because Next.js rejects
// non-Route exports from a route file, and these rules deserve direct unit tests
// (the deal-merge.ts / validate.ts idiom — hand-rolled, no new runtime deps).
//
// THE RULE THAT MATTERS MOST: a BLANK Treasury cell must NEVER become 0.00%.
// Treasury emits empty cells for tenors/rows it did not publish. Storing a blank
// as zero would drag the window average toward 0 and silently overstate every
// Sharpe ratio computed over that window. A blank is SKIPPED — the day simply has
// no rate, which the coverage rule then accounts for honestly.

/** Accepted rate range, in PERCENT. Generous on both ends: the 3-month bill has
 *  printed ~17% (1981) and the short end has occasionally gone slightly negative,
 *  but nothing outside this is a plausible par yield. */
export const RATE_PCT_MIN = -25;
export const RATE_PCT_MAX = 100;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function isRealDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return (
    t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
  );
}

const iso = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * Defensive date parse → YYYY-MM-DD, or null when the value is not a real
 * calendar date. BOTH shapes are accepted on purpose:
 *   • `MM/DD/YYYY` — Treasury's native CSV format (`07/28/2026`), so an n8n
 *     workflow can forward the column verbatim with no date arithmetic.
 *   • `YYYY-MM-DD` — the ISO form every other AOA feed uses.
 * Rejects impossible dates (`02/30/2026`), non-strings, and anything else. There
 * is no "best effort" fallback: an unparseable date is a rejected row, never a
 * guessed one — a mis-dated rate would corrupt the window average silently.
 */
export function parseRateDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const isoM = ISO_DATE.exec(s);
  if (isoM) {
    const [y, m, d] = [+isoM[1], +isoM[2], +isoM[3]];
    return isRealDate(y, m, d) ? iso(y, m, d) : null;
  }
  const usM = US_DATE.exec(s);
  if (usM) {
    const [m, d, y] = [+usM[1], +usM[2], +usM[3]];
    return isRealDate(y, m, d) ? iso(y, m, d) : null;
  }
  return null;
}

/** How many decimal places a finite number carries, up to the 2 we care about. */
function hasMoreThanTwoDecimals(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) > 1e-9;
}

export type RateParse =
  | { kind: "ok"; ratePct: number }
  /** Treasury published no value for this cell — the day has no rate. */
  | { kind: "blank" }
  /** Present but unusable: non-numeric, non-finite, out of range, or wrong scale. */
  | { kind: "bad" };

/**
 * Parse one rate cell. The value is a PERCENT (3.9 ⇒ 3.90%), matching the source
 * CSV exactly so the feed does no arithmetic.
 *
 * `null` / `undefined` / `""` / whitespace ⇒ "blank" (SKIPPED, never 0).
 *
 * SCALE GUARD: a value below 1.0 carrying more than two decimals is rejected as
 * "bad". Treasury publishes exactly two decimals, so extra precision means the
 * payload was transformed — and the transformation to fear is a percent→decimal
 * division (3.90% arriving as 0.039), which would store a plausible-looking
 * 0.04% and understate the risk-free rate by ~100×. Residual hole, accepted: a
 * whole-number rate (4.00 → 0.04) survives the guard. The report DISCLOSES the
 * averaged rate, so such a value is visible to any reader rather than hidden.
 */
export function parseRatePct(v: unknown): RateParse {
  if (v === null || v === undefined) return { kind: "blank" };
  if (typeof v === "string" && v.trim() === "") return { kind: "blank" };
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (typeof n !== "number" || !Number.isFinite(n)) return { kind: "bad" };
  if (n < RATE_PCT_MIN || n > RATE_PCT_MAX) return { kind: "bad" };
  if (Math.abs(n) < 1 && hasMoreThanTwoDecimals(n)) return { kind: "bad" };
  return { kind: "ok", ratePct: n };
}

/** One normalized row ready to upsert. */
export type RateRow = { rateDate: string; ratePct: number };

export type NormalizedRates = {
  rows: RateRow[];
  /** Blank cells — expected and benign (Treasury leaves cells empty). */
  skipped: number;
  /** Unusable rows: bad date, non-numeric/non-finite/out-of-range/mis-scaled
   *  rate, or a duplicate date within the batch. Counted, never echoed. */
  rejected: number;
};

/**
 * Normalize the payload's `rates` array. One bad row NEVER aborts the batch (the
 * house invariant) — it is counted and dropped.
 *
 * Duplicate dates within a batch are anomalous (the CSV carries one row per
 * business day), so the FIRST occurrence wins and later ones count as rejected
 * rather than quietly overwriting. Rows come back sorted by date so the response
 * `from`/`to` describe the real span.
 */
export function normalizeRates(items: unknown[]): NormalizedRates {
  const rows: RateRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let rejected = 0;
  for (const it of items) {
    if (typeof it !== "object" || it === null || Array.isArray(it)) {
      rejected++;
      continue;
    }
    const rec = it as Record<string, unknown>;
    const rateDate = parseRateDate(rec.date);
    if (!rateDate) {
      rejected++;
      continue;
    }
    const parsed = parseRatePct(rec.ratePct);
    if (parsed.kind === "blank") {
      skipped++;
      continue;
    }
    if (parsed.kind === "bad") {
      rejected++;
      continue;
    }
    if (seen.has(rateDate)) {
      rejected++;
      continue;
    }
    seen.add(rateDate);
    rows.push({ rateDate, ratePct: parsed.ratePct });
  }
  rows.sort((a, b) => a.rateDate.localeCompare(b.rateDate));
  return { rows, skipped, rejected };
}
