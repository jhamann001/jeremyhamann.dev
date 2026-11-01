import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-segment loading UI for the ticket detail (§7 "Loading states").
 *
 * Why this file exists: opening a ticket is the app's most-used navigation and its slowest server
 * render — `requireUser` → `getTicketDetail` (which AWAITS the `TICKET_VIEWED` insert under the audit
 * chain's advisory lock, I3) → comments / activity / macros / assignees → the streamed panels. With
 * no boundary above it, an App Router client navigation held the previous screen on display,
 * unchanged, for the whole of that: on a phone, tapping "Open" on a ticket card looked like nothing
 * had happened, and the natural response is a second tap.
 *
 * It is a SKELETON, not a spinner, and it mirrors the real layout — header, description, timeline,
 * and (from `md`) the properties column — so the page does not jump when the content lands. It shows
 * no ticket data because it has none: `loading.tsx` renders before the audited read, and nothing here
 * may leak a subject, a requester or a queue. `aria-busy` with a polite status line is how a screen
 * reader hears the same thing.
 */
export default function TicketDetailLoading(): React.JSX.Element {
  return (
    <div aria-busy="true" className="mx-auto flex w-full max-w-7xl flex-col gap-4 md:gap-5">
      <span role="status" className="sr-only">
        Loading ticket…
      </span>

      {/* Header: badge row (SLA first on phones), then the subject. */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-7 w-11/12 max-w-xl md:h-8" />
        <Skeleton className="h-4 w-40" />
      </div>

      <div className="grid gap-4 md:gap-5 lg:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-4 md:gap-5">
          <section className="rounded-lg border bg-card p-4 text-card-foreground">
            <Skeleton className="mb-3 h-4 w-24" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          </section>

          {[0, 1].map((i) => (
            <section key={i} className="rounded-lg border bg-card p-4 text-card-foreground">
              <div className="mb-3 flex items-center gap-2">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-4 w-32" />
              </div>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </section>
          ))}
        </div>

        <div className="hidden flex-col gap-4 md:flex md:gap-5">
          <div className="rounded-lg border bg-card p-4 text-card-foreground">
            <Skeleton className="mb-3 h-4 w-20" />
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
