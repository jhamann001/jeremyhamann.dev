import "server-only";
import { prisma } from "@/lib/db";
import { escapeSlack, sendTradeRequestSlack, TRADE_REQUESTS_SLACK_ORIGIN } from "@/lib/slack/trade-requests";
import { queueRequestRoute, TRADE_REQUESTS_ROUTES } from "@/lib/trade-requests/routes";

// Ported from trade-request d41b6c9 server/src/services/digest.ts (ticket). Message wording is byte-identical;
// test/trade-request-digest-wording.test.ts compares it with the standalone service's own output.

const DIGEST_TZ = "America/New_York";

/** Every status except Approved and Rejected (standalone product direction: Completed stays visible). */
export const OPEN_STATUSES = ["Pending Review", "Needs Info", "Pending Current Asset Liquidation", "Completed"] as const;
type OpenStatus = (typeof OPEN_STATUSES)[number];

const STATUS_SECTION_ORDER: OpenStatus[] = ["Pending Review", "Needs Info", "Pending Current Asset Liquidation", "Completed"];

const STATUS_SECTION_LABEL: Record<OpenStatus, string> = {
  "Pending Review": "Pending Review",
  "Needs Info": "Needs Info",
  "Pending Current Asset Liquidation": "Pending Liquidation",
  Completed: "Completed",
};

const MAX_DETAIL_ROWS = 10;
const DEADLINE_SOON_DAYS = 7;

export interface OutstandingRequest {
  id: string;
  status: OpenStatus;
  tradeType: string;
  tradeAmount: string | null;
  totalValue: number | null;
  priority: "Urgent" | "Standard" | "Low" | null;
  createdAt: Date;
  liquidityDeadline: string | null;
  clientNames: string[];
  submittedByName: string | null;
  waitingMinutes: number;
}

export interface DigestSummary {
  runDate: string;
  total: number;
  urgent: number;
  overdue48h: number;
  oldestWaitingMinutes: number | null;
  byStatus: Partial<Record<OpenStatus, OutstandingRequest[]>>;
}

/** One queue row. Numeric and minute columns are cast to text in SQL, as the standalone mapper expects. */
export interface DigestRow {
  id: string;
  status: string;
  trade_type: string;
  trade_amount: string | null;
  total_value: string | null;
  priority: string | null;
  created_at: Date | string;
  liquidity_deadline: string | null;
  client_names: string[] | null;
  client_name: string | null;
  advisor_name: string | null;
  waiting_minutes: string;
}

export type DigestLinks = { queueUrl: string; requestUrl: (id: string) => string };

/** AOA workspace targets on the production origin (the standalone screens are off after cutover). */
export const AOA_DIGEST_LINKS: DigestLinks = {
  queueUrl: `${TRADE_REQUESTS_SLACK_ORIGIN}${TRADE_REQUESTS_ROUTES.tradingQueue}`,
  requestUrl: (id) => `${TRADE_REQUESTS_SLACK_ORIGIN}${queueRequestRoute(id)}`,
};

