/**
 * Runtime environment — node only, layer L2.
 *
 * `env` is evaluated at import so a misconfigured serving process fails closed at boot:
 * `src/instrumentation.ts` imports this module during `next start`.
 * Errors list offending KEY NAMES only — never values.
 *
 * Environment classification: `APP_ENV` — set explicitly per deployment by Terraform — says WHICH
 * environment a process serves (local | dev | production); `NODE_ENV` says only whether it serves a production
 * BUILD. Cloud Run runs every image, dev included, with NODE_ENV=production, so the production-only rules (Okta
 * required, dev login forbidden) key on `APP_ENV === "production"`, and a production build served under any other
 * label (a "deployed dev" instance, or a local `next start`) gets its own, smaller rule set.
 */
import { z } from "zod";
import { isValidGoogleDomainList, isValidGoogleGroupList } from "@/lib/google-domain";
import { isValidOktaGroupsClaim, isValidOktaScope } from "@/lib/okta-groups";
import { demoMode, isStandInUrl } from "@/lib/demo/mode";

export type AppEnvLabel = "local" | "dev" | "demo" | "production";

export type Env = {
  NODE_ENV: "development" | "test" | "production";
  DATABASE_URL: string | undefined;
  /** Optional; when set, publicDb's base client uses it (`datasourceUrl`) — a SELECT-only role in production. */
  PUBLIC_DATABASE_URL: string | undefined;
  AUTH_SECRET: string | undefined;
  AUTH_OKTA_ID: string | undefined;
  AUTH_OKTA_SECRET: string | undefined;
  AUTH_OKTA_ISSUER: string | undefined;
  /** Optional, trimmed; when set must contain the token `openid`. Unset = "openid profile email groups". */
  AUTH_OKTA_SCOPE: string | undefined;
  /** Optional, trimmed; when set must be an identifier (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/). Unset = "groups". */
  AUTH_OKTA_GROUPS_CLAIM: string | undefined;

  // --- Temporary Google sign-in (src/lib/google-domain.ts). Okta is still the sign-in method this desk is
  // built around and is still MANDATORY in production; these four ADD a domain-restricted Google provider
  // wherever they are set, and never substitute for the Okta trio in production. Retiring the whole feature
  // is unsetting the pair. All four are optional and all four fail closed.

  /** OAuth 2.0 client id. The pair AUTH_GOOGLE_ID + AUTH_GOOGLE_SECRET is what registers the provider. */
  AUTH_GOOGLE_ID: string | undefined;
  /** OAuth 2.0 client secret. Unset (either half) = no Google provider is registered at all. */
  AUTH_GOOGLE_SECRET: string | undefined;
  /**
   * Comma-separated domain allowlist. Unset means the HARDCODED DEFAULT (example.com,
   * example.net) — never "every domain". A value that is set but is not a list of bare domains is refused
   * at boot by key name.
   */
  AUTH_GOOGLE_ALLOWED_DOMAINS: string | undefined;
  /**
   * Comma-separated internal group names granted to a Google sign-in. Unset = `[]` = the person
   * authenticates and lands on /no-access — deliberate. An unknown name is refused at boot, because a
   * typo that grants nothing silently is indistinguishable from an RBAC bug.
   */
  AUTH_GOOGLE_GROUPS: string | undefined;

  /** raw === "true" */
  AUTH_DEV_LOGIN: boolean;
  /** integer >= 0, default 0 */
  TRUSTED_PROXY_HOPS: number;
  CLIENT_API_TOKEN: string | undefined;
  /** default "local" */
  APP_ENV: AppEnvLabel;

  // ---------------------------------------------------------------------------
  // Wave A. Every one is OPTIONAL and FAIL-CLOSED: unset means the feature
  // it gates is DISABLED, never "on with a default". Nothing in this wave can transmit anything
  // unless its key is present, which is how "built but not sending" is enforced mechanically rather
  // than by convention. A key that is SET but malformed is refused at boot by key name.
  // ---------------------------------------------------------------------------

  /** Machine bearer for /api/ingest/*, /api/export/* and /api/integrations/*. Unset = those routes 401. */
  INTEGRATION_API_TOKEN: string | undefined;
  // Per-surface machine bearers, resolved by `src/lib/integration-scope.ts`. Each one NARROWS: where it
  // is set, INTEGRATION_API_TOKEN no longer opens that surface, so one workflow's credential can be
  // split off without rotating all four at once. Unset = that surface falls back to the shared bearer,
  // which is today's behaviour byte for byte. Declared here so an operator sees the whole credential
  // surface in one place and a short value is refused at boot like every other shared secret.
  /** Machine bearer for /api/ingest/* only. Unset = that surface falls back to INTEGRATION_API_TOKEN. */
  INGEST_API_TOKEN: string | undefined;
  /** Machine bearer for /api/export/* only. Unset = that surface falls back to INTEGRATION_API_TOKEN. */
  EXPORT_API_TOKEN: string | undefined;
  /** Machine bearer for /api/integrations/* only. Unset = that surface falls back to INTEGRATION_API_TOKEN. */
  OUTBOX_API_TOKEN: string | undefined;
  /** HMAC key for the outbound reply token (S2/S3 share the format). Unset = no reply-token threading. */
  REPLY_TOKEN_SECRET: string | undefined;
  /**
   * Comma-separated reply-token secrets that are still ACCEPTED but never used to sign. Rotating
   * REPLY_TOKEN_SECRET invalidates every token already sitting in a client's mailbox; listing the old
   * value here gives the rotation an overlap instead of a two-week manual tail.
   * Each entry obeys the same minimum length. Unset = only the current secret verifies.
   */
  REPLY_TOKEN_PREVIOUS_SECRETS: string | undefined;
  /**
   * Absolute https origin of the staff app, used for deep links in Slack alerts and other out-of-band
   * text. Unset = links degrade to bare paths (which still route for anyone with the app open).
   */
  APP_BASE_URL: string | undefined;
  /** JSON object: inbound address -> { queueKey, brand, category? }. Unset = every mailbox is unknown. */
  MAILBOX_MAP: string | undefined;
  /**
   * Comma-separated authserv-ids whose `Authentication-Results` verdict this desk acts on — the
   * hostname the RECEIVING MTA stamps on delivery (Google Workspace writes `mx.google.com`). Adding an
   * entry says "this host's word is enough to attribute a wire instruction to a client", so the value
   * is a property of where the mail lands and changes the day the desk leaves Workspace. Unset = the
   * module default in `src/lib/email/auth-results.ts`; an empty list would trust nobody and hold every
   * inbound message, so unset must NOT be read as an empty list.
   */
  EMAIL_TRUSTED_AUTHSERV_IDS: string | undefined;
  /** GCS bucket for attachments. Unset = the filesystem backend under .local-attachments/ (local dev). */
  ATTACHMENTS_BUCKET: string | undefined;
  /** Service account whose IAM signBlob mints V4 signatures. Unset = the metadata server's own identity. */
  ATTACHMENTS_SIGNER_EMAIL: string | undefined;
  /** Retention-locked bucket for the nightly duplicate copy. Unset = the duplicate-copy job logs and exits. */
  DUPLICATE_COPY_BUCKET: string | undefined;
  /** https Slack webhook for the SLA digest. Unset = the sweep still runs and audits, but posts nothing. */
  SLA_ALERT_SLACK_WEBHOOK_URL: string | undefined;
  /** JSON object: QueueKey -> https Slack webhook. Unset = event alerts run and audit, but post nothing. */
  SLACK_QUEUE_WEBHOOKS: string | undefined;
  /** Email of the seeded SYSTEM actor the jobs runtime acts as. Unset = the seeded default. */
  JOB_ACTOR_EMAIL: string | undefined;

  // ---------------------------------------------------------------------------
  // Wave B. Same rule as Wave A, without exception: every key is
  // OPTIONAL and FAIL-CLOSED. Unset DISABLES the feature it gates; it never enables one with a
  // default. A key that is SET but malformed is refused at boot by key name. Nothing in this wave
  // transmits anything unless its key is present, and no key is set anywhere.
  // ---------------------------------------------------------------------------

  /** JSON object: staff email -> Slack member id. Unset = no Slack DM is ever attempted. */
  SLACK_USER_MAP: string | undefined;
  /**
   * Web-push (RFC 8291 / VAPID). All three are needed together: without the pair there is no key to
   * sign with, and without a subject the push services refuse the JWT. Any one missing disables push
   * entirely — the subscribe route 404s and `sendWebPush` returns "disabled".
   */
  VAPID_PUBLIC_KEY: string | undefined;
  VAPID_PRIVATE_KEY: string | undefined;
  /** `mailto:` or `https:` contact for the push service operator, per RFC 8292 §2.1. */
  VAPID_SUBJECT: string | undefined;
  /** "vertex" is the only implemented provider. Unset = the AI draft seam is off and the button hides. */
  AI_DRAFTING_PROVIDER: string | undefined;
  VERTEX_PROJECT: string | undefined;
  /** e.g. `us-central1`. Unset with a provider set is a misconfiguration and is refused at boot. */
  VERTEX_LOCATION: string | undefined;
  VERTEX_MODEL: string | undefined;
  /** Days a RESOLVED ticket waits before the auto-close job closes it. Unset = the job exits 0. */
  AUTO_CLOSE_DAYS: number | undefined;
  /** "true" enables the SYSTEM auto-acknowledgement on a newly ingested ticket. */
  AUTO_ACK_ENABLED: boolean;
  /** "true" enables the SYSTEM resolved notice when a ticket reaches RESOLVED. */
  RESOLVED_NOTICE_ENABLED: boolean;
  /** Hour of the firm day (0..23) the digest job posts. Unset = 8. */
  DIGEST_HOUR_LOCAL: number | undefined;
  /** "true" arms the outbound webhook dispatcher. Unset = endpoints can be configured but nothing sends. */
  WEBHOOKS_ENABLED: boolean;
  /**
   * The APP-HELD half of every outbound webhook signing key. An endpoint row stores a random
   * per-endpoint salt and NOT a signable credential; the key the receiver verifies with is
   * `HMAC-SHA256(WEBHOOK_SIGNING_KEY, "<domain>:<salt>")`, so a database compromise on its own yields
   * nothing that can forge a signature. Unset = no endpoint can be created and nothing can be signed:
   * the dispatcher records an unsigned delivery as an ordinary failure rather than sending unsigned.
   */
  WEBHOOK_SIGNING_KEY: string | undefined;
  /** "true" serves POST /api/mcp. Unset = the route answers 404 to everyone, bearer or not. */
  MCP_ENABLED: boolean;
  /**
   * Comma-separated domains a requester address may use OUTSIDE production. A dev or local instance
   * with real-looking fixtures must never be able to email a real client, so when this is set an
   * address outside the list is refused at ingest. Unset = no domain guard (production behaviour).
   */
  ALLOWED_REQUESTER_DOMAINS: string | undefined;

  // legacy help desk export tooling (scripts/legacy-desk-export, tools/help-center). Declared here so an operator
  // can see the whole surface in one place; the APP never reads them at runtime.
  LEGACY_DESK_SUBDOMAIN: string | undefined;
  LEGACY_DESK_EMAIL: string | undefined;
  LEGACY_DESK_API_TOKEN: string | undefined;
};

