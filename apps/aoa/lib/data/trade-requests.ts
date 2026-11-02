import "server-only";
import { cache } from "react";
import { ServiceAuth } from "@/lib/demo/service-auth";
import { tradeRequestsNativeEnabled } from "@/lib/flags";
import { isAoaServed } from "@/lib/trade-requests/serving-state";

// Live trade-request read for the client/household/transfer surfaces
// (trade-request-linking S1). The Trade-Request app exposes an OIDC-gated
// machine endpoint that returns a REDACTED projection of a client's — or a
// household's — trade requests (client-name PII dropped, every account number
// pre-masked). AOA READS this — it never copies the underlying request data.
// The endpoint verifies a Google-signed ID token whose audience equals the
// app's base URL and whose email is the aoa-run@ service account.
//
// KEYLESS by construction: GoogleAuth mints the ID token from the ambient
// identity — on Cloud Run that is the aoa-run@ metadata identity, locally it is
// ADC. There is NO service-account key file; getIdTokenClient(audience) both
// sets the token's audience to the app base URL (which MUST equal the app's
// MACHINE_AUDIENCE) and attaches it to the request.
//
// NO-LOG discipline (mirrors lib/data/acat-status.ts / lib/twr/warehouse.ts): we
// NEVER log the token, the URL, the cedar_ridge_user_id(s), or the response body
// — only STATIC markers and status codes. The projection is PII-adjacent (it
// carries advisor + household names) and must never reach a log.
//
// CONTRACT NOTE (differs from the ACAT by-id seam): the endpoint returns
// `{ data: MachineTradeRequest[] }` (a `data` WRAPPER), and an unknown/absent
// client is `200 { data: [] }`, NOT 404. So "no requests" is a normal 200 with
// an empty array; a 404 is treated defensively as empty rather than an error.

// Non-secret env: the Trade-Request app's public base URL. Any trailing slash is
// stripped — the value is used verbatim as BOTH the OIDC token audience (which
// must match the app's MACHINE_AUDIENCE byte-for-byte) and the request path
// prefix. A stray trailing slash from a misconfigured env would otherwise
// mismatch the audience (→ silent 401) and produce a double-slash path.
const TRADE_REQUEST_API_URL = (
  process.env.TRADE_REQUEST_API_URL ??
  "https://trade-request-123456789012.us-central1.run.app"
).replace(/\/+$/, "");

const LOG_TAG = "trade-requests";

// Same budget as the Warehouse reads. Covers credential discovery/token minting
// as well as transport; an optional panel must eventually settle when either
// service is unavailable. The HTTP request also receives the abort signal.
export const TRADE_REQUEST_READ_TIMEOUT_MS = 15_000;

/** Max ids the endpoint accepts per batch call (mirrors the server's own
 *  `z.array(UUID).max(50)` clamp). We de-dupe + clamp on our side too so an
 *  oversized household can never 400 the endpoint. */
const MAX_BATCH_IDS = 50;

/** DEV-ONLY escape hatch: return bundled fixtures instead of calling the
 *  endpoint. Fails closed in production (the `NODE_ENV` guard is first and can
 *  never be flipped by env alone), so a stray `TRADE_REQUEST_FIXTURE=1` in a
 *  prod environment is inert. Mirrors acatFixtureEnabled(). */
function tradeRequestFixtureEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.TRADE_REQUEST_FIXTURE === "1"
  );
}

/** One account line on a request. `accountNumber` arrives MASKED from the
 *  endpoint (e.g. "****1234"); AOA shows it verbatim. */
export type TradeRequestAccount = {
  accountId?: string | null; // stable Apex custodian_account_id / ULID
  accountNumber: string | null; // masked at the source
  accountType: string | null;
  balance: number | null;
};

export type TradeRequestProfileProjection = {
  decidedAt: string;
  riskScore: number | null;
  instructions: Array<{ key: string; label: string; value: string }>;
};

/** The endpoint's redacted trade-request projection. `clientName`/`clientNames`,
 *  free-form notes, strategy rationale, execution plan, and the audit log are
 *  dropped server-side; account numbers are pre-masked. Approved profile facts
 *  arrive in the narrow `profile` projection. `clientIds` is the
 *  authoritative set of cedar_ridge_user_ids a request spans (a household
 *  rebalance has len > 1); `clientId` is the primary/initiating client. */
