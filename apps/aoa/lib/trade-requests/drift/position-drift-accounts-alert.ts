import type { Pool } from '@/lib/trade-requests/pg-compat';
import logger from '@/lib/trade-requests/log';
import { sendDriftChannelMessage } from '@/lib/trade-requests/drift/slack';
import { DRIFT_DASHBOARD_ORIGIN } from '@/lib/trade-requests/drift/targets';
import { DRIFT_ALLOW_LIST_NAMES } from '@/lib/trade-requests/drift/registry-drift-allow-list';
import type { AccountDriftResult } from '@/lib/trade-requests/drift/position-drift-accounts';

/**
 * v2 per-account Slack renderer — "compact" format (advisor-approved 2026-06).
 *
 * One scannable message: a one-line headline (count + worst Δ), the 5 worst
 * accounts in an aligned code block, a "…and N more" overflow, a link to the
 * /drift dashboard, and a single trailing line for the secondary cohorts
 * (uninvested + accounts with no model). The dashboard is the source of
 * truth; Slack is the nudge, so we deliberately cap the per-account list.
 *
 * Gated on `DRIFT_ALERTS_ENABLED` (same env var as v1). When off, emits an
 * `account_drift_alert_suppressed` info log and returns `{ sent: false }`.
 */

/** How many of the worst accounts to list inline before collapsing to "…and N more". */
const TOP_N = 5;

export interface AccountDriftAlertInput {
  accounts: readonly AccountDriftResult[];
  runDateLocal: string;
  /**
   * App DB pool. Used to claim `drift_alert_sends(run_date_local)` so the daily
   * report posts exactly once per run date — the run that wins the INSERT sends;
   * re-runs / retries / manual triggers see the conflict and skip. (Replaces the
   * old "rows freshly inserted this run" gate, which mis-fired to silence.)
   */
  pool: Pool;
  /** ticket: replaces DRIFT_ALERTS_ENABLED. False in shadow mode and whenever AOA is not the drift sender. */
  send: () => Promise<boolean>;
}