/** Shared minimum for every shared secret in this app (CLIENT_API_TOKEN's existing rule, generalised). */
export const MIN_SECRET_LENGTH = 32;

/** A JSON object, not an array and not a scalar — the shape both JSON-valued keys must have. */
function isJsonObject(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** An absolute https URL. A webhook is an outbound credential in a URL: http would leak it. */
function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

/** base64url, as the Web Push API hands the browser's keys over. No padding, no `+` or `/`. */
function isBase64Url(raw: string): boolean {
  return /^[A-Za-z0-9_-]{16,256}$/.test(raw);
}

/** RFC 8292 §2.1: the VAPID `sub` claim is a `mailto:` or `https:` URI identifying the operator. */
function isVapidSubject(raw: string): boolean {
  return /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) || isHttpsUrl(raw);
}

/** The AI providers this repo implements. Anything else is a typo, not an extension point. */
// "demo" is the canned-draft provider (src/lib/ai/demo.ts); it drafts only in demo mode.
const AI_PROVIDERS: readonly string[] = ["vertex", "demo"];

const NODE_ENVS = ["development", "test", "production"] as const;
// "demo" is the public portfolio demo: treated like "dev" everywhere, with its own banner.
const APP_ENVS = ["local", "dev", "demo", "production"] as const;

