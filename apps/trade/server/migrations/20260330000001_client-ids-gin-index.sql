-- Up Migration
-- NOTE: Cannot use CONCURRENTLY inside node-pg-migrate's default transaction.
-- For large tables, consider running this index creation manually with CONCURRENTLY
-- outside of the migration runner before deploying.
CREATE INDEX IF NOT EXISTS idx_requests_client_ids ON trade_requests USING GIN (client_ids jsonb_path_ops);

-- Down Migration
DROP INDEX IF EXISTS idx_requests_client_ids;
