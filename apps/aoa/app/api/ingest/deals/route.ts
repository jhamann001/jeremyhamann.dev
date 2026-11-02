import type { Prisma } from "@prisma/client";
import { INGEST_DEALS, writeAudit } from "@/lib/audit";
import type {
  DealInput,
  DealStage,
  StageHistoryEntry,
} from "@/lib/data/deal-types";
import { dealInputToDbData } from "@/lib/deals/import-csv";
import { requireIngestToken } from "@/lib/ingest/auth";
import { mergeStage } from "@/lib/ingest/deal-merge";
import { withIngestScope } from "@/lib/ingest/scope";
import { logIngestSuccess } from "@/lib/observability/structured-log";
import type {
  IngestDryRunResponse,
  IngestErrorBody,
  IngestLiveResponse,
  RejectedItem,
} from "@/lib/ingest/types";
import { validateDealsItem, validateEnvelope } from "@/lib/ingest/validate";

// Node runtime: crypto (auth) + Prisma. Plain POST handler, no intercepting/
// parallel routes. The FIRST ingest writer into an app-owned table (app.deal):
// same skeleton as the activity/emails routes, but the persistence step is a
// Prisma upsert (not raw SQL) so the stage-merge + stage_history append read as
// plain TS across app.deal's ~25 columns. The DB side is the new
// 20260711000000_app_deal_ingest migration (grants + `deal_ingest_all` RLS).
export const runtime = "nodejs";

const MAX_ITEMS = 5000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const err = (error: IngestErrorBody["error"], status: number) =>
  Response.json({ error } satisfies IngestErrorBody, { status });

// Shared 405 helper — guarantees the TDD §8 body rather than Next's default.
// NOT exported (Next.js rejects non-Route exports from a route module); the
// HTTP-verb exports below are the public surface and each returns this body.
function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

// jsonb comes back from Prisma as JsonValue — narrow it once, defensively (the
// D3 server-actions idiom in app/(authenticated)/deals/actions.ts).
const asStageHistory = (v: unknown): StageHistoryEntry[] =>
  Array.isArray(v) ? (v as StageHistoryEntry[]) : [];