/** dotenv files routinely carry `KEY=` placeholders: an empty or whitespace-only value counts as unset. */
const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined),
  z.string().optional(),
);

/** Same unset rule, trimmed: the auth module reads these two literally and trims them the same way (okta-groups). */
const optionalTrimmedString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
  z.string().optional(),
);

/** An optional positive integer: blank counts as unset, `0` and negatives are refused by key name. */
const optionalPositiveInt = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
  z.coerce.number().int().positive().optional(),
);

/** An optional hour of the day, 0..23 inclusive. */
const optionalHour = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
  z.coerce.number().int().min(0).max(23).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.preprocess(
    (v) => (v === undefined || (typeof v === "string" && v.trim() === "") ? "development" : v),
    z.enum(NODE_ENVS),
  ),
  DATABASE_URL: optionalString,
  PUBLIC_DATABASE_URL: optionalString,
  AUTH_SECRET: optionalString,
  AUTH_OKTA_ID: optionalString,
  AUTH_OKTA_SECRET: optionalString,
  AUTH_OKTA_ISSUER: optionalString,
  // the shared advisor platform app needs scope "openid email profile ops_portal_groups" and claim "OpsPortalGroups". A value
  // that is set but malformed is refused by key name (the auth module would otherwise fall back to the default
  // silently, which is not what an operator who set the variable intended).
  AUTH_OKTA_SCOPE: optionalTrimmedString.refine((v) => v === undefined || isValidOktaScope(v)),
  AUTH_OKTA_GROUPS_CLAIM: optionalTrimmedString.refine((v) => v === undefined || isValidOktaGroupsClaim(v)),
  AUTH_GOOGLE_ID: optionalString,
  AUTH_GOOGLE_SECRET: optionalString,
  // Both lists are refused by key name when SET but unusable — the AUTH_OKTA_SCOPE rule, for
  // the same reason: the runtime helpers fall back to a safe default, and a silent fall-back is not what an
  // operator who wrote the variable asked for. A blank value is "unset" and keeps the defaults; `",,,"` is
  // a written value that means nothing and is refused.
  AUTH_GOOGLE_ALLOWED_DOMAINS: optionalTrimmedString.refine((v) => v === undefined || isValidGoogleDomainList(v)),
  AUTH_GOOGLE_GROUPS: optionalTrimmedString.refine((v) => v === undefined || isValidGoogleGroupList(v)),
  // Literal read: only the exact string "true" enables dev login (same rule as isDevLoginEnabled).
  AUTH_DEV_LOGIN: z.preprocess((v) => v === "true", z.boolean()),
  TRUSTED_PROXY_HOPS: z.preprocess(
    (v) => (v === undefined || (typeof v === "string" && v.trim() === "") ? 0 : v),
    z.coerce.number().int().min(0),
  ),
  CLIENT_API_TOKEN: optionalString,
  // --- Wave A. Shape only here; the length / disabled-when-unset rules are the invariant blocks below,
  // so a local developer can still run without any of them. A malformed JSON or non-https value is
  // refused HERE, in every mode: an operator who set the variable meant it to work.
  INTEGRATION_API_TOKEN: optionalString,
  INGEST_API_TOKEN: optionalString,
  EXPORT_API_TOKEN: optionalString,
  OUTBOX_API_TOKEN: optionalString,
  REPLY_TOKEN_SECRET: optionalString,
  REPLY_TOKEN_PREVIOUS_SECRETS: optionalString,
  APP_BASE_URL: optionalTrimmedString.refine((v) => v === undefined || isHttpsUrl(v)),
  MAILBOX_MAP: optionalTrimmedString.refine((v) => v === undefined || isJsonObject(v)),
  EMAIL_TRUSTED_AUTHSERV_IDS: optionalTrimmedString,
  ATTACHMENTS_BUCKET: optionalTrimmedString,
  ATTACHMENTS_SIGNER_EMAIL: optionalTrimmedString,
  DUPLICATE_COPY_BUCKET: optionalTrimmedString,
  // https only, except the demo's loopback Slack stand-in (src/lib/demo/mode.ts), refused outside demo mode.
  SLA_ALERT_SLACK_WEBHOOK_URL: optionalTrimmedString.refine((v) => v === undefined || isHttpsUrl(v) || isStandInUrl(v)),
  SLACK_QUEUE_WEBHOOKS: optionalTrimmedString.refine((v) => v === undefined || isJsonObject(v)),
  JOB_ACTOR_EMAIL: optionalTrimmedString,
  // --- Wave B. Shape only here; the "needed together" rules are the invariant block below, so a
  // local developer can still run with none of them set. ---
  SLACK_USER_MAP: optionalTrimmedString.refine((v) => v === undefined || isJsonObject(v)),
  VAPID_PUBLIC_KEY: optionalTrimmedString.refine((v) => v === undefined || isBase64Url(v)),
  VAPID_PRIVATE_KEY: optionalTrimmedString.refine((v) => v === undefined || isBase64Url(v)),
  VAPID_SUBJECT: optionalTrimmedString.refine((v) => v === undefined || isVapidSubject(v)),
  AI_DRAFTING_PROVIDER: optionalTrimmedString.refine((v) => v === undefined || AI_PROVIDERS.includes(v)),
  VERTEX_PROJECT: optionalTrimmedString,
  VERTEX_LOCATION: optionalTrimmedString,
  VERTEX_MODEL: optionalTrimmedString,
  AUTO_CLOSE_DAYS: optionalPositiveInt,
  AUTO_ACK_ENABLED: z.preprocess((v) => v === "true", z.boolean()),
  RESOLVED_NOTICE_ENABLED: z.preprocess((v) => v === "true", z.boolean()),
  DIGEST_HOUR_LOCAL: optionalHour,
  WEBHOOKS_ENABLED: z.preprocess((v) => v === "true", z.boolean()),
  WEBHOOK_SIGNING_KEY: optionalString,
  MCP_ENABLED: z.preprocess((v) => v === "true", z.boolean()),
  ALLOWED_REQUESTER_DOMAINS: optionalTrimmedString,
  LEGACY_DESK_SUBDOMAIN: optionalTrimmedString,
  LEGACY_DESK_EMAIL: optionalTrimmedString,
  LEGACY_DESK_API_TOKEN: optionalString,
  // Unknown labels are refused by key name (zod enum): only local | dev | demo | production exist.
  APP_ENV: z.preprocess(
    (v) => (v === undefined || (typeof v === "string" && v.trim() === "") ? "local" : v),
    z.enum(APP_ENVS),
  ),
});

