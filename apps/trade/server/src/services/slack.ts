import { WebClient } from '@slack/web-api';
import logger from '../lib/logger.js';
import { readSecret } from '../lib/secrets.js';
import { messagesAllowed } from './serviceModeState.js';

const token = readSecret('SLACK_BOT_TOKEN');
const channelId = readSecret('SLACK_CHANNEL_ID');
const driftChannelId = readSecret('DRIFT_SLACK_CHANNEL_ID');

// SLACK_API_URL points the client at another Web API base URL (the demo's stand-in); unset means slack.com.
const slackApiUrl = process.env.SLACK_API_URL;
const client = token ? new WebClient(token, slackApiUrl ? { slackApiUrl } : {}) : null;

if (token && !channelId) {
  logger.warn(
    'SLACK_BOT_TOKEN is set but SLACK_CHANNEL_ID is missing — channel notifications will be silently dropped',
  );
}

if (token && !driftChannelId) {
  logger.warn(
    'SLACK_BOT_TOKEN is set but DRIFT_SLACK_CHANNEL_ID is missing — registry drift alerts will be silently dropped',
  );
}

function isEnabled(): boolean {
  return client !== null;
}

export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function postWithRetry(fn: () => Promise<unknown>, context: string): Promise<void> {
  if (!messagesAllowed()) {
    logger.info({ event: 'slack_send_suppressed' }, 'Slack send skipped: service is not active');
    return;
  }
  try {
    await fn();
  } catch (err) {
    logger.warn({ err }, `Slack ${context} failed, retrying once`);
    try {
      await new Promise((r) => setTimeout(r, 1000));
      await fn();
    } catch (retryErr) {
      logger.error({ err: retryErr }, `Slack ${context} retry failed — notification lost`);
      throw retryErr;
    }
  }
}

async function postFireAndForget(fn: () => Promise<unknown>, context: string): Promise<void> {
  postWithRetry(fn, context).catch(() => {});
}

export async function sendChannelMessage(text: string): Promise<void> {
  if (!isEnabled()) return;
  if (!channelId) throw new Error('SLACK_CHANNEL_ID is not configured');
  await postWithRetry(() => client!.chat.postMessage({ channel: channelId, text, mrkdwn: true }), 'channel message');
}

export async function sendDirectMessage(slackUserId: string, text: string): Promise<void> {
  if (!isEnabled() || !slackUserId) return;
  await postWithRetry(
    () => client!.chat.postMessage({ channel: slackUserId, text, mrkdwn: true }),
    `DM to ${slackUserId}`,
  );
}

/**
 * Post a message to the dedicated registry-drift channel. Resolved at module
 * init from `DRIFT_SLACK_CHANNEL_ID` (Secret Manager mount in production,
 * env var locally). No-op when `SLACK_BOT_TOKEN` is unset or
 * `DRIFT_SLACK_CHANNEL_ID` is missing — matches the existing
 * `sendChannelMessage` failure-soft behavior so a missing channel ID never
 * breaks the nightly job, only mutes the alert.
 */
export async function sendDriftChannelMessage(text: string): Promise<void> {
  if (!isEnabled() || !driftChannelId) return;
  await postWithRetry(
    () => client!.chat.postMessage({ channel: driftChannelId, text, mrkdwn: true }),
    'drift channel message',
  );
}

// ─── Pre-built message helpers ──────────────────────────────────────────────

interface NewRequestInfo {
  requestId: string;
  clientName: string;
  clientNames?: string[];
  tradeType: string;
  priority: string;
  submittedBy: string;
  totalValue: number;
  accounts: string[];
  advisorNotes?: string;
}

