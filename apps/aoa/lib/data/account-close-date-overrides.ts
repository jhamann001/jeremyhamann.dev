import { withIngestScope } from "@/lib/ingest/scope";
import type { Prisma } from "@prisma/client";

export type AccountCloseDateOverride = {
  custodianAccountId: string;
  provisionalCloseDate: string;
  reason: string;
  sourceReference: string;
};

type RawOverride = {
  custodian_account_id: string;
  provisional_close_date: string;
  reason: string;
  source_reference: string;
};

/** Active, owner-approved operational fallbacks. The source account close date
 * always takes precedence in the snapshot validator; this table is consulted
 * only when Apex publishes CLOSED with no close_date. */
export async function activeAccountCloseDateOverrides(): Promise<
  AccountCloseDateOverride[]
> {
  return withIngestScope((tx) => activeAccountCloseDateOverridesInTransaction(tx));
}

/** Same read on an already-locked ingest transaction. Snapshot commits MUST use
 * this form so a concurrently retired fallback cannot be reintroduced. */
export async function activeAccountCloseDateOverridesInTransaction(
  tx: Prisma.TransactionClient,
): Promise<AccountCloseDateOverride[]> {
  const rows = await tx.$queryRaw<RawOverride[]>`
      SELECT custodian_account_id,
             to_char(provisional_close_date, 'YYYY-MM-DD') AS provisional_close_date,
             reason,
             source_reference
      FROM app.account_close_date_override
      WHERE retired_at IS NULL
      ORDER BY custodian_account_id`;
  return rows.map((row) => ({
    custodianAccountId: row.custodian_account_id,
    provisionalCloseDate: row.provisional_close_date,
    reason: row.reason,
    sourceReference: row.source_reference,
  }));
}
