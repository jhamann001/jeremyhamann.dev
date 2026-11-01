-- Up Migration
-- Fix updated_at for rows imported via import-migration.ts where the value was
-- either NULL (source JSON had no updatedAt) or stored with microsecond precision
-- (COALESCE fallback to bare NOW()). Both cases break the optimistic concurrency
-- check because JavaScript Date only carries millisecond precision.

UPDATE trade_requests
SET updated_at = date_trunc('milliseconds', COALESCE(updated_at, created_at))
WHERE updated_at IS NULL
   OR updated_at != date_trunc('milliseconds', updated_at);

-- Down Migration
-- No-op: the original NULL / microsecond values were incorrect and caused
-- "Request was modified by another user" false positives.