function keyNamesOf(issues: readonly { path: PropertyKey[] }[]): string[] {
  const names = new Set<string>();
  for (const issue of issues) {
    const head = issue.path[0];
    names.add(head === undefined ? "(root)" : String(head));
  }
  return [...names].sort();
}

function hasOktaTrio(env: Env): boolean {
  return env.AUTH_OKTA_ID !== undefined && env.AUTH_OKTA_SECRET !== undefined && env.AUTH_OKTA_ISSUER !== undefined;
}

/**
 * Whether the temporary Google provider is configured. The domain allowlist is deliberately NOT part of
 * this: it always resolves (unset = the hardcoded default), so the pair is the whole condition, and
 * `isGoogleConfigured()` in `src/auth.config.ts` re-checks the allowlist anyway before registering.
 */
function hasGooglePair(env: Env): boolean {
  return env.AUTH_GOOGLE_ID !== undefined && env.AUTH_GOOGLE_SECRET !== undefined;
}

/**
 * APP_ENV === "production" (whatever NODE_ENV says): Okta is the only sign-in method and dev login is refused
 * outright; the signing secret, the database and a trusted-hop count are mandatory; a client-API token, when
 * present, is at least 32 characters.
 */
function productionInvariantViolations(env: Env): string[] {
  const offending: string[] = [];
  if (env.AUTH_DEV_LOGIN) offending.push("AUTH_DEV_LOGIN");
  if (env.AUTH_SECRET === undefined) offending.push("AUTH_SECRET");
  if (env.AUTH_OKTA_ID === undefined) offending.push("AUTH_OKTA_ID");
  if (env.AUTH_OKTA_SECRET === undefined) offending.push("AUTH_OKTA_SECRET");
  if (env.AUTH_OKTA_ISSUER === undefined) offending.push("AUTH_OKTA_ISSUER");
  if (env.DATABASE_URL === undefined) offending.push("DATABASE_URL");
  if (env.TRUSTED_PROXY_HOPS < 1) offending.push("TRUSTED_PROXY_HOPS");
  offending.push(...shortSecretViolations(env));
  return offending;
}

