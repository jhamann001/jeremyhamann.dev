"use client";

import Link from "next/link";
import { ArrowRight, ShieldAlert } from "lucide-react";
import type { AuditRow } from "@/types/domain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MobileCard } from "@/components/shell/mobile-card";
import { AuditActionBadge } from "@/components/audit/audit-action-badge";
import { formatDateTime, formatTicketNumber, GROUP_LABELS, labelize } from "@/lib/format";
import { cn } from "@/lib/utils";

const VALUE_PREVIEW_CHARS = 48;

/** One-line preview of an old/new value; the dialog shows the full text. Shared with the md+ table cell. */
export function truncateValue(value: string | null, max = VALUE_PREVIEW_CHARS): string {
  if (value === null) return "";
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Phone presentation of one ledger row. Renders the SAME `AuditRow` the md+
 * table renders, from the same `AuditTable`. The body is the tappable region (→ `AuditRowDialog`);
 * the "Open HD-n" link lives in the card's action strip, outside that region, so a tap on it navigates
 * without opening the dialog. The action badge sits top-right — the glance target on a phone.
 */
export function AuditRowCard({ row, onOpen }: { row: AuditRow; onOpen: (row: AuditRow) => void }): React.JSX.Element {
  const hasTicket = row.ticketId !== null && row.ticketNumber !== null;
  const hasChange = row.oldValue !== null || row.newValue !== null;

  return (
    <MobileCard
      as="li"
      label={`Open audit row ${row.seq}`}
      onActivate={() => onOpen(row)}
      tone={row.action === "AUTHZ_DENIED" ? "alarm" : "default"}
      data-seq={row.seq}
      data-dual-role={row.dualRole ? "true" : undefined}
      actions={
        hasTicket ? (
          <Button asChild variant="outline" size="sm" className="min-w-11">
            <Link
              href={`/tickets/${row.ticketId}`}
              prefetch={false}
              aria-label={`Open ticket ${formatTicketNumber(row.ticketNumber as number)}`}
            >
              Open {formatTicketNumber(row.ticketNumber as number)}
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        ) : undefined
      }
    >
      {/* (1) seq + action — the badge is the loudest element */}
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-xs tabular-nums text-muted-foreground">#{row.seq}</span>
        <AuditActionBadge action={row.action} />
      </div>

      {/* (2) when + where from */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <time dateTime={row.occurredAt} title={row.occurredAt} className="tabular-nums" suppressHydrationWarning>
          {formatDateTime(row.occurredAt)}
        </time>
        <span aria-hidden>·</span>
        <code className="font-mono">{row.ipAddress}</code>
      </div>

      {/* (3) actor */}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium break-all">{row.actorEmail}</span>
        {row.actorGroups.length > 0 || row.dualRole ? (
          <span className="flex flex-wrap items-center gap-1">
            {row.actorGroups.map((g) => (
              <Badge key={g} variant="secondary" className="font-normal" data-group={g}>
                {GROUP_LABELS[g]}
              </Badge>
            ))}
            {row.dualRole ? (
              <Badge className="gap-1 border-transparent bg-red-600 text-white dark:bg-red-700" data-dual-role>
                <ShieldAlert aria-hidden />
                Dual role
              </Badge>
            ) : null}
          </span>
        ) : null}
      </div>

      {/* (4) entity */}
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        <span className="text-muted-foreground">{labelize(row.entityType)}</span>
        {hasTicket ? (
          <span className="font-medium text-foreground">{formatTicketNumber(row.ticketNumber as number)}</span>
        ) : row.entityId ? (
          <span className="min-w-0 font-mono break-all" title={row.entityId}>
            {row.entityId}
          </span>
        ) : null}
      </div>

      {/* (5) field + change */}
      {row.fieldChanged || hasChange ? (
        <div className="flex min-w-0 flex-col gap-0.5 text-xs">
          {row.fieldChanged ? <code className="font-mono">{row.fieldChanged}</code> : null}
          {hasChange ? (
            <span className="flex min-w-0 flex-wrap items-center gap-1.5 break-words">
              <span className={cn("min-w-0", row.oldValue === null && "text-muted-foreground italic")}>
                {row.oldValue === null ? "null" : truncateValue(row.oldValue)}
              </span>
              <ArrowRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className={cn("min-w-0", row.newValue === null && "text-muted-foreground italic")}>
                {row.newValue === null ? "null" : truncateValue(row.newValue)}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
    </MobileCard>
  );
}
