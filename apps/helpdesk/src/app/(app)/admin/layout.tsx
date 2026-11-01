import type { ReactNode } from "react";

/**
 * FOUNDATION-OWNED. The Admin section's shell: a heading band the two admin pages share.
 *
 * No RBAC here on purpose — a layout is not an authorization boundary in the App Router (it renders
 * around a page whether or not that page is allowed), so each PAGE does its own `requireGroup`-style
 * check and the middleware refuses the path outright (`isPathAllowed`). This file is layout only.
 */
export const dynamic = "force-dynamic";

export default function AdminLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 md:gap-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight md:text-xl">Admin</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Desk configuration. Every change here is recorded in the audit log.
        </p>
      </header>
      {children}
    </div>
  );
}
