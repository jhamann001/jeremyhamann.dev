-- Up Migration
-- Truncate existing timestamps to millisecond precision so they match
-- the date_trunc('milliseconds', NOW()) used in application INSERT/UPDATE queries.
-- This prevents optimistic concurrency checks from failing due to precision mismatch.

UPDATE trade_requests
SET created_at = date_trunc('milliseconds', created_at),
    updated_at = date_trunc('milliseconds', updated_at)
WHERE created_at IS NOT NULL;

UPDATE audit_logs
SET created_at = date_trunc('milliseconds', created_at)
WHERE created_at IS NOT NULL;

-- Down Migration
-- No-op: restoring microsecond precision is not meaningful since the original
-- sub-millisecond digits carried no semantic value.
