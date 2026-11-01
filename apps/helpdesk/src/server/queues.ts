/**
 * Queue reads — node, layer L4.
 *
 * Summaries carry counters only (no record content), so they have no denial path: a queue the viewer
 * cannot read is returned with `canRead: false` and every count zeroed. Breached/warning counters use
 * the same SQL predicates as the list filter over OPEN_STATUSES.
 */
import type { QueueKey, QueueSummary, TicketPriority, TicketStatus, Viewer } from "@/types/domain";
import {
  METRICS_EXCLUDED_STATUSES,
  OPEN_STATUSES,
  QUEUE_KEYS,
  QUEUE_LABELS,
  QUEUE_SLUGS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from "@/types/domain";
import { prisma } from "@/lib/db";
import { canReadQueue, canWriteQueue } from "@/lib/rbac";
import { breachedOpenWhere, loadWarningMinutes, warningOpenWhere } from "@/server/sla-where";

export async function listQueues(): Promise<
  Array<{ id: string; key: QueueKey; slug: string; name: string; description: string }>
> {
  const rows = await prisma.queue.findMany({
    select: { id: true, key: true, name: true, description: true },
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
  });
  return rows.map((q) => ({ id: q.id, key: q.key, slug: QUEUE_SLUGS[q.key], name: q.name, description: q.description }));
}

function zeroByStatus(): Record<TicketStatus, number> {
  const out = {} as Record<TicketStatus, number>;
  for (const s of TICKET_STATUSES) out[s] = 0;
  return out;
}

function zeroByPriority(): Record<TicketPriority, number> {
  const out = {} as Record<TicketPriority, number>;
  for (const p of TICKET_PRIORITIES) out[p] = 0;
  return out;
}

function emptySummary(key: QueueKey, row: { name: string; description: string } | undefined, viewer: Viewer): QueueSummary {
  return {
    key,
    slug: QUEUE_SLUGS[key],
    name: row?.name ?? QUEUE_LABELS[key],
    description: row?.description ?? "",
    total: 0,
    open: 0,
    byStatus: zeroByStatus(),
    byPriority: zeroByPriority(),
    breached: 0,
    warning: 0,
    unassigned: 0,
    canRead: canReadQueue(viewer.groups, key),
    canWrite: canWriteQueue(viewer.groups, key),
  };
}

/**
 * All three queues in QUEUE_KEYS order. `canRead === false` ⇒ every count is 0. `byStatus` covers
 * status ∉ {CLOSED, VOIDED}; `byPriority`, `unassigned`, `breached` and `warning` cover OPEN_STATUSES.
 * CONTRACT-GAP: the contract does not say which statuses `unassigned` spans; OPEN_STATUSES was chosen
 * to match the other actionable counters (a RESOLVED ticket needs no owner).
 *
 * WAVE B, two changes, both from CONTRACT §2:
 *
 *  - **VOIDED is excluded from `total` and `byStatus`.** A ticket entered in error is nobody's number.
 *    `OPEN_STATUSES` never contained VOIDED, so `open`, `byPriority`, `unassigned`, `breached` and
 *    `warning` were already right; `status: { not: "CLOSED" }` was the one predicate that let it
 *    through, and it is the one this counter and /reports would otherwise disagree about.
 *  - **The live warning bands.** `SLA.warningMinutes` is read once per call and threaded
 *    into both SLA predicates, so editing a policy re-colours THIS counter and the ticket badge
 *    together. Without it the feature is half-on: the badge moves and the dashboard number does not.
 *    One extra query per dashboard load, against a four-row table.
 */
export async function getQueueSummaries(viewer: Viewer, now: Date = new Date()): Promise<QueueSummary[]> {
  const rows = await prisma.queue.findMany({ select: { id: true, key: true, name: true, description: true } });
  const rowByKey = new Map(rows.map((r) => [r.key, r] as const));
  const summaries = new Map<QueueKey, QueueSummary>(
    QUEUE_KEYS.map((key) => [key, emptySummary(key, rowByKey.get(key), viewer)] as const),
  );
  const keyById = new Map(rows.map((r) => [r.id, r.key] as const));

  const readableIds = rows.filter((r) => canReadQueue(viewer.groups, r.key)).map((r) => r.id);
  if (readableIds.length === 0) return QUEUE_KEYS.map((k) => summaries.get(k) as QueueSummary);

  const openStatuses: TicketStatus[] = [...OPEN_STATUSES];
  const warnings = await loadWarningMinutes();
  const [byStatus, byPriority, unassigned, breached, warning] = await Promise.all([
    prisma.ticket.groupBy({
      by: ["queueId", "status"],
      where: { queueId: { in: readableIds }, status: { notIn: ["CLOSED", ...METRICS_EXCLUDED_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ["queueId", "priority"],
      where: { queueId: { in: readableIds }, status: { in: openStatuses } },
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ["queueId"],
      where: { queueId: { in: readableIds }, status: { in: openStatuses }, assigneeId: null },
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ["queueId"],
      where: { AND: [{ queueId: { in: readableIds } }, breachedOpenWhere(now, warnings)] },
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ["queueId"],
      where: { AND: [{ queueId: { in: readableIds } }, warningOpenWhere(now, warnings)] },
      _count: { _all: true },
    }),
  ]);

  const summaryFor = (queueId: string): QueueSummary | undefined => {
    const key = keyById.get(queueId);
    return key === undefined ? undefined : summaries.get(key);
  };

  for (const g of byStatus) {
    const s = summaryFor(g.queueId);
    if (!s) continue;
    s.byStatus[g.status] += g._count._all;
    s.total += g._count._all;
    if (openStatuses.includes(g.status)) s.open += g._count._all;
  }
  for (const g of byPriority) {
    const s = summaryFor(g.queueId);
    if (s) s.byPriority[g.priority] += g._count._all;
  }
  for (const g of unassigned) {
    const s = summaryFor(g.queueId);
    if (s) s.unassigned += g._count._all;
  }
  for (const g of breached) {
    const s = summaryFor(g.queueId);
    if (s) s.breached += g._count._all;
  }
  for (const g of warning) {
    const s = summaryFor(g.queueId);
    if (s) s.warning += g._count._all;
  }

  return QUEUE_KEYS.map((k) => summaries.get(k) as QueueSummary);
}

export async function getQueueSummary(viewer: Viewer, key: QueueKey, now: Date = new Date()): Promise<QueueSummary | null> {
  const all = await getQueueSummaries(viewer, now);
  return all.find((s) => s.key === key) ?? null;
}
