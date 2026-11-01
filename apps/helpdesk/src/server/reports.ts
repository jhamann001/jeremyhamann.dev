/**
 * Desk metrics — node only, layer L4, a plain read module.
 *
 * Ten reports over the same three promises:
 *
 *  1. **Nothing counts a VOIDED ticket.** Every query applies `status NOT IN METRICS_EXCLUDED_STATUSES`
 *    . A ticket entered in error never happened; counting it as volume, as backlog or as
 *     a breach would make the desk's own numbers wrong in the direction that flatters nobody. The dev
 *     seed carries a VOIDED ticket that is BREACHED on its raw timers precisely so a surface that
 *     forgets shows it immediately, and `reports.integration.test.ts` asserts the exclusion directly.
 *  2. **Rows are bounded by the viewer's READABLE queues**, exactly as `listTickets` and the ticket
 *     export are. `reports:read` means "may open the page"; what the numbers cover is narrowed again
 *     here, per query, by queue id. A viewer with no readable queue gets an empty report, not an error.
 *  3. **Every bucket is a firm-local period**. `date_trunc` runs on
 *     `("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York'` — the columns are
 *     `timestamp(3) without time zone` holding UTC, so the first conversion attaches the zone the value
 *     is IN and the second moves it to the zone the desk READS. One `AT TIME ZONE` would silently
 *     re-label UTC as Eastern and move every evening ticket a day.
 *
 * Percentiles use a **tagged-template `$queryRaw`** — never `$queryRawUnsafe` — because
 * `percentile_cont` has no Prisma equivalent and an average of daily medians is not a median. Counts,
 * groupings by enum and "how many right now" stay on the Prisma client, which is where the readable-
 * queue filter is hardest to get wrong. Every raw query has a FIXED shape: optional filters travel as
 * arrays with a `cardinality(…) = 0 OR …` guard rather than as string concatenation, so there is one
 * statement per report and no branch of it is ever built from text. Every range BOUND in those queries
 * goes through `sqlInstant` and a `::timestamp` cast — a bare `Date` is bound as `timestamptz`, which
 * makes Postgres re-read the stored UTC column through the session zone. See that helper.
 *
 * A report PAGE writes no audit row: it is aggregate counts over rows the viewer can already list, and
 * §e's definition of a view does not reach it (CONTRACT §3.3 rule 5). A report EXPORT does — `reportCsv`
 * awaits `REPORT_EXPORTED` before the first byte, like `TICKET_LIST_EXPORTED`.
 *
 * Two honest limits, stated rather than papered over:
 *  - **Backlog and SLA history are read from the ticket's CURRENT timestamps.** A ticket that was
 *    resolved and later reopened has had `resolvedAt` cleared (`changeTicketStatus`), so it reads as
 *    never-resolved at every past edge. The reopen-rate report is where that movement is visible, and
 *    it reads the ledger, which does keep both halves.
 *  - **`warningMinutes` is not applied here.** These reports count breaches (a clock passed), not
 *    warnings (a clock is about to pass), so the per-priority warning band B4 made editable changes no
 *    number on this page.
 */
import type { Prisma } from "@prisma/client";
import type {
  QueueKey,
  ReportGranularity,
  ReportKey,
  ReportQuery,
  ReportResult,
  ReportRow,
  RequestContext,
  TicketCategory,
  TicketResolution,
  Viewer,
} from "@/types/domain";
import {
  CATEGORY_LABELS,
  METRICS_EXCLUDED_STATUSES,
  OPEN_STATUSES,
  QUEUE_LABELS,
  RESOLUTION_LABELS,
  TICKET_RESOLUTIONS,
} from "@/types/domain";
import { prisma } from "@/lib/db";
import { actorFromViewer, writeAudit } from "@/lib/audit";
import { FIRM_TIME_ZONE } from "@/lib/firm-time";
import { logWarn } from "@/lib/logger";
import { canAdminWebhooks, canReviewHeldIntake, readableQueues } from "@/lib/rbac";
import { csvCell } from "@/server/audit-export";
import { breachedOpenWhere } from "@/server/sla-where";
import type { ExtendedReportKey, ExtendedReportQuery, ExtendedReportResult, ReportBucket, ReportRange } from "@/server/reports-query";
import {
  EXTENDED_REPORT_LABELS,
  isContractReportKey,
  reportBuckets,
  reportFilters,
  resolveRange,
} from "@/server/reports-query";

export type {
  ExtendedReportKey,
  ExtendedReportQuery,
  ExtendedReportResult,
  ReportBucket,
  ReportRange,
} from "@/server/reports-query";

/**
 * CONTRACT §10 B7. The declared type is the eight contract keys; the stored map additionally carries
 * B7's two extra keys (see the deviation note in `reports-query.ts`), which is why the narrowing
 * annotation is here rather than a second literal that could drift from the first.
 */
export const REPORT_LABELS: Readonly<Record<ReportKey, string>> = EXTENDED_REPORT_LABELS;

/** RFC 4180 line terminator, as in every other export in this repository. */
const CRLF = "\r\n";

/** Anything slower than this is logged with the request id rather than silently tolerated. */
const SLOW_REPORT_MS = 2_000;

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

type Scope = {
  /** Queue ids the viewer may read AND asked for. Empty ⇒ every count is zero. */
  queueIds: string[];
  keyById: Map<string, QueueKey>;
  /** Queue keys in scope, in QUEUE_KEYS order. */
  keys: QueueKey[];
  range: ReportRange;
  buckets: ReportBucket[];
  granularity: ReportGranularity;
  /** Empty array = "every value" for the raw-SQL guards. */
  priorities: string[];
  categories: string[];
  now: Date;
};

const EXCLUDED_STATUSES: string[] = [...METRICS_EXCLUDED_STATUSES];

