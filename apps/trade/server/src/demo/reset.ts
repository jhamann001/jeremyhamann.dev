// The demo reset: put the database back to its starting state, then produce what the firm's scheduled
// jobs would have left behind. The jobs are not scheduled in the demo. Instead the reset runs the real
// drift check once per weekday for the past two weeks, and the daily digest once, against the stand-ins
// with their clock set to each day, so the drift history, alerts and digest always look current.
// Needs the stand-ins listening (startStandIns) and the demo configuration (.env.example's demo block).

import pool from '../db/pool.js';
import logger from '../lib/logger.js';
import { readSecret } from '../lib/secrets.js';
import { resetDemoData, type SeedSummary } from '../db/demoSeed.js';
import { runDriftCheck } from '../services/registryDriftRunner.js';
import { sendDailyDigest } from '../services/digest.js';
import { notifyNewRequest, notifyStatusChange } from '../services/slack.js';
import { setStandInDate, standInUniverse } from './standIns/feeds.js';

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 14;

// The firm's calendar: the drift check dates its runs by the New York day, and runs at 9:30 AM there.
const FIRM_TZ = 'America/New_York';
const firmDay = new Intl.DateTimeFormat('en-CA', { timeZone: FIRM_TZ });
const firmWeekday = new Intl.DateTimeFormat('en-US', { timeZone: FIRM_TZ, weekday: 'short' });
const firmHour = new Intl.DateTimeFormat('en-US', { timeZone: FIRM_TZ, hour: 'numeric', hourCycle: 'h23' });

const isFirmWeekday = (instant: Date) => !['Sat', 'Sun'].includes(firmWeekday.format(instant));

/** 9:30 AM New York time on the New York calendar day of `instant` (daylight saving included). */
export function firmMorning(instant: Date): Date {
  const guess = new Date(`${firmDay.format(instant)}T13:30:00Z`); // 9:30 AM during daylight saving
  return new Date(guess.getTime() + (9 - Number(firmHour.format(guess))) * 3_600_000);
}

export interface ResetSummary extends SeedSummary {
  driftRuns: number;
  digestSent: boolean;
  outboxMessages: number;
}

export async function resetDemo(now: Date = new Date()): Promise<ResetSummary> {
  const client = await pool.connect();
  let seed: SeedSummary;
  try {
    seed = await resetDemoData(client, standInUniverse(), now);
  } finally {
    client.release();
  }

  let driftRuns = 0;
  let digestSent = false;
  try {
    await replayRequestNotifications(now);
    // Oldest first, as the scheduler would have run them: 9:30 AM New York time on New York weekdays,
    // and today's run at reset time.
    for (let k = HISTORY_DAYS - 1; k >= 0; k--) {
      const day = new Date(now.getTime() - k * DAY_MS);
      if (!isFirmWeekday(day)) continue;
      const at = k === 0 ? now : firmMorning(day);
      setStandInDate(at);
      await runDriftCheck({ pool, now: at });
      driftRuns++;
    }
    setStandInDate(now);
    digestSent = (await sendDailyDigest(pool, now)).sent;
  } finally {
    setStandInDate(null);
  }

  const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox_messages');
  const summary = { ...seed, driftRuns, digestSent, outboxMessages: Number(rows[0].n) };
  logger.info({ event: 'demo_reset_complete', ...summary }, 'demo reset complete');
  return summary;
}

const outboxCount = async () => Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox_messages')).rows[0].n);

/**
 * The notifiers post fire-and-forget; wait until the stand-in has stored the message before moving the
 * clock. A message that never arrives costs one timestamp, not the drift history, so it is logged, not thrown.
 */
async function outboxReaches(count: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await outboxCount()) >= count) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  logger.warn({ event: 'demo_reset_replay_missing', expected: count }, 'a replayed notification did not reach the outbox in time');
}

/**
 * The seed writes requests straight to the database, so the Slack posts the app makes on submit and on a
 * status change never happened. Replay them for the last two days' requests, each at its own time.
 */
async function replayRequestNotifications(now: Date): Promise<void> {
  // Without Slack configured the notifiers post nothing, so there is nothing to replay.
  if (!readSecret('SLACK_BOT_TOKEN') || !readSecret('SLACK_CHANNEL_ID')) return;
  const { rows } = await pool.query<{
    id: string; client_name: string; trade_type: string; priority: string; total_value: string; selected_accounts: string[];
    advisor_notes: string | null; status: string; created_at: Date; updated_at: Date; advisor_name: string | null; slack_user_id: string | null;
  }>(
    `SELECT tr.id, tr.client_name, tr.trade_type, tr.priority, tr.total_value, tr.selected_accounts, tr.advisor_notes,
            tr.status, tr.created_at, tr.updated_at, u.name AS advisor_name, u.slack_user_id
       FROM trade_requests tr LEFT JOIN users u ON u.id = tr.advisor_id
      WHERE tr.created_at > $1 ORDER BY tr.created_at`,
    [new Date(now.getTime() - 2 * DAY_MS)],
  );
  const trader = (await pool.query<{ name: string }>(`SELECT name FROM users WHERE role = 'trader' ORDER BY name LIMIT 1`)).rows[0]?.name ?? 'Trader';
  let expected = await outboxCount();
  for (const r of rows) {
    setStandInDate(r.created_at);
    notifyNewRequest({
      requestId: r.id, clientName: r.client_name, tradeType: r.trade_type, priority: r.priority, submittedBy: r.advisor_name ?? 'Advisor',
      totalValue: Number(r.total_value), accounts: r.selected_accounts, advisorNotes: r.advisor_notes ?? undefined,
    });
    await outboxReaches(++expected);
    if (r.status !== 'Pending Review') {
      setStandInDate(r.updated_at);
      notifyStatusChange({ requestId: r.id, clientName: r.client_name, newStatus: r.status, note: '', changedBy: trader, advisorSlackId: r.slack_user_id });
      await outboxReaches(++expected);
    }
  }
}
