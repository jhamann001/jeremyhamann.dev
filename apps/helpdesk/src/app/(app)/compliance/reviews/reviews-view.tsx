"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCheck, Download, ExternalLink, Eye, Flag, LoaderCircle, Paperclip, Stamp } from "lucide-react";
import { toast } from "sonner";
import type { ActionError, QueueKey } from "@/types/domain";
import {
  CATEGORY_LABELS,
  MESSAGE_DELIVERY_STATUS_LABELS,
  QUEUE_LABELS,
  REVIEW_VERDICT_LABELS,
} from "@/types/domain";
import { formatDateTime, formatRelative, formatTicketNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { openReplyForReview } from "@/server/reviews.actions";
import type { ReplyReviewRow, ReviewQuery, ReviewState } from "@/server/reviews";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ReviewStampSheet } from "@/components/ticket/review-stamp";

/**
 * The review queue's body — slice B6.
 *
 * Colocated with its route rather than under `src/components/**` because `/compliance/reviews/**` is
 * this slice's owned subtree and this component has exactly one consumer. Recorded in
 * the build record.
 *
 * R7 — same data, same state: phone cards and the md+ layout render the SAME `ReplyReviewRow[]` in
 * the same component, and the filters write the same URL through the same serializer the server
 * parses. There is no second fetch and no client-side query key.
 *
 * R1/R3/R4 — one flip at `md`. Filters stack on a phone and sit in a row from `md`; every control is
 * at least 44 px tall and every text input is 16 px (the global phone rule in `globals.css`).
 *
 * `ReviewStampSheet` is imported from `@/components/ticket/review-stamp`, so the checklist a reviewer
 * sees here is by construction the checklist they see on a ticket.
 *
 * G1: a client module may import only `.actions` server modules. `openReplyForReview` is one; the
 * ROW type comes in as a TYPE-only import, which G1 exempts.
 *
 * Copy rule (Wave A CONTRACT §10 S3 / CROSSWALK P16, binding here too): this screen never says a
 * reply was "sent". `DeliveryChip`/`MESSAGE_DELIVERY_STATUS_LABELS` are the only statements about
 * transmission in the app, and this row defers to them — the date filters read "Replied on or
 * after/before", the byline is "Written by", the stamp sheet heading is "saved". The row's own
 * `delivery:` clause is the one place transmission is described, and it always prints: a null
 * `deliveryStatus` means no `MessageDelivery` row exists at all (a phone-only requester, Decision
 * #62), which is "none queued", not silence after a claim.
 */

export type ReviewsViewProps = {
  rows: ReplyReviewRow[];
  total: number;
  query: ReviewQuery;
  queues: QueueKey[];
  viewerId: string;
  capped: boolean;
  maxRows: number;
  defaultWindowDays: number;
  windowStart: string;
};

const STATE_LABELS: Readonly<Record<ReviewState, string>> = {
  UNREVIEWED: "Not reviewed",
  REVIEWED: "Reviewed",
  ALL: "All replies",
};

const ALL = "__all__";

function hrefFor(next: Partial<ReviewQuery>, current: ReviewQuery): string {
  const merged: ReviewQuery = { ...current, ...next };
  const p = new URLSearchParams();
  if (merged.from !== null) p.set("from", merged.from);
  if (merged.to !== null) p.set("to", merged.to);
  if (merged.queueKey !== null) p.set("queue", merged.queueKey);
  if (merged.state !== "UNREVIEWED") p.set("state", merged.state);
  const qs = p.toString();
  return qs.length > 0 ? `/compliance/reviews?${qs}` : "/compliance/reviews";
}

