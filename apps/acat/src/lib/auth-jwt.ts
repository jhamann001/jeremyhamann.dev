// Pure, testable JWT refresh logic for the NextAuth `jwt` callback. Lives in
// its own module so unit tests can import it without dragging in the full
// NextAuth/next-server runtime.

// Hard cap on session lifetime. Short enough that a leaked token decays
// quickly; long enough that real users don't get bounced mid-workflow.
// 4h matches typical ops-desk usage patterns — users open the app in the
// morning and leave it open through the workday.
export const SESSION_MAX_AGE_SEC = 4 * 60 * 60; // 4 hours

// NextAuth's database-session update cadence. JWT sessions run the callback
// on every session read; this setting does not throttle permission checks.
export const SESSION_UPDATE_AGE_SEC = 5 * 60; // 5 minutes

// Server-side idle timeout. If no authenticated request is made for this
// long, the session is invalidated on the next request. Mirrors the
// client-side timeout in src/hooks/use-idle-timeout.ts, but a malicious
// client cannot bypass it.
export const IDLE_TIMEOUT_SEC = 4 * 60 * 60; // 4 hours

// ticket: ADVISOR is a third role tier between USER and ADMIN — it has
// less access than USER (no ops dashboard, no records page), but is
// scoped to its own /advisor surface.
export type AppRole = "ADMIN" | "USER" | "ADVISOR";

export type JwtTokenLike = {
  email?: string | null;
  role?: AppRole;
  lastRoleCheckAt?: number;
  lastActivityAt?: number;
  [k: string]: unknown;
};

export interface ProcessJwtDeps {
  now: () => number; // unix seconds
  findAllowedUser: (
    email: string
  ) => Promise<{ active: boolean; role: AppRole } | null>;
  log?: {
    info: (payload: Record<string, unknown>, msg: string) => void;
    warn: (payload: Record<string, unknown> | string, msg?: string) => void;
  };
}

/**
 * Core of the NextAuth `jwt` callback. Returns the updated token, or `null`
 * to invalidate the session (which makes @auth/core clear the cookie).
 */
export async function processJwtRefresh(
  token: JwtTokenLike,
  user: { email?: string | null } | undefined,
  trigger: string | undefined,
  deps: ProcessJwtDeps
): Promise<JwtTokenLike | null> {
  const now = deps.now();
  const email = (user?.email ?? token.email ?? undefined)?.toLowerCase();

  if (trigger === "signIn" || token.lastActivityAt == null) {
    token.lastActivityAt = now;
  } else if (now - token.lastActivityAt > IDLE_TIMEOUT_SEC) {
    deps.log?.info(
      { email, idleFor: now - token.lastActivityAt },
      "session expired by idle timeout"
    );
    return null;
  } else {
    token.lastActivityAt = now;
  }

  if (!email) {
    deps.log?.warn("jwt refresh with no email; invalidating session");
    return null;
  }

  // A signed cookie proves identity, not current authorization. Recheck the
  // indexed allow-list row on every protected session read so a recent JWT
  // cannot retain permissions after a role change or deactivation. In
  // particular, a route handler may receive the original cookie even after
  // Proxy refreshed it; both reads must use the current database role.
  let allowed: Awaited<ReturnType<ProcessJwtDeps["findAllowedUser"]>>;
  try {
    allowed = await deps.findAllowedUser(email);
  } catch (err) {
    deps.log?.warn(
      { err, email },
      "role recheck DB lookup failed; invalidating session"
    );
    return null;
  }
  if (!allowed || !allowed.active) {
    deps.log?.info(
      { email, found: !!allowed, active: allowed?.active ?? null },
      "session revoked: user not found or inactive"
    );
    return null;
  }
  // Adding a database role must not silently grant the default ops access.
  if (
    allowed.role !== "ADMIN" &&
    allowed.role !== "USER" &&
    allowed.role !== "ADVISOR"
  ) {
    deps.log?.warn({ email, role: allowed.role }, "session revoked: unsupported role");
    return null;
  }
  token.role = allowed.role;
  token.lastRoleCheckAt = now;

  return token;
}
