import "server-only";

import { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { RECONCILIATION_HISTORY_PAGE_SIZE, type ReconciliationHistoryView } from "@/lib/operations/reconciliation-history-query";
import type { ReconciliationHistoryRow } from "./trade-reconciliation";

export type ReconciliationHistoryPage = {
  rows: ReconciliationHistoryRow[];
  view: ReconciliationHistoryView;
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  snapshot: string;
};

/** Full-population rollups happen in PostgreSQL; only the requested 100 rows leave it. */
export async function reconciliationHistoryPage(identity: Identity, view: ReconciliationHistoryView, page: number): Promise<ReconciliationHistoryPage> {
  if (!["daily", "monthly", "quarterly"].includes(view) || !Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new Error("invalid_history_query");
  return withUserScope(identity, async (tx) => {
    const [result] = await tx.$queryRaw<Array<{ total: bigint; snapshot: string; rows: ReconciliationHistoryRow[] }>>(Prisma.sql`
      WITH reviewed AS (
        SELECT run_id, COUNT(DISTINCT row_fingerprint)::int AS explained,
          MAX(created_at)::text AS latest_review, COUNT(*)::text AS review_count
        FROM app.trade_reconciliation_review_event GROUP BY run_id
      ), runs AS (
        SELECT r.id, r.run_date, r.business_date, r.completed_at,
          r.raw_match_count::bigint AS matched,
          CASE WHEN r.legacy_source = 'fee_store_daily_reconciliation' THEN 0 ELSE COALESCE(v.explained, 0) END::bigint AS explained,
          CASE WHEN r.legacy_source = 'fee_store_daily_reconciliation'
            THEN r.exception_count + COALESCE(r.legacy_unmatched_apex, 0) + COALESCE(r.legacy_unmatched_alpha, 0)
            ELSE GREATEST(0, r.exception_count - COALESCE(v.explained, 0)) END::bigint AS unresolved,
          r.meridian_record_count::bigint AS denominator,
          (r.raw_match_count >= 0 AND r.meridian_record_count >= r.raw_match_count) AS valid_counts,
          v.latest_review, v.review_count,
          ROW_NUMBER() OVER (PARTITION BY r.business_date ORDER BY r.run_date DESC, r.completed_at DESC, r.id DESC) AS latest
        FROM app.trade_reconciliation_run r LEFT JOIN reviewed v ON v.run_id = r.id
      ), metadata AS (
        SELECT MD5(COALESCE(STRING_AGG(ROW(id, run_date, business_date, completed_at, matched, explained, unresolved, denominator, valid_counts, latest_review, review_count)::text, '|' ORDER BY run_date DESC, completed_at DESC, id DESC), '')) AS snapshot
        FROM runs
      ), history AS (
        SELECT id AS key, run_date::text AS period, id AS run_id, run_date::text AS run_date,
          business_date::text AS trade_date, completed_at,
          matched, explained, unresolved, denominator, valid_counts
        FROM runs WHERE ${view} = 'daily'
        UNION ALL
        SELECT CASE WHEN ${view} = 'monthly' THEN TO_CHAR(run_date, 'YYYY-MM') ELSE TO_CHAR(run_date, 'YYYY "Q"Q') END AS key,
          CASE WHEN ${view} = 'monthly' THEN TO_CHAR(run_date, 'YYYY-MM') ELSE TO_CHAR(run_date, 'YYYY "Q"Q') END AS period,
          CASE WHEN COUNT(*) = 1 THEN MIN(id) END AS run_id,
          CASE WHEN COUNT(*) = 1 THEN MIN(run_date)::text END AS run_date,
          CASE WHEN COUNT(*) = 1 THEN MIN(business_date)::text END AS trade_date,
          MAX(completed_at) AS completed_at,
          SUM(matched), SUM(explained), SUM(unresolved),
          SUM(denominator), BOOL_AND(valid_counts)
        FROM runs WHERE ${view} <> 'daily' AND latest = 1
        GROUP BY 1, 2
      ), bounded AS (
        SELECT * FROM history ORDER BY period DESC, completed_at DESC, key DESC
        LIMIT ${RECONCILIATION_HISTORY_PAGE_SIZE} OFFSET ${(page - 1) * RECONCILIATION_HISTORY_PAGE_SIZE}
      )
      SELECT (SELECT COUNT(*) FROM history) AS total, metadata.snapshot,
        COALESCE((SELECT JSONB_AGG(JSONB_STRIP_NULLS(JSONB_BUILD_OBJECT(
          'period', period, 'runId', run_id, 'runDate', run_date, 'tradeDate', trade_date,
          'completedAt', CASE WHEN run_id IS NOT NULL THEN TO_CHAR(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
          'matched', matched, 'explained', explained, 'unresolved', unresolved,
          'rate', CASE WHEN NOT valid_counts THEN 'Unavailable'
            WHEN denominator = 0 THEN 'N/A'
            WHEN matched = denominator THEN '100.00%'
            ELSE TO_CHAR(LEAST(99.99, matched::numeric / denominator * 100), 'FM999999999999990.00') || '%' END
        )) ORDER BY period DESC, completed_at DESC, key DESC) FROM bounded), '[]'::jsonb) AS rows
      FROM metadata
    `);
    if (!result) throw new Error("history_unavailable");
    const total = Number(result.total);
    return { ...result, total, page, view, pageSize: RECONCILIATION_HISTORY_PAGE_SIZE, pageCount: Math.max(1, Math.ceil(total / RECONCILIATION_HISTORY_PAGE_SIZE)) };
  });
}
