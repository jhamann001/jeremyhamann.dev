/**
 * /dashboard — the operator screen.
 * List rows and counters expose no record content, so this render is not an audited view; the
 * preview sheet and the detail page are. Everything the client needs is serialized as DTOs.
 */
import type { AssigneeOption, QueueKey, Viewer } from "@/types/domain";
import { canWriteQueue, readableQueues } from "@/lib/rbac";
import { requireUser } from "@/lib/session";
import { getQueueSummaries } from "@/server/queues";
import { listAssignableUsers, listTickets } from "@/server/tickets";
import { parseTicketListQuery } from "@/server/validation";
import { DashboardView } from "@/components/dashboard/dashboard-view";

export const dynamic = "force-dynamic";

/** One `listAssignableUsers` per readable queue the viewer can write (assignee filter + preview select). */
async function loadAssigneesByQueue(viewer: Viewer): Promise<Partial<Record<QueueKey, AssigneeOption[]>>> {
  const writable = readableQueues(viewer.groups).filter((q) => canWriteQueue(viewer.groups, q));
  const lists = await Promise.all(writable.map((q) => listAssignableUsers(q)));
  const out: Partial<Record<QueueKey, AssigneeOption[]>> = {};
  writable.forEach((q, i) => {
    out[q] = lists[i] ?? [];
  });
  return out;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const query = parseTicketListQuery(await searchParams);

  const [summaries, page, assigneesByQueue] = await Promise.all([
    getQueueSummaries(viewer),
    listTickets(viewer, query),
    loadAssigneesByQueue(viewer),
  ]);

  return (
    <DashboardView viewer={viewer} summaries={summaries} page={page} query={query} assigneesByQueue={assigneesByQueue} />
  );
}