async function resolveScope(viewer: Viewer, query: ExtendedReportQuery, now: Date): Promise<Scope> {
  const readable = readableQueues(viewer.groups);
  const requested = query.queueKey !== undefined && query.queueKey.length > 0 ? query.queueKey : readable;
  const wanted = new Set(requested.filter((k) => readable.includes(k)));

  const rows = await prisma.queue.findMany({ select: { id: true, key: true } });
  const inScope = rows.filter((r) => wanted.has(r.key));
  const range = resolveRange(query);

  return {
    queueIds: inScope.map((r) => r.id),
    keyById: new Map(inScope.map((r) => [r.id, r.key] as const)),
    keys: readable.filter((k) => wanted.has(k)),
    range,
    buckets: reportBuckets(range, query.granularity),
    granularity: query.granularity,
    priorities: query.priority !== undefined ? [...query.priority] : [],
    categories: query.category !== undefined ? [...query.category] : [],
    now,
  };
}

/**
 * The Prisma half of the scope — identical in meaning to the SQL guards further down, and written
 * long-hand because Prisma's generated enum filters do not accept a widened `string[]`.
 */
function scopedWhere(scope: Scope, extra?: Prisma.TicketWhereInput): Prisma.TicketWhereInput {
  const and: Prisma.TicketWhereInput[] = [
    { queueId: { in: scope.queueIds }, status: { notIn: [...METRICS_EXCLUDED_STATUSES] } },
  ];
  if (scope.priorities.length > 0) {
    and.push({ priority: { in: scope.priorities as Prisma.EnumTicketPriorityFilter["in"] } });
  }
  if (scope.categories.length > 0) {
    and.push({ category: { in: scope.categories as Prisma.EnumTicketCategoryFilter["in"] } });
  }
  if (extra !== undefined) and.push(extra);
  return { AND: and };
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function round2(n: number | null | undefined): number {
  if (n === null || n === undefined || !Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function pct(part: number, whole: number): number {
  return whole <= 0 ? 0 : round2((part / whole) * 100);
}

/**
 * A range bound, as a literal an untyped `$queryRaw` parameter cannot misread.
 *
 * The timestamp columns are `timestamp(3) WITHOUT TIME ZONE` holding UTC. Binding a JS `Date` into a
 * tagged template sends it as `timestamptz`, and Postgres resolves `timestamp >= timestamptz` by
 * promoting the COLUMN through the session `TimeZone` — so the same predicate reads a different window
 * on a session set to `America/New_York` (the local cluster) than on one set to UTC (Cloud SQL). The
 * Prisma-built half of every report compares in UTC unconditionally, so the two halves of one report
 * answered two questions four or five hours apart, and the headline total, the buckets and the
 * per-queue split were three different numbers.
 *
 * Sending the instant as ISO text and casting it to `timestamp` in SQL makes both halves compare naive
 * UTC to naive UTC, on every cluster, whatever the session zone. `backlogReport` already did this
 * (`unnest(... ::text[]::timestamp[])`), which is why backlog and volume disagreed with each other.
 * Bucketing still converts to the firm zone — that is `date_trunc`'s job, and it is unaffected.
 */
function sqlInstant(at: Date): string {
  return at.toISOString();
}

/** `timestamp` values come back as a Date whose UTC parts ARE the firm-local wall clock (see header). */
function bucketKeyOf(value: Date | string): string {
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? "" : at.toISOString().slice(0, 10);
}

function emptyValues(series: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of series) out[s] = 0;
  return out;
}

type BuiltReport = { series: string[]; rows: ReportRow[]; totals: Record<string, number> };

/** One row per bucket, in order, with zeros for the periods nothing happened in. */
function rowsFromBuckets(
  scope: Scope,
  series: readonly string[],
  fill: (bucket: ReportBucket) => Record<string, number>,
): ReportRow[] {
  return scope.buckets.map((b) => ({ bucket: b.key, label: b.label, values: { ...emptyValues(series), ...fill(b) } }));
}

// ---------------------------------------------------------------------------
// Raw building blocks
// ---------------------------------------------------------------------------

/** Tickets RESOLVED per firm-local period (bucketed on when they were resolved, not when they arrived). */
async function resolvedPerBucket(scope: Scope): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ bucket: Date; n: number }>>`
    SELECT date_trunc(${scope.granularity}, (t."resolvedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${FIRM_TIME_ZONE}) AS bucket,
           count(*)::int AS n
      FROM "Ticket" t
     WHERE t."resolvedAt" IS NOT NULL
       AND t."resolvedAt" >= ${sqlInstant(scope.range.fromAt)}::timestamp
       AND t."resolvedAt" < ${sqlInstant(scope.range.toAt)}::timestamp
       AND t."queueId" = ANY(${scope.queueIds}::text[])
       AND t.status::text <> ALL(${EXCLUDED_STATUSES}::text[])
       AND (cardinality(${scope.priorities}::text[]) = 0 OR t.priority::text = ANY(${scope.priorities}::text[]))
       AND (cardinality(${scope.categories}::text[]) = 0 OR t.category::text = ANY(${scope.categories}::text[]))
     GROUP BY 1`;
  return new Map(rows.map((r) => [bucketKeyOf(r.bucket), r.n] as const));
}

// ---------------------------------------------------------------------------
// The reports
// ---------------------------------------------------------------------------

/**
 * One cell of the volume report: a count for one firm-local bucket, and — for the `created` half —
 * for one queue. `kind` is the discriminator of the UNION below; `queueId` is NULL on the `resolved`
 * half, which has no per-queue column to feed.
 */
type VolumeCell = { kind: string; bucket: Date; queueId: string | null; n: number; complaints: number };

/**
 * Everything the volume report counts, in ONE statement (see `volumeReport` for why one).
 *
 * Two aggregates over `Ticket` under one UNION ALL: tickets CREATED in the range, grouped by
 * firm-local bucket AND by queue, with the complaint count carried alongside; and tickets RESOLVED in
 * the range, grouped by firm-local bucket (bucketed on when they were resolved, not when they
 * arrived). Both halves apply the identical scope guards, so the three renderings the CSV prints —
 * the headline, the daily rows and the per-queue split — are three foldings of one result set rather
 * than three answers to three questions.
 */