export function notifyNewRequest(info: NewRequestInfo): void {
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(info.totalValue);

  const clientLabel =
    info.clientNames && info.clientNames.length > 1
      ? info.clientNames.map((n) => escapeSlack(n)).join(', ')
      : escapeSlack(info.clientName);

  const lines = [
    `*New Trade Request* \`${escapeSlack(info.requestId)}\``,
    `Client: *${clientLabel}* | Type: ${escapeSlack(info.tradeType)} | Priority: ${escapeSlack(info.priority)}`,
    `Accounts: ${info.accounts.map((a) => `\`${escapeSlack(a)}\``).join(', ')}`,
    `Submitted by: ${escapeSlack(info.submittedBy)} | Value: ${formatted}`,
  ];

  if (info.advisorNotes) {
    lines.push(`Notes: ${escapeSlack(info.advisorNotes)}`);
  }

  const appUrl = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim();
  lines.push(`View request: ${appUrl}/queue/${info.requestId}`);

  const text = lines.join('\n');

  if (!isEnabled() || !channelId) return;
  postFireAndForget(() => client!.chat.postMessage({ channel: channelId, text, mrkdwn: true }), 'channel message');
}

interface ExclusionChangeInfo {
  clientId: string;
  clientName: string;
  ticker: string;
  kind: 'advisor' | 'client';
  /** Original reason captured before delete; empty string allowed. */
  reason: string;
  /** v3.4 — explicit DNB / DNS side flags. */
  noBuy: boolean;
  noSell: boolean;
  action: 'added' | 'removed';
  changedBy: string;
}

/**
 * v3.4 — render the DNB/DNS abbreviation pair. Mirrors the `formatSide`
 * helper in `routes/exclusions.ts`; both must stay in sync. A row where
 * both flags are false would be `''` here, but the route's Zod schema +
 * the DB CHECK constraint prevent that state from ever reaching this code.
 */
function formatSide(noBuy: boolean, noSell: boolean): string {
  if (noBuy && noSell) return 'DNB+DNS';
  if (noBuy) return 'DNB';
  return 'DNS';
}

export function notifyExclusionChange(info: ExclusionChangeInfo): void {
  const lines = [
    `*Exclusion ${info.action}* for *${escapeSlack(info.clientName)}*`,
    `Ticker: \`${escapeSlack(info.ticker)}\` | Kind: ${info.kind} | Side: ${formatSide(info.noBuy, info.noSell)}`,
  ];
  if (info.reason) {
    lines.push(`Reason: ${escapeSlack(info.reason)}`);
  }
  lines.push(`Changed by: ${escapeSlack(info.changedBy)}`);
  const text = lines.join('\n');

  if (!isEnabled() || !channelId) return;
  postFireAndForget(() => client!.chat.postMessage({ channel: channelId, text, mrkdwn: true }), 'exclusion change');
}

interface ExclusionBatchEntry {
  ticker: string;
  kind: 'advisor' | 'client';
  reason: string;
  noBuy: boolean;
  noSell: boolean;
}

interface ExclusionBatchChangeEntry {
  ticker: string;
  kind: 'advisor' | 'client';
  before: { noBuy: boolean; noSell: boolean };
  after: { noBuy: boolean; noSell: boolean };
}

interface ExclusionBatchInfo {
  clientId: string;
  clientName: string;
  added: ExclusionBatchEntry[];
  removed: ExclusionBatchEntry[];
  /**
   * v3.4 — inline flag-only edits (DNB↔DNS or DNB+DNS↔one side). Renders
   * as a separate "Changed:" section with the before→after transition.
   * No-op edits (after == before) are filtered out by the route before
   * this helper is called.
   */
  changed: ExclusionBatchChangeEntry[];
  changedBy: string;
}

/**
 * One Slack message per batch Apply — the v3.3 replacement for firing one
 * `notifyExclusionChange` per ticker. Collapses an entire add/remove/edit
 * transaction into a single summary post in #trading-notifications.
 *
 * Header adapts to the shape of the batch. v3.4 extends the header logic
 * to recognize edit-only and mixed batches.
 *
 * Empty batches are a no-op — the route guards them out earlier but this is
 * a cheap second line of defense.
 */
