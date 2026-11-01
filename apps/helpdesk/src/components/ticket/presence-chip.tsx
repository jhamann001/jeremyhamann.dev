"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye } from "lucide-react";
import type { PresenceDTO, TicketDetailDTO } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { ResponsivePopover } from "@/components/shell/responsive-sheet";

/**
 * "Who else is looking at this".
 *
 * A CLIENT component: it polls `GET /api/tickets/[id]/presence`, so it may import only L0/L1,
 * `@/components/**` and `@/server/*.actions`. It reaches for nothing else — a fetch, a button and
 * the shared responsive disclosure.
 *
 * Presence is derived from the recent `TICKET_VIEWED` rows the desk already writes, not from a new
 * heartbeat channel: no socket, no extra table, no new write path, and it cannot disagree with the
 * audit trail because it IS the audit trail.
 *
 * **It polls only while the tab is visible.** A background tab that kept asking every thirty seconds
 * would be a request a minute per forgotten tab, for an answer nobody is looking at. On returning to
 * the tab it refreshes immediately rather than waiting out the interval, because a stale "nobody else
 * is here" is the answer that costs two people an hour of duplicated work.
 *
 * It renders NOTHING when nobody else is here: an empty chip that says "0 others" is furniture.
 *
 * **Fix round 2 — the names are VISIBLE, not a tooltip.** The chip used to carry them in `title`, and
 * MOBILE_FIRST R10 is explicit that a `title` is not a visible explanation: a phone has no hover, so a
 * sighted operator could see that somebody else was on the ticket but not WHO — which is the half of
 * the answer that decides whether to message them. The chip is now a control: tapping it opens the
 * list (a bottom sheet on a phone, a popover from md), exactly like `SlaDetailPopover` beside it.
 *
 * **Known gap, deliberately not closed here.** This component is mounted only inside the `md:hidden`
 * facts strip, because CONTRACT §9 pins the placement ("`SlaDetailPopover` + `PresenceChip` in the
 * phone-only strip"). So presence is invisible at 768 px and above, which is where the desk mostly
 * works, and there is no md+ equivalent in the properties column. Closing that needs a placement
 * decision plus an edit to the foundation-owned ticket page; it is written up for the orchestrator in
 * the build record
 */
export type PresenceChipProps = { ticketId: TicketDetailDTO["id"] };

const POLL_MS = 30_000;

function displayName(user: { name: string | null; email: string }): string {
  const name = user.name?.trim() ?? "";
  return name.length > 0 ? name : user.email;
}

export function PresenceChip({ ticketId }: PresenceChipProps): React.JSX.Element | null {
  const [viewers, setViewers] = useState<PresenceDTO["viewers"]>([]);
  const [open, setOpen] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/presence`, {
        signal: controller.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        // 401 / 404 are ordinary answers here (session gone, ticket not readable any more). The chip
        // simply stops claiming anyone is present rather than showing an error on somebody's ticket.
        setViewers([]);
        return;
      }
      const body = (await res.json()) as PresenceDTO;
      setViewers(Array.isArray(body.viewers) ? body.viewers : []);
    } catch {
      // An aborted or failed poll is not an event: keep the last answer and try again on the interval.
    }
  }, [ticketId]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    function start(): void {
      if (timer !== null) return;
      void load();
      timer = setInterval(() => void load(), POLL_MS);
    }
    function stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    }
    function onVisibility(): void {
      if (document.visibilityState === "visible") start();
      else stop();
    }

    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
      inFlight.current?.abort();
    };
  }, [load]);

  if (viewers.length === 0) return null;

  const names = viewers.map((v) => displayName(v.user));
  const label =
    names.length === 1
      ? `${names[0]} also has this ticket open`
      : `${names.length} colleagues also have this ticket open: ${names.join(", ")}`;

  return (
    <ResponsivePopover
      open={open}
      onOpenChange={setOpen}
      title="Also on this ticket"
      className="w-72 p-0"
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 gap-1.5 border-sky-300 bg-sky-50 text-sky-900 hover:bg-sky-100 md:min-h-8 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200 dark:hover:bg-sky-900/50"
          data-slice="B2-presence"
          data-presence-count={viewers.length}
        >
          <Eye aria-hidden className="size-3.5" />
          {/* The count is the glanceable part; the names are one tap away and are also read out here
              for a screen reader, which has no tap. R10: the badge carries its value as TEXT. */}
          <span aria-hidden>{names.length === 1 ? names[0] : `${names.length} others`}</span>
          <span className="sr-only" role="status">
            {label}
          </span>
        </Button>
      }
    >
      <div className="flex flex-col gap-2 px-4 pb-2 md:p-3">
        <p className="text-xs text-muted-foreground">
          {names.length === 1 ? "Also has this ticket open:" : "Also have this ticket open:"}
        </p>
        <ul className="flex flex-col gap-1">
          {viewers.map((v) => (
            <li key={v.user.id} className="min-w-0 truncate text-sm font-medium">
              {displayName(v.user)}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Read from the ticket views the desk already records, refreshed every 30 seconds while this tab
          is open. Somebody who has just closed the ticket can still appear here for a few minutes.
        </p>
      </div>
    </ResponsivePopover>
  );
}
