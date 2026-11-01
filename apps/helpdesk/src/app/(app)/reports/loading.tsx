import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-segment loading UI for `/reports` (§7 probe G13).
 *
 * Reports are the slowest read in the app by construction — percentile aggregates over the whole
 * ticket table for a date range — so this is the boundary that matters most: without it a navigation
 * to /reports holds the previous screen for as long as the query takes, which on a real book is
 * seconds rather than milliseconds.
 *
 * The shape mirrors the page (filter bar → chart panel → data table) so nothing jumps when the numbers
 * land, and it shows none of them: `loading.tsx` renders before the gate and before the read.
 */
export default function ReportsLoading(): React.JSX.Element {
  return (
    <section aria-busy="true" className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <span role="status" className="sr-only">
        Loading…
      </span>

      <header className="flex flex-col gap-2">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </header>

      {/* Report picker, date range, granularity: 44 px on a phone, 36 px from md. */}
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-11 w-32 min-w-11 rounded-md md:h-9" />
        ))}
      </div>

      {/* The chart panel: one block at the height the inline SVG occupies, so the page does not jump. */}
      <div className="rounded-lg border bg-card p-4 text-card-foreground">
        <Skeleton className="h-56 w-full md:h-72" />
      </div>

      {/* The data-table toggle's rows. */}
      <ul className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <li key={i} className="flex items-center gap-3 rounded-md border bg-card px-3 py-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-16" />
          </li>
        ))}
      </ul>
    </section>
  );
}
