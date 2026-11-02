import type { Prisma } from "@prisma/client";

export const AUDIT_READ_TRANSACTION_OPTIONS = {
  timeout: 15_000,
  maxWait: 5_000,
} as const;
export const AUDIT_READ_STATEMENT_TIMEOUT_MS = 10_000;
export const AUDIT_READ_LOCK_TIMEOUT_MS = 2_000;

/**
 * Prisma's interactive transaction deadline does not cancel an executing SQL
 * statement. Bound the work in PostgreSQL too, so an unavailable Audit page
 * cannot occupy a pooled connection until an instance-wide request timeout.
 * SET LOCAL keeps these read-specific limits inside the existing RLS scope.
 */
export async function applyAuditReadDatabaseBounds(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config(
    'statement_timeout', ${String(AUDIT_READ_STATEMENT_TIMEOUT_MS)}, true
  )`;
  await tx.$executeRaw`SELECT set_config(
    'lock_timeout', ${String(AUDIT_READ_LOCK_TIMEOUT_MS)}, true
  )`;
  // Large audit histories exceed PostgreSQL's default JIT cost thresholds.
  // These latency-sensitive, short-lived reads should not compile a fresh plan
  // before returning a bounded page. Keep this local to the scoped transaction
  // so it cannot change later users or ingestion work on the pooled connection.
  await tx.$executeRaw`SELECT set_config('jit', 'off', true)`;
}
