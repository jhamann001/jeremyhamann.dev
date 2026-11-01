/**
 * Denial coalescing for the UNAUTHENTICATED public client API — node, layer L2
 * (§3 rule 4). The same core also carries the machine
 * surface's pre-authentication denials (`src/lib/integration-auth.ts`).
 *
 * The problem this solves: `/api/client/**` sits outside the session middleware and answers to a
 * bearer, so anything on the internet can knock on it. Every denial is evidence and the ledger is
 * append-only, which means an unauthenticated scanner would otherwise be able to grow the
 * compliance record without limit — one hash-chained row per probe, at whatever rate it likes. Each
 * such row also takes the GLOBAL `pg_advisory_xact_lock(hashtext('AuditLog.chain'))` that every staff
 * write transaction needs, so the flood would serialise the desk as well as bloat the ledger.
 *
 * So there are TWO bounds, and a denial writes a row only when it passes both:
 *
 *  1. **Per key** (route + client IP). The FIRST unauthenticated denial for a key in a window writes
 *     ONE `AUTHZ_DENIED_COALESCED` row; every later denial in that window is counted and sent to the
 *     structured log instead. The next window's first denial writes the next row and states how many
 *     were suppressed since the last one, so a single row can carry the true count rather than a
 *     bare "1".
 *  2. **Per scope** (the key's leading segment — the route, in its realm's namespace), added because
 *     bound 1 alone is keyed on an address the attacker chooses. An adversary holding an IPv6 /64, or
 *     any small rotating pool, presents a fresh IP on every request, so every probe is a fresh key and
 *     bound 1 never fires: the throttle was a no-op against exactly the adversary it was built for.
 *     At most `DENIAL_MAX_ROWS_PER_ROUTE_WINDOW` rows are recorded per scope per window, whatever the
 *     source address. A denial the scope budget refuses is credited to that scope's carried count, so
 *     the next row in the scope still states how many denials it stands for — the evidence is
 *     compressed, never dropped.
 *
 * Three properties this deliberately does NOT have, all stated rather than hidden:
 *  - It is per Cloud Run INSTANCE. Instances are ephemeral and there may be several, so the recorded
 *    count is a FLOOR, never a total, and the per-scope budget bounds rows per instance rather than
 *    per service. The audit metadata says the count is a floor.
 *  - It is a bound on ROWS, not on REQUESTS. It does not stop the probe reaching the process; it stops
 *    the probe writing the ledger. An edge rate limit in front of the service is the control that
 *    would refuse the traffic itself, and **no such control is deployed**: neither `infra/terraform-dev`
 *    nor `infra/terraform-prod` contains a `google_compute_security_policy`, a load balancer or any
 *    other rate limit, and both stacks run Cloud Run with `INGRESS_TRAFFIC_ALL` and `allUsers` as
 *    invoker. Requesting one is the build record; until it
 *    exists, bound 2 above — not Cloud Armor — is what actually holds the row count down.
 *  - It has no timers. A window is closed lazily, by the next attempt that finds it stale, so there is
 *    no interval keeping an idle instance warm and nothing to clean up at shutdown.
 *
 * Both maps are bounded and LRU-evicted, so a scanner rotating source addresses cannot grow them: the
 * cost of eviction is that an evicted key's suppressed count is lost, which is a floor becoming a
 * slightly lower floor.
 *
 * AUTHENTICATED denials (a valid bearer with the wrong requester, a bad machine bearer) are never
 * coalesced — those stay one row each, because there are few of them and each names a caller.
 */
import type { RequestContext } from "@/types/domain";
import { recordCoalescedDenial, recordSignInDenied } from "@/lib/audit";
import { logWarn } from "@/lib/logger";

/**
 * One row per key per minute, at most, and the length of the per-scope budget window.
 *
 * It is the DEFAULT for bound 1, not the only value: `recordDenialAttempt` takes an optional
 * `windowMs` so a surface whose refusals are POLLED rather than probed can ask for a longer key
 * window (the staff presence endpoint re-fetches every 30 seconds, so a minute would halve its rows
 * rather than bound them). Bound 2 — the per-scope row budget — always runs on this constant, so a
 * long key window can never widen the number of rows a scope may write in a minute.
 */
export const DENIAL_WINDOW_MS = 60_000;

