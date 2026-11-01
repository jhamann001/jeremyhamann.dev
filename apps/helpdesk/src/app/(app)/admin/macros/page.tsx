import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getRequestContext } from "@/lib/request-context";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { canAdminMacros } from "@/lib/rbac";
import { listMacrosAdmin } from "@/server/macros";
import { MacrosAdminView } from "@/components/admin/macros/macros-admin-view";

export const dynamic = "force-dynamic";

/**
 * Macro administration — slice S9.
 *
 * The GATE below is the foundation's and is kept verbatim: authenticate, check `canAdminMacros`
 * (ops_team or compliance_officers), write the AUTHZ_DENIED row, then 404 rather than
 * 403 so the page's existence does not leak to someone who may not use it. Middleware refuses the
 * path too, but middleware is a coarse UX gate and the server is authoritative — which is why
 * `listMacrosAdmin` re-checks the same capability a third time.
 *
 * The list is a plain server render: the macro library is small, it is not paginated, and every
 * mutation ends in `router.refresh()`, so there is no client fetch and no second copy of the data.
 */
export default async function AdminMacrosPage(): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const ctx = await getRequestContext();

  if (!canAdminMacros(viewer.groups)) {
    await recordDenied(actorFromViewer(viewer), ctx, "macro:admin path:/admin/macros");
    notFound();
  }

  const macros = await listMacrosAdmin(viewer, ctx);

  return <MacrosAdminView macros={macros} />;
}
