"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Copy, Link2, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import type { ActionError, DuplicateCandidateDTO } from "@/types/domain";
import { WAVE_B_LIMITS } from "@/types/domain";
import { formatRelative, formatTicketNumber } from "@/lib/format";
import { addTicketLink, duplicateCandidates, mergeTickets } from "@/server/ticket-links.actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/tickets/status-badge";
import {
  ResponsiveSheet,
  ResponsiveSheetBody,
  ResponsiveSheetFooter,
} from "@/components/shell/responsive-sheet";

/**
 * The candidate list and the two one-tap actions behind the duplicate banner.
 *
 * **The banner offers, a person decides.** Nothing here merges on its own, and the merge asks for a
 * reason first — a false positive that silently merged two clients' tickets would put one client's
 * correspondence on another's record, which is the one failure this desk cannot walk back.
 *
 * Exported for two mounts: `DuplicateBanner` on the ticket page (server, loads its own candidates), and
 * `NewTicketDuplicateWarning` on B11's new-ticket form (client, scores a draft that has no id yet).
 */

const REASON_LABELS: Readonly<Record<DuplicateCandidateDTO["reason"], string>> = {
  "same-external-ref": "Same external reference",
  "same-requester-subject": "Same requester, similar subject",
  "same-requester-recent": "Same requester, this week",
};

function CandidateHeading({ candidate }: { candidate: DuplicateCandidateDTO }): React.JSX.Element {
  return (
    <>
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">{formatTicketNumber(candidate.ticketNumber)}</span>
        <StatusBadge status={candidate.status} describe />
        <span>{REASON_LABELS[candidate.reason]}</span>
        <time dateTime={candidate.createdAt} suppressHydrationWarning>
          {formatRelative(candidate.createdAt)}
        </time>
      </span>
      <span className="mt-0.5 block truncate text-sm font-medium">{candidate.subject}</span>
    </>
  );
}

/**
 * The merge sheet. A reason of at least twelve characters is required by the server and asked for here,
 * because "duplicate" on its own does not tell the next reader which of two clients' requests survived.
 */
