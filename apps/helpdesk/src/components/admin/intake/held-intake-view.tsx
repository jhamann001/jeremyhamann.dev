"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { LoaderCircle, Search, ShieldAlert, X } from "lucide-react";
import type { QueueKey, SuspendedIntakeReason, SuspendedIntakeStatus } from "@/types/domain";
import type { HeldIntakeCounts, HeldIntakePage, HeldIntakeRow } from "@/server/suspended-intake";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DiscardIntakeDialog } from "@/components/admin/intake/discard-intake-dialog";
import { ReleaseIntakeDialog } from "@/components/admin/intake/release-intake-dialog";
import { cn } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 300;

/** Plain-language names for the nine hold reasons. The enum value is a filter key, not a sentence. */
export const HELD_REASON_LABELS: Readonly<Record<SuspendedIntakeReason, string>> = {
  UNAUTHENTICATED: "Sender not verified",
  AUTO_REPLY: "Auto-reply",
  BOUNCE: "Bounce",
  SYSTEM_SENDER: "System sender",
  SPAM: "Spam",
  UNKNOWN_MAILBOX: "Unknown mailbox",
  LOOP_DETECTED: "Mail loop",
  PARSE_FAILED: "Could not be read",
  OVERSIZE: "Too large",
  FORWARDED: "Forwarded message",
};

/** What a reviewer needs to know about each reason before deciding. One line, no jargon. */
const HELD_REASON_HELP: Readonly<Record<SuspendedIntakeReason, string>> = {
  UNAUTHENTICATED:
    "DMARC did not pass, or the sender is not this thread's client. Treat a payment or address-change instruction here as unverified until you reach the client another way.",
  AUTO_REPLY: "An out-of-office or vacation responder.",
  BOUNCE: "A delivery failure notice. The address it names may be dead.",
  SYSTEM_SENDER: "A no-reply or notification address.",
  SPAM: "Flagged as spam by the mail provider or by a header.",
  UNKNOWN_MAILBOX: "The address it arrived on is not in the mailbox map, so it has no queue.",
  LOOP_DETECTED: "The desk appears to be replying to itself.",
  PARSE_FAILED: "No readable body, or no usable sender address.",
  OVERSIZE: "The body is past the ceiling a ticket can hold.",
  FORWARDED:
    "This is a forwarded copy of somebody else’s mail. The apparent sender is whoever forwarded it, so nothing was attributed. Release it against the right client, or discard it.",
};

/**
 * The caution a card carries when the sender was never proven but the winning reason says something
 * else entirely — an unmapped mailbox, an auto-reply, spam. Deliberately NOT
 * `HELD_REASON_HELP.UNAUTHENTICATED`: that line offers "or the sender is not this thread's client",
 * which is about a thread match, and this message matched no thread.
 */
const SENDER_UNVERIFIED_HELP =
  "Sender not verified: authentication did not pass on this message either, so the address above is" +
  " unproven. Treat a payment or address-change instruction here as unverified until you reach the" +
  " client on a number you already hold.";

const STATUS_FILTERS = [
  { key: "NEW", label: "Held" },
  { key: "RELEASED", label: "Released" },
  { key: "DISCARDED", label: "Discarded" },
  { key: "ALL", label: "All" },
] as const;

export type HeldIntakeViewProps = {
  /** One server-rendered page: its rows, the matched total, and the cursor for the next page. */
  page: HeldIntakePage;
  /**
   * `byReason` / `total` describe the status and mailbox filter currently applied — they label the
   * reason chips, so a chip can never carry a number for rows that are not on screen. `waitingTotal`
   * is the NEW backlog across every mailbox, which is what the amber banner and the Held chip claim.
   */
  counts: HeldIntakeCounts;
  status: SuspendedIntakeStatus | "ALL";
  reason: SuspendedIntakeReason | undefined;
  mailbox: string;
  /** The cursor this render was produced from — absent on the newest page. */
  cursor: string | undefined;
  releasableQueues: QueueKey[];
};

/**
 * The ONE URL writer for this surface. A filter change never carries the
 * cursor: changing the status, the reason or the mailbox starts again from the newest message, which
 * is what "Held" means to a reviewer.
 */
function hrefFor(
  pathname: string,
  status: SuspendedIntakeStatus | "ALL",
  reason: SuspendedIntakeReason | undefined,
  mailbox: string,
  cursor?: string,
): string {
  const params = new URLSearchParams();
  if (status !== "NEW") params.set("status", status);
  if (reason !== undefined) params.set("reason", reason);
  const trimmed = mailbox.trim();
  if (trimmed.length > 0) params.set("mailbox", trimmed);
  if (cursor !== undefined) params.set("cursor", cursor);
  const qs = params.toString();
  return qs.length > 0 ? `${pathname}?${qs}` : pathname;
}

