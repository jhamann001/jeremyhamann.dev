// ticket: Build the daily-digest Slack payload from a snapshot of ACATs.
//
// Pure function — takes records + a clock and returns a SlackBlockMessage.
// The cron route fetches the records and posts the result; nothing
// here knows about Prisma, fetch, or env vars. This keeps the digest
// fully unit-testable and lets us tweak the format without touching
// the route.
//
// Content priorities (informed by what the now-deleted "Flag to CS
// Slack" button was trying to surface):
//   1. "Are we keeping up?"  — counts of active, aging, with-issues.
//   2. "What changed today?" — newly opened + newly completed in the
//      last 24h.
//   3. "Where's the pain?"   — top-5 stalest still-open transfers.
//
// Per-custodian aging (ticket) lands in a separate PR; until then
// the digest uses a single AGING_THRESHOLD_DAYS heuristic, which is
// the same threshold the dashboard used before that refactor.

import type { AcatRecord } from "./types";
import { ACAT_STATUS_LABELS, TERMINAL_STATUSES } from "./types";
import { getDaysOpen, getIssueCount } from "./acat-derivations";
import type { SlackBlockMessage } from "./slack-webhook";

// Mirrors the legacy dashboard threshold so the digest behavior is
// continuous with what ops was already eyeballing. PR1 (ticket)
// adds per-custodian SLAs; this constant will go away then.
export const AGING_THRESHOLD_DAYS = 7;

const TOP_N_STALEST = 5;

export interface DigestSnapshot {
  // Counts for the header line.
  active: number;
  completed: number;
  aging: number;
  withIssues: number;

  // Last-24h deltas — derived from acatDate (open) and apexCompletionDate (close).
  openedYesterday: AcatRecord[];
  completedYesterday: AcatRecord[];

  // Slowest still-open transfers, oldest first.
  stalest: AcatRecord[];
}

/**
 * Pre-compute every aggregate the digest formatter needs. Exposed
 * separately so the cron route can log the same numbers it posts,
 * and so the formatter is dumb (display only).
 */
export function buildDigestSnapshot(
  records: AcatRecord[],
  now: number
): DigestSnapshot {
  const dayAgo = now - 24 * 60 * 60 * 1000;

  const liveRecords = records.filter((r) => !r.deletedAt);

  const active: AcatRecord[] = [];
  const completed: AcatRecord[] = [];
  for (const r of liveRecords) {
    if (TERMINAL_STATUSES.has(r.status)) completed.push(r);
    else active.push(r);
  }

  const aging = active.filter(
    (r) => getDaysOpen(r, now) >= AGING_THRESHOLD_DAYS
  );
  const withIssues = active.filter((r) => getIssueCount(r) > 0);

  // "Opened in the last 24h" uses acatDate (the record's anchor
  // date) — originalClientRequestDate can pre-date the row creation
  // by weeks for backfills, so it's the wrong signal here.
  const openedYesterday = liveRecords.filter((r) => {
    const t = new Date(r.acatDate).getTime();
    return Number.isFinite(t) && t >= dayAgo && t <= now;
  });

  const completedYesterday = liveRecords.filter((r) => {
    if (!TERMINAL_STATUSES.has(r.status)) return false;
    const stamp = r.apexCompletionDate ?? r.lastUpdated;
    const t = new Date(stamp).getTime();
    return Number.isFinite(t) && t >= dayAgo && t <= now;
  });

  const stalest = [...active]
    .sort((a, b) => getDaysOpen(b, now) - getDaysOpen(a, now))
    .slice(0, TOP_N_STALEST);

  return {
    active: active.length,
    completed: completed.length,
    aging: aging.length,
    withIssues: withIssues.length,
    openedYesterday,
    completedYesterday,
    stalest,
  };
}

/**
 * Format the snapshot into a Slack Block Kit message. The fallback
 * `text` field is what shows up in notifications + the channel
 * sidebar, so it stays human-readable on its own.
 */
export function formatDigestMessage(
  snapshot: DigestSnapshot,
  now: number = Date.now()
): SlackBlockMessage {
  const date = new Date(now);
  const dateLabel = date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const summaryLine =
    `${snapshot.active} active · ` +
    `${snapshot.aging} aging (>${AGING_THRESHOLD_DAYS}d) · ` +
    `${snapshot.withIssues} with issues`;

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Transfer Tracker — Daily Status, ${dateLabel}`,
      },
    },
    {
      type: "section",
      fields: [
        mdField(`*Active*\n${snapshot.active}`),
        mdField(`*Aging (>${AGING_THRESHOLD_DAYS}d)*\n${snapshot.aging}`),
        mdField(`*With issues*\n${snapshot.withIssues}`),
        mdField(`*Finalized (total)*\n${snapshot.completed}`),
      ],
    },
  ];

  if (snapshot.openedYesterday.length > 0) {
    blocks.push(
      sectionBlock(
        `*Opened in the last 24h* (${snapshot.openedYesterday.length})\n` +
          snapshot.openedYesterday
            .slice(0, 10)
            .map((r) => `• ${escapeMd(r.clientName)} — ${ACAT_STATUS_LABELS[r.status] ?? r.status}`)
            .join("\n")
      )
    );
  }

  if (snapshot.completedYesterday.length > 0) {
    blocks.push(
      sectionBlock(
        `*Completed in the last 24h* (${snapshot.completedYesterday.length})\n` +
          snapshot.completedYesterday
            .slice(0, 10)
            .map((r) => `• ${escapeMd(r.clientName)}`)
            .join("\n")
      )
    );
  }

  if (snapshot.stalest.length > 0) {
    blocks.push(
      sectionBlock(
        `*Slowest open transfers*\n` +
          snapshot.stalest
            .map((r) => {
              const days = getDaysOpen(r, now);
              const contra = r.transferringContra
                ? ` from ${escapeMd(r.transferringContra)}`
                : "";
              return `• ${escapeMd(r.clientName)}${contra} — *${days}d* (${ACAT_STATUS_LABELS[r.status] ?? r.status})`;
            })
            .join("\n")
      )
    );
  }

  return {
    text: `Transfer Tracker daily status: ${summaryLine}`,
    blocks,
  };
}

function mdField(text: string) {
  return { type: "mrkdwn", text };
}

function sectionBlock(text: string) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

/**
 * Slack mrkdwn treats `<`, `>`, and `&` as special. Client names can
 * legitimately contain `&` (e.g. "Smith & Co. Trust"); escaping
 * keeps the message readable without surprises.
 */
function escapeMd(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
