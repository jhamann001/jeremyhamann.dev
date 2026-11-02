import "server-only";
import type { Identity } from "@/lib/rls";
import { withUserScope } from "@/lib/rls";

/** Document ids for one custodian. Used by the merge adapter before the move. */
export async function listCustodianFeeScheduleDocumentIds(
  identity: Identity,
  custodianId: string,
): Promise<string[]> {
  return withUserScope(identity, async (tx) => {
    const rows = await tx.custodianFeeScheduleDocument.findMany({
      where: { custodianId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  });
}

/** Move listed fee-schedule rows onto another custodian. Does not change id, content, byteSize, or sha256. */
export async function reassignCustodianFeeScheduleDocuments(
  identity: Identity,
  documentIds: string[],
  custodianId: string,
): Promise<number> {
  if (documentIds.length === 0) return 0;
  return withUserScope(identity, async (tx) => {
    const result = await tx.custodianFeeScheduleDocument.updateMany({
      where: { id: { in: documentIds } },
      data: { custodianId },
    });
    return result.count;
  });
}

/** One-file byte read for download. Never used by the library list. */
export async function readCustodianFeeScheduleBytes(
  identity: Identity,
  documentId: string,
): Promise<{ filename: string; contentType: string; content: Buffer } | null> {
  return withUserScope(identity, async (tx) => {
    const row = await tx.custodianFeeScheduleDocument.findUnique({
      where: { id: documentId },
      select: { filename: true, contentType: true, content: true },
    });
    if (!row) return null;
    return {
      filename: row.filename,
      contentType: row.contentType,
      content: Buffer.from(row.content),
    };
  });
}
