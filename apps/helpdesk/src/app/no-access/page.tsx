import { redirect } from "next/navigation";
import { ShieldOff } from "lucide-react";
import type { Viewer } from "@/types/domain";
import { getViewer } from "@/lib/session";
import { safeRelativePath } from "@/lib/rbac";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { getRequestContext } from "@/lib/request-context";
import { signOutAction } from "@/app/sign-in/sign-in.actions";
import { GROUP_LABELS } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

/**
 * Landing page for an authenticated user the middleware turned away. The attempted
 * path reaches the ledger only when it is a well-formed same-origin relative path; anything else
 * is recorded as the literal `path:invalid`. The page never echoes `from`.
 */
export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}): Promise<React.JSX.Element> {
  const viewer: Viewer | null = await getViewer();
  if (!viewer) {
    // CONTRACT-GAP: §g specifies behaviour only "when viewer". /no-access sits outside the
    // middleware matcher, so an unauthenticated hit is possible; the most conservative reading
    // is to send it to sign-in without writing anything.
    redirect("/sign-in");
  }

  const { from } = await searchParams;
  // The PATH only, never its query string. `src/auth.config.ts`
  // already drops the query before redirecting, so this is the second of two: a `/no-access?from=…`
  // link can be typed, pasted or kept in a bookmark, and this row is append-only and no-hard-delete —
  // an address that reached it could never be taken back out. Stripped HERE rather than inside
  // `safeRelativePath`, whose other callers legitimately want the query they were given.
  // `"unknown"` and `"invalid"` contain no `?` and pass through this unchanged.
  const attempted = from === undefined ? "unknown" : safeRelativePath(from, "invalid");
  const path = attempted.split("?", 1)[0];
  await recordDenied(actorFromViewer(viewer), await getRequestContext(), `path:${path}`);

  return (
    <main className="flex min-h-svh items-start justify-center bg-background px-safe pt-6 pb-safe text-foreground sm:items-center">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
        <div className="flex items-start gap-3">
          <ShieldOff aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div>
              <h1 className="text-base font-semibold">You don&apos;t have access to that page</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Your account is signed in but its Okta groups do not grant access to that page. This attempt
                has been recorded.
              </p>
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Signed in as</dt>
              <dd className="font-medium break-all sm:truncate" title={viewer.email}>
                {viewer.email}
              </dd>
              <dt className="text-muted-foreground">Groups</dt>
              <dd className="flex flex-wrap gap-1">
                {viewer.groups.length === 0 ? (
                  <span className="text-muted-foreground italic">none recognized</span>
                ) : (
                  viewer.groups.map((g) => (
                    <Badge key={g} variant="secondary" className="font-normal">
                      {GROUP_LABELS[g]}
                    </Badge>
                  ))
                )}
              </dd>
            </dl>

            <p className="text-sm">
              Access here follows your Okta group membership. Ask the Operations team which group this page
              needs and to raise the request; Compliance reviews access, it does not grant it.
            </p>

            <div className="grid grid-cols-2 gap-2 pt-1 sm:flex sm:justify-start">
              <Button asChild variant="outline">
                <a href="/dashboard">Go to dashboard</a>
              </Button>
              <form action={signOutAction} className="contents">
                <Button type="submit" variant="ghost" className="w-full sm:w-auto">
                  Sign out
                </Button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