/**
 * every shared secret is at least MIN_SECRET_LENGTH characters wherever the process is
 * network-reachable. A short bearer is worse than no bearer — it looks like protection.
 */
function shortSecretViolations(env: Env): string[] {
  const offending: string[] = [];
  const secrets: readonly (keyof Env)[] = [
    "CLIENT_API_TOKEN",
    "INTEGRATION_API_TOKEN",
    "INGEST_API_TOKEN",
    "EXPORT_API_TOKEN",
    "OUTBOX_API_TOKEN",
    "REPLY_TOKEN_SECRET",
    "WEBHOOK_SIGNING_KEY",
  ];
  for (const key of secrets) {
    const value = env[key];
    if (typeof value === "string" && value.length < MIN_SECRET_LENGTH) offending.push(key);
  }
  // A retired secret still VERIFIES tokens, so it is held to the same length as the current one. An
  // empty list entry (a trailing comma) is not a secret and is simply ignored by the parser.
  if (previousReplySecrets(env.REPLY_TOKEN_PREVIOUS_SECRETS).some((v) => v.length < MIN_SECRET_LENGTH)) {
    offending.push("REPLY_TOKEN_PREVIOUS_SECRETS");
  }
  return offending;
}

/**
 * The trusted authserv-ids, or `undefined` when the key is unset or lists nothing usable — which the
 * caller must read as "use the module default", never as "trust nobody". An empty list is fail-closed
 * in the wrong direction: it would hold every inbound message rather than the forged ones.
 */
export function trustedAuthservIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const ids = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
  return ids.length === 0 ? undefined : [...new Set(ids)];
}

/**
 * The retired reply-token secrets, in the order they should be tried after the current one.
 * Comma-separated, trimmed, empties dropped, duplicates removed. Exported so the verifier and the
 * invariant check cannot disagree about what the variable means.
 */
export function previousReplySecrets(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value !== "") seen.add(value);
  }
  return [...seen];
}

/**
 * NODE_ENV === "production" && APP_ENV !== "production" — a production build served as dev or local (the Cloud Run
 * dev service, a local `next start`). Such an instance is reachable over the network, so it still needs the signing
 * secret, the database and a trusted-hop count, plus AT LEAST ONE sign-in method: the complete Okta trio, the
 * temporary Google pair, or AUTH_DEV_LOGIN=true (Decision #57 — before an Okta application exists, the personas
 * were the only way in, and the domain-restricted Google provider is the second). A client-API token, when
 * present, is at least 32 characters here too: the dev service is publicly routable.
 *
 * This is the ONLY check Google widens. The production block above is untouched on purpose: Okta stays
 * mandatory where APP_ENV=production, so Google can be ADDED to production but can never REPLACE Okta there.
 */
function deployedInvariantViolations(env: Env): string[] {
  const offending: string[] = [];
  if (env.AUTH_SECRET === undefined) offending.push("AUTH_SECRET");
  if (env.DATABASE_URL === undefined) offending.push("DATABASE_URL");
  if (env.TRUSTED_PROXY_HOPS < 1) offending.push("TRUSTED_PROXY_HOPS");
  if (!hasOktaTrio(env) && !hasGooglePair(env) && !env.AUTH_DEV_LOGIN) {
    // Every key that WOULD satisfy the check is named, because this message is the operator's instruction
    // sheet: a Google-only dev service is now a legitimate shape, and a message that named only Okta and the
    // personas would send them to configure the wrong thing.
    offending.push(
      "AUTH_DEV_LOGIN",
      "AUTH_OKTA_ID",
      "AUTH_OKTA_SECRET",
      "AUTH_OKTA_ISSUER",
      "AUTH_GOOGLE_ID",
      "AUTH_GOOGLE_SECRET",
    );
  }
  offending.push(...shortSecretViolations(env));
  return offending;
}

/** Which check refused the environment. Chooses the message prefix; also useful to an operator. */
export type EnvInvariantKind = "shape" | "production" | "deployed";

