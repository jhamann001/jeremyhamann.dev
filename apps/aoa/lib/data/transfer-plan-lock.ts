import "server-only";
import { Prisma } from "@prisma/client";

/**
 * Serialize plan edits, approvals and stage gates for one transfer. The caller
 * must supply its existing withUserScope transaction: RLS still determines
 * which rows can be locked, and no transfer details leave this helper.
 */
export async function lockTransferPlan(
  tx: Prisma.TransactionClient,
  transferId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM app.transfer WHERE id = ${transferId} FOR UPDATE
  `);
  if (rows.length !== 1) throw new Error("Transfer unavailable");
}
