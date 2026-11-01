import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getRequestContext } from "@/lib/request-context";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { env } from "@/lib/env";
import { canAdminWebhooks } from "@/lib/rbac";
import { listWebhookDeliveries, listWebhookEndpoints } from "@/server/webhooks";
import { WebhooksAdminView } from "@/components/admin/webhooks/webhooks-admin-view";

export const dynamic = "force-dynamic";

/**
 * Webhooks — slice B5 (§5 `webhooks:admin`).
 *
 * The GATE below is the foundation's and is kept VERBATIM, exactly as Wave A's admin pages keep
 * theirs: authenticate, check the capability, write the `AUTHZ_DENIED` row, then `notFound()` rather
 * than a 403 so the page's existence does not leak to someone who may not use it. Middleware refuses
 * this path too (`isPathAllowed`), but middleware is a coarse UX gate and the server is authoritative
 * — and `listWebhookEndpoints` re-checks a third time.
 *
 * The body is a plain server render handed to one client view: the endpoint list is small, it is not
 * paginated, and every mutation ends in `router.refresh()`, so there is no client fetch and no second
 * copy of the data — the same shape `/admin/macros` uses. The delivery page is loaded here too rather
 * than per-endpoint, because an operator's first question is "is anything failing", not "is THIS
 * endpoint failing".
 *
 * The signing secret is shown ONCE, at creation, by the create sheet, and never again by anything.
 */
export default async function AdminWebhooksPage(): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const ctx = await getRequestContext();

  if (!canAdminWebhooks(viewer.groups)) {
    await recordDenied(actorFromViewer(viewer), ctx, "webhooks:admin path:/admin/webhooks");
    notFound();
  }

  const [endpoints, deliveries] = await Promise.all([
    listWebhookEndpoints(viewer, ctx),
    listWebhookDeliveries(viewer, {}, ctx),
  ]);

  // G1: a client component may not import `@/lib/env`, so the flag is resolved here and passed down.
  return <WebhooksAdminView endpoints={endpoints} deliveries={deliveries} webhooksEnabled={env.WEBHOOKS_ENABLED} />;
}
