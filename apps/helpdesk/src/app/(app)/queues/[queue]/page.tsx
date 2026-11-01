/**
 * /queues/[queue] — the dashboard pinned to one queue.
 * Unknown slug → 404; a queue the viewer cannot read → /no-access (middleware already redirected the
 * common case; this is the authoritative server check, I5). `query.queueKey` is pinned to the route.
 */
import { notFound, redirect } from "next/navigation";
import type { AssigneeOption, QueueKey, TicketListQuery, Viewer } from "@/types/domain";
import { canReadQueue, canWriteQueue, queueKeyFromSlug } from "@/lib/rbac";
import { requireUser } from "@/lib/session";
import { getQueueSummaries } from "@/server/queues";
import { listAssignableUsers, listTickets } from "@/server/tickets";
import { parseTicketListQuery } from "@/server/validation";
import { DashboardView } from "@/components/dashboard/dashboard-view";

export const dynamic = "force-dynamic";

async function loadAssigneesForQueue(viewer: Viewer, queueKey: QueueKey): Promise<Partial<Record<QueueKey, AssigneeOption[]>>> {
  if (!canWriteQueue(viewer.groups, queueKey)) return {};
  return { [queueKey]: await listAssignableUsers(queueKey) };
}

export default async function QueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ queue: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { queue } = await params;
  const queueKey = queueKeyFromSlug(queue);
  if (queueKey === null) notFound();

  const viewer = await requireUser();
  if (!canReadQueue(viewer.groups, queueKey)) redirect("/no-access");

  const query: TicketListQuery = { ...parseTicketListQuery(await searchParams), queueKey };

  const [summaries, page, assigneesByQueue] = await Promise.all([
    getQueueSummaries(viewer),
    listTickets(viewer, query),
    loadAssigneesForQueue(viewer, queueKey),
  ]);

  return (
    <DashboardView
      viewer={viewer}
      summaries={summaries}
      page={page}
      query={query}
      assigneesByQueue={assigneesByQueue}
      pinnedQueue={queueKey}
    />
  );
}
