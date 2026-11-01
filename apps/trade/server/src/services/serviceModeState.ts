import logger from '../lib/logger.js';

export const SERVICE_MODES = ['active', 'frozen', 'mcp-only'] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

function isServiceMode(value: string): value is ServiceMode {
  return (SERVICE_MODES as readonly string[]).includes(value);
}

/**
 * Emergency override from SERVICE_MODE_OVERRIDE. Unset or empty: none. An unrecognised value
 * reads as frozen (no writes, no messages) rather than silently as active.
 */
export function modeOverride(): ServiceMode | null {
  const raw = (process.env.SERVICE_MODE_OVERRIDE ?? '').trim().toLowerCase();
  if (raw === '') return null;
  if (isServiceMode(raw)) return raw;
  logger.error({ event: 'service_mode_override_invalid' }, 'SERVICE_MODE_OVERRIDE is not active, frozen or mcp-only');
  return 'frozen';
}

let observed: ServiceMode = 'active';

/** Records the effective mode from the latest database read on this instance. */
export function observeServiceMode(mode: ServiceMode): void {
  observed = mode;
}

/** Slack and email send only while the service is active (the override wins over the last read). */
export function messagesAllowed(): boolean {
  return (modeOverride() ?? observed) === 'active';
}