export type TradeRequestSummary = {
  id: string;
  clientId: string | null;
  clientIds: string[];
  status: string | null;
  tradeType: string | null;
  priority: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  totalValue: number | null;
  advisor: string | null;
  householdId: number | null;
  householdName: string | null;
  selectedAccounts: string[]; // masked
  accounts: TradeRequestAccount[];
  liquidateOption: string | null;
  liquidationApproval: string | null;
  /** Optional during the rolling deployment; null for non-qualifying requests. */
  profile?: TradeRequestProfileProjection | null;
};

/** Thrown for any read failure the panel renders as "Trade requests
 *  unavailable." — an unauthorized (401/403), an endpoint 5xx, or a transport
 *  throw. A 404 is NOT an error (treated as no requests) — the caller gets `[]`. */
export class TradeRequestReadError extends Error {
  constructor(
    message: string,
    readonly reason: "unauthorized" | "endpoint_error" | "transport_error" | "non_authoritative",
  ) {
    super(message);
    this.name = "TradeRequestReadError";
  }
}

function record(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}
function nullableString(v: unknown): boolean {
  return v === null || typeof v === "string";
}
function nullableNumber(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}
function stringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((value) => typeof value === "string" && value !== "");
}
function authoritativeAccount(v: unknown): boolean {
  if (!record(v)) return false;
  return (v.accountId === undefined || nullableString(v.accountId)) &&
    nullableString(v.accountNumber) && nullableString(v.accountType) && nullableNumber(v.balance);
}
function authoritativeProfile(v: unknown): boolean {
  if (v == null) return true;
  if (!record(v) || typeof v.decidedAt !== "string" || v.decidedAt === "") return false;
  if (!(v.riskScore === null || (
    typeof v.riskScore === "number" && Number.isInteger(v.riskScore) &&
    v.riskScore >= 1 && v.riskScore <= 25
  ))) return false;
  return Array.isArray(v.instructions) && v.instructions.every((instruction) => (
    record(instruction) &&
    typeof instruction.key === "string" && instruction.key !== "" &&
    typeof instruction.label === "string" && instruction.label !== "" &&
    typeof instruction.value === "string" && instruction.value !== ""
  ));
}
function authoritativeRow(v: unknown): boolean {
  if (!record(v)) return false;
  return typeof v.id === "string" && v.id !== "" &&
    nullableString(v.clientId) && stringArray(v.clientIds) && v.clientIds.length > 0 &&
    nullableString(v.status) && nullableString(v.tradeType) && nullableString(v.priority) &&
    nullableString(v.createdAt) && nullableString(v.updatedAt) && nullableNumber(v.totalValue) &&
    nullableString(v.advisor) && nullableNumber(v.householdId) && nullableString(v.householdName) &&
    stringArray(v.selectedAccounts) && Array.isArray(v.accounts) &&
    v.accounts.every(authoritativeAccount) && nullableString(v.liquidateOption) &&
    nullableString(v.liquidationApproval) && authoritativeProfile(v.profile);
}

// Defensive coercions — the projection is external data; never trust its shapes.
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x !== "")
    : [];
}

function mapAccount(raw: unknown): TradeRequestAccount {
  const a = (raw ?? {}) as Record<string, unknown>;
  return {
    accountId: str(a.accountId),
    accountNumber: str(a.accountNumber),
    accountType: str(a.accountType),
    balance: num(a.balance),
  };
}

function mapProfile(raw: unknown): TradeRequestProfileProjection | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const decidedAt = str(p.decidedAt);
  if (!decidedAt) return null;
  const score = num(p.riskScore);
  const riskScore =
    score != null && Number.isInteger(score) && score >= 1 && score <= 25
      ? score
      : null;
  const instructions = Array.isArray(p.instructions)
    ? p.instructions.flatMap((value) => {
        if (value == null || typeof value !== "object" || Array.isArray(value)) {
          return [];
        }
        const row = value as Record<string, unknown>;
        const key = str(row.key);
        const label = str(row.label);
        const instructionValue = str(row.value);
        return key && label && instructionValue
          ? [{ key, label, value: instructionValue }]
          : [];
      })
    : [];
  return { decidedAt, riskScore, instructions };
}

