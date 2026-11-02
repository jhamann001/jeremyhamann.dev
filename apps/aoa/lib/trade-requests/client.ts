import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import type { IdTokenClient } from "google-auth-library";
import { ServiceAuth } from "@/lib/demo/service-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { tradeRequestsNativeEnabled } from "@/lib/flags";
import { canUseTradeRequestsWorkspace, type TradeRequestsWorkspaceRole } from "./access";
import { loadNativeHandlers } from "./native";
import { nativeHandlerFor, type NativeHandler } from "./native/registry";
import { isAoaServed } from "./serving-state";
import { failedResult, finalResult, notSetUpResult, refusalCode } from "./service-response";
import { serviceFetch } from "@/lib/demo/stand-ins/fetch";

// The service trusts only the signed assertion for person and role, so the
// role is re-read from AOA's database on every call. Never log tokens, emails,
// names, URLs or bodies.

const DEFAULT_API_URL = "https://trade-request-123456789012.us-central1.run.app";
export const LOCAL_DELEGATED_CALLER = "aoa-local@delegated.invalid";
export const ASSERTION_LIFETIME_S = 120;
export const ASSERTION_REUSE_MS = 30_000;
export const RETRY_DELAYS_MS = [500, 1_000] as const;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const LOG_TAG = "trade-requests-delegated";
const NATIVE_LOG_EVENT = "trade_request_native_call";
// AOA DEV calls only the non-production Trade Request service (owner ruling on
// TDD OQ-1). Fails closed if a dev runtime is ever pointed at production.
const PRODUCTION_HOSTS = new Set([new URL(DEFAULT_API_URL).host, "trade.jeremyhamann.dev"]);
const DEV_RUNTIME_DOMAIN = "@ops-portal-dev.iam.gserviceaccount.com";
const IAM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

// Per-attempt limit and how many more attempts follow a missed or 502/503/504 response.
export const TRADE_REQUEST_OPERATIONS = {
  listRequests: { timeoutMs: 30_000, retries: 2 },
  requestCounts: { timeoutMs: 30_000, retries: 2 },
  requestDetail: { timeoutMs: 30_000, retries: 2 },
  checklistRead: { timeoutMs: 30_000, retries: 2 },
  clientList: { timeoutMs: 30_000, retries: 2 },
  lastAllocation: { timeoutMs: 30_000, retries: 2 },
  clientExclusions: { timeoutMs: 30_000, retries: 2 },
  householdResolve: { timeoutMs: 30_000, retries: 2 },
  notificationsList: { timeoutMs: 30_000, retries: 2 },
  resubmitRequest: { timeoutMs: 120_000, retries: 2 },
  statusChange: { timeoutMs: 30_000, retries: 2 },
  checklistSave: { timeoutMs: 30_000, retries: 2 },
  createRequest: { timeoutMs: 120_000, retries: 0 },
  exportExclusions: { timeoutMs: 30_000, retries: 0 },
  clientsExclusionsLookup: { timeoutMs: 30_000, retries: 0 },
  accountExclusionsLookup: { timeoutMs: 30_000, retries: 0 },
  exclusionSave: { timeoutMs: 30_000, retries: 0 },
  markNotificationRead: { timeoutMs: 30_000, retries: 0 },
  markAllNotificationsRead: { timeoutMs: 30_000, retries: 0 },
} as const satisfies Record<string, { timeoutMs: number; retries: 0 | 2 }>;

export type TradeRequestOperation = keyof typeof TRADE_REQUEST_OPERATIONS;

export type TradeRequestCall = {
  operation: TradeRequestOperation;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path below /api/aoa; callers encode id segments with encodeURIComponent. */
  path: `/${string}`;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body, sent unchanged on every attempt (create carries idempotencyKey here). */
  body?: unknown;
  /** Shown when there is no service text or failure description; always shown for bell calls. */
  defaultMessage: string;
  /** Bell calls never show the "not set up" message or service text. */
  channel?: "workspace" | "bell";
};

