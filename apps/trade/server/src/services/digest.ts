import type { Pool } from 'pg';
import logger from '../lib/logger.js';
import { sendChannelMessage, sendDirectMessage, escapeSlack } from './slack.js';

const DIGEST_TZ = 'America/New_York';

/**
 * Statuses we consider "open" for digest purposes. Per product direction we
 * exclude only `Approved` and `Rejected` — everything else is surfaced, even
 * `Completed`, because the team wants visibility on recently-finished work
 * alongside what's still pending.
 */
const OPEN_STATUSES = ['Pending Review', 'Needs Info', 'Pending Current Asset Liquidation', 'Completed'] as const;
type OpenStatus = (typeof OPEN_STATUSES)[number];

const STATUS_SECTION_ORDER: OpenStatus[] = [
  'Pending Review',
  'Needs Info',
  'Pending Current Asset Liquidation',
  'Completed',
];

const STATUS_SECTION_LABEL: Record<OpenStatus, string> = {
  'Pending Review': 'Pending Review',
  'Needs Info': 'Needs Info',
  'Pending Current Asset Liquidation': 'Pending Liquidation',
  Completed: 'Completed',
};

/** Soft cap on the number of per-request rows we render. Anything beyond this
 * is summarised as "…and N more in the queue" so the Slack message stays
 * scannable. */
const MAX_DETAIL_ROWS = 10;

/** How far ahead we look for a "close" liquidity deadline. Deadlines within
 * this window are called out inline on the request row. */
const DEADLINE_SOON_DAYS = 7;

