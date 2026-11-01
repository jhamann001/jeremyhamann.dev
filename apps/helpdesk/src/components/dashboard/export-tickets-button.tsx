"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import type { TicketExportScope, TicketListQuery, Viewer } from "@/types/domain";
import { canExportTickets, canViewAudit } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ticketExportHref } from "@/components/dashboard/ticket-query-params";

/**
 * Staff CSV export of the current ticket list.
 *
 * A plain anchor to the route, styled as a button — exactly like the audit export (S7 of the original
 * build): a server action cannot stream a file, and an anchor keeps the browser's own download UX. The
 * filters travel through the shared serializer, pagination is dropped so the file covers the whole
 * filtered set rather than the page on screen, and the route writes `TICKET_LIST_EXPORTED` **before the
 * first byte** — which is what the caption states, in the same words the audit export uses.
 *
 * Scope: everyone with `ticket:export` gets the standard column set. `full` adds the original
 * description and every comment body, INTERNAL ones included — client correspondence in bulk — so the
 * toggle is shown only to compliance, whose whole role is reading that material. The control is a
 * convenience, not the boundary: the route re-checks the capability and RECORDS a denial when a
 * hand-edited `?scope=full` arrives without it.
 */
export function ExportTicketsButton({
  query,
  viewer,
  className,
}: {
  query: TicketListQuery;
  viewer: Viewer;
  className?: string;
}): React.JSX.Element | null {
  // The route gates `scope=full` on exactly this predicate and records a denial when it fails, so
  // the control and the server can never disagree about who may pull message bodies.
  const canChooseScope = canViewAudit(viewer.groups);
  const [scope, setScope] = useState<TicketExportScope>("standard");

  if (!canExportTickets(viewer.groups)) return null;

  const effectiveScope: TicketExportScope = canChooseScope ? scope : "standard";
  const href = ticketExportHref(query, effectiveScope);

  return (
    <div className={className} data-slot="ticket-export">
      <div className="flex items-center gap-2">
        {canChooseScope ? (
          <Select
            value={scope}
            onValueChange={(v) => {
              if (v === "standard" || v === "full") setScope(v);
            }}
          >
            <SelectTrigger size="sm" aria-label="Export scope" className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="standard">Standard columns</SelectItem>
              <SelectItem value="full">Full — with message bodies</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
        <Button asChild variant="outline" size="sm">
          <a href={href} download data-ticket-export data-scope={effectiveScope}>
            <Download aria-hidden />
            Export CSV
          </a>
        </Button>
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground md:text-right">Export is itself audited</p>
    </div>
  );
}