async function volumeCells(scope: Scope): Promise<VolumeCell[]> {
  return prisma.$queryRaw<VolumeCell[]>`
    SELECT 'created'::text AS kind,
           date_trunc(${scope.granularity}, (t."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${FIRM_TIME_ZONE}) AS bucket,
           t."queueId" AS "queueId",
           count(*)::int AS n,
           count(*) FILTER (WHERE t."isComplaint")::int AS complaints
      FROM "Ticket" t
     WHERE t."createdAt" >= ${sqlInstant(scope.range.fromAt)}::timestamp
       AND t."createdAt" < ${sqlInstant(scope.range.toAt)}::timestamp
       AND t."queueId" = ANY(${scope.queueIds}::text[])
       AND t.status::text <> ALL(${EXCLUDED_STATUSES}::text[])
       AND (cardinality(${scope.priorities}::text[]) = 0 OR t.priority::text = ANY(${scope.priorities}::text[]))
       AND (cardinality(${scope.categories}::text[]) = 0 OR t.category::text = ANY(${scope.categories}::text[]))
     GROUP BY 2, t."queueId"
    UNION ALL
    SELECT 'resolved'::text AS kind,
           date_trunc(${scope.granularity}, (t."resolvedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${FIRM_TIME_ZONE}) AS bucket,
           NULL::text AS "queueId",
           count(*)::int AS n,
           0::int AS complaints
      FROM "Ticket" t
     WHERE t."resolvedAt" IS NOT NULL
       AND t."resolvedAt" >= ${sqlInstant(scope.range.fromAt)}::timestamp
       AND t."resolvedAt" < ${sqlInstant(scope.range.toAt)}::timestamp
       AND t."queueId" = ANY(${scope.queueIds}::text[])
       AND t.status::text <> ALL(${EXCLUDED_STATUSES}::text[])
       AND (cardinality(${scope.priorities}::text[]) = 0 OR t.priority::text = ANY(${scope.priorities}::text[]))
       AND (cardinality(${scope.categories}::text[]) = 0 OR t.category::text = ANY(${scope.categories}::text[]))
     GROUP BY 2`;
}

/**
 * Tickets created and resolved per firm-local period, with the whole-range totals and the per-queue
 * split of `created`.
 *
 * **The TOTAL row is the sum of the rows printed above it, by construction.** It used to be three
 * separate statements — a bucketed raw count, a bucketed raw count of resolutions, and a Prisma
 * `groupBy` for the per-queue split — issued concurrently through `Promise.all`. Three statements are
 * three READ COMMITTED snapshots: a ticket inserted while the report was running was counted by
 * whichever of them had not run yet, and the CSV then carried a headline `created` that its own daily
 * buckets and its own `created.<queue>` columns did not sum to. That is not a rounding difference an
 * auditor forgives — it is the same file contradicting itself, and it was observed on the dev desk
 * (38 against 37 and 37) while other work was writing tickets.
 *
 * So: ONE statement, one snapshot, and one arithmetic path. `created` is folded out of the same cells
 * twice — once per bucket for the rows, once per queue for the split — and the headline is the sum of
 * the rendered rows rather than a fourth independent reading. A bucket the database returns that the
 * range did not ask for (which the range guard already makes impossible, and which
 * `reports.integration.test.ts` pins) can no longer reach the headline without a row to stand on: it
 * is dropped from BOTH, loudly, instead of from the rows alone.
 */
async function volumeReport(scope: Scope): Promise<BuiltReport> {
  const series = ["created", "resolved"];
  const cells = await volumeCells(scope);

  const known = new Set(scope.buckets.map((b) => b.key));
  const createdByBucket = new Map<string, number>();
  const resolvedByBucket = new Map<string, number>();
  const complaintsByBucket = new Map<string, number>();
  const createdByQueue = new Map<string, number>();

  for (const cell of cells) {
    const key = bucketKeyOf(cell.bucket);
    if (!known.has(key)) {
      // Unreachable while the range bounds and the bucket edges are derived from the same range.
      // Said out loud rather than absorbed, because absorbing it silently is what produced a total
      // that disagreed with its own rows.
      logWarn("reports", "volume_bucket_outside_range", {
        bucket: key,
        from: scope.range.fromDate,
        to: scope.range.toDate,
        granularity: scope.granularity,
      });
      continue;
    }
    if (cell.kind === "resolved") {
      resolvedByBucket.set(key, (resolvedByBucket.get(key) ?? 0) + cell.n);
      continue;
    }
    createdByBucket.set(key, (createdByBucket.get(key) ?? 0) + cell.n);
    complaintsByBucket.set(key, (complaintsByBucket.get(key) ?? 0) + cell.complaints);
    if (cell.queueId !== null) {
      createdByQueue.set(cell.queueId, (createdByQueue.get(cell.queueId) ?? 0) + cell.n);
    }
  }

  const rows = rowsFromBuckets(scope, series, (b) => ({
    created: createdByBucket.get(b.key) ?? 0,
    resolved: resolvedByBucket.get(b.key) ?? 0,
  }));

  const totals: Record<string, number> = {
    created: rows.reduce((a, r) => a + r.values.created, 0),
    resolved: rows.reduce((a, r) => a + r.values.resolved, 0),
    complaints: scope.buckets.reduce((a, b) => a + (complaintsByBucket.get(b.key) ?? 0), 0),
  };
  totals.net = totals.created - totals.resolved;
  for (const [queueId, n] of createdByQueue) {
    const key = scope.keyById.get(queueId);
    if (key !== undefined) totals[`created.${key}`] = n;
  }
  return { series, rows, totals };
}

