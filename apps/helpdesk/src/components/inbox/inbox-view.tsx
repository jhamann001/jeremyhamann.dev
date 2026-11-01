"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BellOff, CheckCheck, Inbox as InboxIcon, Lock } from "lucide-react";
import type { InboxPage, NotificationDTO, NotificationKind } from "@/types/domain";
import { LIVE_NOTIFICATION_KINDS, NOTIFICATION_KIND_LABELS, isLiveNotificationKind } from "@/types/domain";
import { formatDateTime, formatRelative, formatTicketNumber } from "@/lib/format";
import { markNotificationsRead } from "@/server/notifications.actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserAvatar } from "@/components/tickets/user-avatar";
import { flattenRows, groupRows, inboxHref, mergePage } from "@/components/inbox/inbox-query";
import type { Accumulated } from "@/components/inbox/inbox-query";

export type InboxViewProps = {
  page: InboxPage;
  kind: NotificationKind | undefined;
  unreadOnly: boolean;
  /** The cursor that produced `page`, so "Load more" can grow the list instead of replacing it. */
  cursor: string | undefined;
};

/**
 * `/inbox` (docs/MOBILE_FIRST.md R1–R12).
 *
 * One layout flip at `md`: below it each notification is a stacked, full-width card whose whole body
 * is a 44 px link; from `md` the same card puts its timestamp on the right. Same rows, same
 * component, same URL at both widths. The filter chips write the URL through `inboxHref`, which
 * is also what the server page reads — one serializer, two surfaces.
 *
 * Reading is not audited (CONTRACT §3 rule 3) and a row is not a view: a kind and a timestamp
 * carry no record content, and the three fields that could — the WM number, the subject and the
 * preview — reach this component only for tickets in the viewer's readable queues (`listInbox` /
 * `toNotificationDTO`). A row outside them arrives with the kind label in place of its preview, so
 * the line below is dropped rather than repeating the badge. Opening the ticket is the audited view,
 * which is why every row links out rather than expanding in place.
 */
export function InboxView({ page, kind, unreadOnly, cursor }: InboxViewProps): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const baseKey = inboxHref({ kind, unreadOnly });
  const [acc, setAcc] = useState<Accumulated>(() => mergePage(null, page, cursor, baseKey));
  let current = acc;
  if (acc.page !== page || acc.baseKey !== baseKey) {
    current = mergePage(acc, page, cursor, baseKey);
    setAcc(current);
  }

  const rows = useMemo(() => flattenRows(current.chunks), [current.chunks]);
  const groups = useMemo(() => groupRows(rows), [rows]);

  /**
   * Only the kinds something in the tree can actually write are offered, so the filter cannot promise
   * a page that is empty by construction (`LIVE_NOTIFICATION_KINDS`). A saved link or a bookmark that
   * still carries a deferred kind keeps working — that kind is added back for as long as it is the
   * selected one, rather than leaving the trigger showing a placeholder over an applied filter.
   */
  const kindOptions = useMemo<NotificationKind[]>(
    () =>
      kind !== undefined && !isLiveNotificationKind(kind)
        ? [...LIVE_NOTIFICATION_KINDS, kind]
        : [...LIVE_NOTIFICATION_KINDS],
    [kind],
  );

  /**
   * The single URL write. Every filter change drops the cursor, because a new filter is a new
   * result set and carrying a cursor across it would open the list in the middle of nowhere.
   */
  function go(nextKind: NotificationKind | undefined, nextUnreadOnly: boolean): void {
    startTransition(() => router.replace(inboxHref({ kind: nextKind, unreadOnly: nextUnreadOnly }), { scroll: false }));
  }

  function loadMore(): void {
    if (page.nextCursor === null) return;
    // `push`, not `replace`: each loaded page is a Back step, and the server renders it under the
    // same capability gate as the first.
    startTransition(() => router.push(inboxHref({ kind, unreadOnly, cursor: page.nextCursor ?? undefined }), { scroll: false }));
  }

  function markAll(): void {
    startTransition(async () => {
      const result = await markNotificationsRead({ all: true });
      if (result.ok) {
        toast.success(
          result.data.read === 0 ? "Nothing was unread" : `${result.data.read} marked read`,
        );
        router.refresh();
        return;
      }
      toast.error(
        result.code === "UNAUTHORIZED" ? "Your session has ended. Sign in again." : "Could not mark them read.",
      );
    });
  }

  function markOne(id: string): void {
    startTransition(async () => {
      const result = await markNotificationsRead({ ids: [id] });
      if (result.ok) router.refresh();
    });
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4" data-slice="B1-inbox">
      <header className="flex flex-col gap-1">
        <h1 className="text-base font-semibold">Inbox</h1>
        <p className="text-sm text-muted-foreground">
          Mentions, assignments and alerts for you. Opening a ticket from here is recorded, like every
          other way in.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {/*
          `min-w-11` as well as `min-h-11`: the global phone rule in src/app/globals.css sets a 44 px
          minimum HEIGHT and no minimum width, so a short label collapses on the horizontal axis —
          "All" measured 39x44 at 360, 390 and 430. "Unread" escaped only because its label plus the
          unread Badge happened to be wider, which makes the failure label-length-dependent. Same fix
          and same reason as `webhooks-admin-view.tsx` and `suppression-admin-view.tsx`.
        */}
        <Button
          type="button"
          variant={unreadOnly ? "default" : "outline"}
          className="min-h-11 min-w-11 md:min-h-9"
          aria-pressed={unreadOnly}
          onClick={() => go(kind, true)}
        >
          Unread
          {page.unread > 0 ? (
            <Badge variant="secondary" className="ml-1 tabular-nums">
              {page.unread}
            </Badge>
          ) : null}
        </Button>
        <Button
          type="button"
          variant={unreadOnly ? "outline" : "default"}
          className="min-h-11 min-w-11 md:min-h-9"
          aria-pressed={!unreadOnly}
          onClick={() => go(kind, false)}
        >
          All
        </Button>

        <Select
          value={kind ?? "ALL"}
          onValueChange={(v) => go(v === "ALL" ? undefined : (v as NotificationKind), unreadOnly)}
        >
          <SelectTrigger className="min-h-11 w-full md:min-h-9 md:w-56" aria-label="Filter by kind">
            <SelectValue placeholder="Every kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Every kind</SelectItem>
            {kindOptions.map((k) => (
              <SelectItem key={k} value={k}>
                {NOTIFICATION_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full md:ml-auto md:min-h-9 md:w-auto"
          disabled={pending || page.unread === 0}
          onClick={markAll}
        >
          <CheckCheck aria-hidden />
          Mark all read
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-card p-8 text-center text-card-foreground">
          <InboxIcon aria-hidden className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{unreadOnly ? "Nothing unread" : "Nothing here yet"}</p>
          <p className="text-xs text-muted-foreground">
            {unreadOnly
              ? "Everything addressed to you has been read."
              : "You are notified when someone mentions you, assigns you a ticket, or a ticket you follow moves."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Group heading="Today" rows={groups.today} onMarkRead={markOne} pending={pending} />
          <Group heading="Earlier" rows={groups.earlier} onMarkRead={markOne} pending={pending} />
        </div>
      )}

      <div className="flex flex-col items-center gap-2">
        {page.nextCursor !== null ? (
          <Button type="button" variant="outline" className="min-h-11 w-full md:w-auto" disabled={pending} onClick={loadMore}>
            {pending ? "Loading…" : "Load more"}
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground tabular-nums">
          {rows.length} shown · {page.unread} unread
        </p>
      </div>
    </section>
  );
}

function Group({
  heading,
  rows,
  onMarkRead,
  pending,
}: {
  heading: string;
  rows: readonly NotificationDTO[];
  onMarkRead: (id: string) => void;
  pending: boolean;
}): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{heading}</p>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <NotificationRow key={row.id} row={row} onMarkRead={onMarkRead} pending={pending} />
        ))}
      </ul>
    </div>
  );
}

