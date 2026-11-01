"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Clock, LockKeyhole, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { QueueSummary, QueueSummaryResponse } from "@/types/domain";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SNAP_ROW_CLASSES } from "@/components/shell/filter-sheet";
import { cn } from "@/lib/utils";

/**
 * Phone: each card is a snap-start slide at 85 % width so ~1.15 cards show (peek affordance) and the numerals
 * never squash. From `sm` the carousel becomes the grid again (density only — R1's single layout flip stays `md`).
 */
const CAROUSEL_CARD_CLASSES = "w-[85%] shrink-0 snap-start sm:w-auto";

/** Counters poll on this cadence while the tab is visible. */
const POLL_INTERVAL_MS = 15_000;

async function fetchQueueSummary(): Promise<QueueSummaryResponse> {
  const res = await fetch("/api/queues/summary", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`queue summary request failed (${res.status})`);
  return (await res.json()) as QueueSummaryResponse;
}

/** Convention 12: repeated bare keys via URLSearchParams.append — never `key[]`, never comma-joined. */
function queueHref(slug: string, params: Array<[key: string, value: string]>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of params) sp.append(k, v);
  const qs = sp.toString();
  return qs.length > 0 ? `/queues/${slug}?${qs}` : `/queues/${slug}`;
}

function Stat({
  href,
  label,
  value,
  icon: Icon,
  tone,
}: {
  href: string;
  label: string;
  value: number;
  icon: LucideIcon;
  tone: "neutral" | "warning" | "breached";
}): React.JSX.Element {
  const toneClass =
    value === 0
      ? "text-muted-foreground"
      : tone === "breached"
        ? "text-destructive"
        : tone === "warning"
          ? "text-amber-700 dark:text-amber-300"
          : "text-foreground";
  return (
    <Link
      href={href}
      prefetch={false}
      className={cn(
        // explicit 44 on phones (a bare <Link> has no data-slot); desktop density returns at md
        "flex min-h-11 min-w-0 flex-col justify-center gap-0.5 rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 md:min-h-0",
      )}
      aria-label={`${label}: ${value}`}
    >
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Icon aria-hidden className="size-3" />
        <span className="truncate">{label}</span>
      </span>
      <span className={cn("text-lg font-semibold tabular-nums leading-none md:text-base", toneClass)}>{value}</span>
    </Link>
  );
}

function QueueCard({ summary }: { summary: QueueSummary }): React.JSX.Element {
  const { slug, name, canRead } = summary;

  if (!canRead) {
    return (
      <Card size="sm" className={cn(CAROUSEL_CARD_CLASSES, "opacity-70")} data-queue={summary.key} data-can-read="false">
        <CardHeader>
          <CardTitle className="flex min-h-11 items-center gap-2 md:min-h-0">
            <span className="truncate">{name}</span>
            <LockKeyhole aria-hidden className="size-3.5 text-muted-foreground" />
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">No access</CardContent>
      </Card>
    );
  }

  const hasAlarm = summary.breached > 0;
  return (
    <Card
      size="sm"
      className={cn(CAROUSEL_CARD_CLASSES, hasAlarm && "ring-destructive/40")}
      data-queue={summary.key}
      data-can-read="true"
    >
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <Link
            href={`/queues/${slug}`}
            prefetch={false}
            className="flex min-h-11 min-w-11 items-center rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 md:min-h-0"
          >
            <span className="truncate">{name}</span>
          </Link>
          <span className="shrink-0 text-2xl font-semibold tabular-nums leading-none" aria-label={`${summary.open} open`}>
            {summary.open}
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">open</span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-1">
        <Stat
          href={queueHref(slug, [["assigneeId", "unassigned"]])}
          label="Unassigned"
          value={summary.unassigned}
          icon={UserRound}
          tone="neutral"
        />
        <Stat
          href={queueHref(slug, [["slaStatus", "WARNING"]])}
          label="Warning"
          value={summary.warning}
          icon={Clock}
          tone="warning"
        />
        <Stat
          href={queueHref(slug, [["slaStatus", "BREACHED"]])}
          label="Breached"
          value={summary.breached}
          icon={CircleAlert}
          tone="breached"
        />
      </CardContent>
    </Card>
  );
}

/** Seconds-ago label ticking once a second; null before mount so SSR and the first client paint agree. */
function useAgeLabel(updatedAt: number): string | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  if (now === null || updatedAt === 0) return null;
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  return seconds < 60 ? `updated ${seconds}s ago` : `updated ${Math.floor(seconds / 60)}m ago`;
}

/**
 * One card per queue (open / unassigned / warning / breached), polling GET /api/queues/summary every
 * 15 s while the tab is visible. Counters carry no record content and are not audited views.
 */
export function QueueCounters({ initial }: { initial: QueueSummary[] }): React.JSX.Element {
  const query = useQuery<QueueSummaryResponse>({
    queryKey: ["queue-summary"],
    queryFn: fetchQueueSummary,
    // The RSC already computed these; the poll takes over from here. generatedAt is not rendered.
    initialData: { queues: initial, generatedAt: "" },
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const age = useAgeLabel(query.dataUpdatedAt);

  // The RSC decides which queues this surface shows (all three on the dashboard, one on a queue page);
  // the poll returns every queue, so match by key and keep the server's order.
  const shown = initial
    .map((s) => query.data.queues.find((q) => q.key === s.key) ?? s)
    .filter((s): s is QueueSummary => s !== undefined);

  return (
    <section aria-label="Queue counters" className="flex flex-col gap-1.5">
      {/* Phone: element-level snap carousel (data-snap-row is the QA allowlist + hidden scrollbar); sm+: the grid. */}
      <div
        data-snap-row
        className={cn(
          SNAP_ROW_CLASSES,
          "pb-1 sm:mx-0 sm:grid sm:snap-none sm:gap-3 sm:overflow-visible sm:px-0 sm:pb-0",
          shown.length >= 3 ? "sm:grid-cols-3" : shown.length === 2 ? "sm:grid-cols-2" : "sm:max-w-sm",
        )}
      >
        {shown.map((s) => (
          <QueueCard key={s.key} summary={s} />
        ))}
      </div>
      <div className="flex items-center gap-2 px-0.5 text-[11px] text-muted-foreground" aria-live="polite">
        <span suppressHydrationWarning>{age ?? "live counters"}</span>
        {query.isFetching ? <span aria-hidden>·</span> : null}
        {query.isFetching ? <span>refreshing…</span> : null}
        {query.isError ? (
          <span className="text-destructive" role="status">
            · counters paused — last poll failed
          </span>
        ) : null}
      </div>
    </section>
  );
}