async function backlogReport(scope: Scope): Promise<BuiltReport> {
  const series = ["backlog", "breached"];
  if (scope.buckets.length === 0) return { series, rows: [], totals: { current: 0, peak: 0, breached: 0 } };

  // One edge per bucket: the instant the period ENDS, never later than the range or than now — a
  // backlog reading for a moment that has not happened yet is not a reading.
  const ceiling = Math.min(scope.range.toAt.getTime(), scope.now.getTime());
  const edges = scope.buckets.map((b) => sqlInstant(new Date(Math.min(b.end.getTime(), ceiling))));

  const rows = await prisma.$queryRaw<Array<{ edge: Date; backlog: number; breached: number }>>`
    SELECT e.edge,
           count(t.id)::int AS backlog,
           count(t.id) FILTER (
             WHERE (t."firstRespondedAt" IS NULL AND t."firstResponseDueAt" < e.edge)
                OR (t."firstRespondedAt" IS NOT NULL AND t."resolutionDueAt" < e.edge)
           )::int AS breached
      FROM unnest(${edges}::text[]::timestamp[]) AS e(edge)
      LEFT JOIN "Ticket" t
        ON t."createdAt" <= e.edge
       AND (t."resolvedAt" IS NULL OR t."resolvedAt" > e.edge)
       AND (t."closedAt" IS NULL OR t."closedAt" > e.edge)
       AND t."queueId" = ANY(${scope.queueIds}::text[])
       AND t.status::text <> ALL(${EXCLUDED_STATUSES}::text[])
       AND (cardinality(${scope.priorities}::text[]) = 0 OR t.priority::text = ANY(${scope.priorities}::text[]))
       AND (cardinality(${scope.categories}::text[]) = 0 OR t.category::text = ANY(${scope.categories}::text[]))
     GROUP BY e.edge`;

  const byEdge = new Map(rows.map((r) => [r.edge.toISOString(), r] as const));
  const out = scope.buckets.map((b, i) => {
    const hit = byEdge.get(new Date(edges[i]).toISOString());
    return {
      bucket: b.key,
      label: b.label,
      values: { backlog: hit?.backlog ?? 0, breached: hit?.breached ?? 0 },
    };
  });

  const peak = out.reduce((a, r) => Math.max(a, r.values.backlog), 0);
  const last = out.at(-1);
  return {
    series,
    rows: out,
    totals: { current: last?.values.backlog ?? 0, peak, breached: last?.values.breached ?? 0 },
  };
}

type DurationRow = { bucket: Date | null; n: number; answered: number; p50: number | null; p90: number | null };

/**
 * First response: minutes from creation to `firstRespondedAt`, which `recordClientContact` also stamps —
 * that is the callback credit, and it lands here for free because the credit is the column, not a second
 * rule. `percentile_cont` ignores NULL inputs, so the unanswered tickets count toward `n` and toward the
 * coverage number without dragging the median toward infinity.
 */
async function firstResponseReport(scope: Scope): Promise<BuiltReport> {
  const series = ["p50", "p90", "responded"];
  const [bucketed, whole] = await Promise.all([
    prisma.$queryRaw<DurationRow[]>`
      SELECT date_trunc(${scope.granularity}, (t."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${FIRM_TIME_ZONE}) AS bucket,
             count(*)::int AS n,
             count(t."firstRespondedAt")::int AS answered,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."firstRespondedAt" - t."createdAt")) / 60.0) AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."firstRespondedAt" - t."createdAt")) / 60.0) AS p90
        FROM "Ticket" t
       WHERE t."createdAt" >= ${sqlInstant(scope.range.fromAt)}::timestamp
         AND t."createdAt" < ${sqlInstant(scope.range.toAt)}::timestamp
         AND t."queueId" = ANY(${scope.queueIds}::text[])
         AND t.status::text <> ALL(${EXCLUDED_STATUSES}::text[])
         AND (cardinality(${scope.priorities}::text[]) = 0 OR t.priority::text = ANY(${scope.priorities}::text[]))
         AND (cardinality(${scope.categories}::text[]) = 0 OR t.category::text = ANY(${scope.categories}::text[]))
       GROUP BY 1`,
    prisma.$queryRaw<DurationRow[]>`
      SELECT NULL::timestamp AS bucket,
             count(*)::int AS n,
             count(t."firstRespondedAt")::int AS answered,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."firstRespondedAt" - t."createdAt")) / 60.0) AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."firstRespondedAt" - t."createdAt")) / 60.0) AS p90
        FROM "Ticket" t
       WHERE t."createdAt" >= ${sqlInstant(scope.range.fromAt)}::timestamp
         AND t."createdAt" < ${sqlInstant(scope.range.toAt)}::timestamp
         AND t."queueId" = ANY(${scope.queueIds}::text[])
         AND t.status::text <> ALL(${EXCLUDED_STATUSES}::text[])
         AND (cardinality(${scope.priorities}::text[]) = 0 OR t.priority::text = ANY(${scope.priorities}::text[]))
         AND (cardinality(${scope.categories}::text[]) = 0 OR t.category::text = ANY(${scope.categories}::text[]))`,
  ]);

  const byBucket = new Map(bucketed.map((r) => [bucketKeyOf(r.bucket ?? new Date(0)), r] as const));
  const rows = rowsFromBuckets(scope, series, (b) => {
    const hit = byBucket.get(b.key);
    return { p50: round2(hit?.p50 ?? 0), p90: round2(hit?.p90 ?? 0), responded: hit?.answered ?? 0 };
  });

  const w = whole[0];
  const created = w?.n ?? 0;
  const responded = w?.answered ?? 0;
  return {
    series,
    rows,
    totals: {
      p50: round2(w?.p50 ?? 0),
      p90: round2(w?.p90 ?? 0),
      created,
      responded,
      unanswered: created - responded,
      respondedPct: pct(responded, created),
    },
  };
}

