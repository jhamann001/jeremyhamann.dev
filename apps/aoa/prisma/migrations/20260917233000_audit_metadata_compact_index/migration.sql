-- One statement, deliberately outside a transaction: build without blocking
-- audit inserts. Do not prepend SET/BEGIN or append another SQL statement;
-- PostgreSQL would treat a multi-statement command as an implicit transaction.
-- The job deadline bounds the deployment attempt, not proof that SQL stopped.
-- A failed/invalid concurrent index requires inspected recovery, never a blind
-- retry or IF NOT EXISTS success claim.
-- No id/changed INCLUDE columns: btree deduplication keeps exact facets compact.
CREATE INDEX CONCURRENTLY "row_change_table_name_op_actor_email_idx"
  ON "audit"."row_change"("table_name", "op", "actor_email");
