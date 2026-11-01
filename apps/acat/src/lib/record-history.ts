import { prisma } from "@/lib/prisma";

// The tracker History tab's read. The session route and the machine route
// share it so the two cannot drift: newest first, "read" actions omitted,
// newest 100 only (no paging).
export const RECORD_HISTORY_LIMIT = 100;

export function loadRecordHistory(acatRecordId: string) {
  return prisma.auditLog.findMany({
    where: { acatRecordId, action: { not: "read" } },
    orderBy: { timestamp: "desc" },
    take: RECORD_HISTORY_LIMIT,
    select: {
      id: true,
      action: true,
      field: true,
      oldValue: true,
      newValue: true,
      performedBy: true,
      timestamp: true,
    },
  });
}