export function notifyExclusionBatchChange(info: ExclusionBatchInfo): void {
  const addedCount = info.added.length;
  const removedCount = info.removed.length;
  const changedCount = info.changed.length;
  const totalCount = addedCount + removedCount + changedCount;
  if (totalCount === 0) return;

  // Count distinct buckets that contributed to this batch — drives whether
  // the header is a single-bucket-specific phrase or the generic "N exclusions
  // updated" form.
  const buckets = (addedCount > 0 ? 1 : 0) + (removedCount > 0 ? 1 : 0) + (changedCount > 0 ? 1 : 0);

  let header: string;
  if (buckets > 1) {
    header = `*${totalCount} exclusions updated* for *${escapeSlack(info.clientName)}*`;
  } else if (addedCount > 0) {
    header =
      addedCount === 1
        ? `*Exclusion added* for *${escapeSlack(info.clientName)}*`
        : `*${addedCount} exclusions added* for *${escapeSlack(info.clientName)}*`;
  } else if (removedCount > 0) {
    header =
      removedCount === 1
        ? `*Exclusion removed* for *${escapeSlack(info.clientName)}*`
        : `*${removedCount} exclusions removed* for *${escapeSlack(info.clientName)}*`;
  } else {
    header =
      changedCount === 1
        ? `*Exclusion updated* for *${escapeSlack(info.clientName)}*`
        : `*${changedCount} exclusions updated* for *${escapeSlack(info.clientName)}*`;
  }

  const lines: string[] = [header];
  const renderRow = (e: ExclusionBatchEntry): string =>
    `- \`${escapeSlack(e.ticker)}\` (${e.kind}, ${formatSide(e.noBuy, e.noSell)})${
      e.reason ? ` — ${escapeSlack(e.reason)}` : ''
    }`;
  const renderChangeRow = (e: ExclusionBatchChangeEntry): string =>
    `- \`${escapeSlack(e.ticker)}\` (${e.kind}): ${formatSide(e.before.noBuy, e.before.noSell)} → ${formatSide(
      e.after.noBuy,
      e.after.noSell,
    )}`;

  if (addedCount > 0) {
    lines.push('Added:');
    for (const entry of info.added) lines.push(renderRow(entry));
  }
  if (removedCount > 0) {
    lines.push('Removed:');
    for (const entry of info.removed) lines.push(renderRow(entry));
  }
  if (changedCount > 0) {
    lines.push('Changed:');
    for (const entry of info.changed) lines.push(renderChangeRow(entry));
  }
  lines.push(`Changed by: ${escapeSlack(info.changedBy)}`);

  const text = lines.join('\n');
  if (!isEnabled() || !channelId) return;
  postFireAndForget(
    () => client!.chat.postMessage({ channel: channelId, text, mrkdwn: true }),
    'exclusion batch change',
  );
}

interface StatusChangeInfo {
  requestId: string;
  clientName: string;
  newStatus: string;
  note: string;
  changedBy: string;
  advisorSlackId: string | null;
}

export function notifyStatusChange(info: StatusChangeInfo): void {
  const lines = [
    `Request \`${escapeSlack(info.requestId)}\` for *${escapeSlack(info.clientName)}* updated to: *${escapeSlack(info.newStatus)}*`,
    `Note: ${info.note ? escapeSlack(info.note) : 'No additional notes'}`,
    `Updated by: ${escapeSlack(info.changedBy)}`,
  ];

  if (info.newStatus === 'Needs Info') {
    const appUrl = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim();
    lines.push('', `Please review and edit your request: ${appUrl}/edit/${info.requestId}`);
  }

  const text = lines.join('\n');

  if (!isEnabled()) return;
  if (info.advisorSlackId) {
    postFireAndForget(
      () => client!.chat.postMessage({ channel: info.advisorSlackId!, text, mrkdwn: true }),
      `DM to ${info.advisorSlackId}`,
    );
  } else if (channelId) {
    postFireAndForget(() => client!.chat.postMessage({ channel: channelId, text, mrkdwn: true }), 'channel message');
  }
}
