-- A transaction's row-change timestamps are identical. The at-only index must
-- read and sort that entire batch before returning the first bounded page.
-- Match the existing deterministic ordering without changing RLS or its grain.
-- Acquire the write-blocking index-build lock promptly or fail; bound the build
-- too. An explicit transaction rolls the whole migration back on failure.
-- Do not automatically retry a failed deploy: inspect the failed migration and
-- contention, then use the documented Prisma recovery flow before retrying.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
CREATE INDEX "row_change_at_id_idx" ON "audit"."row_change"("at" DESC, "id" DESC);
COMMIT;
