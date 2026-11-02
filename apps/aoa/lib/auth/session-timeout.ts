// Pure, dependency-free session-timeout math (ticket). Kept out of the
// next-auth stack so it can be unit-tested in the `node` vitest suite and reused
// by both the server (auth.ts maxAge) and the client SessionTimeout component.

/** Sliding/idle session length: 4 hours. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 4; // 14400

/**
 * How often ongoing server interaction slides the DB session expiry forward
 * (Auth.js `session.updateAge`). Every ~30 min of activity re-stamps expires to
 * now + maxAge, so continuous use never logs you out, but ~4h of true inactivity
 * does. Smaller than maxAge (required by Auth.js) and small enough that a page
 * navigation reliably refreshes the countdown the client renders.
 */
export const SESSION_UPDATE_AGE_SECONDS = 60 * 30; // 1800

/** Show the pre-logout warning when this little time is left. */
export const WARN_BEFORE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Milliseconds remaining until the session expires. Never negative — a session
 * already past `expires` reports 0 (fully elapsed), which the caller treats as
 * "sign out now".
 */
export function msUntilExpiry(expiresAtMs: number, nowMs: number): number {
  return Math.max(0, expiresAtMs - nowMs);
}

/**
 * True once we are within the warning window (<= 5 min left) but the session
 * has not yet expired. At exactly 0 remaining the warning is over — the caller
 * signs out — so this is false there.
 */
export function shouldWarn(expiresAtMs: number, nowMs: number): boolean {
  const remaining = msUntilExpiry(expiresAtMs, nowMs);
  return remaining > 0 && remaining <= WARN_BEFORE_MS;
}

/** True once the session has fully elapsed (time to sign out). */
export function isExpired(expiresAtMs: number, nowMs: number): boolean {
  return msUntilExpiry(expiresAtMs, nowMs) <= 0;
}

/**
 * Format a remaining-millis value as a countdown clock "M:SS" (e.g. 4:07).
 * Rounds up so the label reads "5:00" for the first tick of the window and only
 * shows "0:00" at true expiry — a user never sees the clock hit 0 while there is
 * still a second of grace left.
 */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
