import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-segment loading UI for `/inbox` (§7 probe G13).
 *
 * Same reason as every other boundary in this app: the page is `dynamic = "force-dynamic"` and does
 * `requireUser` → `getRequestContext` → an RBAC check → a database read before its first byte, and
 * without a boundary an App Router client navigation holds the PREVIOUS screen on display for all of
 * it. The inbox is reached from a bell in the topbar, one tap, many times a day; a tap that appears to
 * do nothing is the one that gets tapped twice.
 *
 * It shows no data because it has none: `loading.tsx` renders before the gate and before the read, and
 * nothing here may hint at whose ticket, whose mention, or how many. `aria-busy` plus one polite
 * status line is how a screen reader hears the same thing.
 */
export default function InboxLoading(): React.JSX.Element {
  return (
    <section aria-busy="true" className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <span role="status" className="sr-only">
        Loading…
      </span>

      <header className="flex flex-col gap-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full max-w-md" />
      </header>

      {/* Unread / all filter chips: `min-w-11` is the 44 px floor the real chips carry. */}
      <div className="flex flex-wrap gap-2">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-11 w-24 min-w-11 rounded-md md:h-9" />
        ))}
      </div>

      <ul className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className="rounded-lg border bg-card p-3 text-card-foreground">
            <div className="flex items-start gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