export type TradeRequestResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; outcome: "not_set_up"; message: string }
  | { ok: false; outcome: "failed"; status: number | null; message: string };

type Actor = { id: string; email: string; name: string; role: TradeRequestsWorkspaceRole };
type Config = { apiUrl: string; audience: string; localKey: string | null };
type Attempt =
  | { kind: "response"; status: number; body: unknown; malformed: boolean }
  | { kind: "no_response"; description: string }
  | { kind: "unconfirmed" };

class DeadlineExceeded extends Error {}

function config(): Config {
  const apiUrl = (process.env.TRADE_REQUEST_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const audience = process.env.TRADE_REQUEST_DELEGATED_AUDIENCE || `${apiUrl}/api/aoa`;
  const localKey = process.env.NODE_ENV !== "production" ? process.env.TRADE_REQUEST_DELEGATED_LOCAL_KEY || null : null;
  return { apiUrl, audience, localKey };
}

// The session role is normalized by auth.ts, so the stored role is checked
// here: anything other than a workspace role (for example a legacy
// HEAD_OF_ADVISORY row) is never sent to the service.
async function currentActor(): Promise<Actor | null> {
  const session = await auth();
  const id = session?.user?.id;
  const email = session?.user?.email?.trim().toLowerCase();
  if (!id || !email) return null;
  const user = await prisma.user.findUnique({ where: { id }, select: { name: true, role: true } });
  const role: string | undefined = user?.role;
  if (!user || !canUseTradeRequestsWorkspace(role)) return null;
  const name = (user.name?.trim() || session?.user?.name?.trim() || email).slice(0, 255);
  return { id, email, name, role };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signHs256(claims: Record<string, unknown>, key: string): string {
  const input = `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url(claims)}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // The losing branch may reject after the deadline; keep that rejection handled.
  work.catch(() => undefined);
  if (signal.aborted) return Promise.reject(new DeadlineExceeded());
  return Promise.race([
    work,
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new DeadlineExceeded()), { once: true })),
  ]);
}

const idAuth = new ServiceAuth();
const iamAuth = new ServiceAuth({ scopes: [IAM_SCOPE] });
const idClients = new Map<string, Promise<IdTokenClient>>();
let runtimeServiceAccount: Promise<string> | null = null;
const assertions = new Map<string, { token: Promise<string>; mintedAt: number }>();
const MINT_TIMEOUT_MS = 120_000;

/** Clears cached clients and assertions (tests only). */
export function resetDelegatedClientState(): void {
  idClients.clear();
  assertions.clear();
  runtimeServiceAccount = null;
}

async function applicationToken(cfg: Config): Promise<string> {
  if (cfg.localKey) {
    const iat = Math.floor(Date.now() / 1000);
    return signHs256({ iss: LOCAL_DELEGATED_CALLER, email: LOCAL_DELEGATED_CALLER, aud: cfg.audience, iat, exp: iat + ASSERTION_LIFETIME_S }, cfg.localKey);
  }
  let client = idClients.get(cfg.audience);
  if (!client) {
    client = idAuth.getIdTokenClient(cfg.audience);
    idClients.set(cfg.audience, client);
    client.catch(() => idClients.delete(cfg.audience));
  }
  const authorization = (await (await client).getRequestHeaders()).get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw new Error("id_token_unavailable");
  return authorization.slice("Bearer ".length);
}

async function serviceAccountEmail(): Promise<string> {
  runtimeServiceAccount ??= iamAuth.getCredentials().then((credentials) => {
    if (!credentials.client_email) throw new Error("service_account_unavailable");
    return credentials.client_email;
  });
  try {
    return await runtimeServiceAccount;
  } catch (error) {
    runtimeServiceAccount = null;
    throw error;
  }
}

// The mint is shared by concurrent callers, so it is bounded by its own
// timeout rather than by any one caller's attempt deadline.
async function signWithServiceAccount(claims: Record<string, unknown>, cfg: Config): Promise<string> {
  const signal = AbortSignal.timeout(MINT_TIMEOUT_MS);
  const serviceAccount = await serviceAccountEmail();
  const targets = [cfg.apiUrl, cfg.audience].map((value) => URL.canParse(value) ? new URL(value).host : "");
  if (serviceAccount.toLowerCase().endsWith(DEV_RUNTIME_DOMAIN) && targets.some((host) => PRODUCTION_HOSTS.has(host))) {
    console.error(`[${LOG_TAG}] dev_runtime_production_target`);
    throw new Error("dev_runtime_production_target");
  }
  const authorization = (await (await iamAuth.getClient()).getRequestHeaders()).get("authorization") ?? "";
  const response = await serviceFetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:signJwt`,
    {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ payload: JSON.stringify({ iss: serviceAccount, ...claims }) }),
      signal,
      cache: "no-store",
    },
  );
  const body = (await response.json().catch(() => null)) as { signedJwt?: unknown } | null;
  if (!response.ok || typeof body?.signedJwt !== "string") throw new Error("sign_jwt_failed");
  return body.signedJwt;
}