/**
 * The key window `GET /api/tickets/[id]/presence` asks for: one full refusal row per (viewer, ticket)
 * per quarter hour.
 *
 * Longer than `DENIAL_WINDOW_MS` on purpose, and it is the worked example the paragraph above
 * describes. `PresenceChip` polls every 30 seconds, so a one-minute key window would HALVE a stuck
 * tab's rows (1,440 a day) rather than bound them. Fifteen minutes turns the same tab into at most
 * four rows an hour, each stating how many refusals it stands for, while the first refusal is still
 * recorded the instant it happens. The per-scope row budget still runs on `DENIAL_WINDOW_MS`.
 *
 * IT LIVES HERE RATHER THAN IN THE ROUTE (integration round 3). A Next.js App Router `route.ts` may
 * export only the HTTP method handlers and the route-segment config fields; any other export fails
 * `next build` with "is not a valid Route export field" — and NOT `tsc --noEmit`, because the check is
 * generated during the build. This constant was exported from the route so its test could read it,
 * which type-checked, passed every test, and broke the build. `src/lib/guardrails.test.ts` G19 now
 * fails on any such export, so the next one is caught in the suite instead.
 */
export const PRESENCE_DENIAL_WINDOW_MS = 15 * 60_000;

/** LRU bound on the tracked-key map. ~10k keys is far more than one instance sees in a window. */
export const DENIAL_MAX_TRACKED_KEYS = 10_000;

/**
 * The per-scope row budget: at most this many `AUTHZ_DENIED_COALESCED` rows per route per window on
 * this instance, however many distinct source addresses ask. Ten leaves ordinary operational noise
 * (a handful of misconfigured callers on one route in one minute) individually attributable, while
 * capping a rotating-address flood at ten rows a minute per route instead of one row per probe.
 * Denials past the budget are not lost: they are added to the count the next row in the scope states.
 */
export const DENIAL_MAX_ROWS_PER_ROUTE_WINDOW = 10;

/** LRU bound on the scope map. There are a handful of real scopes; the bound is for synthetic keys. */
export const DENIAL_MAX_TRACKED_SCOPES = 256;

/**
 * Separates the scope (route) from the rest of a throttle key. A control character no route, realm
 * prefix or resolved IP can contain: `src/lib/client-ip.ts` only ever yields a validated IPv4/IPv6
 * literal or the string `unknown`.
 */
export const DENIAL_SCOPE_SEPARATOR = "";

export type DenialThrottleDecision =
  | { record: true; suppressedSinceLastRecord: number; windowStartedAt: Date }
  | { record: false; suppressedSinceLastRecord: number; windowStartedAt: Date };

type WindowState = {
  /**
   * Epoch ms at which the current window opened (i.e. when its row was recorded), or `null` when the
   * key has no open window — the scope budget refused its row, so the NEXT attempt on this key should
   * try to record again rather than be silenced by a window no row ever opened.
   */
  windowStartedAt: number | null;
  /** Denials seen for this key since its last recorded row. */
  suppressed: number;
};

type ScopeState = {
  /** Epoch ms at which the current budget window opened. */
  windowStartedAt: number;
  /** Rows recorded in this scope during the current budget window. */
  recorded: number;
  /** Denials the BUDGET refused since the last row recorded in this scope, from any source address. */
  carried: number;
};

/**
 * Insertion-ordered, so `keys().next()` is the least recently touched entry. A touch is
 * delete-then-set, which moves the key to the end.
 */
const windows = new Map<string, WindowState>();

/** Same discipline, keyed by scope: the per-route budget that survives source-address rotation. */
const scopes = new Map<string, ScopeState>();

