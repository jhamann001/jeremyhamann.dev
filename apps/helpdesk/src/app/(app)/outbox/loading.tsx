import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-segment loading UI for `/outbox` (§7 probe G13): the page reads the Outbox before its first
 * byte, and without a boundary a client navigation holds the previous screen until it has. It shows no
 * data because it has none yet.
 */
export default function OutboxLoading(): React.JSX.Element {
  return (
    <section aria-busy="true" className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <span role="status" className="sr-only">
        Loading…
      </span>
      <header className="flex flex-col gap-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full max-w-md" />
      </header>
      <Skeleton className="h-24 w-full rounded-md" />
      <ul className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <li key={i}>
            <Skeleton className="h-20 w-full rounded-md" />
          </li>
        ))}
      </ul>
    </section>
  );
}
