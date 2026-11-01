import { prisma } from "@/lib/prisma";
import { summarizeCustodianTimings } from "@/lib/custodian-timing";

/**
 * Load the completed inbound transfers used by every custodian timing surface.
 * Keeping this query in one place prevents the admin API and MCP tools from
 * silently applying different completion, direction, or deletion rules.
 */
export async function loadObservedCustodianTimings(custodianId?: string) {
  const timingRecords = await prisma.acatRecord.findMany({
    where: {
      ...(custodianId
        ? { custodianId }
        : { custodianId: { not: null } }),
      deletedAt: null,
      direction: { equals: "In", mode: "insensitive" },
      apexCompletionDate: { not: null },
    },
    select: {
      custodianId: true,
      originalClientRequestDate: true,
      acatDate: true,
      apexCompletionDate: true,
      type: true,
    },
  });

  return summarizeCustodianTimings(timingRecords);
}
