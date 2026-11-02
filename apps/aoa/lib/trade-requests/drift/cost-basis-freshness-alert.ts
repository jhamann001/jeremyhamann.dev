import logger from '@/lib/trade-requests/log';
import { escapeSlack, sendDriftChannelMessage } from '@/lib/trade-requests/drift/slack';
import type { CostBasisFreshnessResult } from '@/lib/trade-requests/drift/cost-basis-freshness';

/**
 * Slack notification for stale cost-basis data. Mirrors the gating of
 * `positionDriftAccountsAlert.ts`:
 *   - Only fires when freshness level is NOT 'ok'.
 *   - Gated on `DRIFT_ALERTS_ENABLED` (shadow mode emits an info log only).
 *
 * This is a heads-up notification, not a blocker — the drift run completes with
 * best-available cost basis regardless.
 */

export interface CostBasisFreshnessAlertResult {
  sent: boolean;
  level: CostBasisFreshnessResult['level'];
}

const EMOJI: Record<CostBasisFreshnessResult['level'], string> = {
  ok: '✅',
  warn: '⚠️',
  critical: '🚨',
  missing: '❓',
};

export async function postCostBasisFreshnessAlert(input: {
  freshness: CostBasisFreshnessResult;
  runDateLocal: string;
  /** ticket: replaces DRIFT_ALERTS_ENABLED. */
  send: () => Promise<boolean>;
}): Promise<CostBasisFreshnessAlertResult> {
  const { freshness, runDateLocal } = input;

  if (freshness.level === 'ok') {
    return { sent: false, level: 'ok' };
  }

  if (!(await input.send())) {
    logger.info(
      {
        event: 'cost_basis_freshness_alert_suppressed',
        runDateLocal,
        level: freshness.level,
        fullAgeDays: freshness.full.ageDays,
        dailyAgeDays: freshness.daily.ageDays,
        reason: 'DRIFT_ALERTS_ENABLED!=true',
      },
      'cost-basis freshness alert suppressed (shadow mode)',
    );
    return { sent: false, level: freshness.level };
  }

  const text = `${EMOJI[freshness.level]} *Cost-basis data staleness* — ${escapeSlack(runDateLocal)}\n${escapeSlack(
    freshness.message,
  )}\n_Drift ran with best-available cost basis; tax figures may be stale._`;

  await sendDriftChannelMessage(text);

  logger.warn(
    {
      event: 'cost_basis_freshness_alert_sent',
      runDateLocal,
      level: freshness.level,
      fullLatest: freshness.full.latest,
      fullAgeDays: freshness.full.ageDays,
      dailyLatest: freshness.daily.latest,
      dailyAgeDays: freshness.daily.ageDays,
    },
    'cost-basis freshness alert posted to Slack',
  );

  return { sent: true, level: freshness.level };
}
