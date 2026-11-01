import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getRequestContext } from "@/lib/request-context";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { canUseInbox } from "@/lib/rbac";
import { listInbox } from "@/server/notifications";
import { InboxView } from "@/components/inbox/inbox-view";
import { parseInboxFilters } from "@/components/inbox/inbox-query";

export const dynamic = "force-dynamic";

/**
 * Inbox — slice **B1**.
 *
 * The GATE below is the foundation's and is kept VERBATIM, exactly as Wave A's admin pages keep
 * theirs: authenticate, check the capability, write the `AUTHZ_DENIED` row, then `notFound()` rather
 * than a 403 so the page's existence does not leak to someone who may not use it. Middleware refuses
 * this path too (`isPathAllowed`), but middleware is a coarse UX gate and the server is authoritative
 * — and `listInbox` re-checks a third time.
 *
 * NO VIEW ROW IS WRITTEN. The page lists notifications addressed to the
 * signed-in person: a kind, a sanitized preview, a WM number, a timestamp, and — only for tickets in
 * their readable queues — the subject the dashboard already shows them. Opening one is the audited
 * view, exactly as it is from a queue list.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const ctx = await getRequestContext();

  if (!canUseInbox(viewer.groups)) {
    await recordDenied(actorFromViewer(viewer), ctx, "inbox path:/inbox");
    notFound();
  }

  const filters = parseInboxFilters(await searchParams);
  const page = await listInbox(viewer, {
    kinds: filters.kind === undefined ? [] : [filters.kind],
    unreadOnly: filters.unreadOnly,
    cursor: filters.cursor ?? null,
  });

  return <InboxView page={page} kind={filters.kind} unreadOnly={filters.unreadOnly} cursor={filters.cursor} />;
}
