import logger from '../lib/logger.js';
import { escapeSlack, sendDriftChannelMessage } from './slack.js';
import { DRIFT_ALLOW_LIST_NAMES } from './registryDriftAllowList.js';
import type { DriftHouseholdResult } from './registryDrift.js';
import type { DriftAlertResult } from './driftContract.js';

/**
 * Render and post the nightly drift Slack message. The runner persists rows
 * before calling this function; the `breachInsertedHouseholdNames` set is the
 * subset of households whose INSERT actually wrote a row (i.e. ON CONFLICT
 * DO NOTHING did not silently drop them), which is how the digest pattern
 * (`server/src/services/digest.ts:379-394`) guarantees a manual re-run on
 * the same calendar day cannot double-post.
 *
 * Allow-listed and unmapped-account households are excluded from the alert
 * payload entirely; the unmapped count is surfaced as a single trailing line
 * so on-call sees the coverage signal without it drowning real breaches.
 *
 * `DRIFT_ALERTS_ENABLED` is the runtime shadow-mode kill switch: when off,
 * this function returns `{ sent: false }` after emitting a structured
 * `drift_alert_suppressed` info log so we still have a forensic trail.
 */

export interface DriftAlertInput {
  households: readonly DriftHouseholdResult[];
  breachInsertedHouseholdNames: ReadonlySet<string>;
  runDateLocal: string;
  unmappedAccountCount: number;
}

export type { DriftAlertResult } from './driftContract.js';

function formatPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function buildMessage(input: {
  runDateLocal: string;
  alerting: DriftHouseholdResult[];
  unmappedAccountCount: number;
}): string {
  const { runDateLocal, alerting, unmappedAccountCount } = input;
  const headerCount = alerting.length;
  const householdWord = headerCount === 1 ? 'household' : 'households';
  const lines: string[] = [
    `*Registry drift report* — ${escapeSlack(runDateLocal)} — ${headerCount} ${householdWord} over tolerance`,
    '',
  ];

  for (const household of alerting) {
    const worst = household.worstSymbol ? `worst bucket: ${escapeSlack(household.worstSymbol)}` : 'worst bucket: n/a';
    const accounts = household.accountCount === 1 ? '1 account' : `${household.accountCount} accounts`;
    lines.push(
      `• ${escapeSlack(household.householdName)} · max ${formatPct(household.maxDeltaPct)} · ${worst} (${escapeSlack(accounts)})`,
    );

    // Drilldown line: surface the worst-account top per-symbol delta so the
    // on-call sees a concrete ticker without expanding the dashboard. Pick
    // the household's worst account (the one whose maxDeltaPct equals the
    // household's), then the symbol with the largest per-symbol delta on
    // that account. Plan §5.F.
    const worstAccount = household.details.accounts.find(
      (account) => Math.abs(account.maxDeltaPct - household.maxDeltaPct) < 1e-9,
    );
    let topSymbolLine = '   ↳ top symbol: n/a';
    if (worstAccount) {
      const entries = Object.entries(worstAccount.perSymbolDelta);
      let topSymbol: string | null = null;
      let topDelta = -Infinity;
      for (const [symbol, detail] of entries) {
        if (detail.delta > topDelta) {
          topDelta = detail.delta;
          topSymbol = symbol;
        }
      }
      if (topSymbol !== null && Number.isFinite(topDelta)) {
        topSymbolLine = `   ↳ top symbol: ${escapeSlack(topSymbol)} (${formatPct(topDelta)})`;
      }
    }
    lines.push(topSymbolLine);
  }

  if (unmappedAccountCount > 0) {
    lines.push('', `_${unmappedAccountCount} unmapped accounts this run — check households.json_`);
  }

  return lines.join('\n');
}

export async function postDriftAlert(input: DriftAlertInput): Promise<DriftAlertResult> {
  const allBreaches = input.households.filter(
    (household) => household.breach && household.coverageStatus !== 'unmapped_account',
  );

  const suppressedAllowListed = allBreaches
    .filter((household) => DRIFT_ALLOW_LIST_NAMES.has(household.householdName))
    .map((household) => household.householdName);

  const alerting = allBreaches.filter(
    (household) =>
      !DRIFT_ALLOW_LIST_NAMES.has(household.householdName) &&
      input.breachInsertedHouseholdNames.has(household.householdName),
  );

  if (process.env.DRIFT_ALERTS_ENABLED !== 'true') {
    logger.info(
      {
        event: 'drift_alert_suppressed',
        runDateLocal: input.runDateLocal,
        reason: 'DRIFT_ALERTS_ENABLED!=true',
        breachCount: alerting.length,
        suppressedAllowListed: suppressedAllowListed.length,
      },
      'drift alert suppressed (shadow mode)',
    );
    return {
      sent: false,
      alertingHouseholds: alerting.map((household) => household.householdName),
      suppressedAllowListed,
    };
  }

  if (alerting.length === 0) {
    logger.info(
      {
        event: 'drift_alert_clean',
        runDateLocal: input.runDateLocal,
        unmappedAccountCount: input.unmappedAccountCount,
      },
      'drift alert skipped (no non-allow-listed breaches)',
    );
    return {
      sent: false,
      alertingHouseholds: [],
      suppressedAllowListed,
    };
  }

  const text = buildMessage({
    runDateLocal: input.runDateLocal,
    alerting,
    unmappedAccountCount: input.unmappedAccountCount,
  });

  await sendDriftChannelMessage(text);

  logger.info(
    {
      event: 'drift_alert_sent',
      runDateLocal: input.runDateLocal,
      alertingHouseholdCount: alerting.length,
      suppressedAllowListedCount: suppressedAllowListed.length,
      unmappedAccountCount: input.unmappedAccountCount,
    },
    'drift alert posted to Slack',
  );

  return {
    sent: true,
    alertingHouseholds: alerting.map((household) => household.householdName),
    suppressedAllowListed,
  };
}
