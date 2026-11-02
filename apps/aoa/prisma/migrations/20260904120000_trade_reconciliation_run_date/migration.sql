-- Preserve the operator-selected reconciliation run date separately from the
-- prior NYSE trade date already stored as business_date. Existing completed
-- runs predate this column, so their actual Eastern completion date is the
-- safest durable backfill. Legacy or interrupted rows can lack completion
-- evidence; for those rows, preserve the date the old UI already stored.
-- Some development runs were created before the UI treated the selected date
-- as the run date, so the historical run and trade dates can legitimately be
-- equal. New live and imported runs enforce the prior-trading-day rule before
-- persistence.

BEGIN;

ALTER TABLE "app"."trade_reconciliation_run"
  ADD COLUMN "run_date" DATE;

-- This table forces RLS. The migration owner normally bypasses RLS, but FORCE
-- also binds the owner and the runtime policies intentionally do not allow
-- updates to immutable reconciliation runs. Temporarily return to the normal
-- owner-bypass behavior for this controlled one-time backfill, then restore
-- FORCE before the transaction commits. A failure rolls the whole transaction
-- back, including this setting.
ALTER TABLE "app"."trade_reconciliation_run"
  NO FORCE ROW LEVEL SECURITY;

UPDATE "app"."trade_reconciliation_run"
SET "run_date" = COALESCE(
  ("completed_at" AT TIME ZONE 'America/New_York')::date,
  "business_date"
);

ALTER TABLE "app"."trade_reconciliation_run"
  ALTER COLUMN "run_date" SET NOT NULL;

CREATE INDEX "trade_reconciliation_run_run_date_completed_idx"
  ON "app"."trade_reconciliation_run"("run_date" DESC, "completed_at" DESC);

ALTER TABLE "app"."trade_reconciliation_run"
  FORCE ROW LEVEL SECURITY;

COMMIT;
