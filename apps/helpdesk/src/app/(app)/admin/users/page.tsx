import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getRequestContext } from "@/lib/request-context";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { canAdminUsers } from "@/lib/rbac";
import { listStaffUsers } from "@/server/users";
import { UsersAdminView } from "@/components/admin/users/users-admin-view";

export const dynamic = "force-dynamic";

/**
 * Staff accounts — slice S8.
 *
 * The GATE below is the foundation's and is kept verbatim: authenticate, check `canAdminUsers`
 * (ops_team only), write the AUTHZ_DENIED row, then 404 rather than 403 so the page's
 * existence does not leak to someone who may not use it. Middleware refuses `/admin/users` too, but
 * middleware is a coarse UX gate and the server is authoritative — which is why `listStaffUsers`
 * re-checks the same capability a third time.
 *
 * `searchParams` was added to the foundation's signature so the list is filterable; the gate itself
 * is unchanged. Filters live in the URL, so a link to "every inactive account" is shareable and the
 * page stays a server render with no client fetch.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; active?: string }>;
}): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const ctx = await getRequestContext();

  if (!canAdminUsers(viewer.groups)) {
    await recordDenied(actorFromViewer(viewer), ctx, "user:admin path:/admin/users");
    notFound();
  }

  const params = await searchParams;
  const search = typeof params.search === "string" ? params.search.trim().slice(0, 200) : "";
  // Anything that is not exactly "true" or "false" means "no filter" — an unparsable value narrows
  // nothing rather than silently hiding half the directory.
  const isActive = params.active === "true" ? true : params.active === "false" ? false : undefined;

  const users = await listStaffUsers(viewer, { search: search || undefined, isActive }, ctx);

  return <UsersAdminView viewerId={viewer.id} users={users} search={search} isActive={isActive} />;
}