export interface OutstandingRequest {
  id: string;
  status: OpenStatus;
  tradeType: string;
  tradeAmount: string | null;
  totalValue: number | null;
  priority: 'Urgent' | 'Standard' | 'Low' | null;
  createdAt: Date;
  liquidityDeadline: string | null;
  clientNames: string[];
  /**
   * Name of the user who submitted the request (joined from `users.name` on
   * `trade_requests.advisor_id`). Surfaced in the digest because the digest
   * audience cares who to chase, not the (always-Rachel) advisor of record.
   */
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

interface OutstandingRow {
  id: string;
  status: string;
  trade_type: string;
  trade_amount: string | null;
  total_value: string | null;
  priority: string | null;
  created_at: string;
  liquidity_deadline: string | null;
  client_names: string[] | null;
  client_name: string | null;
  advisor_name: string | null;
  waiting_minutes: string;
}

/**
 * Compute the run_date as a YYYY-MM-DD string in America/New_York. We use
 * Intl.DateTimeFormat rather than toLocaleDateString so the format is stable
 * regardless of the server locale, and so DST transitions are handled by the
 * tz database rather than by the app.
 */
export function computeRunDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DIGEST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function primaryOrigin(): string {
  return (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
}

function queueLink(): string {
  return `${primaryOrigin()}/queue`;
}

function requestLink(id: string): string {
  return `${primaryOrigin()}/queue/${id}`;
}

function formatDateHeader(runDate: string): string {
  const [y, m, d] = runDate.split('-').map((v) => parseInt(v, 10));
  // Construct a UTC date at noon to avoid tz rollover when formatting.
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: DIGEST_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatAge(minutes: number | null): string {
  if (minutes == null) return 'n/a';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

/**
 * Format a dollar amount into a compact, human-friendly string.
 * Prefers numeric `total_value` over the free-text `trade_amount` column
 * (which may hold ranges like "100k-200k" that aren't parseable).
 */
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
  const clean = names.map((n) => (n ?? '').trim()).filter(Boolean);
  if (clean.length === 0) return '(client unknown)';
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} & ${clean[1]}`;
  return `${clean[0]} & ${clean.length - 1} others`;
}

/**
 * Returns a `deadline MMM D` label if the liquidity deadline is set and falls
 * within DEADLINE_SOON_DAYS from today in the digest timezone. Past-due
 * deadlines are flagged with `overdue` instead of a date so they stand out.
 */
function formatDeadline(isoDate: string | null, now: Date): string | null {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split('-').map((v) => parseInt(v, 10));
  if (!y || !m || !d) return null;
  // Deadline is a date, not a moment — compare date-only in the digest tz.
  const today = computeRunDate(now);
  const [ty, tm, td] = today.split('-').map((v) => parseInt(v, 10));
  const todayDays = Date.UTC(ty, tm - 1, td) / 86_400_000;
  const deadlineDays = Date.UTC(y, m - 1, d) / 86_400_000;
  const diff = deadlineDays - todayDays;
  if (diff < 0) return 'deadline overdue';
  if (diff > DEADLINE_SOON_DAYS) return null;
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: DIGEST_TZ,
    month: 'short',
    day: 'numeric',
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

function coercePriority(value: string | null): OutstandingRequest['priority'] {
  if (value === 'Urgent' || value === 'Standard' || value === 'Low') return value;
  return null;
}

function priorityRank(p: OutstandingRequest['priority']): number {
  if (p === 'Urgent') return 0;
  if (p === 'Standard') return 1;
  return 2;
}

export async function collectDigestSummary(pool: Pool, now: Date): Promise<DigestSummary> {
  const runDate = computeRunDate(now);

  const { rows } = await pool.query<OutstandingRow>(
    `
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
    FROM trade_requests tr
    LEFT JOIN users u ON u.id = tr.advisor_id
    WHERE tr.status = ANY($1::text[])
    ORDER BY tr.created_at ASC
    `,
    [OPEN_STATUSES as unknown as string[]],
  );

  const requests: OutstandingRequest[] = [];
  for (const r of rows) {
    const status = coerceStatus(r.status);
    if (!status) continue;
    const waitingMinutes = parseInt(r.waiting_minutes, 10);
    const clientNames =
      Array.isArray(r.client_names) && r.client_names.length > 0
        ? r.client_names
        : r.client_name
          ? [r.client_name]
          : [];
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
    if (req.priority === 'Urgent') urgent += 1;
    if (req.waitingMinutes > 48 * 60) overdue48h += 1;
    if (oldestWaitingMinutes == null || req.waitingMinutes > oldestWaitingMinutes) {
      oldestWaitingMinutes = req.waitingMinutes;
    }
  }

  // Sort each bucket: urgent first, then oldest first.
  for (const key of Object.keys(byStatus) as OpenStatus[]) {
    byStatus[key]!.sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return b.waitingMinutes - a.waitingMinutes;
    });
  }

  return {
    runDate,
    total: requests.length,
    urgent,
    overdue48h,
    oldestWaitingMinutes,
    byStatus,
  };
}

function renderRequestRow(req: OutstandingRequest, now: Date): string[] {
  const url = requestLink(req.id);
  const money = formatMoney(req.totalValue, req.tradeAmount);

  const topParts: string[] = [`<${url}|${escapeSlack(req.id)}>`, escapeSlack(req.tradeType)];
  if (money) topParts.push(escapeSlack(money));
  topParts.push(escapeSlack(formatClientNames(req.clientNames)));

  const bottomParts: string[] = [];
  if (req.submittedByName) bottomParts.push(escapeSlack(req.submittedByName));
  bottomParts.push(formatAge(req.waitingMinutes));
  if (req.priority === 'Urgent') bottomParts.push('🚨 Urgent');
  const deadline = formatDeadline(req.liquidityDeadline, now);
  if (deadline) bottomParts.push(escapeSlack(deadline));

  return [`• ${topParts.join(' · ')}`, `   ${bottomParts.join(' · ')}`];
}

export function renderDigest(summary: DigestSummary, now: Date = new Date()): string {
  const header = `*Trade Request — Daily Digest* — ${escapeSlack(formatDateHeader(summary.runDate))}`;
  const link = `<${queueLink()}|Open the queue →>`;

  if (summary.total === 0) {
    return [header, '', 'All clear — no open requests on the queue.', '', link].join('\n');
  }

  const lines: string[] = [header];

  const summaryBits: string[] = [`${summary.total} open request${summary.total === 1 ? '' : 's'}`];
  if (summary.urgent > 0) summaryBits.push(`${summary.urgent} urgent`);
  if (summary.overdue48h > 0) summaryBits.push(`${summary.overdue48h} waiting > 48h`);
  if (summary.oldestWaitingMinutes != null) {
    summaryBits.push(`oldest ${formatAge(summary.oldestWaitingMinutes)}`);
  }
  lines.push(summaryBits.join(' · '));

  // Walk sections in priority order, rendering up to MAX_DETAIL_ROWS rows total.
  let rowsRendered = 0;
  let skipped = 0;
  for (const status of STATUS_SECTION_ORDER) {
    const bucket = summary.byStatus[status];
    if (!bucket || bucket.length === 0) continue;

    lines.push('', `*${STATUS_SECTION_LABEL[status]} (${bucket.length})*`);

    const remaining = Math.max(0, MAX_DETAIL_ROWS - rowsRendered);
    const show = bucket.slice(0, remaining);
    const skip = bucket.length - show.length;

    for (const req of show) {
      lines.push(...renderRequestRow(req, now));
    }
    rowsRendered += show.length;
    skipped += skip;

    if (skip > 0) {
      lines.push(`   …and ${skip} more in this bucket`);
    }
  }

  if (skipped > 0 && rowsRendered >= MAX_DETAIL_ROWS) {
    lines.push('', `_Showing the ${MAX_DETAIL_ROWS} most pressing — ${skipped} more in the queue._`);
  }

  lines.push('', link);
  return lines.join('\n');
}

export async function buildDailyDigest(
  pool: Pool,
  now: Date = new Date(),
): Promise<{ text: string; summary: DigestSummary }> {
  const summary = await collectDigestSummary(pool, now);
  const text = renderDigest(summary, now);
  return { text, summary };
}

export type SendDailyDigestResult =
  { sent: true; summary: DigestSummary } | { sent: false; summary: DigestSummary; reason: 'already_posted' };

export async function sendDailyDigest(pool: Pool, now: Date = new Date()): Promise<SendDailyDigestResult> {
  const { text, summary } = await buildDailyDigest(pool, now);

  // Idempotency: only post if we successfully insert a row for today's date.
  // ON CONFLICT DO NOTHING means a retry the same local day is a no-op.
  const { rows } = await pool.query<{ run_date: string }>(
    `INSERT INTO digest_runs (run_date, summary)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (run_date) DO NOTHING
     RETURNING run_date`,
    [summary.runDate, JSON.stringify({ total: summary.total, urgent: summary.urgent, overdue48h: summary.overdue48h })],
  );

  if (rows.length === 0) {
    logger.info({ runDate: summary.runDate }, 'Daily digest already posted today — skipping');
    return { sent: false, summary, reason: 'already_posted' };
  }

  await sendChannelMessage(text);
  logger.info({ runDate: summary.runDate, total: summary.total }, 'Daily digest posted to Slack');
  return { sent: true, summary };
}

/**
 * One-shot test delivery: renders today's digest with live data and sends it
 * to a caller-supplied Slack target (channel ID or user ID) without touching
 * the idempotency table. Used for reviewing copy against production data.
 */
export async function sendDigestToTarget(
  pool: Pool,
  target: string,
  now: Date = new Date(),
): Promise<{ sent: boolean; summary: DigestSummary; target: string }> {
  const { text, summary } = await buildDailyDigest(pool, now);
  await sendDirectMessage(target, text);
  logger.info({ target, total: summary.total }, 'Digest test-send delivered');
  return { sent: true, summary, target };
}
