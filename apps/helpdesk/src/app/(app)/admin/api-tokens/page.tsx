import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getRequestContext } from "@/lib/request-context";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { canAdminTokens } from "@/lib/rbac";
import { listApiTokens } from "@/server/api-tokens.actions";
import { ApiTokensAdminView } from "@/components/admin/api-tokens/api-tokens-admin-view";

export const dynamic = "force-dynamic";

/**
 * API tokens — slice B8 (`client-api-mcp`; the build record `tokens:admin`).
 *
 * The GATE below is the foundation's and is kept VERBATIM, exactly as Wave A's admin pages keep
 * theirs: authenticate, check the capability, write the `AUTHZ_DENIED` row, then `notFound()` rather
 * than a 403 so the page's existence does not leak to someone who may not use it. Middleware refuses
 * this path too (`isPathAllowed`), but middleware is a coarse UX gate and the server is authoritative
 * — and `listApiTokens` re-checks the same capability a third time.
 *
 * The plaintext token is shown ONCE, at creation, from the action's own result. Nothing on this page
 * renders a stored `tokenHash` and no route echoes one: `API_TOKEN_SELECT` does not select that
 * column at all, so there is no value in the DTO to leak by accident.
 *
 * A plain server render with no pagination, like `/admin/macros`: the credential inventory is a list
 * of tens, every mutation ends in `router.refresh()`, and a second client fetch would be a second
 * copy of the same rows to keep in step.
 */
export default async function AdminApiTokensPage(): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const ctx = await getRequestContext();

  if (!canAdminTokens(viewer.groups)) {
    await recordDenied(actorFromViewer(viewer), ctx, "tokens:admin path:/admin/api-tokens");
    notFound();
  }

  // `listApiTokens` is a server action rather than a plain read module because B8 owns
  // `api-tokens.actions.ts` and not a sibling read file; a server component may call
  // one directly, and it carries the same `runAction` authenticate → RBAC → audit-on-denial path.
  const result = await listApiTokens();
  if (!result.ok) {
    // The action has already written its own AUTHZ_DENIED row for a FORBIDDEN. Anything else here is
    // a failure to read, and an admin screen that renders an empty list on a failed read is a lie.
    return (
      <section className="rounded-lg border border-dashed bg-card p-6 text-card-foreground">
        <h2 className="text-base font-semibold">API tokens</h2>
        <p className="mt-3 text-sm text-muted-foreground">
          The credential list could not be loaded. Nothing was changed — reload the page.
        </p>
      </section>
    );
  }

  return <ApiTokensAdminView tokens={result.data} />;
}