const ENV_INVARIANT_PREFIX: Record<EnvInvariantKind, string> = {
  shape: "Invalid environment configuration for",
  production: "Production environment invariants violated for",
  deployed: "Deployed environment invariants violated for",
};

/**
 * The failure `parseEnv` throws, carrying the offending variable NAMES as data.
 *
 * The message has always named the keys and never their values, and it still reads exactly as it did.
 * The point of the class is that `keys` is now STRUCTURED: `src/app/api/health/route.ts` logs through
 * `@/lib/logger`, which records `errorLabel(e)` and deliberately nothing derived from a message
 * (CWE-209). A misconfiguration that only says "Error" in Cloud Logging is a
 * 503 nobody can diagnose, so the probe reads `keys` off the error and logs it as its own field —
 * which is safe for the same reason the message always was, because these are the names of the
 * variables, never their contents. Nothing here ever holds a value.
 *
 * `errorLabel(e)` also improves on its own: the line now reads `EnvInvariantError`, not `Error`.
 */
export class EnvInvariantError extends Error {
  /** Which of the three checks refused. */
  readonly kind: EnvInvariantKind;
  /** The offending variable NAMES, in the order the check reports them. Never their values. */
  readonly keys: readonly string[];

  constructor(kind: EnvInvariantKind, keys: readonly string[]) {
    super(`${ENV_INVARIANT_PREFIX[kind]}: ${keys.join(", ")}`);
    this.name = "EnvInvariantError";
    this.kind = kind;
    this.keys = [...keys];
  }
}

/**
 * The offending variable names when `e` is an {@link EnvInvariantError}, otherwise null.
 *
 * The accessor exists so a caller that must not import much — the health probe holds a closed
 * three-module import allowlist (guardrail G13) — can read the names without a second import or an
 * `instanceof` against a class it would have to name.
 */
export function envInvariantKeys(e: unknown): readonly string[] | null {
  return e instanceof EnvInvariantError ? e.keys : null;
}

/**
 * Wave B key groups that are all-or-nothing. Returns the names of every key in a group that is
 * partially set — the group's own names, so an operator reads "VAPID_PRIVATE_KEY, VAPID_SUBJECT" and
 * knows exactly what is missing. Values never appear.
 *
 * Why refuse rather than degrade: the alternative is a deployment that looks configured and silently
 * is not. A VAPID public key with no private key means every push subscription succeeds in the browser
 * and nothing is ever delivered; `AI_DRAFTING_PROVIDER=vertex` with no project means the draft button
 * appears and fails on click. Both are worse than an unset feature and much worse than a boot error.
 */
function incompleteGroupViolations(env: Env): string[] {
  const offending: string[] = [];
  const vapid: readonly (keyof Env)[] = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];
  const vapidSet = vapid.filter((k) => env[k] !== undefined);
  if (vapidSet.length > 0 && vapidSet.length < vapid.length) offending.push(...vapid);

  if (env.AI_DRAFTING_PROVIDER === "vertex") {
    for (const k of ["VERTEX_PROJECT", "VERTEX_LOCATION", "VERTEX_MODEL"] as const) {
      if (env[k] === undefined) offending.push(k);
    }
  }
  return [...new Set(offending)];
}

/**
 * Whether web push is configured at all. One predicate, so the subscribe route, the dispatcher and the
 * /admin/flags view cannot disagree about it.
 */
export function isWebPushEnabled(env: Env): boolean {
  return (
    env.VAPID_PUBLIC_KEY !== undefined && env.VAPID_PRIVATE_KEY !== undefined && env.VAPID_SUBJECT !== undefined
  );
}

/** Whether the AI draft seam is configured. Same reasoning as `isWebPushEnabled`. */
export function isAiDraftingEnabled(env: Env): boolean {
  if (env.AI_DRAFTING_PROVIDER === "demo") return demoMode();
  return (
    env.AI_DRAFTING_PROVIDER !== undefined &&
    env.VERTEX_PROJECT !== undefined &&
    env.VERTEX_LOCATION !== undefined &&
    env.VERTEX_MODEL !== undefined
  );
}

/**
 * The requester-domain allowlist, or `undefined` when the key is unset — which the caller must read as
 * "no domain guard", never as "allow nothing". Lower-cased, deduped, empties dropped; an entry may be
 * written with or without a leading dot.
 */
export function allowedRequesterDomains(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const domains = raw
    .split(",")
    .map((part) => part.trim().toLowerCase().replace(/^\./, ""))
    .filter((part) => part !== "");
  return domains.length === 0 ? undefined : [...new Set(domains)];
}

/**
 * Options for `parseEnv`. `enforceProductionInvariants` (default true) switches the SERVING-PROCESS invariant
 * blocks on. It is switched off in exactly one place — the module-level `env` of a process that serves no
 * request: the `next build` worker (`isNextBuildPhase`, decision #43) and a plain node/tsx process such as
 * `prisma db seed` (`isNextServerProcess`, decision #57). The name is kept from #43; it covers both blocks.
 */
