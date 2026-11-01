/**
 * /tickets/new — create a ticket, or log a call (Wave B B11).
 *
 * Gate: the viewer must be able to create into at least one queue (compliance-only users cannot).
 * Assignee options are loaded per creatable queue; `createTicket` re-validates eligibility server-side.
 *
 * The page is unchanged by the log-a-call variant: the channel selector, the phone-only requester and
 * the "client was reached" option are all inside `NewTicketForm`, and both write paths
 * (`createTicket`, `logCall`) re-check `canCreateTicket` on the server. This page loads assignee
 * options for the web-form path only — a logged call is intake and is assigned from the board.
 */
import { redirect } from "next/navigation";
import type { AssigneeOption, QueueKey } from "@/types/domain";
import { creatableQueues } from "@/lib/rbac";
import { requireUser } from "@/lib/session";
import { listAssignableUsers } from "@/server/tickets";
import { NewTicketForm } from "@/components/dashboard/new-ticket-form";

export const dynamic = "force-dynamic";

export default async function NewTicketPage(): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const creatable = creatableQueues(viewer.groups);
  if (creatable.length === 0) redirect("/no-access");

  const lists = await Promise.all(creatable.map((q) => listAssignableUsers(q)));
  const assigneesByQueue: Partial<Record<QueueKey, AssigneeOption[]>> = {};
  creatable.forEach((q, i) => {
    assigneesByQueue[q] = lists[i] ?? [];
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">New ticket</h1>
        <p className="text-xs text-muted-foreground">
          Pick how the request reached us, then the category — which routes it to a queue and sets its default
          priority and SLA clocks. A call can be logged against a phone number alone. Creation is recorded.
        </p>
      </header>
      <NewTicketForm viewer={viewer} assigneesByQueue={assigneesByQueue} />
    </div>
  );
}
