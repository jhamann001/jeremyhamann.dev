"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isStaleDeployError } from "@/lib/stale-deploy";

/**
 * Route-segment error boundary for the authenticated shell. Deliberately generic: it never renders
 * `error.message` (which could carry ticket content) — only the opaque digest as a support reference.
 *
 * Fix round 2: the copy used to assert "Nothing was changed." That is true for the case it was written
 * for (I3 — a read whose audit insert failed is not served) but FALSE for the case that actually put
 * people here: a server action that committed its transaction and then threw while re-rendering. The
 * link that bricked the ticket detail page was written, audited, and then denied by a boundary telling
 * the operator it had not been. A boundary cannot know which of the two happened, so it must not claim
 * either — it says what is certain (the page did not render) and what to do next.
 *
 * The one case it can know: a tab opened before a deploy calls an action the new build does not have
 * (src/lib/stale-deploy.ts). That action never ran, so it says nothing was saved and offers a reload, which
 * is the fix; Retry would re-render the same out-of-date page.
 */
export default function AppErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const stale = isStaleDeployError(error);
  return (
    <div role="alert" className="mx-auto mt-8 max-w-md rounded-lg border bg-card p-6 text-card-foreground shadow-sm md:mt-16">
      <div className="flex items-start gap-3">
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 className="text-base font-semibold">{stale ? "This page is out of date" : "This page could not be shown"}</h1>
          <p className="text-sm text-muted-foreground">
            {stale ? (
              "The help desk was updated after this page opened, so that action never reached it and nothing was saved. Reload to continue."
            ) : (
              <>
                Something went wrong while building this page. If you had just saved something, it may
                already have been recorded — reload before trying again, and check the ticket&apos;s activity
                before repeating the action.
              </>
            )}
          </p>
          {error.digest ? (
            <p className="font-mono text-xs break-all text-muted-foreground">Reference: {error.digest}</p>
          ) : null}
          <div className="pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => (stale ? window.location.reload() : reset())}
            >
              <RotateCcw aria-hidden />
              {stale ? "Reload" : "Retry"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
