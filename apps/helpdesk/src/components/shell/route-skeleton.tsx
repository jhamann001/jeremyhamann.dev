import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-segment loading skeletons shared by the `(app)` segments' `loading.tsx` files
 * (§7 probe G13).
 *
 * Why these are shared rather than written per route: `/dashboard` and `/queues/[queue]` render the
 * SAME component (`DashboardView`) with different props, so one shape describes both, and a skeleton
 * that drifts from the page it stands in for makes the layout jump exactly when the content lands.
 *
 * Every export here is a pure presentational server component. A `loading.tsx` paints BEFORE the
 * route's RBAC gate has run — it is shown to a viewer who may turn out to be denied — so nothing in
 * this module may read a session, a database, `params` or `searchParams`, and nothing may `await`.
 * `aria-busy` plus one polite `role="status"` line is how a screen reader hears the same thing.
 *
 * Phone tap sizes are the real controls' (`h-11 … md:h-9`, `min-w-11`), so the skeleton reserves the
 * space the page is about to need instead of a smaller one.
 */

/** One polite announcement per fallback. Visible skeletons are for the eye; this is for the ear. */
function LoadingAnnouncement({ label }: { label: string }): React.JSX.Element {
  return (
    <span role="status" className="sr-only">
      {label}
    </span>
  );
}

/** Title + description, with the md+ primary action every list header carries. */
function PageHeaderSkeleton(): React.JSX.Element {
  return (
    <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <Skeleton className="hidden h-9 w-28 shrink-0 md:block" />
    </header>
  );
}

/**
 * `/dashboard` and `/queues/[queue]`: header → queue counters → filters → ticket list.
 *
 * Both pages are `dynamic = "force-dynamic"` and do `requireUser` → `parseTicketListQuery` → three
 * parallel reads (`queueSummaries`, `listTickets`, the per-queue assignee lists) before their first
 * byte. These are the bottom navigation's own destinations, so with no boundary a tab tap left the
 * previous screen on display, unchanged, for the whole of that — the dead tap G13 exists to catch.
 */
export function TicketListSkeleton(): React.JSX.Element {
  return (
    <section aria-busy="true" className="flex flex-col gap-4 md:gap-5">
      <LoadingAnnouncement label="Loading tickets…" />
      <PageHeaderSkeleton />

      {/* Queue counters: a horizontal snap row on a phone, a grid from md. */}
      <div className="flex gap-3 overflow-hidden">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-[85%] shrink-0 rounded-lg md:w-full" />
        ))}
      </div>

      {/* Filters: search, then the phone `Filters (n)` trigger / the md+ inline control row. */}
      <div className="flex flex-col gap-3">
        <Skeleton className="h-11 w-full md:h-9" />
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-11 min-w-11 w-24 rounded-md md:h-9" />
          ))}
        </div>
      </div>

      {/* Ticket cards at every width: the table is md+ only and the card list is what a phone sees. */}
      <ul className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className="rounded-lg border bg-card p-4 text-card-foreground">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
              <Skeleton className="h-5 w-11/12" />
              <Skeleton className="h-4 w-2/3" />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-11 w-24 rounded-md md:h-9" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * `/compliance/audit`: header with the two actions, the filter row, then the ledger.
 *
 * `requireGroup("compliance_officers")` → `getRequestContext` → `queryAuditLog`, which itself WRITES
 * an `AUDIT_LOG_VIEWED` row before returning — the slowest gated read in the app, and the one where a
 * fallback must be most careful: it paints before the group check has decided anything.
 */
export function AuditLogSkeleton(): React.JSX.Element {
  return (
    <section aria-busy="true" className="flex flex-col gap-4">
      <LoadingAnnouncement label="Loading the audit log…" />
      <header className="flex flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full max-w-lg" />
        </div>
        {/* Verify chain / Export CSV — a 2-column grid on a phone, inline from md. */}
        <div className="grid grid-cols-2 gap-2 md:flex md:w-auto">
          <Skeleton className="h-11 w-full rounded-md md:h-9 md:w-32" />
          <Skeleton className="h-11 w-full rounded-md md:h-9 md:w-32" />
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-11 min-w-11 w-28 rounded-md md:h-9" />
        ))}
      </div>

      <ul className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <li key={i} className="rounded-lg border bg-card p-4 text-card-foreground">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-5 w-32 rounded-full" />
                <Skeleton className="h-4 w-24" />
              </div>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * `/tickets/new`: the create form. `requireUser` → one `listAssignableUsers` per creatable queue
 * before the first byte, and the route is reached from the header button and the dashboard's own
 * empty state.
 */
export function TicketFormSkeleton(): React.JSX.Element {
  return (
    <section aria-busy="true" className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <LoadingAnnouncement label="Loading the new-ticket form…" />
      <header className="flex flex-col gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </header>

      <div className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-28" />
            {/* Every Select/Input on this form is 44 px on a phone and 16 px text. */}
            <Skeleton className="h-11 w-full md:h-9" />
          </div>
        ))}
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>

      {/* md+ action row. On a phone the form's own StickyActionBar owns the bottom edge instead. */}
      <div className="hidden justify-end gap-2 md:flex">
        <Skeleton className="h-9 w-20 rounded-md" />
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>
    </section>
  );
}
