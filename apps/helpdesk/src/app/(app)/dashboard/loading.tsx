import { TicketListSkeleton } from "@/components/shell/route-skeleton";

/**
 * Route-segment loading boundary (docs/MOBILE_FIRST.md §7 probe G13 — "a navigation paints something
 * within 400 ms"). The shape lives in `@/components/shell/route-skeleton`; see that module for why
 * a fallback may not read a session, a database, `params` or `searchParams`.
 */
export default function DashboardLoading(): React.JSX.Element {
  return <TicketListSkeleton />;
}