export interface AccountDriftAlertResult {
  sent: boolean;
  /** Apex account IDs that contributed to the alert (post allow-list filter). */
  alertingAccountIds: string[];
  /** Apex account IDs suppressed because the household name is in the allow-list. */
  suppressedAllowListed: string[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-06-09" → "Jun 9". Falls back to the raw string if it doesn't parse. */
function shortDate(runDateLocal: string): string {
  const m = runDateLocal.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return runDateLocal;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[3])}`;
}

/** Truncate with an ellipsis so columns stay aligned in the code block. */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * Collapse a legal account title into something scannable. Apex titles look
 * like "<client names> - <registration>", and the registration is often
 * noise ("Joint Brokerage Tenants With Right Of Survivorship"). Keep the
 * names verbatim and abbreviate the registration to a short, human label.
 */
export function shortAccountLabel(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return '(no title)';
  const sep = trimmed.indexOf(' - ');
  if (sep === -1) return trimmed;
  const name = trimmed.slice(0, sep).trim();
  const typeRaw = trimmed
    .slice(sep + 3)
    .trim()
    .toLowerCase();

  let type: string;
  if (typeRaw.includes('inherited')) type = 'Inherited IRA';
  else if (typeRaw.includes('roth')) type = 'Roth IRA';
  else if (typeRaw.includes('traditional')) type = 'Trad IRA';
  else if (typeRaw.includes('sep')) type = 'SEP IRA';
  else if (typeRaw.includes('joint')) type = 'Joint';
  else if (typeRaw.includes('trust')) type = 'Trust';
  else if (typeRaw.includes('brokerage')) type = 'Brokerage';
  else {
    // Unknown registration: clean underscores, title-case, keep it short.
    type = typeRaw
      .replace(/_/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    type = clip(type, 14);
  }
  return `${name} — ${type}`;
}

function buildMessage(input: {
  runDateLocal: string;
  accounts: readonly AccountDriftResult[];
  visible: readonly AccountDriftResult[]; // out-of-tolerance, allow-list-filtered, sorted desc
}): string {
  const { runDateLocal, accounts, visible } = input;

  const managedTotal = accounts.filter((a) => !a.unmapped).length;
  const uninvested = accounts.filter((a) => a.status === 'uninvested').length;
  const noModelTotal = accounts.filter((a) => a.status === 'no_template').length;
  const noModelUnmapped = accounts.filter((a) => a.status === 'no_template' && a.unmapped).length;
  const worst = visible[0]?.maxBucketDeltaPct ?? 0;

  const appUrl = DRIFT_DASHBOARD_ORIGIN;

  const lines: string[] = [
    `🟠  *Drift report* · ${shortDate(runDateLocal)}`,
    `*${visible.length}* of ${managedTotal} accounts out of tolerance · worst is *${worst.toFixed(1)}%* off target`,
  ];

  // Aligned table of the worst TOP_N, with a "% off" column header so the
  // number is self-explanatory (it's how far the most-drifted sleeve sits
  // from its model target, in percentage points). No Slack escaping inside a
  // code block — backtick fences render literally, so "&" must stay "&".
  const top = visible.slice(0, TOP_N);
  if (top.length > 0) {
    const header = ` ${'% off'.padStart(6)}  ${padEnd('account', 34)}  household`;
    const tableLines = top.map((a) => {
      const pct = `${(a.maxBucketDeltaPct ?? 0).toFixed(1)}%`.padStart(6);
      const label = padEnd(clip(shortAccountLabel(a.accountTitle), 34), 34);
      const household = clip(a.household?.trim() ? a.household : 'unmapped', 20);
      return ` ${pct}  ${label}  ${household}`;
    });
    if (visible.length > TOP_N) {
      tableLines.push(` …and ${visible.length - TOP_N} more`);
    }
    lines.push('```', header, ...tableLines, '```');
  }

  lines.push(`📋  Full list → <${appUrl}/trade-requests/drift|drift dashboard>`);

  const alsoParts: string[] = [];
  if (uninvested > 0) alsoParts.push(`${uninvested} uninvested`);
  if (noModelTotal > 0) {
    const suffix = noModelUnmapped > 0 ? ` (${noModelUnmapped} not yet in Meridian)` : '';
    alsoParts.push(`${noModelTotal} accounts have no model${suffix}`);
  }
  if (alsoParts.length > 0) {
    lines.push(`_Also: ${alsoParts.join(' · ')}_`);
  }

  return lines.join('\n');
}

export async function postAccountDriftAlert(input: AccountDriftAlertInput): Promise<AccountDriftAlertResult> {
  // Out-of-tolerance, mapped accounts, worst-first. Unmapped/no_template rows
  // have no template to drift against, so they're never "out" — they surface
  // in the trailing "Also:" line instead.
  const outMapped = input.accounts
    .filter((a) => a.status === 'out' && !a.unmapped)
    .slice()
    .sort((a, b) => (b.maxBucketDeltaPct ?? 0) - (a.maxBucketDeltaPct ?? 0));

  const suppressedAllowListed = outMapped
    .filter((a) => DRIFT_ALLOW_LIST_NAMES.has(a.household))
    .map((a) => a.accountId);

  const visible = outMapped.filter((a) => !DRIFT_ALLOW_LIST_NAMES.has(a.household));
  const noOp = (): AccountDriftAlertResult => ({ sent: false, alertingAccountIds: [], suppressedAllowListed });

  if (!(await input.send())) {
    logger.info(
      {
        event: 'account_drift_alert_suppressed',
        runDateLocal: input.runDateLocal,
        reason: 'DRIFT_ALERTS_ENABLED!=true',
        outCount: visible.length,
        suppressedAllowListed: suppressedAllowListed.length,
      },
      'account drift alert suppressed (shadow mode)',
    );
    return noOp();
  }

  if (visible.length === 0) {
    // Nothing actionable this run — do NOT claim the date, so a later run that
    // surfaces a real breach can still post today.
    logger.info(
      { event: 'account_drift_alert_clean', runDateLocal: input.runDateLocal },
      'account drift alert skipped (no out-of-tolerance, non-allow-listed accounts)',
    );
    return noOp();
  }

  // Send-once-per-day claim: the run that wins this INSERT posts; concurrent or
  // later runs (retries, manual triggers, tomorrow's first run) see the conflict
  // and skip. Robust to whatever the persistence layer did with row inserts.
  let claimed: boolean;
  try {
    const { rows } = await input.pool.query(
      `INSERT INTO trade_request.drift_alert_sends (run_date_local) VALUES ($1::date)
         ON CONFLICT (run_date_local) DO NOTHING
       RETURNING run_date_local`,
      [input.runDateLocal],
    );
    claimed = rows.length > 0;
  } catch (err) {
    logger.error(
      {
        event: 'account_drift_alert_claim_failed',
        runDateLocal: input.runDateLocal,
        message: err instanceof Error ? err.message : String(err),
      },
      'account drift alert claim query failed (non-fatal); skipping post',
    );
    return noOp();
  }

  if (!claimed) {
    logger.info(
      { event: 'account_drift_alert_already_sent', runDateLocal: input.runDateLocal },
      'account drift alert already posted for this run date — skipping',
    );
    return noOp();
  }

  const text = buildMessage({ runDateLocal: input.runDateLocal, accounts: input.accounts, visible });

  try {
    await sendDriftChannelMessage(text);
  } catch (err) {
    // Release the claim so a later run can retry the post (the send failed, not
    // the analysis). Best-effort — a failed delete just means we won't retry today.
    logger.error(
      {
        event: 'account_drift_alert_send_failed',
        runDateLocal: input.runDateLocal,
        message: err instanceof Error ? err.message : String(err),
      },
      'account drift alert Slack send failed (non-fatal); releasing claim',
    );
    await input.pool
      .query(`DELETE FROM trade_request.drift_alert_sends WHERE run_date_local = $1::date`, [input.runDateLocal])
      .catch(() => undefined);
    return noOp();
  }

  logger.info(
    {
      event: 'account_drift_alert_sent',
      runDateLocal: input.runDateLocal,
      visibleOutCount: visible.length,
      suppressedAllowListedCount: suppressedAllowListed.length,
    },
    'account drift alert posted to Slack',
  );

  return {
    sent: true,
    alertingAccountIds: visible.map((a) => a.accountId),
    suppressedAllowListed,
  };
}

/** Exported for tests. */
export const buildAccountDriftMessageForTests = buildMessage;
