"use client";

import { useEffect, useState } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isStaleDeployError, reloadOnceForNewDeploy } from "@/lib/stale-deploy";

/**
 * The sign-in page's error boundary. Without one, a sign-in that threw showed Next's bare "Application
 * error". The usual cause is a sign-in page opened before a deploy (src/lib/stale-deploy.ts): nothing ran,
 * so the page reloads itself once and the next click works. Like the app's boundary, it never renders
 * `error.message`.
 */
export default function SignInErrorBoundary({ error }: { error: Error & { digest?: string } }): React.JSX.Element {
  const stale = isStaleDeployError(error);
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    if (stale) setReloading(reloadOnceForNewDeploy());
  }, [stale]);

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div role="alert" className="w-full max-w-md rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
        <div className="flex items-start gap-3">
          <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h1 className="text-base font-semibold">
              {stale ? "The help desk was just updated" : "Sign-in didn't go through"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {stale
                ? reloading
                  ? "This page opened before the update. Reloading it now: choose your sign-in again."
                  : "This page opened before the update. Reload it, then choose your sign-in again."
                : "Reload the page and try again."}
            </p>
            {error.digest ? (
              <p className="font-mono text-xs break-all text-muted-foreground">Reference: {error.digest}</p>
            ) : null}
            {reloading ? null : (
              <div className="pt-2">
                <Button type="button" variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => window.location.reload()}>
                  <RotateCcw aria-hidden />
                  Reload
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