/** One RSC-rendered page of held mail, keyed by the cursor that produced it. */
type Chunk = { cursor: string | undefined; rows: HeldIntakeRow[] };

type Accumulated = {
  /** The filter without the cursor — a change here means a different result set. */
  baseKey: string;
  /** The `page` object the last chunk was built from (identity check, so a refresh replaces it). */
  page: HeldIntakePage;
  chunks: Chunk[];
};

/**
 * Keeps the pages already on screen when the server hands down the next one, so "Load more" grows
 * the list instead of replacing it. Same shape as `AuditTable`'s merge, and pure for the same reason:
 * the reconciliation below runs during render.
 */
function mergePage(
  prev: Accumulated | null,
  page: HeldIntakePage,
  cursor: string | undefined,
  baseKey: string,
): Accumulated {
  const chunk: Chunk = { cursor, rows: page.rows };
  if (prev === null || prev.baseKey !== baseKey) return { baseKey, page, chunks: [chunk] };

  const existing = prev.chunks.findIndex((c) => c.cursor === cursor);
  if (existing >= 0) {
    // The same cursor rendered again (router.refresh after a release or a discard, or a Back
    // navigation): replace that page in place so the row's new status is the one on screen.
    const chunks = prev.chunks.slice();
    chunks[existing] = chunk;
    return { baseKey, page, chunks };
  }

  const last = prev.chunks[prev.chunks.length - 1];
  if (cursor !== undefined && last !== undefined && last.rows.length > 0 && prev.page.nextCursor === cursor) {
    return { baseKey, page, chunks: [...prev.chunks, chunk] };
  }

  // A cursor that does not continue what is on screen (a pasted or stale URL): start from that page.
  return { baseKey, page, chunks: [chunk] };
}