async function resolutionTimeReport(scope: Scope): Promise<BuiltReport> {
  const series = ["p50", "p90", "resolved"];
  const [bucketed, whole] = await Promise.all([
    prisma.$queryRaw<DurationRow[]>`
      SELECT date_trunc(${scope.granularity}, (t."resolvedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${FIRM_TIME_ZONE}) AS bucket,
             count(*)::int AS n,
             count(*)::int AS answered,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."resolvedAt" - t."createdAt")) / 60.0) AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."resolvedAt" - t."createdAt")) / 60.0) AS p90
        FROM "Ticket" t
       WHERE t."resolvedAt" IS NOT NULL
         AND t."resolvedAt" >= ${sqlInstant(scope.range.fromAt)}::timestamp
         AND t."resolvedAt" < ${sqlInstant(scope.range.toAt)}::timestamp
         AND t."queueId" = ANY(${scope.queueIds}::text[])
         AND t.status::text <> ALL(${EXCLUDED_STATUSES}::text[])
         AND (cardinality(${scope.priorities}::text[]) = 0 OR t.priority::text = ANY(${scope.priorities}::text[]))
         AND (cardinality(${scope.categories}::text[]) = 0 OR t.category::text = ANY(${scope.categories}::text[]))
       GROUP BY 1`,
    prisma.$queryRaw<DurationRow[]>`
      SELECT NULL::timestamp AS bucket,
             count(*)::int AS n,
             count(*)::int AS answered,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."resolvedAt" - t."createdAt")) / 60.0) AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."resolvedAt" - t."createdAt")) / 60.0) AS p90
        FROM "Ticket" t
       WHERE t."resolvedAt" IS NOT NULL
         AND t."resolvedAt" >= ${sqlInstant(scope.range.fromAt)}::timestamp
         AND t."resolvedAt" < ${sqlInstant(scope.range.toAt)}::timestamp
         AND t."queueId" = ANY(${scope.queueIds}::text[])
         AND t.status::text <> ALL(${EXCLUDED_STATUSES}::text[])
         AND (cardinality(${scope.priorities}::text[]) = 0 OR t.priority::text = ANY(${scope.priorities}::text[]))
         AND (cardinality(${scope.categories}::text[]) = 0 OR t.category::text = ANY(${scope.categories}::text[]))`,
  ]);

  const byBucket = new Map(bucketed.map((r) => [bucketKeyOf(r.bucket ?? new Date(0)), r] as const));
  const rows = rowsFromBuckets(scope, series, (b) => {
    const hit = byBucket.get(b.key);
    return { p50: round2(hit?.p50 ?? 0), p90: round2(hit?.p90 ?? 0), resolved: hit?.n ?? 0 };
  });

  const w = whole[0];
  return {
    series,
    rows,
    totals: { p50: round2(w?.p50 ?? 0), p90: round2(w?.p90 ?? 0), resolved: w?.n ?? 0 },
  };
}

type AttainmentRow = { bucket: Date | null; resolved: number; fr_met: number; res_met: number; both: number };

/**
 * Attainment over the tickets RESOLVED in the range, using the same rule `computeSlaStatus` calls MET:
 * resolved on time, with the first response — or, absent one, the resolution itself — on time. A ticket
 * still open has met nothing yet and is not in the denominator; the backlog report is where its clock
 * shows up.
 */
async function slaAttainmentReport(scope: Scope): Promise<BuiltReport> {
  const series = ["firstResponsePct", "resolutionPct", "metPct"];
  const [bucketed, whole] = await Promise.all([
    prisma.$queryRaw<AttainmentRow[]>`
      SELECT date_trunc(${scope.granularity}, (t."resolvedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${FIRM_TIME_ZONE}) AS bucket,
             count(*)::int AS resolved,
             count(*) FILTER (
               WHERE (t."firstRespondedAt" IS NOT NULL AND t."firstRespondedAt" <= t."firstResponseDueAt")
                  OR (t."firstRespondedAt" IS NULL AND t."resolvedAt" <= t."firstResponseDueAt")
             )::int AS fr_met,
             count(*) FILTER (WHERE t."resolvedAt" <= t."resolutionDueAt")::int AS res_met,
             count(*) FILTER (
               WHERE t."resolvedAt" <= t."resolutionDueAt"
                 AND ((t."firstRespondedAt" IS NOT NULL AND t."firstRespondedAt" <= t."firstResponseDueAt")
                   OR (t."firstRespondedAt" IS NULL AND t."resolvedAt" <= t."firstResponseDueAt"))
             )::int AS both
        FROM "Ticket" t
       WHERE t."resolvedAt" IS NOT NULL
         AND t."resolvedAt" >= ${sqlInstant(scope.range.fromAt)}::timestamp
         AND t."resolvedAt" < ${sqlInstant(scope.range.toAt)}::timestamp
         AND t."queueId" = ANY(${scope.queueIds}::text[])
         AND t.status::text <> ALL(${EXCLUDED_STATUSES}::text[])
         AND (cardinality(${scope.priorities}::text[]) = 0 OR t.priority::text = ANY(${scope.priorities}::text[]))
         AND (cardinality(${scope.categories}::text[]) = 0 OR t.category::text = ANY(${scope.categories}::text[]))
       GROUP BY 1`,
    prisma.$queryRaw<AttainmentRow[]>`
      SELECT NULL::timestamp AS bucket,
             count(*)::int AS resolved,
             count(*) FILTER (
               WHERE (t."firstRespondedAt" IS NOT NULL AND t."firstRespondedAt" <= t."firstResponseDueAt")
                  OR (t."firstRespondedAt" IS NULL AND t."resolvedAt" <= t."firstResponseDueAt")
             )::int AS fr_met,
             count(*) FILTER (WHERE t."resolvedAt" <= t."resolutionDueAt")::int AS res_met,
             count(*) FILTER (
               WHERE t."resolvedAt" <= t."resolutionDueAt"
                 AND ((t."firstRespondedAt" IS NOT NULL AND t."firstRespondedAt" <= t."firstResponseDueAt")
                   OR (t."firstRespondedAt" IS NULL AND t."resolvedAt" <= t."firstResponseDueAt"))
             )::int AS both
        FROM "Ticket" t
       WHERE t."resolvedAt" IS NOT NULL
         AND t."resolvedAt" >= ${sqlInstant(scope.range.fromAt)}::timestamp
         AND t."resolvedAt" < ${sqlInstant(scope.range.toAt)}::timestamp
         AND t."queueId" = ANY(${scope.queueIds}::text[])
         AND t.status::text <> ALL(${EXCLUDED_STATUSES}::text[])
         AND (cardinality(${scope.priorities}::text[]) = 0 OR t.priority::text = ANY(${scope.priorities}::text[]))
         AND (cardinality(${scope.categories}::text[]) = 0 OR t.category::text = ANY(${scope.categories}::text[]))`,
  ]);

  const byBucket = new Map(bucketed.map((r) => [bucketKeyOf(r.bucket ?? new Date(0)), r] as const));
  const rows = rowsFromBuckets(scope, series, (b): Record<string, number> => {
    const hit = byBucket.get(b.key);
    if (hit === undefined) return {};
    return {
      firstResponsePct: pct(hit.fr_met, hit.resolved),
      resolutionPct: pct(hit.res_met, hit.resolved),
      metPct: pct(hit.both, hit.resolved),
    };
  });

  const w = whole[0];
  const resolved = w?.resolved ?? 0;
  return {
    series,
    rows,
    totals: {
      resolved,
      firstResponseMet: w?.fr_met ?? 0,
      resolutionMet: w?.res_met ?? 0,
      met: w?.both ?? 0,
      firstResponsePct: pct(w?.fr_met ?? 0, resolved),
      resolutionPct: pct(w?.res_met ?? 0, resolved),
      metPct: pct(w?.both ?? 0, resolved),
    },
  };
}