export function ReviewsView({
  rows,
  total,
  query,
  queues,
  viewerId,
  capped,
  maxRows,
  defaultWindowDays,
  windowStart,
}: ReviewsViewProps): React.JSX.Element {
  const router = useRouter();
  const [, startNav] = useTransition();
  const [stampFor, setStampFor] = useState<ReplyReviewRow | null>(null);

  function go(next: Partial<ReviewQuery>): void {
    startNav(() => router.push(hrefFor(next, query)));
  }

  const exportHref = (() => {
    const p = new URLSearchParams();
    if (query.from !== null) p.set("from", query.from);
    if (query.to !== null) p.set("to", query.to);
    if (query.queueKey !== null) p.set("queue", query.queueKey);
    if (query.state !== "UNREVIEWED") p.set("state", query.state);
    const qs = p.toString();
    return qs.length > 0 ? `/compliance/reviews/export?${qs}` : "/compliance/reviews/export";
  })();

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Filters" className="flex flex-col gap-3 rounded-lg border p-3 md:flex-row md:flex-wrap md:items-end">
        <div className="flex flex-col gap-1.5 md:w-44">
          <Label htmlFor="review-state">Show</Label>
          <Select value={query.state} onValueChange={(v) => go({ state: v as ReviewState })}>
            <SelectTrigger id="review-state" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {(Object.keys(STATE_LABELS) as ReviewState[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5 md:w-48">
          <Label htmlFor="review-queue">Queue</Label>
          <Select
            value={query.queueKey ?? ALL}
            onValueChange={(v) => go({ queueKey: v === ALL ? null : (v as QueueKey) })}
          >
            <SelectTrigger id="review-queue" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value={ALL}>All queues</SelectItem>
              {queues.map((q) => (
                <SelectItem key={q} value={q}>
                  {QUEUE_LABELS[q]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5 md:w-48">
          <Label htmlFor="review-from">Replied on or after</Label>
          <Input
            id="review-from"
            type="date"
            value={query.from ?? ""}
            onChange={(e) => go({ from: e.target.value.length > 0 ? e.target.value : null })}
          />
        </div>

        <div className="flex flex-col gap-1.5 md:w-48">
          <Label htmlFor="review-to">Replied on or before</Label>
          <Input
            id="review-to"
            type="date"
            value={query.to ?? ""}
            onChange={(e) => go({ to: e.target.value.length > 0 ? e.target.value : null })}
          />
        </div>

        <div className="flex flex-col gap-2 md:ml-auto md:flex-row md:items-center">
          <Button asChild variant="outline" className="min-h-11 justify-center">
            <a href={exportHref} download>
              <Download aria-hidden />
              Export CSV
            </a>
          </Button>
        </div>
      </section>

      <p className="text-xs text-muted-foreground" role="status">
        {total} {total === 1 ? "reply" : "replies"} match
        {query.from === null ? ` in the last ${defaultWindowDays} days` : ""} (from{" "}
        {formatDateTime(windowStart)}).
        {capped ? ` Showing the oldest ${maxRows} — narrow the dates to see the rest.` : ""}
      </p>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
          {query.state === "UNREVIEWED"
            ? "Nothing waiting for a review in this window."
            : "No replies match these filters."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <ReviewRow
              key={row.commentId}
              row={row}
              viewerId={viewerId}
              onStamp={() => setStampFor(row)}
            />
          ))}
        </ul>
      )}

      <ReviewStampSheet
        open={stampFor !== null}
        onOpenChange={(o) => {
          if (!o) setStampFor(null);
        }}
        commentId={stampFor?.commentId ?? ""}
        heading={
          stampFor === null
            ? ""
            : `${formatTicketNumber(stampFor.ticketNumber)} · saved ${formatDateTime(stampFor.sentAt)}`
        }
      >
        {stampFor === null ? null : (
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-xs font-medium">{stampFor.subject}</p>
            <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap break-words">{stampFor.excerpt}</p>
            {stampFor.excerptTruncated ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Shortened. Open the reply in full before you stamp it — the full text is on the ticket.
              </p>
            ) : null}
          </div>
        )}
      </ReviewStampSheet>
    </div>
  );
}

function ReviewRow({
  row,
  viewerId,
  onStamp,
}: {
  row: ReplyReviewRow;
  viewerId: string;
  onStamp: () => void;
}): React.JSX.Element {
  const [pending, startTransition] = useTransition();
  const [fullBody, setFullBody] = useState<string | null>(null);
  const mine = row.stamps.find((s) => s.reviewer.id === viewerId) ?? null;

  function applyError(err: ActionError): void {
    toast.error(err.code === "INTERNAL" ? "The reply could not be opened." : err.message);
  }

  function openFull(): void {
    startTransition(async () => {
      const result = await openReplyForReview({ commentId: row.commentId });
      if (!result.ok) {
        applyError(result);
        return;
      }
      setFullBody(result.data.body);
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="outline" className="tabular-nums">
          {formatTicketNumber(row.ticketNumber)}
        </Badge>
        <Badge variant="secondary">{QUEUE_LABELS[row.queueKey]}</Badge>
        <span className="text-xs text-muted-foreground">{CATEGORY_LABELS[row.category]}</span>
        {row.retracted ? (
          <Badge variant="outline" className="border-destructive/60 text-destructive">
            Withdrawn
          </Badge>
        ) : null}
        {row.attachmentCount > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Paperclip aria-hidden className="size-3.5" />
            {row.attachmentCount}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {formatRelative(row.sentAt)} · {formatDateTime(row.sentAt)}
        </span>
      </div>

      <p className="text-sm font-medium break-words">{row.subject}</p>
      <p className="text-xs text-muted-foreground">
        {/*
          "Written by", not "Sent by" (Wave A copy rule, CONTRACT §10 S3 / CROSSWALK P16). This row
          describes a stored reply; whether anything left the building is the `delivery:` clause
          below, and on a phone-only requester (Decision #62) `deliveryStatus` is null because no
          delivery was ever enqueued. A byline that said "Sent by" claimed transmission this screen
          cannot observe — and read as a contradiction next to "delivery: Not sent (suppressed)".
        */}
        Written by {row.author?.name ?? row.authorLabel}
        {/*
          The shared label map, never the raw enum. A lowercased enum printed "delivery
          failed_suppressed", "delivery leased" and "delivery cancelled" to a compliance officer —
          and two of those are actively misleading: LEASED means "Sending", and FAILED_SUPPRESSED
          means the desk deliberately did not send, which is the distinction Wave B added the status
          for. This is the surface a reviewer stamps correspondence from, so the vocabulary matters
          more here, not less (`delivery-chip-label.ts`: the UI never prints a raw enum).
        */}
        {row.deliveryStatus !== null
          ? ` · delivery: ${MESSAGE_DELIVERY_STATUS_LABELS[row.deliveryStatus]}`
          : " · delivery: none queued"}
      </p>

      <p className="rounded-md border bg-muted/40 p-3 text-sm leading-relaxed whitespace-pre-wrap break-words">
        {fullBody ?? row.excerpt}
      </p>

      {row.stamps.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {row.stamps.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <Badge
                variant="outline"
                className={cn(
                  "gap-1",
                  s.verdict === "APPROVED"
                    ? "border-emerald-500/60 text-emerald-800 dark:text-emerald-300"
                    : "border-amber-500/70 text-amber-900 dark:text-amber-200",
                )}
              >
                {s.verdict === "APPROVED" ? <CheckCheck aria-hidden /> : <Flag aria-hidden />}
                {REVIEW_VERDICT_LABELS[s.verdict]}
              </Badge>
              <span>{s.reviewer.name ?? s.reviewer.email}</span>
              <span aria-hidden>·</span>
              <span>{formatDateTime(s.createdAt)}</span>
              {s.note !== null && s.note.length > 0 ? (
                <span className="w-full text-foreground/80">{s.note}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {row.excerptTruncated && fullBody === null ? (
          <Button type="button" variant="outline" className="min-h-11 justify-center" onClick={openFull} disabled={pending}>
            {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Eye aria-hidden />}
            {pending ? "Opening…" : "Read in full"}
          </Button>
        ) : null}
        <Button asChild variant="outline" className="min-h-11 justify-center">
          <Link href={row.ticketPath} prefetch={false}>
            <ExternalLink aria-hidden />
            Open ticket
          </Link>
        </Button>
        <Button
          type="button"
          variant={mine === null ? "default" : "ghost"}
          className="min-h-11 justify-center"
          onClick={onStamp}
          disabled={mine !== null}
        >
          <Stamp aria-hidden />
          {mine === null ? "Review" : "Reviewed by you"}
        </Button>
      </div>
    </li>
  );
}
