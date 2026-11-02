import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { INGEST_RISK_FREE_RATE, writeAudit } from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { normalizeRates } from "@/lib/ingest/risk-free-rate";
import { RF_SOURCE, RF_TENOR } from "@/lib/twr/risk-free-rate";

// Node runtime: crypto (run id) + Prisma. Risk-free-rate ingest.
//
// WHY: the performance reports' Sharpe ratio used a risk-free rate HARD-CODED at
// two call sites (lib/twr/warehouse.ts, lib/twr/household.ts). It went ~30bp stale
// and a compliance review flagged it as the one manually-maintained assumption in
// the calculation path. This route makes the rate DATA. AOA does NOT call Treasury
// — n8n fetches the CSV and POSTs it here (the house pattern), so report
// generation reads only stored rows and stays reproducible.
//
// SOURCE: US Treasury "Daily Treasury Par Yield Curve Rates", the "3 Mo" column:
//   https://home.treasury.gov/resource-center/data-chart-center/interest-rates/
//     daily-treasury-rates.csv/<year>/all?type=daily_treasury_yield_curve
//     &field_tdr_date_value=<year>&page&_format=csv
// Header `Date,"1 Mo","1.5 Month","2 Mo","3 Mo",...`; rows like
// `07/28/2026,3.76,3.86,3.90,3.90,...` — one row per business day.
//
// CONTRACT (the n8n workflow is built against exactly this):
//   POST /api/ingest/risk-free-rate[?dryRun=1]
//   Authorization: Bearer <INGEST_TOKEN>
//   Content-Type: application/json
//   {
//     "source": "us-treasury-daily-par-yield",   // OPTIONAL, this is the default
//     "tenor":  "3M",                            // OPTIONAL, this is the default
//     "rates": [
//       { "date": "2026-07-28", "ratePct": 3.90 },   // ISO date
//       { "date": "07/27/2026", "ratePct": 3.89 },   // Treasury's native MM/DD/YYYY
//       { "date": "2026-07-24", "ratePct": null }    // blank cell → SKIPPED, not 0
//     ]
//   }
//   `ratePct` is a PERCENT — 3.90 means 3.90%, NOT 0.0390. Send the CSV cell
//   verbatim; do no arithmetic in n8n.
//
//   200 → { upserted, skipped, rejected, source, tenor, from, to }
//   200 (dryRun=1) → { would_upsert, skipped, rejected, source, tenor, from, to }
//   401 unauthorized · 400 bad_request/invalid_json · 413 too_large ·
//   422 no_valid_rates · 405 method_not_allowed · 500 internal
//
// UPSERT BY DATE — never a full replace. This is an append-only time series:
// history is immutable, a published business day never disappears, and a Treasury
// revision is an UPDATE of that one date. `ingest_rw` has NO DELETE grant on the
// table (see the 20260802000000_mirror_risk_free_rate migration), so the route
// physically cannot wipe history. Re-POSTing the same year is idempotent.
//
// NO-LOG: nothing here logs payload contents. There is no PII in public market
// data, but the rule is absolute and the logs stay counts-only regardless.
export const runtime = "nodejs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
// ~250 business days a year ⇒ 5,000 rows is about twenty years of history in one
// POST, far more than the "current year + last year" the workflow actually sends.
const MAX_ITEMS = 5000;

const err = (error: string, status: number) => Response.json({ error }, { status });
function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

export async function POST(req: Request): Promise<Response> {
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) return err("too_large", 413);
  }

  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return err("too_large", 413);
  let body: { source?: unknown; tenor?: unknown; rates?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return err("invalid_json", 400);
  }
  if (typeof body !== "object" || body === null) return err("bad_request", 400);

  const source =
    typeof body.source === "string" && body.source.trim() !== ""
      ? body.source.trim()
      : RF_SOURCE;
  const tenor =
    typeof body.tenor === "string" && body.tenor.trim() !== ""
      ? body.tenor.trim()
      : RF_TENOR;
  if (!Array.isArray(body.rates)) return err("bad_request", 400);
  // Row cap BEFORE per-item work.
  if (body.rates.length > MAX_ITEMS) return err("too_large", 413);

  const { rows, skipped, rejected } = normalizeRates(body.rates);
  // A payload that yields no storable row is a 422 NO-OP. Upsert-by-date could
  // not damage anything anyway, but an explicit 422 makes a broken upstream
  // (empty CSV, renamed column, changed date format) loud instead of a silent 200.
  if (rows.length === 0) return err("no_valid_rates", 422);

  // Received count derived from the NORMALIZER's own buckets, never re-read off
  // the request body: normalizeRates puts every input item in exactly one of
  // rows / skipped / rejected (each branch continues), so this equals the
  // payload length. Computing it here keeps `body.*` out of the log statement
  // and the audit detail below — security scanner SAST flags untrusted request data reaching
  // a log call (CWE-117 log injection) even when the value is a length.
  const received = rows.length + skipped + rejected;

  const from = rows[0].rateDate;
  const to = rows[rows.length - 1].rateDate;
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const runId = crypto.randomUUID();
  const safeRunId = encodeURIComponent(runId).slice(0, 256);

  // Counts-only anomaly marker (no dates, no values) so a systematically broken
  // payload is visible in logs without echoing anything the caller sent.
  if (rejected > 0) {
    console.warn(
      `[ingest:risk-free-rate] run_id=${safeRunId} rejected=${rejected} of ${received}`,
    );
  }

  try {
    await withIngestScope(async (tx) => {
      if (!dryRun) {
        for (const r of rows) {
          // Upsert by rate_date. rate_pct is written as text and cast in SQL so
          // the numeric(5,2) column parses the decimal exactly — no float
          // round-trip on a value the report later discloses.
          await tx.$executeRaw`
            INSERT INTO mirror.risk_free_rate
              (rate_date, tenor, rate_pct, source, synced_at)
            VALUES
              (${r.rateDate}::date, ${tenor}, ${String(r.ratePct)}::numeric,
               ${source}, now())
            ON CONFLICT (rate_date) DO UPDATE SET
              tenor     = EXCLUDED.tenor,
              rate_pct  = EXCLUDED.rate_pct,
              source    = EXCLUDED.source,
              synced_at = now()`;
        }
      }
      await writeAudit(
        tx as Prisma.TransactionClient,
        { role: "INGEST", email: null },
        {
          action: INGEST_RISK_FREE_RATE,
          entityType: "ingest_run",
          entityId: runId,
          detail: {
            source,
            tenor,
            received,
            upserted: rows.length,
            skipped,
            rejected,
            from,
            to,
            dry_run: dryRun,
          },
        },
      );
    });
  } catch {
    console.error(`[ingest:risk-free-rate] run_id=${safeRunId} tx_failed`);
    return err("internal", 500);
  }

  const shape = { skipped, rejected, source, tenor, from, to };
  return Response.json(
    dryRun ? { would_upsert: rows.length, ...shape } : { upserted: rows.length, ...shape },
  );
}