/**
 * Per-agent load. Open load is "right now", deliberately: a queue's standing work is not a property of
 * the date range, and an agent's Monday backlog is the question the row answers. The resolved column IS
 * range-bounded, and the two are labelled as such on the page so they are never read as one number.
 */
async function agentLoadReport(scope: Scope): Promise<BuiltReport> {
  const series = ["open", "resolved", "breached"];
  const openStatuses = [...OPEN_STATUSES];

  const [open, resolved, breached] = await Promise.all([
    prisma.ticket.groupBy({
      by: ["assigneeId"],
      where: scopedWhere(scope, { status: { in: openStatuses } }),
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ["assigneeId"],
      where: scopedWhere(scope, { resolvedAt: { gte: scope.range.fromAt, lt: scope.range.toAt } }),
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ["assigneeId"],
      where: scopedWhere(scope, breachedOpenWhere(scope.now)),
      _count: { _all: true },
    }),
  ]);

  const ids = new Set<string>();
  for (const g of [...open, ...resolved, ...breached]) if (g.assigneeId !== null) ids.add(g.assigneeId);
  const users =
    ids.size === 0
      ? []
      : await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, email: true } });
  const nameById = new Map(users.map((u) => [u.id, u.name ?? u.email] as const));

  const values = new Map<string, Record<string, number>>();
  const bump = (id: string | null, key: string, n: number): void => {
    const k = id ?? "unassigned";
    const row = values.get(k) ?? emptyValues(series);
    row[key] += n;
    values.set(k, row);
  };
  for (const g of open) bump(g.assigneeId, "open", g._count._all);
  for (const g of resolved) bump(g.assigneeId, "resolved", g._count._all);
  for (const g of breached) bump(g.assigneeId, "breached", g._count._all);

  const rows: ReportRow[] = [...values.entries()]
    .map(([id, v]) => ({
      bucket: id,
      label: id === "unassigned" ? "Unassigned" : (nameById.get(id) ?? "Former staff member"),
      values: v,
    }))
    .sort((a, b) => b.values.open - a.values.open || b.values.resolved - a.values.resolved || a.label.localeCompare(b.label));

  const totals: Record<string, number> = {
    agents: rows.filter((r) => r.bucket !== "unassigned").length,
    open: rows.reduce((a, r) => a + r.values.open, 0),
    resolved: rows.reduce((a, r) => a + r.values.resolved, 0),
    breached: rows.reduce((a, r) => a + r.values.breached, 0),
    unassigned: values.get("unassigned")?.open ?? 0,
  };
  return { series, rows, totals };
}

async function categoryMixReport(scope: Scope): Promise<BuiltReport> {
  const series = ["created", "resolved", "sharePct"];
  const [created, resolved] = await Promise.all([
    prisma.ticket.groupBy({
      by: ["category"],
      where: scopedWhere(scope, { createdAt: { gte: scope.range.fromAt, lt: scope.range.toAt } }),
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ["category"],
      where: scopedWhere(scope, { resolvedAt: { gte: scope.range.fromAt, lt: scope.range.toAt } }),
      _count: { _all: true },
    }),
  ]);

  const createdByCategory = new Map<TicketCategory, number>(created.map((g) => [g.category, g._count._all] as const));
  const resolvedByCategory = new Map<TicketCategory, number>(resolved.map((g) => [g.category, g._count._all] as const));
  const totalCreated = [...createdByCategory.values()].reduce((a, n) => a + n, 0);

  const keys = new Set<TicketCategory>([...createdByCategory.keys(), ...resolvedByCategory.keys()]);
  const rows: ReportRow[] = [...keys]
    .map((c) => ({
      bucket: c,
      label: CATEGORY_LABELS[c],
      values: {
        created: createdByCategory.get(c) ?? 0,
        resolved: resolvedByCategory.get(c) ?? 0,
        sharePct: pct(createdByCategory.get(c) ?? 0, totalCreated),
      },
    }))
    .sort((a, b) => b.values.created - a.values.created || a.label.localeCompare(b.label));

  return {
    series,
    rows,
    totals: {
      created: totalCreated,
      resolved: [...resolvedByCategory.values()].reduce((a, n) => a + n, 0),
      categories: rows.length,
    },
  };
}

/**
 * A reopen is one edge in the ledger: RESOLVED → OPEN, written either by a member of staff
 * (`TICKET_STATUS_CHANGED`) or by a client answering a resolved ticket (`TICKET_REOPENED_BY_REQUESTER`).
 * Reading the ledger rather than the ticket is the point — `changeTicketStatus` clears `resolvedAt` on
 * a reopen, so the ticket row itself no longer remembers that it ever happened.
 */
const REOPEN_ACTIONS = ["TICKET_STATUS_CHANGED", "TICKET_REOPENED_BY_REQUESTER"];

