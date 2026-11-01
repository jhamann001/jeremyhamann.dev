/**
 * What a report's series columns are CALLED and what they are measured in — pure, client-safe
 * (imports only `@/lib/format`, layer L1).
 *
 * The series keys themselves are machine names chosen by `@/server/reports` (`p50`, `metPct`,
 * `inRange`) and travel unchanged into the CSV, where a sheet or a Warehouse load can map them without
 * a legend. A person should never be shown one: R10's "badges carry their value as text" rule applies
 * to a chart legend as much as to a badge, so every key a report can emit is named here, and
 * `seriesLabel` falls back to the raw key rather than rendering a blank cell if a future report adds
 * one without updating this map.
 */
import { formatDuration } from "@/lib/format";

export type SeriesUnit = "count" | "percent" | "minutes";

type SeriesMeta = { label: string; unit: SeriesUnit };

const SERIES_META: Readonly<Record<string, SeriesMeta>> = {
  // volume / backlog
  created: { label: "Created", unit: "count" },
  resolved: { label: "Resolved", unit: "count" },
  backlog: { label: "Open at period end", unit: "count" },
  breached: { label: "Past an SLA clock", unit: "count" },
  complaints: { label: "Complaints", unit: "count" },
  net: { label: "Net change", unit: "count" },
  current: { label: "Now", unit: "count" },
  peak: { label: "Peak in range", unit: "count" },
  inRange: { label: "In range", unit: "count" },
  counters: { label: "Counters", unit: "count" },
  // response and resolution times
  p50: { label: "Median", unit: "minutes" },
  p90: { label: "90th percentile", unit: "minutes" },
  responded: { label: "Responded to", unit: "count" },
  unanswered: { label: "Awaiting a first response", unit: "count" },
  respondedPct: { label: "Responded to", unit: "percent" },
  // SLA attainment
  firstResponsePct: { label: "First response met", unit: "percent" },
  resolutionPct: { label: "Resolution met", unit: "percent" },
  metPct: { label: "Both met", unit: "percent" },
  firstResponseMet: { label: "First response met", unit: "count" },
  resolutionMet: { label: "Resolution met", unit: "count" },
  met: { label: "Both met", unit: "count" },
  // agent load
  open: { label: "Open now", unit: "count" },
  agents: { label: "Agents", unit: "count" },
  unassigned: { label: "Unassigned", unit: "count" },
  // mixes
  tickets: { label: "Tickets", unit: "count" },
  sharePct: { label: "Share", unit: "percent" },
  categories: { label: "Categories", unit: "count" },
  recorded: { label: "Resolution recorded", unit: "count" },
  unrecorded: { label: "Resolution not recorded", unit: "count" },
  // reopens
  reopened: { label: "Reopened", unit: "count" },
  ticketsReopened: { label: "Tickets reopened", unit: "count" },
  ratePct: { label: "Reopen rate", unit: "percent" },
};

/** `created.OPERATIONS` → "Created · Operations": the per-queue totals volume adds to its own map. */
const QUEUE_SUFFIX_LABELS: Readonly<Record<string, string>> = {
  OPERATIONS: "Operations",
  CLIENT_SERVICE: "Client Service",
  ADVICE: "Advice",
};

export function seriesLabel(key: string): string {
  const meta = SERIES_META[key];
  if (meta !== undefined) return meta.label;
  const dot = key.indexOf(".");
  if (dot > 0) {
    const head = SERIES_META[key.slice(0, dot)];
    const tail = QUEUE_SUFFIX_LABELS[key.slice(dot + 1)];
    if (head !== undefined && tail !== undefined) return `${head.label} · ${tail}`;
  }
  return key;
}

export function seriesUnit(key: string): SeriesUnit {
  const meta = SERIES_META[key];
  if (meta !== undefined) return meta.unit;
  const dot = key.indexOf(".");
  if (dot > 0) {
    const head = SERIES_META[key.slice(0, dot)];
    if (head !== undefined) return head.unit;
  }
  return "count";
}

/**
 * The value as a person reads it: "4", "87.5%", "2h 14m". Minutes go through `formatDuration` so a
 * two-day median does not print as "2880" — the number every SLA conversation is about is a DURATION,
 * and the desk's own policy is written in minutes and hours.
 */
export function formatSeriesValue(key: string, value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  switch (seriesUnit(key)) {
    case "percent":
      return `${round(value)}%`;
    case "minutes":
      return value <= 0 ? "—" : formatDuration(value * 60_000);
    default:
      return String(round(value));
  }
}

/** The CSV and the table print the raw number; only the chart legend and the tiles round for reading. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
