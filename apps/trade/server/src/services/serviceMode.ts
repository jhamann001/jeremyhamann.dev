import pool from '../db/pool.js';
import logger from '../lib/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { modeOverride, observeServiceMode, type ServiceMode } from './serviceModeState.js';

export { SERVICE_MODES, type ServiceMode } from './serviceModeState.js';

export type SenderSwitch = 'on' | 'off';

/**
 * A write admitted just before a freeze can still commit after it. Cloud Run's request timeout is
 * the 300 s default (deploy-prod.yml sets none), so no admitted write outlives this.
 */
export const WRITE_SETTLE_SECONDS = 300;

export interface ServiceState {
  /** What the service enforces: the override when set, otherwise the persisted mode. */
  mode: ServiceMode;
  persistedMode: ServiceMode;
  override: ServiceMode | null;
  digestSender: SenderSwitch;
  driftSender: SenderSwitch;
  modeChangedAt: string | null;
  /** When writes admitted before the current freeze have finished. Null while active or overridden. */
  writesSettledAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ServiceStateChange {
  mode?: ServiceMode;
  digestSender?: SenderSwitch;
  driftSender?: SenderSwitch;
}

interface ServiceModeRow {
  mode: ServiceMode;
  digest_sender: SenderSwitch;
  drift_sender: SenderSwitch;
  mode_changed_at: Date | string;
  updated_at: Date | string;
  updated_by: string;
}

const SELECT_STATE = `SELECT mode, digest_sender, drift_sender, mode_changed_at, updated_at, updated_by FROM service_mode WHERE id`;

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

function toState(row: ServiceModeRow | undefined): ServiceState {
  const override = modeOverride();
  const persistedMode = row?.mode ?? 'active';
  const mode = override ?? persistedMode;
  const modeChangedAt = iso(row?.mode_changed_at);
  const writesSettledAt =
    mode !== 'active' && override === null && modeChangedAt
      ? new Date(Date.parse(modeChangedAt) + WRITE_SETTLE_SECONDS * 1000).toISOString()
      : null;
  return {
    mode,
    persistedMode,
    override,
    digestSender: row?.digest_sender ?? 'on',
    driftSender: row?.drift_sender ?? 'on',
    modeChangedAt,
    writesSettledAt,
    updatedAt: iso(row?.updated_at),
    updatedBy: row?.updated_by ?? null,
  };
}

/**
 * Reads the single service-mode row on every call (no cache). A missing row (only possible before the
 * migration runs) reads as active with both senders on, today's behavior. Database errors propagate.
 */
export async function readServiceState(): Promise<ServiceState> {
  const { rows } = await pool.query<ServiceModeRow>(SELECT_STATE);
  if (!rows[0]) logger.warn({ event: 'service_mode_row_missing' }, 'service_mode row missing; reading as active');
  const state = toState(rows[0]);
  observeServiceMode(state.mode);
  return state;
}

/** Changes the mode and/or sender switches and appends the change, in one transaction. */
export async function changeServiceState(
  change: ServiceStateChange,
  changedBy: string,
  reason: string,
): Promise<ServiceState> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<ServiceModeRow>(`${SELECT_STATE} FOR UPDATE`);
    const before = rows[0];
    if (!before) throw new AppError(503, 'service_mode row missing', 'Service mode is not set up');
    const next = {
      mode: change.mode ?? before.mode,
      digestSender: change.digestSender ?? before.digest_sender,
      driftSender: change.driftSender ?? before.drift_sender,
    };
    await client.query(
      `UPDATE service_mode
          SET mode = $1, digest_sender = $2, drift_sender = $3,
              mode_changed_at = CASE WHEN mode = $1 THEN mode_changed_at ELSE NOW() END,
              updated_at = NOW(), updated_by = $4
        WHERE id`,
      [next.mode, next.digestSender, next.driftSender, changedBy],
    );
    await client.query(
      `INSERT INTO service_mode_changes (changed_by, from_state, to_state, reason) VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
      [
        changedBy,
        JSON.stringify({ mode: before.mode, digestSender: before.digest_sender, driftSender: before.drift_sender }),
        JSON.stringify(next),
        reason,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return readServiceState();
}

let refreshInterval: NodeJS.Timeout | null = null;

/** Called once from the server's listen callback: keeps this instance's message gate current. */
export function startServiceModeRefresh(intervalMs = 15_000): void {
  const refresh = () =>
    readServiceState().catch((err: unknown) =>
      logger.error(
        { event: 'service_mode_read_failed', message: err instanceof Error ? err.message : String(err) },
        'service mode refresh failed',
      ),
    );
  const override = modeOverride();
  if (override) logger.warn({ event: 'service_mode_override_active', mode: override }, 'service mode override set');
  void refresh();
  if (!refreshInterval) {
    refreshInterval = setInterval(() => void refresh(), intervalMs);
    refreshInterval.unref();
  }
}
