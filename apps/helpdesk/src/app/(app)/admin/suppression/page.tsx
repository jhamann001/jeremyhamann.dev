import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getRequestContext } from "@/lib/request-context";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { canAdminSuppression } from "@/lib/rbac";
import { listSuppressionCandidates, listSuppressions } from "@/server/suppression.actions";
import { SuppressionAdminView } from "@/components/admin/suppression/suppression-admin-view";

export const dynamic = "force-dynamic";

/**
 * Suppression — slice B9 (`email-2`, §5 `suppression:admin`).
 *
 * The GATE below is the foundation's and is kept VERBATIM, exactly as Wave A's admin pages keep
 * theirs: authenticate, check the capability, write the `AUTHZ_DENIED` row, then `notFound()` rather
 * than a 403 so the page's existence does not leak to someone who may not use it. Middleware refuses
 * this path too (`isPathAllowed`), but middleware is a coarse UX gate and the server is authoritative
 * — and both server actions below re-check the same capability a third time.
 *
 * Suppression stops OUTBOUND mail only — inbound from the same address still arrives and still becomes
 * a ticket. That sentence is on the screen as well as in this comment, because it is the single thing
 * an operator can get wrong about this page.
 *
 * Two lists, deliberately on one screen. The suppressions are the decisions the desk has made; the
 * candidates are the hard bounces nobody has decided about yet. Separating them into two pages would
 * make the second one a page nobody opens, which is exactly how a bounced address stays un-acted-on.
 *
 * A plain server render with no pagination, like `/admin/api-tokens`: the list is an inventory of tens
 * and every mutation ends in `router.refresh()`, so a client fetch would be a second copy to keep in
 * step.
 */
export default async function AdminSuppressionPage(): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const ctx = await getRequestContext();

  if (!canAdminSuppression(viewer.groups)) {
    await recordDenied(actorFromViewer(viewer), ctx, "suppression:admin path:/admin/suppression");
    notFound();
  }

  const [suppressions, candidates] = await Promise.all([listSuppressions(), listSuppressionCandidates()]);

  // An admin screen that renders an empty list on a failed read is a lie. The actions have already
  // written their own AUTHZ_DENIED row for a FORBIDDEN; anything else here is a failure to read.
  if (!suppressions.ok) {
    return (
      <section className="rounded-lg border border-dashed bg-card p-6 text-card-foreground">
        <h2 className="text-base font-semibold">Suppression</h2>
        <p className="mt-3 text-sm text-muted-foreground">
          The suppression list could not be loaded. Nothing was changed — reload the page.
        </p>
      </section>
    );
  }

  return (
    <SuppressionAdminView
      suppressions={suppressions.data}
      candidates={candidates.ok ? candidates.data : []}
      candidatesFailed={!candidates.ok}
    />
  );
}