function MergeSheet({
  ticketId,
  version,
  candidate,
  open,
  onOpenChange,
}: {
  ticketId: string;
  version: number;
  candidate: DuplicateCandidateDTO | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const router = useRouter();
  const uid = useId();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setReason("");
    setError(null);
  }, [open]);

  function applyError(err: ActionError): void {
    const message =
      err.fieldErrors?.reason?.join(" ") ?? err.fieldErrors?.intoTicketNumber?.join(" ") ?? err.fieldErrors?._form?.join(" ") ?? err.message;
    setError(message);
    if (err.code === "CONFLICT") {
      toast.warning("The ticket changed elsewhere — refreshing. Nothing was merged.");
      router.refresh();
      return;
    }
    toast.error(message);
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(o) => {
        if (!pending) onOpenChange(o);
      }}
      title={candidate === null ? "Mark as duplicate" : `Mark as duplicate of ${formatTicketNumber(candidate.ticketNumber)}`}
      description="This ticket is resolved as a duplicate and linked to the other one. Comments stay where they are."
      size="lg"
    >
      <form
        noValidate
        className="flex min-h-0 flex-1 flex-col"
        aria-busy={pending || undefined}
        onSubmit={(e) => {
          e.preventDefault();
          if (candidate === null) return;
          const trimmed = reason.trim();
          if (trimmed.length < WAVE_B_LIMITS.reasonMinChars) {
            setError(`Say why these are the same request — at least ${WAVE_B_LIMITS.reasonMinChars} characters.`);
            return;
          }
          setError(null);
          startTransition(async () => {
            const result = await mergeTickets({
              ticketId,
              version,
              intoTicketNumber: candidate.ticketNumber,
              reason: trimmed,
            });
            if (!result.ok) {
              applyError(result);
              return;
            }
            toast.success(`Merged into ${formatTicketNumber(candidate.ticketNumber)}`);
            onOpenChange(false);
            router.refresh();
          });
        }}
      >
        <ResponsiveSheetBody className="flex flex-col gap-4">
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            This ticket keeps its number, its comments and its history. It is resolved as a duplicate and
            points at the other one; nothing is moved and nothing is deleted.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-reason`}>Why are these the same request?</Label>
            <Textarea
              id={`${uid}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              minLength={WAVE_B_LIMITS.reasonMinChars}
              maxLength={WAVE_B_LIMITS.reasonMaxChars}
              disabled={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${uid}-error` : undefined}
              className="text-base md:text-sm"
            />
            {error ? (
              <p id={`${uid}-error`} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </ResponsiveSheetBody>
        <ResponsiveSheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={pending || candidate === null}>
            {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Copy aria-hidden />}
            {pending ? "Merging…" : "Mark as duplicate"}
          </Button>
        </ResponsiveSheetFooter>
      </form>
    </ResponsiveSheet>
  );
}

/**
 * The candidate list with per-row Link and Duplicate controls, for an EXISTING ticket.
 * `canWrite` is `links:write` on this queue, resolved on the server and passed as a prop.
 */
export function DuplicateCandidateList({
  ticketId,
  version,
  candidates,
  canWrite,
}: {
  ticketId: string;
  version: number;
  candidates: DuplicateCandidateDTO[];
  canWrite: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [mergeTarget, setMergeTarget] = useState<DuplicateCandidateDTO | null>(null);

  function link(candidate: DuplicateCandidateDTO): void {
    setPendingId(candidate.ticketId);
    startTransition(async () => {
      const result = await addTicketLink({
        ticketId,
        otherTicketNumber: candidate.ticketNumber,
        kind: "RELATED",
        note: "Linked from the possible-duplicate banner",
      });
      setPendingId(null);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`Linked to ${formatTicketNumber(candidate.ticketNumber)}`);
      router.refresh();
    });
  }

  return (
    <>
      <ul className="mt-2 flex flex-col gap-1.5">
        {candidates.map((c) => (
          <li
            key={c.ticketId}
            data-candidate-id={c.ticketId}
            data-candidate-reason={c.reason}
            className="flex flex-col gap-2 rounded-md border bg-background/60 p-2 sm:flex-row sm:items-center"
          >
            <Link
              href={`/tickets/${c.ticketId}`}
              prefetch={false}
              className="min-w-0 flex-1 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label={`Open ticket ${formatTicketNumber(c.ticketNumber)}: ${c.subject}`}
            >
              <CandidateHeading candidate={c} />
            </Link>
            {canWrite ? (
              <span className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 flex-1 sm:min-h-8 sm:flex-none"
                  disabled={pendingId !== null}
                  onClick={() => link(c)}
                >
                  {pendingId === c.ticketId ? (
                    <LoaderCircle aria-hidden className="animate-spin" />
                  ) : (
                    <Link2 aria-hidden />
                  )}
                  Link
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 flex-1 sm:min-h-8 sm:flex-none"
                  disabled={pendingId !== null}
                  onClick={() => setMergeTarget(c)}
                >
                  <Copy aria-hidden />
                  Duplicate
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <MergeSheet
        ticketId={ticketId}
        version={version}
        candidate={mergeTarget}
        open={mergeTarget !== null}
        onOpenChange={(o) => {
          if (!o) setMergeTarget(null);
        }}
      />
    </>
  );
}

/**
 * The same warning for a ticket that does not exist yet — B11's new-ticket form mounts this
 * (CONTRACT §9 / the B2 brief: "exported for B11's new-ticket form mount").
 *
 * It scores the draft through `duplicateCandidates`, debounced, and renders read-only rows: there is no
 * ticket to link or merge until the form is submitted, so the only action offered is to open the
 * existing one. A staff member who opens it and comes back has not lost the draft — the link opens in
 * a new tab for exactly that reason.
 */
export function NewTicketDuplicateWarning({
  requesterEmail,
  requesterPhone,
  subject,
  externalRef,
  debounceMs = 500,
}: {
  requesterEmail: string | null;
  requesterPhone?: string | null;
  subject: string;
  externalRef?: string | null;
  debounceMs?: number;
}): React.JSX.Element | null {
  const [rows, setRows] = useState<DuplicateCandidateDTO[]>([]);

  useEffect(() => {
    const email = (requesterEmail ?? "").trim();
    const phone = (requesterPhone ?? "").trim();
    const ref = (externalRef ?? "").trim();
    if (email.length === 0 && phone.length === 0 && ref.length === 0) {
      setRows([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void duplicateCandidates({
        draft: {
          requesterEmail: email.length > 0 ? email : null,
          requesterPhone: phone.length > 0 ? phone : null,
          subject,
          externalRef: ref.length > 0 ? ref : null,
        },
      }).then((result) => {
        if (cancelled) return;
        setRows(result.ok ? result.data : []);
      });
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [requesterEmail, requesterPhone, subject, externalRef, debounceMs]);

  if (rows.length === 0) return null;

  return (
    <div
      role="status"
      data-slice="B2-duplicate-warning"
      className="rounded-lg border border-amber-300 bg-amber-50/60 p-3 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <p className="text-sm font-medium">
        {rows.length === 1 ? "This may already be open" : `${rows.length} tickets may already cover this`}
      </p>
      <p className="mt-0.5 text-xs">
        Open one before you raise a second — nothing here is created or changed by looking.
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {rows.map((c) => (
          <li key={c.ticketId} className="rounded-md border border-amber-300/60 bg-background/70 p-2 dark:border-amber-800/60">
            <Link
              href={`/tickets/${c.ticketId}`}
              prefetch={false}
              target="_blank"
              rel="noreferrer"
              className="block min-h-11 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 md:min-h-8"
              aria-label={`Open ticket ${formatTicketNumber(c.ticketNumber)} in a new tab: ${c.subject}`}
            >
              <CandidateHeading candidate={c} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