// Keyed by role so a role change takes effect on the next call, not after reuse
// expires. The in-flight promise is cached so concurrent calls share one mint.
function actorAssertion(actor: Actor, cfg: Config): Promise<string> {
  const key = [cfg.localKey ? "local" : "google", cfg.audience, actor.email, actor.role].join("\u0000");
  const now = Date.now();
  const cached = assertions.get(key);
  if (cached && now - cached.mintedAt < ASSERTION_REUSE_MS) return cached.token;
  const iat = Math.floor(now / 1000);
  const claims = {
    sub: actor.email, aud: cfg.audience, iat, exp: iat + ASSERTION_LIFETIME_S,
    jti: randomUUID(), aoa_role: actor.role, name: actor.name,
  };
  const token = cfg.localKey
    ? Promise.resolve(signHs256({ iss: LOCAL_DELEGATED_CALLER, ...claims }, cfg.localKey))
    : signWithServiceAccount(claims, cfg);
  for (const [entry, value] of assertions) if (now - value.mintedAt >= ASSERTION_REUSE_MS) assertions.delete(entry);
  const entry = { token, mintedAt: now };
  assertions.set(key, entry);
  token.catch(() => {
    if (assertions.get(key) === entry) assertions.delete(key);
  });
  return token;
}

function requestUrl(cfg: Config, call: TradeRequestCall): string {
  // Rejects dot segments (including pre-encoded ones such as %2e%2e) and empty segments.
  if (!/^\/[A-Za-z0-9\-._~%/]*$/.test(call.path) || call.path.includes("..") || call.path.includes("//") || /%2e/i.test(call.path)) {
    throw new Error("invalid_trade_request_path");
  }
  const url = new URL(`${cfg.apiUrl}/api/aoa${call.path}`);
  for (const [name, value] of Object.entries(call.query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  return url.toString();
}

async function attempt(call: TradeRequestCall, actor: Actor, cfg: Config, url: string, timeoutMs: number): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const noResponse = (): Attempt => ({
    kind: "no_response",
    description: controller.signal.aborted ? `timeout of ${timeoutMs}ms exceeded` : "Network Error",
  });
  try {
    let bearer: string;
    let assertion: string;
    try {
      [bearer, assertion] = await withDeadline(
        Promise.all([applicationToken(cfg), actorAssertion(actor, cfg)]),
        controller.signal,
      );
    } catch (error) {
      const mintTimedOut = error instanceof Error && error.name === "TimeoutError";
      return controller.signal.aborted || mintTimedOut ? noResponse() : { kind: "unconfirmed" };
    }
    const response = await serviceFetch(url, {
      method: call.method,
      headers: {
        authorization: `Bearer ${bearer}`,
        "x-aoa-actor-assertion": assertion,
        accept: "application/json",
        ...(call.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
    const text = await response.text();
    if (!text) return { kind: "response", status: response.status, body: null, malformed: false };
    try {
      return { kind: "response", status: response.status, body: JSON.parse(text), malformed: false };
    } catch {
      return { kind: "response", status: response.status, body: null, malformed: true };
    }
  } catch {
    return noResponse();
  } finally {
    clearTimeout(timer);
  }
}

// The native path runs only with the switch on and while the serving state reads
// AOA (read fresh on every call); otherwise the delegated call runs as before.
async function nativeHandlerForCall(call: TradeRequestCall): Promise<NativeHandler | null> {
  if (!tradeRequestsNativeEnabled()) return null;
  if (!(await isAoaServed())) return null;
  await loadNativeHandlers();
  return nativeHandlerFor(call.operation) ?? null;
}

// Bounded by the operation's per-attempt limit; one attempt (nothing crosses a network).
// Logs only the operation, outcome, status and duration.
async function runNative<T>(handler: NativeHandler, call: TradeRequestCall, actor: Actor): Promise<TradeRequestResult<T>> {
  const { timeoutMs } = TRADE_REQUEST_OPERATIONS[call.operation];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let result: TradeRequestResult<T>;
  try {
    result = (await withDeadline(handler(call, { aoaUserId: actor.id, email: actor.email, name: actor.name, role: actor.role }), controller.signal)) as TradeRequestResult<T>;
  } catch (error) {
    result = error instanceof DeadlineExceeded
      ? failedResult<T>(call, null, `timeout of ${timeoutMs}ms exceeded`)
      : failedResult<T>(call, 500, "Internal server error");
  } finally {
    clearTimeout(timer);
  }
  console.info(JSON.stringify({
    event: NATIVE_LOG_EVENT, operation: call.operation, outcome: result.ok ? "ok" : result.outcome,
    status: result.ok ? result.status : result.outcome === "failed" ? result.status : null, durationMs: Date.now() - started,
  }));
  return result;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls /api/aoa as the signed-in person. Never throws for service outcomes. */
export async function callTradeRequestService<T>(call: TradeRequestCall): Promise<TradeRequestResult<T>> {
  const failed = (status: number | null, message: string) => failedResult<T>(call, status, message);
  const notSetUp = (status: number | null = null) => notSetUpResult<T>(call, status);

  let actor: Actor | null;
  try {
    actor = await currentActor();
  } catch {
    console.error(`[${LOG_TAG}] actor_lookup_failed`);
    return failed(null, call.defaultMessage);
  }
  if (!actor) {
    console.warn(`[${LOG_TAG}] actor_unconfirmed`);
    return notSetUp();
  }

  let native: NativeHandler | null;
  try {
    native = await nativeHandlerForCall(call);
  } catch {
    console.error(`[${LOG_TAG}] native_unavailable operation=${call.operation}`);
    return failed(null, call.defaultMessage);
  }
  if (native) return runNative<T>(native, call, actor);

  const cfg = config();
  const policy = TRADE_REQUEST_OPERATIONS[call.operation];
  const url = requestUrl(cfg, call);
  for (let index = 0; ; index += 1) {
    const result = await attempt(call, actor, cfg, url, policy.timeoutMs);
    const last = index >= policy.retries;
    if (result.kind === "unconfirmed") {
      console.warn(`[${LOG_TAG}] delegation_unconfirmed`);
      return notSetUp();
    }
    if (result.kind === "response") {
      if (result.status >= 200 && result.status < 300) {
        if (result.malformed) console.warn(`[${LOG_TAG}] malformed_response status=${result.status}`);
        return finalResult<T>(call, result.status, result.body, result.malformed);
      }
      const code = refusalCode(result.body);
      if ((result.status === 401 || result.status === 403) && code) {
        console.warn(`[${LOG_TAG}] refused status=${result.status} code=${code}`);
        return finalResult<T>(call, result.status, result.body);
      }
      if (last || !RETRYABLE_STATUSES.has(result.status)) {
        console.warn(`[${LOG_TAG}] failed status=${result.status}`);
        return finalResult<T>(call, result.status, result.body);
      }
    } else if (last) {
      console.warn(`[${LOG_TAG}] no_response`);
      return failed(null, result.description);
    }
    await sleep(RETRY_DELAYS_MS[index]);
  }
}
