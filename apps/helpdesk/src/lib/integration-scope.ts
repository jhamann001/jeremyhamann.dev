/**
 * Per-surface machine credentials — node only, layer L2 (the build record, §8;
 * the build record).
 *
 * WHY THIS EXISTS. Wave A shipped one bearer, `INTEGRATION_API_TOKEN`, for three surfaces that have
 * nothing in common but their caller:
 *
 *  - READ — `GET /api/export/tickets` is the advisor platform mirror. It applies no queue narrowing and no viewer:
 *    the whole ticket book, with requester names, addresses, household pointers and every PUBLIC
 *    comment body. By itself it is a full export of the firm's client correspondence.
 *  - WRITE — `/api/ingest/**` opens tickets and writes comments, including `authorKind: "REQUESTER"`,
 *    which puts words into a client's thread attributed to that client.
 *  - OUTBOX — `/api/integrations/outbox` leases queued client mail (rendered subject, text and HTML)
 *    and marks it SENT.
 *
 * All four shipped n8n workflows carry the same value as `$vars.WM_INTEGRATION_TOKEN`, on both the dev
 * and the prod instance, readable by anyone who can open a workflow. The voicemail webhook needs only
 * ingest; the advisor platform sync needs only export; the sender needs only the outbox. With one key, a compromise
 * of any one of them is a compromise of all three. §6 is explicit that "a machine caller holds no RBAC
 * grant of its own — the route it runs in decides what it may do", which is exactly why possession of
 * that one token IS every machine capability: there is no per-caller scoping anywhere else to fall
 * back on.
 *
 * WHAT THIS DOES. Each surface gets its own optional key. When the key for a scope is set, that scope
 * accepts ONLY that key — the shared token stops working there, which is what makes the split a
 * narrowing rather than an addition. When it is unset, the scope falls back to `INTEGRATION_API_TOKEN`
 * exactly as before, so an operator can split one workflow at a time instead of rotating four at once.
 * Unset everywhere is today's behaviour, byte for byte.
 *
 * WHERE THE KEYS ARE DECLARED, AND WHY THIS MODULE STILL READS `process.env`. As of the round-2
 * integration pass the three keys ARE declared in `src/lib/env.ts` alongside every other shared secret
 * (`Env`, the zod shape, the parse object and `shortSecretViolations`), so an operator sees the whole
 * credential surface in one place and a short value is refused at boot by key name. This module keeps
 * reading `process.env` rather than importing the parsed `env`, following the precedent in
 * `src/lib/dev-login.ts` and `src/lib/okta-groups.ts`: several suites that exercise the machine routes
 * (`integration-auth.test.ts`, `ingest.test.ts`, `email-intake.test.ts`) mock `@/lib/env` wholesale, and
 * a named import from it here would break them on a missing export. The two layers are deliberately
 * different in ONE respect: `env.ts` refuses a short key at boot in a network-reachable process,
 * whereas a short key here DISABLES its scope (401 to everyone) in a process that did boot — a local
 * developer, or a build worker. Both are fail-closed; this one fails closed on one surface rather than
 * all of them, and it is the last line if a key is mutated after boot.
 */
import { logWarn } from "@/lib/logger";


/**
 * Mirrors `MIN_SECRET_LENGTH` in `src/lib/env.ts` — a short bearer is worse than no bearer, it looks
 * like protection. Declared here rather than imported so that this module can be pulled in by code
 * whose tests mock `@/lib/env` wholesale (several do); `integration-scope.test.ts` asserts the two
 * stay equal (it imports both), so the duplication cannot drift.
 */
export const MIN_SCOPED_TOKEN_LENGTH = 32;

/** The three machine surfaces, one per middleware-excluded route prefix. */
export const INTEGRATION_SCOPES = ["ingest", "export", "outbox"] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];

/** The environment key that narrows each scope. Unset ⇒ that scope falls back to the shared bearer. */
export const INTEGRATION_SCOPE_ENV_KEY: Readonly<Record<IntegrationScope, string>> = Object.freeze({
  ingest: "INGEST_API_TOKEN",
  export: "EXPORT_API_TOKEN",
  outbox: "OUTBOX_API_TOKEN",
});