/** The run date as YYYY-MM-DD in America/New_York. */
export function computeRunDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DIGEST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatDateHeader(runDate: string): string {
  const [y, m, d] = runDate.split("-").map((v) => parseInt(v, 10));
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DIGEST_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatAge(minutes: number | null): string {
  if (minutes == null) return "n/a";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

function formatMoney(totalValue: number | null, tradeAmount: string | null): string | null {
  if (totalValue != null && Number.isFinite(totalValue) && totalValue > 0) {
    if (totalValue >= 1_000_000) return `$${(totalValue / 1_000_000).toFixed(1)}M`;
    if (totalValue >= 1_000) return `$${Math.round(totalValue / 1_000)}k`;
    return `$${Math.round(totalValue)}`;
  }
  if (tradeAmount && tradeAmount.trim()) return tradeAmount.trim();
  return null;
}

function formatClientNames(names: string[]): string {
  const clean = names.map((n) => (n ?? "").trim()).filter(Boolean);
  if (clean.length === 0) return "(client unknown)";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} & ${clean[1]}`;
  return `${clean[0]} & ${clean.length - 1} others`;
}

function formatDeadline(isoDate: string | null, now: Date): string | null {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split("-").map((v) => parseInt(v, 10));
  if (!y || !m || !d) return null;
  const today = computeRunDate(now);
  const [ty, tm, td] = today.split("-").map((v) => parseInt(v, 10));
  const todayDays = Date.UTC(ty, tm - 1, td) / 86_400_000;
  const deadlineDays = Date.UTC(y, m - 1, d) / 86_400_000;
  const diff = deadlineDays - todayDays;
  if (diff < 0) return "deadline overdue";
  if (diff > DEADLINE_SOON_DAYS) return null;
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: DIGEST_TZ,
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)));
  return `deadline ${label}`;
}

function parseNumeric(value: string | null): number | null {
  if (value == null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function coerceStatus(value: string): OpenStatus | null {
  return (OPEN_STATUSES as readonly string[]).includes(value) ? (value as OpenStatus) : null;
}

function coercePriority(value: string | null): OutstandingRequest["priority"] {
  if (value === "Urgent" || value === "Standard" || value === "Low") return value;
  return null;
}

function priorityRank(p: OutstandingRequest["priority"]): number {
  if (p === "Urgent") return 0;
  if (p === "Standard") return 1;
  return 2;
}

/** The queue query. Every table is schema-qualified; casts give the text shapes the mapper expects. */
export const DIGEST_QUEUE_SQL = `
    SELECT
      tr.id,
      tr.status,
      tr.trade_type,
      tr.trade_amount,
      tr.total_value::text                                AS total_value,
      tr.priority,
      tr.created_at,
      CASE
        WHEN tr.liquidity_deadline IS NULL THEN NULL
        ELSE to_char(tr.liquidity_deadline, 'YYYY-MM-DD')
      END                                                 AS liquidity_deadline,
      CASE
        WHEN jsonb_typeof(tr.client_names) = 'array'
          THEN ARRAY(SELECT jsonb_array_elements_text(tr.client_names))
        ELSE NULL
      END                                                 AS client_names,
      tr.client_name,
      u.name                                              AS advisor_name,
      (EXTRACT(EPOCH FROM (now() - tr.created_at)) / 60)::bigint::text AS waiting_minutes
    FROM trade_request.trade_requests tr
    LEFT JOIN trade_request.users u ON u.id = tr.advisor_id
    WHERE tr.status = ANY($1::text[])
    ORDER BY tr.created_at ASC
    `;

/** The standalone collectDigestSummary after its query (digest.ts:204, 236-294). */
export function summarizeDigestRows(rows: DigestRow[], now: Date): DigestSummary {
  const runDate = computeRunDate(now);
  const requests: OutstandingRequest[] = [];
  for (const r of rows) {
    const status = coerceStatus(r.status);
    if (!status) continue;
    const waitingMinutes = parseInt(r.waiting_minutes, 10);
    const clientNames =
      Array.isArray(r.client_names) && r.client_names.length > 0 ? r.client_names : r.client_name ? [r.client_name] : [];
    requests.push({
      id: r.id,
      status,
      tradeType: r.trade_type,
      tradeAmount: r.trade_amount ?? null,
      totalValue: parseNumeric(r.total_value),
      priority: coercePriority(r.priority),
      createdAt: new Date(r.created_at),
      liquidityDeadline: r.liquidity_deadline ?? null,
      clientNames,
      submittedByName: r.advisor_name,
      waitingMinutes: Number.isFinite(waitingMinutes) ? waitingMinutes : 0,
    });
  }

  const byStatus: Partial<Record<OpenStatus, OutstandingRequest[]>> = {};
  let urgent = 0;
  let overdue48h = 0;
  let oldestWaitingMinutes: number | null = null;

  for (const req of requests) {
    const bucket = byStatus[req.status] ?? [];
    bucket.push(req);
    byStatus[req.status] = bucket;
    if (req.priority === "Urgent") urgent += 1;
    if (req.waitingMinutes > 48 * 60) overdue48h += 1;
    if (oldestWaitingMinutes == null || req.waitingMinutes > oldestWaitingMinutes) {
      oldestWaitingMinutes = req.waitingMinutes;
    }
  }

  for (const key of Object.keys(byStatus) as OpenStatus[]) {
    byStatus[key]!.sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return b.waitingMinutes - a.waitingMinutes;
    });
  }

  return { runDate, total: requests.length, urgent, overdue48h, oldestWaitingMinutes, byStatus };
}

export async function collectDigestSummary(now: Date): Promise<DigestSummary> {
  const rows = await prisma.$queryRawUnsafe<DigestRow[]>(DIGEST_QUEUE_SQL, [...OPEN_STATUSES]);
  return summarizeDigestRows(rows, now);
}

function renderRequestRow(req: OutstandingRequest, now: Date, links: DigestLinks): string[] {
  const url = links.requestUrl(req.id);
  const money = formatMoney(req.totalValue, req.tradeAmount);

  const topParts: string[] = [`<${url}|${escapeSlack(req.id)}>`, escapeSlack(req.tradeType)];
  if (money) topParts.push(escapeSlack(money));
  topParts.push(escapeSlack(formatClientNames(req.clientNames)));

  const bottomParts: string[] = [];
  if (req.submittedByName) bottomParts.push(escapeSlack(req.submittedByName));
  bottomParts.push(formatAge(req.waitingMinutes));
  if (req.priority === "Urgent") bottomParts.push("🚨 Urgent");
  const deadline = formatDeadline(req.liquidityDeadline, now);
  if (deadline) bottomParts.push(escapeSlack(deadline));

  return [`• ${topParts.join(" · ")}`, `   ${bottomParts.join(" · ")}`];
}

export function renderDigest(summary: DigestSummary, now: Date, links: DigestLinks): string {
  const header = `*Trade Request — Daily Digest* — ${escapeSlack(formatDateHeader(summary.runDate))}`;
  const link = `<${links.queueUrl}|Open the queue →>`;

  if (summary.total === 0) {
    return [header, "", "All clear — no open requests on the queue.", "", link].join("\n");
  }

  const lines: string[] = [header];

  const summaryBits: string[] = [`${summary.total} open request${summary.total === 1 ? "" : "s"}`];
  if (summary.urgent > 0) summaryBits.push(`${summary.urgent} urgent`);
  if (summary.overdue48h > 0) summaryBits.push(`${summary.overdue48h} waiting > 48h`);
  if (summary.oldestWaitingMinutes != null) {
    summaryBits.push(`oldest ${formatAge(summary.oldestWaitingMinutes)}`);
  }
  lines.push(summaryBits.join(" · "));

  let rowsRendered = 0;
  let skipped = 0;
  for (const status of STATUS_SECTION_ORDER) {
    const bucket = summary.byStatus[status];
    if (!bucket || bucket.length === 0) continue;

    lines.push("", `*${STATUS_SECTION_LABEL[status]} (${bucket.length})*`);

    const remaining = Math.max(0, MAX_DETAIL_ROWS - rowsRendered);
    const show = bucket.slice(0, remaining);
    const skip = bucket.length - show.length;

    for (const req of show) {
      lines.push(...renderRequestRow(req, now, links));
    }
    rowsRendered += show.length;
    skipped += skip;

    if (skip > 0) {
      lines.push(`   …and ${skip} more in this bucket`);
    }
  }

  if (skipped > 0 && rowsRendered >= MAX_DETAIL_ROWS) {
    lines.push("", `_Showing the ${MAX_DETAIL_ROWS} most pressing — ${skipped} more in the queue._`);
  }

  lines.push("", link);
  return lines.join("\n");
}

/** The digest_runs.summary value, key for key as the standalone service writes it (digest.ts:387). */
export function digestClaimSummary(summary: DigestSummary): string {
  return JSON.stringify({ total: summary.total, urgent: summary.urgent, overdue48h: summary.overdue48h });
}

export type DigestCounts = { total: number; urgent: number; overdue48h: number };
export type DigestRunResult =
  | { sent: true; runDate: string; counts: DigestCounts }
  | { sent: false; reason: "already_posted" | "slack_skipped"; runDate: string; counts: DigestCounts }
  | { sent: false; reason: "post_failed"; code: string; runDate: string; counts: DigestCounts };

function logOutcome(runDate: string, outcome: string, total: number): void {
  // Counts and the date only: never the message text, names or request ids.
  console.info(JSON.stringify({ event: "trade_request_digest", runDate, outcome, total }));
}

/**
 * Claims the run date, then posts once. No retry: a failed post keeps the claim, so a later call the same date
 * returns already_posted (standalone behavior, digest.ts:377-398).
 */
export async function runDailyDigest(now: Date = new Date()): Promise<DigestRunResult> {
  const summary = await collectDigestSummary(now);
  const text = renderDigest(summary, now, AOA_DIGEST_LINKS);
  const runDate = summary.runDate;
  const counts: DigestCounts = { total: summary.total, urgent: summary.urgent, overdue48h: summary.overdue48h };

  const claimed = await prisma.$queryRaw<Array<{ run_date: string }>>`
    INSERT INTO trade_request.digest_runs (run_date, summary)
    VALUES (${runDate}::date, ${digestClaimSummary(summary)}::jsonb)
    ON CONFLICT (run_date) DO NOTHING
    RETURNING run_date::text AS run_date`;
  if (claimed.length === 0) {
    logOutcome(runDate, "already_posted", counts.total);
    return { sent: false, reason: "already_posted", runDate, counts };
  }

  const posted = await sendTradeRequestSlack("channel", text);
  logOutcome(runDate, posted.status, counts.total);
  if (posted.status === "sent") return { sent: true, runDate, counts };
  if (posted.status === "skipped") return { sent: false, reason: "slack_skipped", runDate, counts };
  return { sent: false, reason: "post_failed", code: posted.code, runDate, counts };
}
