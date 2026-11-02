-- A completed reconciliation is immutable, but the same trade date can be run
-- again on a later operational day. Keep identical submissions idempotent
-- within one selected run date without redirecting a later rerun to an older
-- snapshot whose run-date label no longer matches the operator's selection.

ALTER TABLE "app"."trade_reconciliation_run"
  DROP CONSTRAINT "trade_reconciliation_run_idempotency_key";

ALTER TABLE "app"."trade_reconciliation_run"
  ADD CONSTRAINT "trade_reconciliation_run_idempotency_key"
  UNIQUE ("run_date", "business_date", "algorithm_version", "source_digest");
