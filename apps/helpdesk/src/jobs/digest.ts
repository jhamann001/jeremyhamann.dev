/**
 * Daily notification digest — node only (§15's job table).
 *
 * One PII-light summary per person, once a firm day, through the channels that person has switched
 * on: counts by kind, the WM numbers, and the deep links. **No subjects, no requesters, no body
 * text** — a digest is a nudge to open the inbox, not a substitute for reading it, and it
 * arrives on a channel the desk does not control. Every literal word lives in
 * `src/server/notifications-templates.ts` with a DRAFT copy in the build record.
 *
 * THE HOUR IS A GUARD, NOT A SCHEDULER. Nothing in this process runs on a clock (`src/jobs/run.ts`);
 * Cloud Scheduler decides when. `DIGEST_HOUR_LOCAL` (firm time, default 8) is what makes an HOURLY
 * schedule produce exactly one digest a day and makes a retry inside the same hour a no-op rather
 * than a second message. `force` exists for a deliberate manual run and for the tests.
 *
 * DISABLED UNLESS A CHANNEL IS CONFIGURED. With `SLACK_USER_MAP` unset and no VAPID keys — the state
 * of every environment on this branch — every user resolves to zero channels, the job reports
 * `sent: 0` and exits 0. That is the acceptance criterion, not a limitation (CONTRACT §0 rule 4).
 */
import type { JobContext, JobOutcome } from "@/jobs/types";
import type { NotificationKind } from "@/types/domain";
import { NOTIFICATION_KINDS } from "@/types/domain";
import { prisma } from "@/lib/db";
import { env, isWebPushEnabled } from "@/lib/env";
import { firmWallClock } from "@/lib/firm-time";
import { appBaseUrl, ticketDeepLink } from "@/jobs/slack";
import { sendWebPush } from "@/server/notifications-push";
import { readNotificationPrefs } from "@/server/notifications";
import { dispatchPending, isSlackDmEnabled, sendSlackDm, slackUserMap } from "@/server/notifications-dispatch";
import { DIGEST_MAX_TICKETS, digestMessage } from "@/server/notifications-templates";

/** Firm-local hour the digest goes out when `DIGEST_HOUR_LOCAL` is unset (contract §4). */
export const DIGEST_HOUR_DEFAULT = 8;

/** How far back "unread" reaches. One firm day, so a digest never repeats yesterday's headline. */
export const DIGEST_WINDOW_MS = 24 * 60 * 60_000;

/** Never DM a hundred lines: beyond this the message says how many and points at the inbox. */
export const DIGEST_MAX_USERS = 500;

export type DigestResult = { sent: number; skipped: number };

/** `DIGEST_HOUR_LOCAL`, or the default. Pure, so the guard is testable without the environment. */
export function digestHour(configured: number | undefined): number {
  return configured === undefined ? DIGEST_HOUR_DEFAULT : configured;
}

/** Whether `now` falls in the digest hour on the FIRM clock. An unreadable instant is never the hour. */
export function isDigestHour(now: Date, hour: number): boolean {
  const wc = firmWallClock(now);
  return wc !== null && wc.hour === hour;
}

type Pending = {
  userId: string;
  email: string;
  prefsRaw: unknown;
  outOfOfficeUntil: Date | null;
  rows: Array<{ kind: NotificationKind; ticketNumber: number | null }>;
};

/**
 * Everyone with unread, undismissed notifications inside the window, with just enough of each row
 * to count it and name its ticket. Bounded by `DIGEST_MAX_USERS` so one bad day cannot turn a
 * five-minute job into an unbounded one.
 */
async function loadPending(since: Date): Promise<Pending[]> {
  const rows = await prisma.notification.findMany({
    where: { createdAt: { gte: since }, readAt: null, dismissedAt: null },
    select: {
      kind: true,
      ticket: { select: { number: true } },
      user: { select: { id: true, email: true, isActive: true, notificationPrefs: true, outOfOfficeUntil: true } },
    },
    orderBy: [{ createdAt: "asc" }],
  });

  const byUser = new Map<string, Pending>();
  for (const row of rows) {
    if (!row.user.isActive) continue;
    let entry = byUser.get(row.user.id);
    if (entry === undefined) {
      if (byUser.size >= DIGEST_MAX_USERS) continue;
      entry = {
        userId: row.user.id,
        email: row.user.email,
        prefsRaw: row.user.notificationPrefs,
        outOfOfficeUntil: row.user.outOfOfficeUntil,
        rows: [],
      };
      byUser.set(row.user.id, entry);
    }
    entry.rows.push({ kind: row.kind, ticketNumber: row.ticket?.number ?? null });
  }
  return [...byUser.values()];
}

