import type { TicketLinkKind } from "@/types/domain";
import { TICKET_LINK_INVERSE_LABELS, TICKET_LINK_KIND_LABELS } from "@/types/domain";

/**
 * The link label that matches the DIRECTION being looked at.
 *
 * Fix round 2. This lived in `link-kind-icon.tsx`, which is a `"use client"` module, and
 * `links-panel.tsx` — an async SERVER component — called it at render. Next turns EVERY
 * export of a client module into a client reference, so the call threw
 * ("Attempted to call linkKindLabel() from the server") and the whole ticket detail page fell to the
 * `(app)` error boundary. Because `listTicketLinks` reads a link from BOTH ends, one `TicketLink` row
 * bricked two ticket pages, and the Remove control lives inside the panel that no longer rendered, so
 * the link could not be undone through the UI either.
 *
 * The rule this file exists to keep: a function a server component calls must live in a module with no
 * `"use client"` directive. `LinkKindIcon` stays in the client module, because it is a component and a
 * client reference is exactly what a component should be. `ticket-surface-probe.test.ts` sweeps the
 * repo for the same mistake.
 *
 * Layer L1-safe: imports `@/types/domain` and nothing else.
 */
export function linkKindLabel(kind: TicketLinkKind, inbound: boolean): string {
  return inbound ? TICKET_LINK_INVERSE_LABELS[kind] : TICKET_LINK_KIND_LABELS[kind];
}
