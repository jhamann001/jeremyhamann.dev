"use client";

import { useMemo, useState } from "react";
import { MailWarning } from "lucide-react";
import Link from "next/link";
import type { SuppressionDTO } from "@/types/domain";
import { SUPPRESSION_REASON_LABELS } from "@/types/domain";
import { formatDateTime } from "@/lib/format";
import type { SuppressionCandidate } from "@/server/suppression.actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AddSuppressionSheet } from "@/components/admin/suppression/add-suppression-sheet";
import { ConfirmBounceButton } from "@/components/admin/suppression/confirm-bounce-button";
import { RemoveSuppressionDialog } from "@/components/admin/suppression/remove-suppression-dialog";
import {
  SUPPRESSION_REASON_HELP,
  SUPPRESSION_REASON_VARIANTS,
  SUPPRESSION_STATE_LABELS,
  bounceCountLabel,
  shortAddress,
  suppressionState,
} from "@/components/admin/suppression/suppression-form-support";
import { cn } from "@/lib/utils";

/**
 * `/admin/suppression` (docs/MOBILE_FIRST.md R1–R12).
 *
 * Mobile-first with one layout flip at `md`, the same shape `/admin/webhooks` and `/admin/macros` use:
 * below it each row is a stacked card whose controls are full width; from `md` the same card lays out
 * in a row. Same data, same component, same list in both.
 *
 * TWO SECTIONS, and the order is the argument. The CANDIDATES come first when there are any, because
 * they are the only thing on this screen that needs a decision — a hard bounce that nobody has looked
 * at is a client who is not being answered and does not know it. The suppression list below is the
 * record of decisions already made, and it is a list somebody reads rather than acts on.
 *
 * Filtering is client-side. The list is a handful of rows that are already loaded, and there is no
 * "link me every lifted suppression" workflow; a round trip per keystroke would buy nothing. Recorded
 * in the integration notes, as `/admin/macros` and `/admin/webhooks` recorded the same departure.
 */

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "live", label: "Stopped" },
  { key: "lifted", label: "Lifted" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["key"];

function matchesFilter(row: SuppressionDTO, filter: StatusFilter): boolean {
  if (filter === "live") return row.removedAt === null;
  if (filter === "lifted") return row.removedAt !== null;
  return true;
}

export type SuppressionAdminViewProps = {
  suppressions: SuppressionDTO[];
  candidates: SuppressionCandidate[];
  /** True when the candidate read failed. The section then says so rather than rendering "none". */
  candidatesFailed: boolean;
};

export function SuppressionAdminView({
  suppressions,
  candidates,
  candidatesFailed,
}: SuppressionAdminViewProps): React.JSX.Element {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const visible = useMemo(() => suppressions.filter((s) => matchesFilter(s, filter)), [suppressions, filter]);
  const liveCount = suppressions.filter((s) => s.removedAt === null).length;

  return (
    <section className="flex flex-col gap-6" data-slice="B9-suppression-admin">
      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Suppression</h2>
          <p className="text-sm text-muted-foreground">
            Addresses the outbox refuses to send to. This stops{" "}
            <span className="font-medium text-foreground">outbound mail only</span> — messages from these addresses
            still arrive, still become tickets and still reach the queue.
          </p>
        </div>
        <AddSuppressionSheet className="w-full md:w-auto md:shrink-0" />
      </header>

      <section className="flex flex-col gap-3" aria-labelledby="suppression-candidates-heading">
        <div className="flex flex-col gap-1">
          <h3 id="suppression-candidates-heading" className="text-base font-semibold">
            Hard bounces awaiting a decision
          </h3>
          <p className="text-sm text-muted-foreground">
            A receiving server said these addresses do not exist. Nothing is suppressed automatically — one bounce
            notice is a mail server&rsquo;s opinion, not a decision to stop answering a client.
          </p>
        </div>

        {candidatesFailed ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            The bounce list could not be loaded. Nothing was changed — reload the page.
          </p>
        ) : candidates.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No hard bounces are waiting. Every address the desk writes to is currently accepting mail.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {candidates.map((candidate) => (
              <CandidateRow key={candidate.email} candidate={candidate} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="suppression-list-heading">
        <h3 id="suppression-list-heading" className="text-base font-semibold">
          Suppression list
        </h3>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter suppressions">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.key}
              type="button"
              variant={f.key === filter ? "secondary" : "outline"}
              size="sm"
              // R3: the global phone rule sets a 44 px minimum height but no minimum width, so a short
              // label needs the width floor too.
              className="min-w-11"
              aria-pressed={f.key === filter}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </Button>
          ))}
          <span className="flex min-h-11 items-center text-xs text-muted-foreground">
            {liveCount} stopped of {suppressions.length}
          </span>
        </div>

        {visible.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {suppressions.length === 0
              ? "No addresses are suppressed. The desk writes to every requester it has an address for."
              : "No addresses match this filter."}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {visible.map((row) => (
              <SuppressionCard key={row.id} row={row} />
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function CandidateRow({ candidate }: { candidate: SuppressionCandidate }): React.JSX.Element {
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3 md:flex-row md:items-center md:justify-between md:gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <MailWarning aria-hidden className="size-4 shrink-0 text-destructive" />
          {/* Both spellings are text, so neither is tooltip-only: the phone reads the short
              form, a wider screen reads the whole address. */}
          <span className="truncate font-mono text-sm md:hidden">{shortAddress(candidate.email)}</span>
          <span className="hidden truncate font-mono text-sm md:inline">{candidate.email}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {bounceCountLabel(candidate.bounces)} · last {formatDateTime(candidate.lastBouncedAt)}
          {candidate.lastTicketNumber === null ? null : (
            <>
              {" · "}
              {/* I11 / G6: prefetching a ticket route would write a TICKET_VIEWED row for a page
                  nobody opened. The link is here so an operator can go and look at what bounced. */}
              <Link
                href={`/tickets/wm/${candidate.lastTicketNumber}`}
                prefetch={false}
                className="underline underline-offset-2 hover:no-underline"
              >
                HD-{candidate.lastTicketNumber}
              </Link>
            </>
          )}
        </span>
      </div>
      <ConfirmBounceButton
        email={candidate.email}
        bounces={candidate.bounces}
        className="w-full md:w-auto md:shrink-0"
      />
    </li>
  );
}

function SuppressionCard({ row }: { row: SuppressionDTO }): React.JSX.Element {
  const state = suppressionState(row);
  const lifted = state === "lifted";

  return (
    <li
      className={cn("flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground", lifted && "opacity-70")}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-sm md:hidden">{shortAddress(row.email)}</span>
            <span className="hidden truncate font-mono text-sm md:inline">{row.email}</span>
            <Badge variant={lifted ? "outline" : "destructive"}>{SUPPRESSION_STATE_LABELS[state]}</Badge>
            <Badge variant={lifted ? "outline" : SUPPRESSION_REASON_VARIANTS[row.reason]} className="font-normal">
              {SUPPRESSION_REASON_LABELS[row.reason]}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">{SUPPRESSION_REASON_HELP[row.reason]}</span>
          <span className="text-xs text-muted-foreground">
            Added {formatDateTime(row.createdAt)}
            {row.createdBy === null ? "" : ` by ${row.createdBy.name ?? row.createdBy.email}`}
            {row.removedAt === null ? "" : ` · lifted ${formatDateTime(row.removedAt)}`}
          </span>
          {row.note === null ? null : <p className="text-sm">{row.note}</p>}
        </div>

        {lifted ? null : (
          <RemoveSuppressionDialog
            suppressionId={row.id}
            email={row.email}
            className="w-full md:w-auto md:shrink-0"
          />
        )}
      </div>
    </li>
  );
}