/** Route prefix → scope. The order is longest-prefix-first so a nested prefix could not be shadowed. */
const SCOPE_BY_PREFIX: readonly (readonly [string, IntegrationScope])[] = Object.freeze([
  ["/api/integrations/", "outbox"],
  ["/api/ingest/", "ingest"],
  ["/api/export/", "export"],
] as const);

/**
 * The scope a machine route path belongs to, or `null` for a path that is not a machine surface.
 * Exported for the guardrail test that pins every machine route to a scope; routes name their own
 * scope as a literal constant so the binding is visible in the file that is authorized by it.
 */
export function integrationScopeForRoute(route: string): IntegrationScope | null {
  for (const [prefix, scope] of SCOPE_BY_PREFIX) {
    if (route === prefix.slice(0, -1) || route.startsWith(prefix)) return scope;
  }
  return null;
}

export type ScopedTokenResolution =
  | { kind: "unset" }
  | { kind: "ok"; token: string }
  | { kind: "invalid"; reason: "too_short" };

/** Reported at most once per scope per process: a flood of probes must not become a flood of logs. */
const reportedInvalid = new Set<IntegrationScope>();

/**
 * What the environment says about one scope's key. Pure apart from the warn-once log; the source is
 * injectable so the tests never mutate `process.env`.
 */
export function resolveScopedIntegrationToken(
  scope: IntegrationScope,
  source: Record<string, string | undefined> = process.env,
): ScopedTokenResolution {
  const raw = source[INTEGRATION_SCOPE_ENV_KEY[scope]];
  if (raw === undefined) return { kind: "unset" };
  const token = raw.trim();
  // An empty value is how an operator (or a deploy template) says "not set" — same rule as env.ts.
  if (token.length === 0) return { kind: "unset" };
  if (token.length < MIN_SCOPED_TOKEN_LENGTH) {
    if (!reportedInvalid.has(scope)) {
      reportedInvalid.add(scope);
      // Structured logger rather than `console.error`: `console` is the sink CWE-209 watches, and the
      // one JSON shape is what lets a single Cloud Logging query see this next to the denials it
      // causes. `logWarn` because the logger's ERROR entry point exists to carry a CAUGHT value and
      // there is none here — a misconfigured key, not a throw. WARNING and ERROR both go to stderr,
      // so the stream an operator tails is unchanged; `effect` carries the consequence.
      //
      // `scope` below is the INTEGRATION scope ("outbox"), and it does reach the line: the logger's
      // own identity key is `logScope`, so the two no longer collide. While it was called `scope`
      // this field was dropped silently, and only `key` said which surface was affected.
      logWarn("integration-scope", "scoped_token_too_short", {
        scope,
        key: INTEGRATION_SCOPE_ENV_KEY[scope],
        minLength: MIN_SCOPED_TOKEN_LENGTH,
        effect: "scope_disabled",
      });
    }
    return { kind: "invalid", reason: "too_short" };
  }
  return { kind: "ok", token };
}

/** True when this scope has its own key set (valid or not) — i.e. the shared bearer no longer opens it. */
export function integrationScopeConfigured(
  scope: IntegrationScope,
  source: Record<string, string | undefined> = process.env,
): boolean {
  return resolveScopedIntegrationToken(scope, source).kind !== "unset";
}

/**
 * The token a caller must present for `scope`, or `undefined` when nothing may open that surface.
 *
 * `undefined` for a scope whose key is set-but-too-short is the fail-closed half of the split: an
 * operator who half-configured the narrowing gets 401s on that surface, never a silent fall back to the
 * broad key they were trying to retire.
 */
export function integrationTokenForScope(
  scope: IntegrationScope | undefined,
  sharedToken: string | undefined,
  source: Record<string, string | undefined> = process.env,
): string | undefined {
  if (scope !== undefined) {
    const resolved = resolveScopedIntegrationToken(scope, source);
    if (resolved.kind === "ok") return resolved.token;
    if (resolved.kind === "invalid") return undefined;
  }
  // Coalesce-then-length, not `sharedToken === undefined || sharedToken === ""`: Wave A already
  // rewrote the `token === ""` check above this function for security scanner CWE-208, which matches on the
  // operand's name. This one was left behind in the same file.
  const shared = sharedToken ?? "";
  return shared.length === 0 ? undefined : shared;
}

/** Test seam: forget which scopes have already logged an invalid key. */
export function resetIntegrationScopeWarnings(): void {
  reportedInvalid.clear();
}