function touchIn<T>(map: Map<string, T>, key: string, state: T, max: number): void {
  map.delete(key);
  map.set(key, state);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function touch(key: string, state: WindowState): void {
  touchIn(windows, key, state, DENIAL_MAX_TRACKED_KEYS);
}

function touchScope(scope: string, state: ScopeState): void {
  touchIn(scopes, scope, state, DENIAL_MAX_TRACKED_SCOPES);
}

/**
 * The scope of a key: everything before the FIRST separator, which is the route (in its realm's
 * namespace) as `denialThrottleKey` composed it. Deliberately the first and not the last separator —
 * the leading segment is ours, everything after it is caller-influenced, and splitting on the last
 * one would let a crafted address mint a scope of its own and walk straight past the budget.
 *
 * A key carrying no separator (a synthetic key in a test, a future caller that builds its own) is its
 * own scope. That is the safe reading: it can only ever spend its own budget, and since bound 1
 * already allows such a key a single row per window, the budget costs it nothing.
 */
function scopeOf(key: string): string {
  const at = key.indexOf(DENIAL_SCOPE_SEPARATOR);
  return at === -1 ? key : key.slice(0, at);
}

/**
 * The FIRST denial for `key` in a window returns `record: true`, provided its scope still has room in
 * the per-route budget; later ones in the same window return `record: false` and increment the
 * counter. The next window's first denial returns `record: true` with `suppressedSinceLastRecord` set
 * to how many were suppressed since the last recorded row — for this key, plus any the scope budget
 * refused — so ONE row can state the true count.
 *
 * A clock that moves backwards (NTP step) leaves `now - windowStartedAt` negative, which reads as
 * "still inside the window" — it suppresses rather than over-records, which is the safe direction for
 * an append-only ledger.
 */
export function recordDenialAttempt(
  key: string,
  now: Date = new Date(),
  windowMs: number = DENIAL_WINDOW_MS,
): DenialThrottleDecision {
  const t = now.getTime();
  const existing = windows.get(key);

  // Bound 1: this key already had its row for the window. `windowMs` is the caller's, so a polled
  // surface can hold one row for longer than a minute; bound 2 below stays on DENIAL_WINDOW_MS.
  if (existing !== undefined && existing.windowStartedAt !== null && t - existing.windowStartedAt < windowMs) {
    const openedAt = existing.windowStartedAt;
    const next: WindowState = { windowStartedAt: openedAt, suppressed: existing.suppressed + 1 };
    touch(key, next);
    return { record: false, suppressedSinceLastRecord: next.suppressed, windowStartedAt: new Date(openedAt) };
  }

  // Bound 2: the key would record, so the route's budget decides whether it may.
  const scope = scopeOf(key);
  const previousScope = scopes.get(scope);
  const scopeState: ScopeState =
    previousScope === undefined || t - previousScope.windowStartedAt >= DENIAL_WINDOW_MS
      ? { windowStartedAt: t, recorded: 0, carried: previousScope?.carried ?? 0 }
      : previousScope;

  const keySuppressed = existing?.suppressed ?? 0;

  if (scopeState.recorded >= DENIAL_MAX_ROWS_PER_ROUTE_WINDOW) {
    // No row: the route has written enough this window. The denial is credited to the scope so the
    // next row in this scope states it, and the key's window stays CLOSED — a key must not be
    // silenced by a window that never produced a row.
    touchScope(scope, { ...scopeState, carried: scopeState.carried + 1 });
    // Only keep a key we are already tracking. Creating an entry per rotated address here would churn
    // the LRU and evict the keys whose counts still mean something.
    if (existing !== undefined) touch(key, { windowStartedAt: null, suppressed: keySuppressed });
    return {
      record: false,
      suppressedSinceLastRecord: keySuppressed + scopeState.carried + 1,
      windowStartedAt: new Date(scopeState.windowStartedAt),
    };
  }

  const suppressedSinceLastRecord = keySuppressed + scopeState.carried;
  touchScope(scope, { windowStartedAt: scopeState.windowStartedAt, recorded: scopeState.recorded + 1, carried: 0 });
  touch(key, { windowStartedAt: t, suppressed: 0 });
  return { record: true, suppressedSinceLastRecord, windowStartedAt: new Date(t) };
}

/** Tests only. */
export function resetDenialThrottle(): void {
  windows.clear();
  scopes.clear();
}

/** Tests and diagnostics: how many keys the bounded map currently holds. */
export function denialThrottleSize(): number {
  return windows.size;
}

/** Tests and diagnostics: how many scopes (routes) the bounded budget map currently holds. */
export function denialThrottleScopeSize(): number {
  return scopes.size;
}

// ---------------------------------------------------------------------------
// Wiring. The pure core above is what the contract pins; this is the one call the unauthenticated
// client routes make, kept here so the two POST routes and (once G7's allow-list admits it) the GET
// route cannot drift apart. Importing the module has no side effects, so the pure core stays usable
// on its own.
// ---------------------------------------------------------------------------

/**
 * The throttle key. Keyed by ROUTE **and** client IP rather than IP alone, because the audit row
 * carries exactly one `route` in its metadata: a key shared across routes would attribute a window's
 * whole count to whichever route happened to knock first. Per-IP-per-route is a refinement of
 * "per client IP per window", never a loosening of it.
 *
 * The two parts are joined by `DENIAL_SCOPE_SEPARATOR` so the route can be recovered as the key's
 * scope for the per-route budget. `route` is always one of our own literals; `ipAddress` is stripped
 * of any separator so a crafted address cannot shift where the scope ends (belt and braces —
 * `src/lib/client-ip.ts` only yields validated literals or `unknown`).
 */
export function denialThrottleKey(route: string, ipAddress: string): string {
  return `${route}${DENIAL_SCOPE_SEPARATOR}${ipAddress.split(DENIAL_SCOPE_SEPARATOR).join("")}`;
}

/**
 * Records ONE unauthenticated denial on the public client API, coalesced.
 *
 * - First denial of a window, while the route's budget has room: writes the `AUTHZ_DENIED_COALESCED`
 *   row, awaited, with `count = 1 + everything suppressed since the last recorded row` (the
 *   contract's "count is the number of denials the window collapsed, including this one").
 * - Later denials in the same window, and denials past the route's budget: one structured log line,
 *   no row. Their count reaches the ledger on the next row for the key or the route.
 *
 * The write is awaited and its errors propagate, exactly like every other denial path (I3/I5): a
 * caller that cannot record the denial answers 500, never an unaudited 401.
 */
export async function recordUnauthenticatedClientDenial(
  ctx: RequestContext,
  route: string,
  now: Date = new Date(),
): Promise<void> {
  const decision = recordDenialAttempt(denialThrottleKey(route, ctx.ipAddress), now);
  if (!decision.record) {
    // No record content here — a route path, a count and an IP, all of which the ledger already holds.
    // Structured logger rather than `console.warn`: `console` is the sink CWE-209 watches, and one
    // JSON shape across both runtimes is what makes the suppressed denials queryable at all.
    logWarn("client-api", "unauthenticated_denial_suppressed", {
      route,
      ipAddress: ctx.ipAddress,
      requestId: ctx.requestId,
      suppressedSinceLastRecord: decision.suppressedSinceLastRecord,
      windowStartedAt: decision.windowStartedAt.toISOString(),
    });
    return;
  }
  await recordCoalescedDenial(ctx, route, decision.suppressedSinceLastRecord + 1, decision.windowStartedAt);
}

/**
 * The scope a refused sign-in is counted under. Not an HTTP route — `callbacks.signIn` is reached through
 * `/api/auth/callback/<provider>` for OIDC and through a POST for the credentials provider — so the
 * provider name is the honest scope, and it keeps one provider's refusals from spending another's budget.
 */
export function signInDenialScope(provider: string): string {
  return `sign-in:${provider}`;
}

/**
 * Records ONE refused sign-in, coalesced on exactly the terms the unauthenticated client API uses
 *: first refusal per (provider, client IP) per window writes the row, the rest are counted
 * and logged, and the per-scope budget bounds the rows a rotating-address probe can write whatever address
 * it presents. The sign-in page is public on both services, so the allowlist can be probed by anyone who
 * finds the URL, and an unbounded row per probe would grow an append-only ledger without limit.
 *
 * `domain` is the refused address's domain, already bounded by the caller to a plausible bare domain, or
 * `null` for anything else — recorded as the literal `domain:invalid`. The local part never reaches here.
 *
 * The write is awaited and its errors propagate, like every other denial path (I3/I5). That is still fail
 * closed: the caller has already decided to refuse, so a throw here costs the refused party a 500 instead
 * of a redirect and costs them no session either way.
 */
export async function recordRefusedSignIn(
  ctx: RequestContext,
  provider: string,
  reason: string,
  domain: string | null,
  now: Date = new Date(),
): Promise<void> {
  const scope = signInDenialScope(provider);
  const recordedDomain = domain ?? "domain:invalid";
  const decision = recordDenialAttempt(denialThrottleKey(scope, ctx.ipAddress), now);
  if (!decision.record) {
    logWarn("auth", "sign_in_refusal_suppressed", {
      route: scope,
      ipAddress: ctx.ipAddress,
      requestId: ctx.requestId,
      reason,
      domain: recordedDomain,
      suppressedSinceLastRecord: decision.suppressedSinceLastRecord,
      windowStartedAt: decision.windowStartedAt.toISOString(),
    });
    return;
  }
  await recordSignInDenied(
    ctx,
    provider,
    reason,
    recordedDomain,
    decision.suppressedSinceLastRecord + 1,
    decision.windowStartedAt,
  );
}