function mapRequest(raw: unknown): TradeRequestSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(r.id) ?? "", // id-less rows are dropped by the caller
    clientId: str(r.clientId),
    clientIds: strArr(r.clientIds),
    status: str(r.status),
    tradeType: str(r.tradeType),
    priority: str(r.priority),
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
    totalValue: num(r.totalValue),
    advisor: str(r.advisor),
    householdId: num(r.householdId),
    householdName: str(r.householdName),
    selectedAccounts: strArr(r.selectedAccounts),
    accounts: Array.isArray(r.accounts) ? r.accounts.map(mapAccount) : [],
    liquidateOption: str(r.liquidateOption),
    liquidationApproval: str(r.liquidationApproval),
    profile: mapProfile(r.profile),
  };
}

// One GoogleAuth per module — the token client caches/refreshes ID tokens
// internally, so we don't re-mint on every request.
const auth = new ServiceAuth();

/**
 * While Trade Requests are AOA-served and the native switch is on (ticket), the
 * same projection is built from AOA's own records, under the same budget; any
 * failure is an endpoint error, never a standalone call.
 */
async function readNativeProjection(params: URLSearchParams): Promise<{ status: number; data: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { readNativeTradeRequestProjection } = await import("@/lib/trade-requests/native/reads/portrait");
    const answer = await Promise.race([
      readNativeTradeRequestProjection(params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Trade-request read timed out")), TRADE_REQUEST_READ_TIMEOUT_MS);
      }),
    ]);
    return { status: answer.status, data: answer.body };
  } catch {
    console.error(`[${LOG_TAG}] native_read_failed`);
    throw new TradeRequestReadError("Trade-request read failed", "endpoint_error");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared fetch core for both public reads. Mints the keyless OIDC token
 * (audience == the app base URL), calls the machine endpoint with the given
 * query params, and returns typed, defensively-coerced rows.
 *   200 → `{ data: [...] }` unwrapped, mapped, id-less rows dropped.
 *   404 → [] (defensive — the contract says empty is 200; a 404 degrades to
 *         "no requests", never a crashed panel).
 *   401 / 403 → TradeRequestReadError(unauthorized).
 *   other non-2xx → TradeRequestReadError(endpoint_error).
 *   transport throw → TradeRequestReadError(transport_error).
 * The query is built with URLSearchParams — ids are NEVER interpolated raw.
 */
async function fetchTradeRequests(
  params: URLSearchParams,
  strictAuthoritative = false,
): Promise<TradeRequestSummary[]> {
  if (tradeRequestsNativeEnabled() && (await isAoaServed())) {
    return rowsFromResponse(await readNativeProjection(params), strictAuthoritative);
  }
  let res;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    res = await Promise.race([
      (async () => {
        // Keep the existing keyless audience and authorization contract.
        const client = await auth.getIdTokenClient(TRADE_REQUEST_API_URL);
        // Credential discovery may resolve after the deadline. Do not start a
        // stale source request when its caller has already shown unavailable.
        controller.signal.throwIfAborted();
        return client.request({
          url: `${TRADE_REQUEST_API_URL}/api/machine/trade-requests?${params.toString()}`,
          method: "GET",
          signal: controller.signal,
          timeout: TRADE_REQUEST_READ_TIMEOUT_MS,
          retry: false,
          validateStatus: () => true, // handle non-2xx ourselves
        });
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Trade-request read timed out"));
        }, TRADE_REQUEST_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Token mint / network failure — STATIC marker only, never the ids/url/token.
    console.error(`[${LOG_TAG}] transport_failed`);
    throw new TradeRequestReadError(
      "Trade-request read failed",
      "transport_error",
    );
  } finally {
    clearTimeout(timer);
  }
  return rowsFromResponse(res, strictAuthoritative);
}

function rowsFromResponse(res: { status: number; data: unknown }, strictAuthoritative: boolean): TradeRequestSummary[] {
  const status = res.status;
  if (status === 200) {
    const body = res.data as unknown;
    if (
      strictAuthoritative &&
      (!record(body) || !Array.isArray(body.data) || !body.data.every(authoritativeRow))
    ) {
      console.error(`[${LOG_TAG}] authoritative_batch_rejected`);
      throw new TradeRequestReadError(
        "Trade-request batch was not authoritative",
        "non_authoritative",
      );
    }
    const rows = Array.isArray((body as { data?: unknown })?.data)
      ? ((body as { data: unknown[] }).data)
      : [];
    // Drop rows with no id — they can key nothing downstream.
    return rows.map(mapRequest).filter((r) => r.id !== "");
  }
  if (status === 404) {
    if (strictAuthoritative) {
      console.error(`[${LOG_TAG}] authoritative_batch_rejected`);
      throw new TradeRequestReadError(
        "Trade-request batch was not authoritative",
        "non_authoritative",
      );
    }
    return []; // treated as no requests (contract returns 200 {data:[]} for empty)
  }
  // STATUS ONLY — never the body (it carries request detail + names).
  console.error(`[${LOG_TAG}] status=${status}`);
  if (status === 401 || status === 403) {
    throw new TradeRequestReadError("Trade-request unauthorized", "unauthorized");
  }
  throw new TradeRequestReadError(`Trade-request ${status}`, "endpoint_error");
}

/**
 * Fetch a single client's trade requests by cedar_ridge_user_id.
 * Returns [] for a client with no requests (never throws on empty). The match
 * is deterministic id equality — the endpoint returns every request whose
 * `clientIds` includes this id.
 */
export async function getTradeRequestsForUser(
  cedarRidgeUserId: string,
): Promise<TradeRequestSummary[]> {
  // DEV-ONLY fixture short-circuit (never in prod — see tradeRequestFixtureEnabled).
  // Local laptops have no aoa-run@ metadata identity, so the OIDC mint above
  // can't resolve; the fixture lets the surfaces render. Dynamic import so the
  // dev module is never pulled into a production bundle.
  if (tradeRequestFixtureEnabled()) {
    const { tradeRequestFixture } = await import("./trade-request-fixture");
    return tradeRequestFixture().filter((r) =>
      r.clientIds.includes(cedarRidgeUserId),
    );
  }

  return fetchTradeRequests(
    new URLSearchParams({ cedar_ridge_user_id: cedarRidgeUserId }),
  );
}

/**
 * Fetch the union of trade requests across a set of cedar_ridge_user_ids (a
 * household's members). De-dupes and clamps to the endpoint's 1–50 window so an
 * oversized household can't 400 the call. A multi-client (household-rebalance)
 * request appears once in the returned union — callers dedup by `id` at the
 * household grain.
 */
export async function getTradeRequestsForUsers(
  cedarRidgeUserIds: string[],
): Promise<TradeRequestSummary[]> {
  const ids = [...new Set(cedarRidgeUserIds.map((s) => s.trim()))]
    .filter(Boolean)
    .slice(0, MAX_BATCH_IDS);
  if (ids.length === 0) return []; // no ids → no call, no malformed query

  if (tradeRequestFixtureEnabled()) {
    const { tradeRequestFixture } = await import("./trade-request-fixture");
    const idSet = new Set(ids);
    return tradeRequestFixture().filter((r) =>
      r.clientIds.some((c) => idSet.has(c)),
    );
  }

  return fetchTradeRequests(
    new URLSearchParams({ cedar_ridge_user_ids: ids.join(",") }),
  );
}

/**
 * Queue-only batch read. Reconciliation may clear prior work, so only the
 * endpoint's authoritative 200 `{ data: [...] }` contract is accepted. A 404,
 * malformed wrapper, or malformed row throws before any subject is scanned.
 */
export async function getAuthoritativeTradeRequestsForUsers(
  cedarRidgeUserIds: string[],
): Promise<TradeRequestSummary[]> {
  const ids = [...new Set(cedarRidgeUserIds.map((s) => s.trim()))]
    .filter(Boolean)
    .slice(0, MAX_BATCH_IDS);
  if (ids.length === 0) return [];

  if (tradeRequestFixtureEnabled()) {
    const { tradeRequestFixture } = await import("./trade-request-fixture");
    const idSet = new Set(ids);
    return tradeRequestFixture().filter((r) =>
      r.clientIds.some((c) => idSet.has(c)),
    );
  }

  return fetchTradeRequests(
    new URLSearchParams({ cedar_ridge_user_ids: ids.join(",") }),
    true,
  );
}

/** Request-cycle memo of the single-client read (one endpoint call per id per
 *  request, no matter how many fragments consume it). ONE SCALAR ARG — never an
 *  array or object literal, which would be a fresh reference every render and
 *  defeat the memo key. Deliberately NOT cross-request (no unstable_cache):
 *  request status is live and we don't want staleness. The household-batch memo
 *  waits for S3 (an array cache key would not memoize). */
export const readTradeRequestsForUserCached = cache(
  (cedarRidgeUserId: string) => getTradeRequestsForUser(cedarRidgeUserId),
);
