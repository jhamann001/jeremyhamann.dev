import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-segment loading UI for the whole `/admin` section (§7 probe G13).
 *
 * Why this file exists: all three admin pages — `/admin/macros`, `/admin/users`, `/admin/intake` — are
 * `dynamic = "force-dynamic"` server renders that do `requireUser` → `getRequestContext` → an RBAC
 * check (which may itself await an `AUTHZ_DENIED` write) → one or two database queries before their
 * first byte. The segment had no boundary, so an App Router client navigation held the PREVIOUS screen
 * on display, unchanged, for all of that. On a phone these routes are reached from inside the Account
 * sheet: the tap closes the sheet and then nothing else happens, and the natural response is a second
 * tap. G13 ("a navigation paints something within 400 ms") is a global probe and §7's Wave A admin
 * bullet makes the global probes binding on these screens regardless of where their per-screen
 * assertions live.
 *
 * One file covers all three because a `loading.tsx` is the Suspense fallback for its segment AND every
 * segment nested under it. It sits inside `admin/layout.tsx`, which is pure markup and therefore
 * already on screen — so this renders the PAGE's own shape, not a second "Admin" band.
 *
 * It is a SKELETON, not a spinner, and it mirrors the shape the three views share (`<header>` with an
 * `h2` and a paragraph → search field → filter chips → a list of bordered cards) so the page does not
 * jump when the content lands. It shows no data because it has none: `loading.tsx` renders before the
 * gate, before the audited read, and before we know whether this viewer may see the page at all —
 * nothing here may hint at a macro, a staff account or a held message. `aria-busy` plus one polite
 * status line is how a screen reader hears the same thing.
 */
export default function AdminLoading(): React.JSX.Element {
  return (
    <section aria-busy="true" className="flex flex-col gap-4">
      <span role="status" className="sr-only">
        Loading…
      </span>

      {/* Header: title, the two-line explanation each admin view carries, and (md+) its primary action. */}
      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full max-w-xl" />
          <Skeleton className="h-4 w-4/5 max-w-md" />
        </div>
        <Skeleton className="hidden h-9 w-32 shrink-0 md:block" />
      </header>

      <div className="flex flex-col gap-3">
        {/* Search field: 44 px on a phone (globals.css `--wm-tap`), 36 px from md — same as the real one. */}
        <Skeleton className="h-11 w-full md:h-9" />
        {/* Filter chips: `min-w-11` is the G2 floor the real chips carry. */}
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-11 min-w-11 w-20 rounded-md md:h-9" />
          ))}
        </div>
      </div>

      {/* Three card-shaped rows. Real borders and `bg-card`, so light and dark both read correctly. */}
      <ul className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <li key={i} className="rounded-lg border bg-card p-4 text-card-foreground">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-24" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