export type ParseEnvOptions = { enforceProductionInvariants?: boolean };

/**
 * Parses and validates the process environment. Shape (key names, enum values, integer hops) is always validated.
 * With the invariants enforced (the default):
 *   - APP_ENV === "production": AUTH_DEV_LOGIN must be false; AUTH_SECRET, AUTH_OKTA_ID/SECRET/ISSUER and
 *     DATABASE_URL are required; TRUSTED_PROXY_HOPS >= 1; CLIENT_API_TOKEN, when set, has length >= 32.
 *   - NODE_ENV === "production" && APP_ENV !== "production" (deployed dev / local `next start`): AUTH_SECRET and
 *     DATABASE_URL are required; TRUSTED_PROXY_HOPS >= 1; the Okta trio OR the Google pair OR
 *     AUTH_DEV_LOGIN=true; CLIENT_API_TOKEN, when set, has length >= 32.
 *   - otherwise (NODE_ENV development/test): no invariant.
 * Throws an {@link EnvInvariantError} naming the offending keys only — values are never echoed, and
 * `keys` carries the same names structurally for a caller that has to log them.
 */
export function parseEnv(raw: NodeJS.ProcessEnv, options: ParseEnvOptions = {}): Env {
  const enforceProductionInvariants = options.enforceProductionInvariants ?? true;
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EnvInvariantError("shape", keyNamesOf(parsed.error.issues));
  }
  const d = parsed.data;
  const env: Env = {
    NODE_ENV: d.NODE_ENV,
    DATABASE_URL: d.DATABASE_URL,
    PUBLIC_DATABASE_URL: d.PUBLIC_DATABASE_URL,
    AUTH_SECRET: d.AUTH_SECRET,
    AUTH_OKTA_ID: d.AUTH_OKTA_ID,
    AUTH_OKTA_SECRET: d.AUTH_OKTA_SECRET,
    AUTH_OKTA_ISSUER: d.AUTH_OKTA_ISSUER,
    AUTH_OKTA_SCOPE: d.AUTH_OKTA_SCOPE,
    AUTH_OKTA_GROUPS_CLAIM: d.AUTH_OKTA_GROUPS_CLAIM,
    AUTH_GOOGLE_ID: d.AUTH_GOOGLE_ID,
    AUTH_GOOGLE_SECRET: d.AUTH_GOOGLE_SECRET,
    AUTH_GOOGLE_ALLOWED_DOMAINS: d.AUTH_GOOGLE_ALLOWED_DOMAINS,
    AUTH_GOOGLE_GROUPS: d.AUTH_GOOGLE_GROUPS,
    AUTH_DEV_LOGIN: d.AUTH_DEV_LOGIN,
    TRUSTED_PROXY_HOPS: d.TRUSTED_PROXY_HOPS,
    CLIENT_API_TOKEN: d.CLIENT_API_TOKEN,
    APP_ENV: d.APP_ENV,
    INTEGRATION_API_TOKEN: d.INTEGRATION_API_TOKEN,
    INGEST_API_TOKEN: d.INGEST_API_TOKEN,
    EXPORT_API_TOKEN: d.EXPORT_API_TOKEN,
    OUTBOX_API_TOKEN: d.OUTBOX_API_TOKEN,
    REPLY_TOKEN_SECRET: d.REPLY_TOKEN_SECRET,
    REPLY_TOKEN_PREVIOUS_SECRETS: d.REPLY_TOKEN_PREVIOUS_SECRETS,
    APP_BASE_URL: d.APP_BASE_URL,
    MAILBOX_MAP: d.MAILBOX_MAP,
    EMAIL_TRUSTED_AUTHSERV_IDS: d.EMAIL_TRUSTED_AUTHSERV_IDS,
    ATTACHMENTS_BUCKET: d.ATTACHMENTS_BUCKET,
    ATTACHMENTS_SIGNER_EMAIL: d.ATTACHMENTS_SIGNER_EMAIL,
    DUPLICATE_COPY_BUCKET: d.DUPLICATE_COPY_BUCKET,
    SLA_ALERT_SLACK_WEBHOOK_URL: d.SLA_ALERT_SLACK_WEBHOOK_URL,
    SLACK_QUEUE_WEBHOOKS: d.SLACK_QUEUE_WEBHOOKS,
    JOB_ACTOR_EMAIL: d.JOB_ACTOR_EMAIL,
    SLACK_USER_MAP: d.SLACK_USER_MAP,
    VAPID_PUBLIC_KEY: d.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: d.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: d.VAPID_SUBJECT,
    AI_DRAFTING_PROVIDER: d.AI_DRAFTING_PROVIDER,
    VERTEX_PROJECT: d.VERTEX_PROJECT,
    VERTEX_LOCATION: d.VERTEX_LOCATION,
    VERTEX_MODEL: d.VERTEX_MODEL,
    AUTO_CLOSE_DAYS: d.AUTO_CLOSE_DAYS,
    AUTO_ACK_ENABLED: d.AUTO_ACK_ENABLED,
    RESOLVED_NOTICE_ENABLED: d.RESOLVED_NOTICE_ENABLED,
    DIGEST_HOUR_LOCAL: d.DIGEST_HOUR_LOCAL,
    WEBHOOKS_ENABLED: d.WEBHOOKS_ENABLED,
    WEBHOOK_SIGNING_KEY: d.WEBHOOK_SIGNING_KEY,
    MCP_ENABLED: d.MCP_ENABLED,
    ALLOWED_REQUESTER_DOMAINS: d.ALLOWED_REQUESTER_DOMAINS,
    LEGACY_DESK_SUBDOMAIN: d.LEGACY_DESK_SUBDOMAIN,
    LEGACY_DESK_EMAIL: d.LEGACY_DESK_EMAIL,
    LEGACY_DESK_API_TOKEN: d.LEGACY_DESK_API_TOKEN,
  };

  // keys that are only meaningful TOGETHER. Checked in every mode, not only in a serving
  // process, because a half-configured feature is a configuration mistake wherever it is written and
  // the failure it produces otherwise (a push that silently never sends, a draft button that 500s)
  // is invisible. Each check names the keys, never the values.
  const incomplete = incompleteGroupViolations(env);
  if (incomplete.length > 0) {
    throw new Error(`Environment keys must be set together, and these are not: ${incomplete.join(", ")}`);
  }

  if (enforceProductionInvariants) {
    if (env.APP_ENV === "production") {
      const offending = productionInvariantViolations(env);
      if (offending.length > 0) {
        throw new EnvInvariantError("production", offending);
      }
    } else if (env.NODE_ENV === "production") {
      const offending = deployedInvariantViolations(env);
      if (offending.length > 0) {
        throw new EnvInvariantError("deployed", offending);
      }
    }
  }

  return env;
}

