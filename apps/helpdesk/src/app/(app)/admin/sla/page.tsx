import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getRequestContext } from "@/lib/request-context";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { canAdminSla } from "@/lib/rbac";
import { listQueueAutoAssign, slaPolicyBoard } from "@/server/sla-policies";
import { SlaAdminView } from "@/components/admin/sla/sla-admin-view";

export const dynamic = "force-dynamic";

/**
 * SLA policy — slice B4.
 *
 * The GATE below is the foundation's and is kept VERBATIM, exactly as Wave A's admin pages keep
 * theirs: authenticate, check the capability, write the `AUTHZ_DENIED` row, then `notFound()` rather
 * than a 403 so the page's existence does not leak to someone who may not use it. Middleware refuses
 * this path too (`isPathAllowed`), but middleware is a coarse UX gate and the server is authoritative
 * — and `slaPolicyBoard` / `listQueueAutoAssign` re-check the same capability a third time.
 *
 * The body renders the whole editable policy: every priority (including one that has no row yet and
 * is running on the code fallback) and every queue's auto-assignment switch. Editing a row writes
 * `SLA_POLICY_CHANGED` with old and new, ONE audit row per field that actually moved, and re-stamps
 * nothing: tickets carry their own snapshot of the two due-date clocks, while the warning band
 * is read live so it re-colours open work without rewriting history. The view says both in words.
 */
export default async function AdminSlaPage(): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const ctx = await getRequestContext();

  if (!canAdminSla(viewer.groups)) {
    await recordDenied(actorFromViewer(viewer), ctx, "sla:admin path:/admin/sla");
    notFound();
  }

  // Sequential rather than concurrent on purpose: the two reads share the `sla:admin` check, and a
  // Promise.all would fire the second query for a viewer the first one is about to refuse.
  const policies = await slaPolicyBoard(viewer, ctx);
  const queues = await listQueueAutoAssign(viewer, ctx);

  return <SlaAdminView policies={policies} queues={queues} />;
}
