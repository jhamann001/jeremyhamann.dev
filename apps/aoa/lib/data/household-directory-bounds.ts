import type { Prisma } from "@prisma/client";

// Preserve Prisma's existing transaction defaults. Its deadline alone does
// not cancel an executing SQL query, which can retain the pooled connection.
export const HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS = { timeout: 5_000, maxWait: 2_000 } as const;
export const HOUSEHOLD_DIRECTORY_STATEMENT_TIMEOUT_MS = 4_000;
export const HOUSEHOLD_DIRECTORY_LOCK_TIMEOUT_MS = 1_000;

export async function applyHouseholdDirectoryDatabaseBounds(tx: Prisma.TransactionClient): Promise<void> {
  // One setup command, followed by the existing single directory query. Lock
  // waits count toward the statement deadline; these budgets are not additive.
  // All settings reset when this RLS-scoped transaction commits or rolls back.
  await tx.$executeRaw`SELECT
    set_config('jit', 'off', true),
    set_config('statement_timeout', ${String(HOUSEHOLD_DIRECTORY_STATEMENT_TIMEOUT_MS)}, true),
    set_config('lock_timeout', ${String(HOUSEHOLD_DIRECTORY_LOCK_TIMEOUT_MS)}, true)`;
}