/**
 * True only inside the `next build` worker. Next sets NEXT_PHASE=phase-production-build (with
 * NODE_ENV=production) while "Collecting page data", which evaluates every server module once to read its
 * route config and serves no request. The serving-process invariants (Okta credentials, TRUSTED_PROXY_HOPS >= 1,
 * no dev login) are therefore not demanded of that worker — the build must not need Okta credentials — but they
 * ARE demanded of every serving process: `src/instrumentation.ts` `register()` runs the strict
 * `parseEnv(process.env)` at `next start`, before the first request, regardless of NEXT_PHASE (I6, I9, §k;
 * decision #43). `next start` never sets phase-production-build.
 */
export const isNextBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

/**
 * True inside a Next.js server process — `next dev`, `next start` (the standalone `server.js` included) and the
 * `next build` worker. Next compiles `process.env.NEXT_RUNTIME` into its server bundles as the literal "nodejs"
 * ("edge" for edge bundles; `src/instrumentation.ts` keys on the same value), so inside a built bundle it cannot
 * be unset from outside. A plain node/tsx process — `prisma db seed` as run by the migrate job, a one-off script,
 * vitest — leaves it undefined. Such a process serves no request, so the module-level `env` below does not
 * demand the serving-process invariants of it: the migrate job carries only the owner DATABASE_URL, never
 * AUTH_SECRET or TRUSTED_PROXY_HOPS, and the seed keeps its own refusal (APP_ENV=production + SEED_DEV_FIXTURES).
 * Every serving process still runs the strict parse at boot (`src/instrumentation.ts`) and at its first request
 * (`assertServingInvariants`), neither of which reads this flag. Decision #57.
 */
export const isNextServerProcess = process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge";

/**
 * Parsed once at import — fail closed at boot for every serving process. Relaxed to shape validation only in the
 * two non-serving cases: the `next build` worker (#43) and a non-Next node process such as the seed (#57).
 */
export const env: Env = parseEnv(process.env, {
  enforceProductionInvariants: isNextServerProcess && !isNextBuildPhase,
});

let servingInvariantsChecked = false;

/**
 * Serving-time boot gate, independent of NEXT_PHASE and NEXT_RUNTIME. The module-level `env` above
 * relaxes the invariants inside the `next build` worker (NEXT_PHASE=phase-production-build) and outside Next server
 * processes. A serving process that INHERITS the build variable — e.g. a Docker image whose `ENV NEXT_PHASE=…` is
 * shared by its build and run stages — would otherwise never re-run the strict parse, because Next skips
 * `instrumentation.register()` under that phase, so the boot gate at `next start` never fires. This runs the strict
 * parse (`parseEnv` reads neither NEXT_PHASE nor NEXT_RUNTIME) the first time a request reaches a request context
 * or the health probe, so a misconfigured production or deployed-dev process fails closed on its first request
 * even when the boot gate was bypassed. It is memoised on success and re-throws on every call until it
 * succeeds. Cheap after the first request; a no-op when neither invariant block applies (NODE_ENV development/test
 * with APP_ENV local/dev).
 */
export function assertServingInvariants(): void {
  if (servingInvariantsChecked) return;
  parseEnv(process.env); // strict: enforceProductionInvariants defaults to true, regardless of NEXT_PHASE / NEXT_RUNTIME
  servingInvariantsChecked = true;
}