export async function POST(req: Request): Promise<Response> {
  // 1. Auth.
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  // 2. Parse + body-size cap.
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) return err("too_large", 413);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("bad_request", 400);
  }
  if (Buffer.byteLength(JSON.stringify(body ?? null)) > MAX_BODY_BYTES)
    return err("too_large", 413);

  // 3. Envelope.
  const parsed = validateEnvelope(body);
  if (!parsed.ok) return err("bad_request", 400);
  const { source, run_id, items } = parsed.envelope;

  // 4. Item-count cap BEFORE per-item work.
  if (items.length > MAX_ITEMS) return err("too_large", 413);

  // 5. Per-item mapping + validation — each item is a RAW CRM report-row
  //    object (keyed by the report's CSV column headers, as n8n's
  //    extractFromFile emits). validateDealsItem MAPS the row → DealInput via
  //    the app's shared importer (reportRecordFromObject → mapReportRow) and
  //    runs the mapped row through the FROZEN validateDealInput; it returns the
  //    mapped DealInput (ok) or a PII-free RejectedItem. One bad row never
  //    aborts the batch.
  const rejected: RejectedItem[] = [];
  const okItems: DealInput[] = [];
  items.forEach((it, i) => {
    // The map+validate runs OUTSIDE the persistence try/catch below, so a throw
    // here (e.g. a future non-total coercion in the shared mapper on arbitrary
    // JSON) would 500 with Next's default, UNsanitized response and no audit
    // row — and abort the whole batch. Guard each item so a thrown error is a
    // clean per-item `item_malformed` rejection, upholding the "one bad row
    // never aborts the batch" invariant. Today mapReportRow is provably
    // non-throwing on JSON input; this is defense-in-depth.
    try {
      const r = validateDealsItem(it, i);
      if (r.ok) okItems.push(r.deal);
      else rejected.push(r.rejected);
    } catch {
      rejected.push({ index: i, reason: "item_malformed" });
    }
  });

  // 6. dryRun.
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  // 7. Persist in ONE transaction. Live: batch-read existing stages, then one
  //    merge-aware upsert per item; then the audit row. dryRun: audit ONLY.
  //
  //    CONCURRENCY (accepted): unlike mirror.* — where scope.ts's "ingest_rw is
  //    the SOLE writer" holds — app.deal is ALSO written by app_rw (the D3
  //    advisor stage promotions). The stage-merge reads a PRE-WRITE snapshot
  //    (the findMany below), so an advisor promotion committed DURING the import
  //    window (between this snapshot and a given row's upsert) could be reverted
  //    by a non-terminal import with NO history entry. Accepted because this
  //    feed runs on an off-hours nightly-style schedule with negligible
  //    concurrent advisor writes. If that changes, replace snapshot-then-write
  //    with an SQL-side atomic merge (INSERT … ON CONFLICT DO UPDATE SET
  //    stage = CASE WHEN EXCLUDED.stage IN ('WON','LOST') THEN EXCLUDED.stage
  //    ELSE deal.stage END) or a per-row SELECT … FOR UPDATE.
  try {
    await withIngestScope(async (tx) => {
      if (!dryRun) {
        // Batch-fetch the stored stage (+ timeline for the append base) for
        // every incoming sf_deal_id in ONE query. NOTE: this Map is NOT updated
        // between upserts, so a batch carrying DUPLICATE sf_deal_ids would lose
        // the intermediate stage_history entry and double-count `upserted`.
        // Accepted because sf_deal_id is the Salesforce PK (unique per export).
        const sfIds = okItems
          .map((it) => it.sf_deal_id)
          .filter((id): id is string => !!id);
        const existingRows =
          sfIds.length === 0
            ? []
            : await tx.deal.findMany({
                where: { sf_deal_id: { in: sfIds } },
                select: { sf_deal_id: true, stage: true, stage_history: true },
              });
        const existingBySfId = new Map(
          existingRows.map((r) => [r.sf_deal_id as string, r]),
        );

        // One `at` for the whole run — the run is a single logical event.
        const at = new Date().toISOString();
        for (const item of okItems) {
          const sfDealId = item.sf_deal_id as string;
          const existing = existingBySfId.get(sfDealId);
          const existingStage = (existing?.stage ?? null) as DealStage | null;
          const incoming = item.stage;
          const { stage: effectiveStage, changed } = mergeStage(
            incoming,
            existingStage,
          );

          // Match the D3 append convention ({stage, from, at, by}); `by` is the
          // run's source (the stable import marker) — there is no acting user.
          const entry: StageHistoryEntry = {
            stage: effectiveStage,
            from: existingStage,
            at,
            by: source,
          };
          const prevHistory = existing
            ? asStageHistory(existing.stage_history)
            : [];

          // dealInputToDbData is the SAME create/update field set the D4 import
          // writes (it deliberately omits stage_history / lost_from / archived_*
          // — app-owned fields the import must not clobber). On create: stage =
          // incoming (already set by dealInputToDbData) + the opening timeline
          // entry. On update: stage = effectiveStage (NOT raw incoming) + append
          // to the STORED timeline only when the stage actually changed.
          const data = dealInputToDbData(item);
          await tx.deal.upsert({
            where: { sf_deal_id: sfDealId },
            create: { ...data, stage_history: [entry] },
            update: {
              ...data,
              stage: effectiveStage,
              ...(changed
                ? { stage_history: [...prevHistory, entry] }
                : {}),
            },
          });
        }
      }

      // Same-tx audit row (ADR-8), counts only. upserted = okItems.length (ITEM
      // count — the frozen invariant is items.length − rejected.length).
      await writeAudit(
        tx as Prisma.TransactionClient,
        { role: "INGEST", email: null },
        {
          action: INGEST_DEALS,
          entityType: "ingest_run",
          entityId: run_id,
          detail: {
            source,
            endpoint: "deals",
            received: items.length,
            upserted: okItems.length,
            rejected: rejected.length,
            dry_run: dryRun,
          },
        },
      );
    });
  } catch {
    // Sanitize run_id before logging — it is user-controlled envelope input, so
    // URL-encode it (neutralizes newlines/control chars, the log-injection
    // vector the SAST recognizes as a CWE-117 sanitizer).
    const safeRunId = encodeURIComponent(run_id).slice(0, 256);
    console.error(`[ingest] deals run_id=${safeRunId} tx_failed`);
    return err("internal", 500);
  }

  // 8. Response. upserted/would_upsert = okItems.length (item count).
  if (dryRun) {
    return Response.json({
      would_upsert: okItems.length,
      rejected,
      run_id,
    } satisfies IngestDryRunResponse);
  }
  if (rejected.length === 0) logIngestSuccess("deals");
  return Response.json({
    upserted: okItems.length,
    rejected,
    run_id,
  } satisfies IngestLiveResponse);
}
