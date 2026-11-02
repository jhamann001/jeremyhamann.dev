import { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";

// Read-only extras for the flag-on transfer detail (mockup fidelity). Runs in
// withUserScope, so app.transfer RLS decides visibility; audit rows expose the
// actor role and action only, never free text from the detail payload.

const HISTORY_LIMIT = 200;

export type WorkspaceTaskMeta = { id: string; status: string; team: string | null; assigned_to: string | null; follow_up_on: Date | null };
export type WorkspaceHistoryEntry = { id: string; at: string; actorRole: string | null; action: string };
export type WorkspaceDetailRecords = { taskMeta: WorkspaceTaskMeta[]; history: WorkspaceHistoryEntry[] };

type AuditRow = { id: bigint; at: Date; actorRole: string | null; action: string };

export async function getWorkspaceDetailRecords(identity: Identity, transferId: string): Promise<WorkspaceDetailRecords> {
  return withUserScope(identity, async tx => {
    const taskMeta = await tx.transferTask.findMany({
      where: { transfer_id: transferId },
      select: { id: true, status: true, team: true, assigned_to: true, follow_up_on: true },
    });
    const audit = await tx.$queryRaw<AuditRow[]>(Prisma.sql`
      SELECT a.id, a.at, a."actorRole", a.action
      FROM audit."AuditLog" a
      WHERE a."entityType" = 'transfer' AND a."entityId" = ${transferId}
      ORDER BY a.at DESC, a.id DESC LIMIT ${HISTORY_LIMIT}`);
    return {
      taskMeta,
      history: audit.map(row => ({ id: String(row.id), at: row.at.toISOString(), actorRole: row.actorRole, action: row.action })),
    };
  });
}
