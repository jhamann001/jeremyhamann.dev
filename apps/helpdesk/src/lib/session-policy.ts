/**
 * Session policy — pure, edge-safe, layer L1.
 *
 * WAVE B FOUNDATION STUB. **Owned by slice B6 (compliance)**, which replaces the body of
 * `isIdleExpired` / `touchActivity` with whatever the control map ends up requiring. The SIGNATURES
 * here are the contract: `src/auth.config.ts` already calls them from the `jwt` callback, so B6
 * changes this file and nothing else. The defaults below are real, not placeholders — a 30-minute
 * idle window is enforced from this commit.
 *
 * Why here and not in `auth.config.ts`: that module is imported by the EDGE middleware, so it may not
 * touch the database and must stay dependency-free. An idle timeout is arithmetic over two
 * numbers already in the JWT, which is exactly what belongs in an L1 module: no I/O, testable without
 * a browser, and identical on the edge and in node.
 *
 * Why an idle timeout at all, on top of the 8-hour absolute lifetime: the absolute bound
 * answers "how long can a demoted user keep stale groups". It does not answer "how long does an
 * unattended laptop stay signed into a books-and-records system", which is the control an examiner
 * asks about and the one a shared desk machine actually needs.
 */

/** How long a session may sit idle before it must re-authenticate. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The JWT fields this module reads and writes. Deliberately a structural type rather than an import
 * of Auth.js's `JWT`: this module is L1 and must not depend on the auth library.
 */
export type ActivityStamped = {
  /** Epoch ms of the last request this token was seen on. */
  lastSeenAt?: unknown;
  /** Epoch ms of the sign-in the token descends from (`groupsSyncedAt`). */
  groupsSyncedAt?: unknown;
};

function asEpochMs(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Whether this token has been idle longer than `IDLE_TIMEOUT_MS`.
 *
 * A token with NO `lastSeenAt` falls back to `groupsSyncedAt` — a token minted before this policy
 * existed is judged from its sign-in, which is the conservative reading. A token with neither is
 * expired: an unreadable stamp is not a fresh one (fail closed).
 */
export function isIdleExpired(token: ActivityStamped, now: number = Date.now()): boolean {
  const last = asEpochMs(token.lastSeenAt) ?? asEpochMs(token.groupsSyncedAt);
  if (last === null) return true;
  return now - last > IDLE_TIMEOUT_MS;
}

/**
 * Stamps the token as seen now. Returns a NEW object rather than mutating, so a caller cannot half-
 * apply it. Auth.js only persists a re-issued token when `updateAge` has elapsed, so the stamp
 * advances at most once an hour in practice — which is why the window is 30 minutes and not 5: the
 * resolution of the input bounds how tight the policy can honestly be.
 */
export function touchActivity<T extends ActivityStamped>(token: T, now: number = Date.now()): T {
  return { ...token, lastSeenAt: now };
}