async function reopenRateReport(scope: Scope): Promise<BuiltReport> {
  const series = ["reopened", "resolved", "ratePct"];
  const [reopens, resolved] = await Promise.all([
    prisma.$queryRaw<Array<{ bucket: Date; n: number; tickets: number }>>`
      SELECT date_trunc(${scope.granularity}, (a."occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${FIRM_TIME_ZONE}) AS bucket,
             count(*)::int AS n,
             count(DISTINCT a."ticketId")::int AS tickets
        FROM "AuditLog" a
        JOIN "Ticket" t ON t.id = a."ticketId"
       WHERE a."occurredAt" >= ${sqlInstant(scope.range.fromAt)}::timestamp
         AND a."occurredAt" < ${sqlInstant(scope.range.toAt)}::timestamp
         AND a.action::text = ANY(${REOPEN_ACTIONS}::text[])
         AND a."fieldChanged" = 'status'
         AND a."oldValue" = 'RESOLVED'
         AND a."newValue" = 'OPEN'
         AND t."queueId" = ANY(${scope.queueIds}::text[])
         AND t.status::text <> ALL(${EXCLUDED_STATUSES}::text[])
         AND (cardinality(${scope.priorities}::text[]) = 0 OR t.priority::text = ANY(${scope.priorities}::text[]))
         AND (cardinality(${scope.categories}::text[]) = 0 OR t.category::text = ANY(${scope.categories}::text[]))
       GROUP BY 1`,
    resolvedPerBucket(scope),
  ]);

  const byBucket = new Map(reopens.map((r) => [bucketKeyOf(r.bucket), r] as const));
  const rows = rowsFromBuckets(scope, series, (b) => {
    const reopened = byBucket.get(b.key)?.n ?? 0;
    const denom = resolved.get(b.key) ?? 0;
    return { reopened, resolved: denom, ratePct: pct(reopened, denom) };
  });

  const totalReopened = reopens.reduce((a, r) => a + r.n, 0);
  const totalResolved = [...resolved.values()].reduce((a, n) => a + n, 0);
  return {
    series,
    rows,
    totals: {
      reopened: totalReopened,
      // Summed per bucket: a ticket reopened in two different periods is two facts, not one.
      ticketsReopened: reopens.reduce((a, r) => a + r.tickets, 0),
      resolved: totalResolved,
      ratePct: pct(totalReopened, totalResolved),
    },
  };
}

async function resolutionMixReport(scope: Scope): Promise<BuiltReport> {
  const series = ["tickets", "sharePct"];
  const grouped = await prisma.ticket.groupBy({
    by: ["resolution"],
    where: scopedWhere(scope, { resolvedAt: { gte: scope.range.fromAt, lt: scope.range.toAt } }),
    _count: { _all: true },
  });

  const byResolution = new Map<TicketResolution, number>(grouped.map((g) => [g.resolution, g._count._all] as const));
  const total = [...byResolution.values()].reduce((a, n) => a + n, 0);

  // Every value, in declaration order, including the zeros: "no ticket was withdrawn this month" is an
  // answer, and a row that disappears when it reaches zero reads as a missing column instead.
  const rows: ReportRow[] = TICKET_RESOLUTIONS.map((r) => ({
    bucket: r,
    label: r === "NONE" ? "Not recorded" : RESOLUTION_LABELS[r],
    values: { tickets: byResolution.get(r) ?? 0, sharePct: pct(byResolution.get(r) ?? 0, total) },
  }));

  return {
    series,
    rows,
    totals: {
      resolved: total,
      recorded: total - (byResolution.get("NONE") ?? 0),
      unrecorded: byResolution.get("NONE") ?? 0,
    },
  };
}

/**
 * Standing operational counters. Two of the five are gated on a capability rather than on a queue,
 * because the rows behind them are not queue-scoped: a held intake has not been attributed to a queue
 * yet, and a dead webhook delivery may carry no ticket at all. A viewer without the capability sees the
 * report without those rows — never a zero, which would read as "nothing is stuck".
 */