function NotificationRow({
  row,
  onMarkRead,
  pending,
}: {
  row: NotificationDTO;
  onMarkRead: (id: string) => void;
  pending: boolean;
}): React.JSX.Element {
  const unread = row.readAt === null;
  // The number IS the deep link: a row whose ticket sits outside the viewer's readable queues shows
  // neither, and says so in words rather than rendering a link that would 404 (see `listInbox`).
  const href = row.ticketNumber === null ? null : `/tickets/wm/${row.ticketNumber}`;

  const body = (
    <>
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant={unread ? "default" : "secondary"} className="font-normal">
          {NOTIFICATION_KIND_LABELS[row.kind]}
        </Badge>
        {row.ticketNumber !== null ? (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatTicketNumber(row.ticketNumber)}
          </span>
        ) : null}
        <time
          dateTime={row.createdAt}
          title={formatDateTime(row.createdAt)}
          className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
          suppressHydrationWarning
        >
          {formatRelative(row.createdAt)}
        </time>
      </span>
      {row.ticketSubject !== null ? (
        <span className="line-clamp-2 text-sm leading-snug font-medium break-words">{row.ticketSubject}</span>
      ) : null}
      {row.preview === NOTIFICATION_KIND_LABELS[row.kind] ? null : (
        <span className="line-clamp-2 text-sm leading-snug break-words text-muted-foreground">{row.preview}</span>
      )}
    </>
  );

  return (
    <li
      data-unread={unread ? "true" : undefined}
      className={`flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground ${
        unread ? "border-l-4 border-l-primary" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <UserAvatar user={row.actor} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {href === null ? (
            <div className="flex min-h-11 flex-col gap-1">{body}</div>
          ) : (
            <Link
              href={href}
              prefetch={false}
              className="flex min-h-11 flex-col gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => {
                if (unread) onMarkRead(row.id);
              }}
            >
              {body}
            </Link>
          )}
          {href === null && row.ticketId !== null ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock aria-hidden className="size-3 shrink-0" />
              You no longer have access to this ticket&apos;s queue.
            </p>
          ) : null}
        </div>
      </div>
      {unread ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          disabled={pending}
          onClick={() => onMarkRead(row.id)}
        >
          <BellOff aria-hidden />
          Mark read
        </Button>
      ) : null}
    </li>
  );
}
