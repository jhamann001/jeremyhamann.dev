"use client";

import { useRef } from "react";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import type { AuditRow } from "@/types/domain";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { AuditActionBadge } from "@/components/audit/audit-action-badge";
import { formatDateTime, formatTicketNumber, GROUP_LABELS, labelize } from "@/lib/format";

/** Long, attacker-influenced strings (values, user agent) render inside a scroll box, never inline. */
function ValueBox({ label, value }: { label: string; value: string | null }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {value === null ? (
        <span className="text-sm text-muted-foreground italic">null</span>
      ) : (
        <pre className="max-h-56 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
          {value}
        </pre>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Hash({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <code className="rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs break-all select-all">{value}</code>
    </div>
  );
}

function metadataJson(metadata: unknown): string | null {
  if (metadata === null || metadata === undefined) return null;
  try {
    const json = JSON.stringify(metadata, null, 2);
    return json === undefined ? null : json;
  } catch {
    return String(metadata);
  }
}

/**
 * Full detail of one ledger row: every hashed column, the request evidence, the chain link and the
 * supplementary (non-evidentiary, outside the hash) metadata. `row` is null while nothing is selected.
 * Stays a centered Dialog on every width: `max-w-[calc(100%-2rem)]` +
 * `max-h-[90svh] overflow-y-auto` already fit a phone viewport, old/new stack below `sm`, hashes and ids
 * `break-all`, and the footer's Close (44 px on phones via the tap rule) sits beneath the caption.
 *
 * R10 focus return. The dialog is opened from a table row / card body
 * by state, without a Radix trigger, so on Esc Radix would focus a null triggerRef and focus would fall to
 * <body>. Same capture/return pattern as `ResponsiveSheet`: remember `document.activeElement` when the
 * content opens and hand focus back to it on close.
 */
export function AuditRowDialog({
  row,
  open,
  onOpenChange,
}: {
  row: AuditRow | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}): React.JSX.Element {
  const returnFocusRef = useRef<HTMLElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90svh] overflow-y-auto sm:max-w-3xl"
        data-audit-seq={row?.seq}
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
        }}
        onCloseAutoFocus={(e) => {
          const el = returnFocusRef.current;
          returnFocusRef.current = null;
          if (el && el.isConnected) {
            e.preventDefault();
            el.focus();
          }
        }}
      >
        {row === null ? (
          <DialogHeader>
            <DialogTitle>Audit row</DialogTitle>
            <DialogDescription>No row selected.</DialogDescription>
          </DialogHeader>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                <span className="font-mono tabular-nums">#{row.seq}</span>
                <AuditActionBadge action={row.action} />
              </DialogTitle>
              <DialogDescription>
                <span title={row.occurredAt} suppressHydrationWarning>
                  {formatDateTime(row.occurredAt)}
                </span>
                <span className="mx-1.5" aria-hidden>
                  ·
                </span>
                <span className="font-mono text-xs">{row.occurredAt}</span>
              </DialogDescription>
            </DialogHeader>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <Fact label="Actor">
                <span className="font-medium">{row.actorEmail}</span>
                {row.actorId ? (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{row.actorId}</span>
                ) : (
                  <span className="ml-2 text-xs text-muted-foreground italic">no user record</span>
                )}
              </Fact>
              <Fact label="Groups">
                <span className="flex flex-wrap items-center gap-1">
                  {row.actorGroups.length === 0 ? (
                    <span className="text-muted-foreground italic">none</span>
                  ) : (
                    row.actorGroups.map((g) => (
                      <Badge key={g} variant="secondary" className="font-normal" data-group={g}>
                        {GROUP_LABELS[g]}
                      </Badge>
                    ))
                  )}
                  {row.dualRole ? (
                    <Badge className="gap-1 border-transparent bg-red-600 text-white dark:bg-red-700" data-dual-role>
                      <ShieldAlert aria-hidden />
                      Dual role
                    </Badge>
                  ) : null}
                </span>
              </Fact>
              <Fact label="Entity">
                <span>{labelize(row.entityType)}</span>
                {row.entityId ? (
                  <span className="ml-2 font-mono text-xs text-muted-foreground break-all">{row.entityId}</span>
                ) : null}
              </Fact>
              <Fact label="Ticket">
                {row.ticketId && row.ticketNumber !== null ? (
                  <Link
                    href={`/tickets/${row.ticketId}`}
                    prefetch={false}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {formatTicketNumber(row.ticketNumber)}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Fact>
              <Fact label="Field">
                {row.fieldChanged ? (
                  <code className="font-mono text-xs">{row.fieldChanged}</code>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Fact>
            </dl>

            <div className="grid gap-3 sm:grid-cols-2">
              <ValueBox label="Old value" value={row.oldValue} />
              <ValueBox label="New value" value={row.newValue} />
            </div>

            <Separator />

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <Fact label="IP address">
                <code className="font-mono text-xs">{row.ipAddress}</code>
              </Fact>
              <Fact label="Request id">
                <code className="font-mono text-xs break-all">{row.requestId}</code>
              </Fact>
              <Fact label="User agent">
                {row.userAgent ? (
                  <span className="font-mono text-xs break-all">{row.userAgent}</span>
                ) : (
                  <span className="text-muted-foreground italic">null</span>
                )}
              </Fact>
            </dl>

            <div className="grid gap-3">
              <Hash label="Previous hash" value={row.prevHash} />
              <Hash label="Hash" value={row.hash} />
            </div>

            <ValueBox label="Metadata (supplementary — outside the hash chain)" value={metadataJson(row.metadata)} />

            <DialogFooter showCloseButton>
              <p className="text-xs text-muted-foreground sm:mr-auto sm:self-center">
                Row id <code className="font-mono">{row.id}</code> is a surrogate key and is not evidentiary.
              </p>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