async function deskHealthReport(scope: Scope, viewer: Viewer): Promise<BuiltReport> {
  const series = ["current", "inRange"];
  const openStatuses = [...OPEN_STATUSES];
  const failedDelivery = ["FAILED", "BOUNCED", "FAILED_SUPPRESSED"] as const;

  const [
    complaintsOpen,
    complaintsNew,
    voidedTotal,
    voidedInRange,
    outboxNow,
    outboxInRange,
  ] = await Promise.all([
    prisma.ticket.count({ where: scopedWhere(scope, { isComplaint: true, status: { in: openStatuses } }) }),
    prisma.ticket.count({
      where: scopedWhere(scope, { isComplaint: true, createdAt: { gte: scope.range.fromAt, lt: scope.range.toAt } }),
    }),
    // VOIDED is the one count that deliberately does NOT exclude itself: this row exists so a void is
    // visible somewhere, having been removed from every other number on the page.
    prisma.ticket.count({ where: { queueId: { in: scope.queueIds }, status: "VOIDED" } }),
    prisma.ticket.count({
      where: {
        queueId: { in: scope.queueIds },
        status: "VOIDED",
        voidedAt: { gte: scope.range.fromAt, lt: scope.range.toAt },
      },
    }),
    prisma.messageDelivery.count({
      where: { status: { in: [...failedDelivery] }, ticket: { queueId: { in: scope.queueIds } } },
    }),
    prisma.messageDelivery.count({
      where: {
        status: { in: [...failedDelivery] },
        ticket: { queueId: { in: scope.queueIds } },
        createdAt: { gte: scope.range.fromAt, lt: scope.range.toAt },
      },
    }),
  ]);

  const rows: ReportRow[] = [
    { bucket: "complaints", label: "Complaints (open / filed in range)", values: { current: complaintsOpen, inRange: complaintsNew } },
    { bucket: "outbox-failed", label: "Outbound mail failed, bounced or suppressed", values: { current: outboxNow, inRange: outboxInRange } },
    { bucket: "voided", label: "Voided tickets (excluded from every other report)", values: { current: voidedTotal, inRange: voidedInRange } },
  ];

  if (canReviewHeldIntake(viewer.groups)) {
    const [heldNow, heldInRange] = await Promise.all([
      prisma.suspendedIntake.count({ where: { status: "NEW" } }),
      prisma.suspendedIntake.count({
        where: { createdAt: { gte: scope.range.fromAt, lt: scope.range.toAt } },
      }),
    ]);
    rows.splice(1, 0, {
      bucket: "held-intake",
      label: "Inbound mail held for review (awaiting / held in range)",
      values: { current: heldNow, inRange: heldInRange },
    });
  }

  if (canAdminWebhooks(viewer.groups)) {
    const [deadNow, deadInRange] = await Promise.all([
      prisma.webhookDelivery.count({ where: { status: "DEAD" } }),
      prisma.webhookDelivery.count({
        where: { status: "DEAD", createdAt: { gte: scope.range.fromAt, lt: scope.range.toAt } },
      }),
    ]);
    rows.push({
      bucket: "webhook-dead",
      label: "Webhook deliveries given up on",
      values: { current: deadNow, inRange: deadInRange },
    });
  }

  return {
    series,
    rows,
    totals: {
      counters: rows.length,
      current: rows.reduce((a, r) => a + r.values.current, 0),
      inRange: rows.reduce((a, r) => a + r.values.inRange, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

async function build(scope: Scope, key: ExtendedReportKey, viewer: Viewer): Promise<BuiltReport> {
  switch (key) {
    case "volume":
      return volumeReport(scope);
    case "backlog":
      return backlogReport(scope);
    case "first-response":
      return firstResponseReport(scope);
    case "resolution":
      return resolutionTimeReport(scope);
    case "sla-attainment":
      return slaAttainmentReport(scope);
    case "agent-load":
      return agentLoadReport(scope);
    case "category-mix":
      return categoryMixReport(scope);
    case "reopen-rate":
      return reopenRateReport(scope);
    case "resolution-mix":
      return resolutionMixReport(scope);
    case "desk-health":
      return deskHealthReport(scope, viewer);
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
}

/**
 * Any report, including B7's two extra keys. `runReport` below is the contract's narrower door onto the
 * same function.
 *
 * `ctx` is not used to authorize (the caller has already checked `reports:read`) and writes no audit row
 * (§3.3 rule 5); it carries the request id onto the slow-query log line, which is the only way to tie a
 * seven-second report to the navigation that asked for it.
 */
export async function runExtendedReport(
  viewer: Viewer,
  query: ExtendedReportQuery,
  ctx: RequestContext,
): Promise<ExtendedReportResult> {
  const now = new Date();
  const scope = await resolveScope(viewer, query, now);
  const started = Date.now();

  const built =
    scope.queueIds.length === 0
      ? { series: [] as string[], rows: [] as ReportRow[], totals: {} as Record<string, number> }
      : await build(scope, query.key, viewer);

  const elapsed = Date.now() - started;
  if (elapsed > SLOW_REPORT_MS) {
    logWarn("reports", "slow_report", {
      requestId: ctx.requestId,
      report: query.key,
      granularity: query.granularity,
      days: scope.range.days,
      queues: scope.queueIds.length,
      ms: elapsed,
    });
  }

  return {
    key: query.key,
    from: scope.range.fromDate,
    to: scope.range.toDate,
    granularity: query.granularity,
    series: built.series,
    rows: built.rows,
    totals: built.totals,
    generatedAt: now.toISOString(),
  };
}

/** CONTRACT §10 B7. The eight contract keys; `query.key` is a `ReportKey`, so the result's is too. */
export async function runReport(viewer: Viewer, query: ReportQuery, ctx: RequestContext): Promise<ReportResult> {
  const result = await runExtendedReport(viewer, query, ctx);
  return { ...result, key: isContractReportKey(result.key) ? result.key : "volume" };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Columns: `bucket`, `label`, then the row series, then any whole-range total that is not already a
 * series. The trailing columns are blank on every data row and carry the `TOTAL` row's values — that is
 * what keeps the export lossless. Recomputing a range median from daily medians is the classic way to
 * publish a wrong number, so the p50 the page shows is the p50 the file carries.
 */
export function reportCsvColumns(result: ExtendedReportResult): string[] {
  const totalsOnly = Object.keys(result.totals).filter((k) => !result.series.includes(k));
  return ["bucket", "label", ...result.series, ...totalsOnly];
}

export function reportToCsv(result: ExtendedReportResult): string {
  const columns = reportCsvColumns(result);
  const lines: string[] = [columns.map((c) => csvCell(c)).join(",")];

  for (const row of result.rows) {
    lines.push(
      columns
        .map((c) => {
          if (c === "bucket") return csvCell(row.bucket);
          if (c === "label") return csvCell(row.label);
          const v = row.values[c];
          return csvCell(v === undefined ? null : v);
        })
        .join(","),
    );
  }

  lines.push(
    columns
      .map((c) => {
        if (c === "bucket") return csvCell("TOTAL");
        if (c === "label") return csvCell(`Whole range ${result.from} to ${result.to}`);
        const v = result.totals[c];
        return csvCell(v === undefined ? null : v);
      })
      .join(","),
  );

  return `${lines.join(CRLF)}${CRLF}`;
}

/**
 * CONTRACT §10 B7 + §3.2. The `REPORT_EXPORTED` row is awaited HERE, before the stream exists, so a
 * downloaded file can never predate its ledger entry. The row carries the report key as
 * `entityId`, the row count as `newValue`, and the filters and range as metadata — never a ticket
 * subject, a requester or any other record content, because a report has none to carry.
 *
 * The body is built in memory rather than paged: a report is bounded by `MAX_BUCKETS` (or by the number
 * of agents, categories or resolutions), which is kilobytes, not the unbounded ticket walk
 * `/api/tickets/export` has to stream.
 */
export async function reportCsvExtended(
  viewer: Viewer,
  query: ExtendedReportQuery,
  ctx: RequestContext,
): Promise<ReadableStream<Uint8Array>> {
  const result = await runExtendedReport(viewer, query, ctx);
  const body = reportToCsv(result);

  await writeAudit(prisma, actorFromViewer(viewer), ctx, {
    action: "REPORT_EXPORTED",
    entityType: "REPORT",
    entityId: query.key,
    newValue: String(result.rows.length),
    metadata: {
      filters: reportFilters(query),
      range: { from: result.from, to: result.to, granularity: result.granularity },
      generatedAt: result.generatedAt,
    },
  });

  const bytes = new TextEncoder().encode(body);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** CONTRACT §10 B7 — the eight contract keys. */
export function reportCsv(viewer: Viewer, query: ReportQuery, ctx: RequestContext): Promise<ReadableStream<Uint8Array>> {
  return reportCsvExtended(viewer, query, ctx);
}

/** Queue names for the page's filter, in the viewer's readable order. Counters only, no record content. */
export function readableQueueOptions(viewer: Viewer): Array<{ key: QueueKey; label: string }> {
  return readableQueues(viewer.groups).map((key) => ({ key, label: QUEUE_LABELS[key] }));
}