/** Counts per kind in `NOTIFICATION_KINDS` order, zero-count kinds dropped. */
export function countByKind(
  rows: ReadonlyArray<{ kind: NotificationKind }>,
): Array<{ kind: NotificationKind; count: number }> {
  const counts = new Map<NotificationKind, number>();
  for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  return NOTIFICATION_KINDS.filter((k) => counts.has(k)).map((k) => ({ kind: k, count: counts.get(k) ?? 0 }));
}

/** Distinct WM numbers, in first-seen order, capped at `DIGEST_MAX_TICKETS`. */
export function digestTicketNumbers(rows: ReadonlyArray<{ ticketNumber: number | null }>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const r of rows) {
    if (r.ticketNumber === null || seen.has(r.ticketNumber)) continue;
    seen.add(r.ticketNumber);
    out.push(r.ticketNumber);
    if (out.length >= DIGEST_MAX_TICKETS) break;
  }
  return out;
}

export type RunDigestOptions = {
  now?: Date;
  /** Skip the firm-hour guard. For a deliberate manual run and for the tests — never for a schedule. */
  force?: boolean;
};

/**
 * Composes and sends the digest.
 *
 * `dispatchPending` is drained FIRST, on purpose: a notification that is about to be DM'd and also
 * about to be summarised would reach the same person twice in the same minute, and draining first
 * means the per-item DM wins and the digest covers what is genuinely still unread.
 *
 * The drain is NOT this job's only reason to exist any more: integration round 1 registered
 * `notification-dispatch` in `src/jobs/{types,run}.ts`, so the fan-out has its own entry point and no
 * longer depends on the digest window. Draining here as well is deliberate and costs nothing —
 * `dispatchPending` is idempotent — and it keeps the ordering guarantee above true on a desk where
 * the dispatch job has no Cloud Scheduler entry yet.
 */
export async function runDigest(options: RunDigestOptions = {}): Promise<DigestResult> {
  const now = options.now ?? new Date();
  const hour = digestHour(env.DIGEST_HOUR_LOCAL);
  if (options.force !== true && !isDigestHour(now, hour)) return { sent: 0, skipped: 0 };

  await dispatchPending();

  const map = slackUserMap(env.SLACK_USER_MAP);
  const slackReady = isSlackDmEnabled(map);
  const pushReady = isWebPushEnabled(env);
  const base = appBaseUrl();
  const inboxLink = base === undefined ? null : ticketDeepLinkToInbox(base);

  // Nothing is configured: every send would return "disabled", so say so once instead of walking
  // every user to discover it eight hundred times.
  if (!slackReady && !pushReady) return { sent: 0, skipped: 0 };

  const pending = await loadPending(new Date(now.getTime() - DIGEST_WINDOW_MS));
  let sent = 0;
  let skipped = 0;

  for (const person of pending) {
    const prefs = readNotificationPrefs(person.prefsRaw);
    const outOfOffice = person.outOfOfficeUntil !== null && person.outOfOfficeUntil.getTime() > now.getTime();
    if (!prefs.digest || (outOfOffice && prefs.muteWhileOutOfOffice)) {
      skipped += 1;
      continue;
    }

    const memberId = map.get(person.email.trim().toLowerCase());
    const subscriptions = pushReady
      ? await prisma.pushSubscription.findMany({
          where: { userId: person.userId },
          select: { endpoint: true, p256dh: true, auth: true },
        })
      : [];
    if ((memberId === undefined || !slackReady) && subscriptions.length === 0) {
      skipped += 1;
      continue;
    }

    const byKind = countByKind(person.rows);
    const tickets = digestTicketNumbers(person.rows).map((number) => ({
      number,
      link: base === undefined ? null : ticketDeepLink(number, base),
    }));
    const text = digestMessage({ unread: person.rows.length, byKind, tickets, inboxLink });

    let delivered = false;
    if (slackReady && memberId !== undefined) {
      delivered = (await sendSlackDm(memberId, text)) === "sent";
    }
    for (const sub of subscriptions) {
      const result = await sendWebPush(sub, {
        title: "WM Help Desk",
        body: person.rows.length === 1 ? "1 unread notification" : `${person.rows.length} unread notifications`,
        url: "/inbox",
        tag: "wmhd-digest",
      });
      if (result === "sent") delivered = true;
    }

    if (delivered) sent += 1;
    else skipped += 1;
  }

  return { sent, skipped };
}

/** `/inbox` on the app's own origin, or null when the origin is unknown. */
function ticketDeepLinkToInbox(base: string): string | null {
  try {
    return new URL("/inbox", base).toString();
  } catch {
    return null;
  }
}

/** The `JobHandler` body B4 registers under the contract job name `digest`. */
export async function runDigestJob(job: JobContext): Promise<JobOutcome> {
  const result = await runDigest({ now: job.now });
  job.log.info("digest", { ...result });
  return { processed: result.sent + result.skipped, skipped: result.skipped, posted: result.sent };
}