function flattenRows(chunks: Chunk[]): HeldIntakeRow[] {
  const seen = new Set<string>();
  const out: HeldIntakeRow[] = [];
  for (const chunk of chunks) {
    for (const row of chunk.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * `/admin/intake` (docs/MOBILE_FIRST.md R1–R12).
 *
 * Mobile-first with one flip at `md`: below it each held message is a stacked card with a full-width
 * release control; from `md` the same card lays its metadata out in a row. Same data, same
 * component, same URL in both. Filters are URL state written here and read by the server render.
 *
 * The snippet is shown, not hidden behind a disclosure: a reviewer cannot judge a held message
 * without reading it, and what is stored is already PII-redacted at write time. It is a
 * preview — the full message lives with the mail workflow, which is what `rawRef` points at.
 */
export function HeldIntakeView({
  page,
  counts,
  status,
  reason,
  mailbox,
  cursor,
  releasableQueues,
}: HeldIntakeViewProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [draft, setDraft] = useState(mailbox);
  const [pending, startTransition] = useTransition();
  const committed = useRef(mailbox);

  const baseKey = hrefFor(pathname, status, reason, mailbox);

  // Derive the accumulated pages from props during render (a guarded setState, not an effect), so the
  // first paint after a "Load more" navigation already holds both pages.
  const [acc, setAcc] = useState<Accumulated>(() => mergePage(null, page, cursor, baseKey));
  let current = acc;
  if (acc.page !== page || acc.baseKey !== baseKey) {
    current = mergePage(acc, page, cursor, baseKey);
    setAcc(current);
  }

  const rows = useMemo(() => flattenRows(current.chunks), [current.chunks]);

  // True when the FIRST page on screen was itself cursored — a shared or bookmarked "Load more" URL.
  // The rows are then a window in the middle of the list, not its newest end, and the count below
  // must not call them "the most recent".
  const startedMidList = current.chunks[0]?.cursor !== undefined;

  useEffect(() => {
    committed.current = mailbox;
    setDraft(mailbox);
  }, [mailbox]);

  useEffect(() => {
    if (draft === committed.current) return;
    const t = setTimeout(() => {
      committed.current = draft;
      startTransition(() => router.replace(hrefFor(pathname, status, reason, draft), { scroll: false }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, pathname, reason, router, status]);

  function setStatus(next: SuspendedIntakeStatus | "ALL"): void {
    startTransition(() => router.replace(hrefFor(pathname, next, reason, draft), { scroll: false }));
  }

  function setReason(next: SuspendedIntakeReason | undefined): void {
    startTransition(() => router.replace(hrefFor(pathname, status, next, draft), { scroll: false }));
  }

  /**
   * `push`, not `replace`: each loaded page is a Back step, and the server renders it under the same
   * capability gate as the first. The merge above keeps the pages already on screen.
   */
  function loadMore(): void {
    if (page.nextCursor === null) return;
    const href = hrefFor(pathname, status, reason, mailbox, page.nextCursor);
    startTransition(() => router.push(href, { scroll: false }));
  }

  const reasonsPresent = (Object.keys(counts.byReason) as SuspendedIntakeReason[]).filter(
    (r) => counts.byReason[r] > 0 || r === reason,
  );
  // `counts.byReason` is scoped to the status and mailbox now showing, so this row lists the reasons
  // that actually occur in the current view — and it no longer disappears the moment the NEW backlog
  // reaches zero, which is exactly when an operator widens the status filter to read the history.

  return (
    <section className="flex flex-col gap-4" data-slice="S2-held-intake">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Held inbound mail</h2>
        <p className="text-sm text-muted-foreground">
          Messages the desk refused to file. Nothing here has reached a queue and nobody has replied to it.
          Releasing one opens a ticket from the stored preview; marking one as not for the desk opens nothing.
          Neither sends anything to the sender, and nothing on this page is ever deleted.
        </p>
      </header>

      {counts.waitingTotal > 0 ? (
        <p
          className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm ring-1 ring-amber-500/30"
          role="status"
        >
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <span>
            <strong className="font-semibold">
              {counts.waitingTotal} {counts.waitingTotal === 1 ? "message is" : "messages are"} waiting.
            </strong>{" "}
            {/*
              This figure counts rows whose REASON is `UNAUTHENTICATED`, which is not the same set as
              "every message whose sender was never proven" — the intake gates are ordered, so a
              message that failed authentication and also arrived on an unmapped address is counted
              under `UNKNOWN_MAILBOX`. The old copy read "None of them failed sender verification",
              an all-clear this page cannot support: a backlog made entirely of unverified
              unmapped-mailbox mail printed exactly that sentence. It now says what it counts, and
              points at the per-card caution for the rest. Widening the count needs a ledger read per
              row.
            */}
            {counts.waitingUnauthenticated > 0
              ? `${counts.waitingUnauthenticated} ${counts.waitingUnauthenticated === 1 ? "is" : "are"} held as “${HELD_REASON_LABELS.UNAUTHENTICATED}” — check those first.`
              : `None are held as “${HELD_REASON_LABELS.UNAUTHENTICATED}”. A card can still carry a sender caution under another reason.`}
          </span>
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Filter by inbound mailbox"
            aria-label="Filter held mail by the mailbox it arrived on"
            maxLength={320}
            // `pr-12` clears the clear-search button: globals.css gives an icon Button a 44 px minimum
            // on phones, so it owns the rightmost 48 px of the field and typed text ran underneath it.
            // `type="search"` contributes no native clear affordance on iOS Safari or Chrome Android.
            className="pl-9 pr-12"
          />
          {draft.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Clear mailbox filter"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              onClick={() => setDraft("")}
            >
              <X aria-hidden />
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by review status">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.key}
              type="button"
              variant={status === f.key ? "secondary" : "outline"}
              size="sm"
              // R3 / G2: globals.css gives a Button a 44 px minimum HEIGHT but no minimum width, so a
              // short label ("All") lands at 38 px wide. The fix is the size, never an opt-out.
              className="min-w-11"
              aria-pressed={status === f.key}
              onClick={() => setStatus(f.key)}
            >
              {f.label}
              {f.key === "NEW" && counts.waitingTotal > 0 ? (
                <Badge variant="secondary" className="ml-1 font-normal">
                  {counts.waitingTotal}
                </Badge>
              ) : null}
            </Button>
          ))}
        </div>

        {reasonsPresent.length > 0 ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by reason">
            <Button
              type="button"
              variant={reason === undefined ? "secondary" : "outline"}
              size="sm"
              className="min-w-11"
              aria-pressed={reason === undefined}
              onClick={() => setReason(undefined)}
            >
              Any reason
            </Button>
            {reasonsPresent.map((r) => (
              <Button
                key={r}
                type="button"
                variant={reason === r ? "secondary" : "outline"}
                size="sm"
                className="min-w-11"
                aria-pressed={reason === r}
                onClick={() => setReason(r)}
              >
                {HELD_REASON_LABELS[r]}
                {counts.byReason[r] > 0 ? (
                  <Badge variant="outline" className="ml-1 font-normal">
                    {counts.byReason[r]}
                  </Badge>
                ) : null}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {/*
        The count never claims to be the whole list. Nothing in this table is ever deleted, so the
        All view outgrows one page permanently and the rows past the cut are the OLDEST — the ones a
        reviewer is most behind on. "Showing 100 of 312" is the honest sentence; "100 messages shown"
        read as a complete count and hid 212 messages at every width.
      */}
      <p className="text-xs text-muted-foreground" aria-live="polite" aria-busy={pending || undefined}>
        {rows.length === 0
          ? "No held messages match."
          : startedMidList
            ? `Showing ${rows.length.toLocaleString()} of ${page.total.toLocaleString()} matching messages, continued from an earlier page.`
            : rows.length >= page.total
              ? `${rows.length.toLocaleString()} ${rows.length === 1 ? "message" : "messages"} shown — the whole list.`
              : `Showing the ${rows.length.toLocaleString()} most recent of ${page.total.toLocaleString()} matching messages.`}
      </p>

      {startedMidList ? (
        <p className="text-xs text-muted-foreground">
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => startTransition(() => router.replace(baseKey, { scroll: false }))}
          >
            Start from the newest message
          </Button>
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing is waiting here. Messages appear when the intake path refuses one — they are never deleted, so
          this page is the whole history once you widen the status filter.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <HeldRowCard key={row.id} row={row} releasableQueues={releasableQueues} />
          ))}
        </ul>
      )}

      {rows.length > 0 ? (
        <div className="flex flex-col items-stretch gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          {/* The remaining count, not a repeat of the line above it: what is still out of reach. */}
          <span>
            {page.nextCursor === null
              ? "Nothing further matches this filter."
              : `${Math.max(page.total - rows.length, 0).toLocaleString()} older ${
                  page.total - rows.length === 1 ? "message" : "messages"
                } not loaded yet.`}
          </span>
          {page.nextCursor !== null ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              // Full width on a phone (R3: the whole row is the target), auto from `sm` where it sits
              // beside the count. Same control, same URL writer, at every width.
              className="w-full sm:w-auto"
              onClick={loadMore}
              disabled={pending}
              aria-busy={pending || undefined}
              data-intake-load-more
            >
              {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
              {pending ? "Loading…" : "Load more"}
            </Button>
          ) : (
            <span>End of matching messages</span>
          )}
        </div>
      ) : null}
    </section>
  );
}

function HeldRowCard({
  row,
  releasableQueues,
}: {
  row: HeldIntakeRow;
  releasableQueues: QueueKey[];
}): React.JSX.Element {
  const senderMismatch = row.detail === "SENDER_MISMATCH";
  /**
   * The sender caution is driven by the row's computed verdict, NOT by its reason.
   *
   * The intake gates are ordered and the reason enum holds one value, so a message that failed
   * sender authentication and also arrived on an unmapped address is held as `UNKNOWN_MAILBOX` —
   * and this card used to render only the benign "not in the mailbox map" line, telling the reviewer
   * deciding whether to release a wire or address-change instruction the wrong thing to be careful
   * about. When the reason already says "Sender not verified" the second badge would be noise, so
   * the extra badge and line appear only where the reason hides the fact.
   */
  const senderCaution = !row.senderVerified && row.reason !== "UNAUTHENTICATED";
  return (
    <li
      data-intake-id={row.id}
      data-reason={row.reason}
      data-status={row.status}
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-card p-3 text-card-foreground ring-1 ring-foreground/10",
        "md:flex-row md:items-start md:justify-between md:gap-4",
        row.status !== "NEW" && "bg-muted/40",
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={row.senderVerified ? "secondary" : "destructive"} className="font-normal">
            {HELD_REASON_LABELS[row.reason]}
          </Badge>
          {senderMismatch ? (
            <Badge variant="outline" className="font-normal">
              Not the ticket&apos;s client
            </Badge>
          ) : null}
          {senderCaution ? (
            <Badge variant="destructive" className="font-normal">
              {HELD_REASON_LABELS.UNAUTHENTICATED}
            </Badge>
          ) : null}
          {row.status !== "NEW" ? (
            <Badge variant="outline" className="font-normal">
              {row.status === "RELEASED" ? "Released" : "Discarded"}
            </Badge>
          ) : null}
        </div>

        <p className="text-sm font-medium break-words">{row.subject}</p>
        <p className="text-xs break-all text-muted-foreground">
          From {row.fromAddress} · to {row.mailbox} · {formatWhen(row.createdAt)}
        </p>

        {/*
          Fix round 1. A FORWARDED hold carries the ORIGINAL sender the parser read out of the
          forwarded block. Until this line the card showed only the forwarder, so the attribution the
          server had already computed was invisible and the release control offered no way to use it —
          the forwarded-mail path read as delivered and was unreachable.
        */}
        {row.candidateRequesterEmail !== null ? (
          <p className="text-xs break-all text-muted-foreground" data-control="forwarded-candidate">
            Appears to be from {row.candidateRequesterEmail}
          </p>
        ) : null}

        {row.snippet !== null && row.snippet.length > 0 ? (
          <p className="rounded-lg bg-muted/60 p-2 text-sm whitespace-pre-wrap">{row.snippet}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">No readable body was stored.</p>
        )}

        <p className="text-xs text-muted-foreground">
          {senderMismatch
            ? "This reply matched an existing ticket, but the address it came from is not that ticket's client — a forward or a Cc'd third party. Releasing it opens a NEW ticket under the sender's own address."
            : HELD_REASON_HELP[row.reason]}
        </p>

        {/*
          Both facts, never one. The reason above is why the message stopped HERE; this is the one
          the single-valued reason could not also say, and it is the one that decides a wire or an
          address change. `data-sender-unverified` marks the row for the desk's own spot checks.
        */}
        {senderCaution ? (
          <p data-sender-unverified className="text-xs font-medium text-destructive">
            {SENDER_UNVERIFIED_HELP}
          </p>
        ) : null}

        {row.status === "DISCARDED" && row.discardedAt !== null ? (
          <p className="text-xs text-muted-foreground">
            Marked as not for the desk {formatWhen(row.discardedAt)}
            {row.discardedBy === null ? "" : ` by ${row.discardedBy}`}
            {row.discardNote === null ? "" : ` — “${row.discardNote}”`}
          </p>
        ) : null}

        {row.ticketNumber !== null && row.ticketId !== null ? (
          <p className="text-xs">
            <Link href={`/tickets/${row.ticketId}`} prefetch={false} className="underline underline-offset-2">
              Released as HD-{row.ticketNumber}
            </Link>
            {row.releasedBy !== null ? ` by ${row.releasedBy.name ?? row.releasedBy.email}` : ""}
          </p>
        ) : null}
      </div>

      {/*
        Two dispositions, never one. Releasing files a real ticket with an SLA clock; most held
        messages are a bounce, an auto-reply, a no-reply notification, spam or a loop, and filing one
        of those as client work is wrong — so before "Not for the desk" existed the only safe move was
        to leave the row NEW, and the queue never went down.
      */}
      <div className="flex flex-col gap-1 md:w-56 md:shrink-0">
        {row.status === "NEW" ? (
          <>
            {row.hasUsableSender ? (
              <ReleaseIntakeDialog
                suspendedId={row.id}
                subject={row.subject}
                fromAddress={row.fromAddress}
                reasonLabel={HELD_REASON_LABELS[row.reason]}
                unknownMailbox={row.reason === "UNKNOWN_MAILBOX"}
                // The row's computed verdict, not its reason: the server gate reads the same rule,
                // so a dialog that asked the reason would have skipped the acknowledgement on a
                // message the server then refused — or, before the gate was fixed too, let an
                // unproven address onto a ticket with nothing said about it.
                senderVerified={row.senderVerified}
                releasableQueues={releasableQueues}
                // Fix round 1: the forwarded-mail path. Null on every non-FORWARDED row, so the extra
                // control appears only where the parser actually read an inner sender.
                candidateRequesterEmail={row.candidateRequesterEmail}
              />
            ) : (
              // `releaseHeldIntake` refuses this row outright — there is no address a ticket could be
              // answered at — so the control is not rendered enabled to produce a toast and nothing
              // else. This is the usual shape of a PARSE_FAILED hold.
              <p className="text-xs text-muted-foreground md:text-right">
                This message has no sender address a ticket could be answered at, so it cannot be released.
              </p>
            )}
            <DiscardIntakeDialog
              suspendedId={row.id}
              subject={row.subject}
              fromAddress={row.fromAddress}
              reasonLabel={HELD_REASON_LABELS[row.reason]}
              releasable={row.hasUsableSender}
            />
          </>
        ) : null}
      </div>
    </li>
  );
}
