import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getRequestContext } from "@/lib/request-context";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { canReadFlags } from "@/lib/rbac";
import { env } from "@/lib/env";
import { FLAG_CATALOG, toFlagRows } from "@/components/admin/flags/flag-catalog";
import { FlagsAdminView } from "@/components/admin/flags/flags-admin-view";

export const dynamic = "force-dynamic";

/**
 * Capabilities — slice B4.
 *
 * The GATE below is the foundation's and is kept VERBATIM, exactly as Wave A's admin pages keep
 * theirs: authenticate, check the capability, write the `AUTHZ_DENIED` row, then `notFound()` rather
 * than a 403 so the page's existence does not leak to someone who may not use it. Middleware refuses
 * this path too (`isPathAllowed`), but middleware is a coarse UX gate and the server is authoritative
 *.
 *
 * `flags:read` is `canAdminUsers || canViewAudit` — ops_team and compliance_officers.
 * The officers are on this list because "what was switched on at the time" is a compliance question
 * before it is an engineering one; they get the read-only view and none of the four admin screens
 * that mint, revoke or stop anything.
 *
 * THE PRESENCE MAP IS BUILT HERE, deliberately, and it is the only place a value is touched. Each
 * entry is `typeof value !== "undefined"` (or the boolean itself for a literal-"true" key) — a
 * predicate, never the value — and what crosses to the component is a boolean. `@/lib/env` cannot be
 * imported from `src/components/**` at all, and the catalog is written so it never needs to be.
 */
export default async function AdminFlagsPage(): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const ctx = await getRequestContext();

  if (!canReadFlags(viewer.groups)) {
    await recordDenied(actorFromViewer(viewer), ctx, "flags:read path:/admin/flags");
    notFound();
  }

  const present: Record<string, boolean> = {
    AUTO_ACK_ENABLED: env.AUTO_ACK_ENABLED,
    RESOLVED_NOTICE_ENABLED: env.RESOLVED_NOTICE_ENABLED,
    REPLY_TOKEN_SECRET: env.REPLY_TOKEN_SECRET !== undefined,
    APP_BASE_URL: env.APP_BASE_URL !== undefined,
    MAILBOX_MAP: env.MAILBOX_MAP !== undefined,
    EMAIL_TRUSTED_AUTHSERV_IDS: env.EMAIL_TRUSTED_AUTHSERV_IDS !== undefined,
    ALLOWED_REQUESTER_DOMAINS: env.ALLOWED_REQUESTER_DOMAINS !== undefined,
    AUTO_CLOSE_DAYS: env.AUTO_CLOSE_DAYS !== undefined,
    DIGEST_HOUR_LOCAL: env.DIGEST_HOUR_LOCAL !== undefined,
    SLA_ALERT_SLACK_WEBHOOK_URL: env.SLA_ALERT_SLACK_WEBHOOK_URL !== undefined,
    SLACK_QUEUE_WEBHOOKS: env.SLACK_QUEUE_WEBHOOKS !== undefined,
    SLACK_USER_MAP: env.SLACK_USER_MAP !== undefined,
    VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY !== undefined,
    VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY !== undefined,
    VAPID_SUBJECT: env.VAPID_SUBJECT !== undefined,
    AI_DRAFTING_PROVIDER: env.AI_DRAFTING_PROVIDER !== undefined,
    VERTEX_PROJECT: env.VERTEX_PROJECT !== undefined,
    VERTEX_LOCATION: env.VERTEX_LOCATION !== undefined,
    VERTEX_MODEL: env.VERTEX_MODEL !== undefined,
    WEBHOOKS_ENABLED: env.WEBHOOKS_ENABLED,
    MCP_ENABLED: env.MCP_ENABLED,
    ATTACHMENTS_BUCKET: env.ATTACHMENTS_BUCKET !== undefined,
    DUPLICATE_COPY_BUCKET: env.DUPLICATE_COPY_BUCKET !== undefined,
  };

  return <FlagsAdminView rows={toFlagRows(FLAG_CATALOG, present)} environment={env.APP_ENV} />;
}
