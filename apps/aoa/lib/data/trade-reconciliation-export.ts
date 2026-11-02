import "server-only";

import { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import type { TradeReconciliationRunExport } from "@/lib/operations/operations-export-csv";

type ExportRecord = {
  id: string;
  run_date: string;
  trade_date: string;
  completed_at: string;
  apex_records: number;
  meridian_records: number;
  matched: number;
  explained: number;
  unresolved: number;
  run_note: string;
};

/** One row per saved run. Trade-level payloads stay in the database. */
export async function exportTradeReconciliationRuns(identity: Identity): Promise<TradeReconciliationRunExport[]> {
  return withUserScope(identity, async (tx) => {
    const rows = await tx.$queryRaw<ExportRecord[]>(Prisma.sql`
      WITH reviewed AS (
        SELECT run_id, COUNT(DISTINCT row_fingerprint)::int AS explained
          FROM app.trade_reconciliation_review_event
         GROUP BY run_id
      ), notes AS (
        SELECT DISTINCT ON (run_id) run_id, note
          FROM app.trade_reconciliation_note_event
         ORDER BY run_id, created_at DESC, id DESC
      )
      SELECT r.id,
             r.run_date::text AS run_date,
             r.business_date::text AS trade_date,
             TO_CHAR(r.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at,
             r.apex_record_count AS apex_records,
             r.meridian_record_count AS meridian_records,
             r.raw_match_count AS matched,
             CASE WHEN r.legacy_source = 'fee_store_daily_reconciliation' THEN 0
                  ELSE COALESCE(v.explained, 0) END AS explained,
             CASE WHEN r.legacy_source = 'fee_store_daily_reconciliation'
                  THEN r.exception_count + COALESCE(r.legacy_unmatched_apex, 0) + COALESCE(r.legacy_unmatched_alpha, 0)
                  ELSE GREATEST(0, r.exception_count - COALESCE(v.explained, 0)) END AS unresolved,
             COALESCE(n.note, '') AS run_note
        FROM app.trade_reconciliation_run r
        LEFT JOIN reviewed v ON v.run_id = r.id
        LEFT JOIN notes n ON n.run_id = r.id
       ORDER BY r.run_date DESC, r.completed_at DESC, r.id DESC
    `);
    return rows.map((row) => ({
      id: row.id,
      runDate: row.run_date,
      tradeDate: row.trade_date,
      completedAt: row.completed_at,
      apexRecords: Number(row.apex_records),
      meridianRecords: Number(row.meridian_records),
      matched: Number(row.matched),
      explained: Number(row.explained),
      unresolved: Number(row.unresolved),
      runNote: row.run_note,
    }));
  }, { maxWait: 10_000, timeout: 15_000 });
}
