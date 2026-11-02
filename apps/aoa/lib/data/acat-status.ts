import "server-only";
import { cache } from "react";
import { ServiceAuth } from "@/lib/demo/service-auth";
import { ACAT_BOOK_LIST_QUERY, ACAT_BOOK_REMOVED_QUERY, mapAcatBookRow, type AcatBookRow } from "./acat-book";

// Live ACAT-status read for the asset-transfer detail page (ticket).
//
// The Transfer Tracker exposes a machine endpoint that returns a REDACTED
// projection of an acat_transfer record (no clientName / wealthAdvisor; every
// account/cusip/DTCC number arrives pre-masked). AOA READS this — it never
// copies the underlying ACAT data. The endpoint is OIDC-gated: it verifies a
// Google-signed ID token whose audience equals the tracker's base URL and whose
// email is the aoa-run@ service account.
//
// KEYLESS by construction: GoogleAuth mints the ID token from the ambient
// identity — on Cloud Run that is the aoa-run@ metadata identity, locally it is
// ADC. There is NO service-account key file, and getIdTokenClient(audience)
// both sets the token's audience to the tracker base URL (which MUST equal the
// tracker's MACHINE_AUTH_AUDIENCE) and attaches the token to the request.
//
// NO-LOG discipline (mirrors lib/twr/warehouse.ts / lib/warehouse/client.ts): we
// NEVER log the token, the URL, or the response body — only STATIC markers and
// status codes. The record projection is PII-adjacent and must never reach a log.

// Non-secret env: the tracker's public base URL. Any trailing slash is stripped
// — the value is used verbatim as BOTH the OIDC token audience (which must match
// the tracker's MACHINE_AUTH_AUDIENCE byte-for-byte) and the request path prefix.
// A stray trailing slash from a misconfigured env would otherwise mismatch the
// audience (→ silent 401) and produce a double-slash path.
const TRANSFER_TRACKER_URL = (
  process.env.TRANSFER_TRACKER_URL ?? "https://transfers.jeremyhamann.dev"
).replace(/\/+$/, "");

const LOG_TAG = "acat-status";

/** DEV-ONLY escape hatch: return bundled fixtures instead of calling the
 *  tracker. Fails closed in production (the `NODE_ENV` guard is first and can
 *  never be flipped by env alone), so a stray `ACAT_FIXTURE=1` in a prod
 *  environment is inert. See lib/data/acat-fixture.ts for the rationale. */
function acatFixtureEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" && process.env.ACAT_FIXTURE === "1"
  );
}

/** One position line in the redacted projection (expected vs actual, plus the
 *  mapping/issue flags). `cusip` arrives masked from the tracker. */
export type AcatStatusAsset = {
  symbol: string | null;
  description: string | null;
  cusip: string | null; // masked at the source
  expectedQty: number | null;
  actualQty: number | null;
  mapStatus: string | null;
  issue: string | null; // non-null = a reconciliation flag to surface
  amount: number | null;
  assetClass: string | null;
};

/** The tracker's acat_transfer projection. Advisor reads receive masked
 *  account, statement, and DTCC numbers. Operations tracker reads use this
 *  same shape with Apex and statement numbers in full; DTCC stays masked.
 *  clientName / wealthAdvisor are absent on the advisor detail read. */
export type AcatStatus = {
  acatTransferId: string;
  controlNumber: string | null;
  direction: string | null;
  type: string | null;
  accountType: string | null;
  status: string | null;
  transferringContra: string | null;
  statementAmount: number | null;
  methodRequested: string | null;
  feeCharged: boolean | null;
  feeAmount: number | null;
  acatDate: string | null;
  apexAccountId: string | null;
  statementAccountNumber: string | null;
  dtccNumber: string | null; // masked
  assets: AcatStatusAsset[];
};

/** Thrown for any read failure the section renders as "ACAT status
 *  unavailable." — an unauthorized (401), a tracker 5xx, or a transport throw.
 *  A 404 is NOT an error (no ACAT yet) — the caller gets `null` for that. */
export class AcatStatusError extends Error {
  constructor(
    message: string,
    readonly reason: "unauthorized" | "tracker_error" | "transport_error",
  ) {
    super(message);
    this.name = "AcatStatusError";
  }
}

// Defensive coercions — the projection is external data; never trust its shapes.
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function mapAsset(raw: unknown): AcatStatusAsset {
  const a = (raw ?? {}) as Record<string, unknown>;
  return {
    symbol: str(a.symbol),
    description: str(a.description),
    cusip: str(a.cusip),
    expectedQty: num(a.expectedQty),
    actualQty: num(a.actualQty),
    mapStatus: str(a.mapStatus),
    issue: str(a.issue),
    amount: num(a.amount),
    assetClass: str(a.assetClass),
  };
}

function mapStatus(raw: unknown, fallbackId: string): AcatStatus {
  const r = (raw ?? {}) as Record<string, unknown>;
  const assets = Array.isArray(r.assets) ? r.assets.map(mapAsset) : [];
  return {
    acatTransferId: str(r.acatTransferId) ?? fallbackId,
    controlNumber: str(r.controlNumber),
    direction: str(r.direction),
    type: str(r.type),
    accountType: str(r.accountType),
    status: str(r.status),
    transferringContra: str(r.transferringContra),
    statementAmount: num(r.statementAmount),
    methodRequested: str(r.methodRequested),
    feeCharged: bool(r.feeCharged),
    feeAmount: num(r.feeAmount),
    acatDate: str(r.acatDate),
    apexAccountId: str(r.apexAccountId),
    statementAccountNumber: str(r.statementAccountNumber),
    dtccNumber: str(r.dtccNumber),
    assets,
  };
}

// One GoogleAuth per module — the token client caches/refreshes ID tokens
// internally, so we don't re-mint on every request.
const auth = new ServiceAuth();

/**
 * Fetch the redacted live ACAT status for a transfer's linked acatTransferId.
 *   200 → the typed projection.
 *   404 → null (the id links no ACAT yet — a normal, non-error state).
 *   401 / 5xx / transport throw → AcatStatusError (the section degrades to a
 *        quiet "unavailable" note; the page never breaks).
 * The id is ALWAYS encodeURIComponent'd into the path — never interpolated raw.
 */
export async function getAcatStatus(
  acatTransferId: string,
): Promise<AcatStatus | null> {
  // DEV-ONLY fixture short-circuit (never in prod — see acatFixtureEnabled).
  // Local laptops have no aoa-run@ metadata identity, so the OIDC mint below
  // can't resolve; the fixture lets the detail/drawer render. Dynamic import so
  // the dev module is never pulled into a production bundle.
  if (acatFixtureEnabled()) {
    const { acatStatusFixture } = await import("./acat-fixture");
    return acatStatusFixture(acatTransferId);
  }

  let res;
  try {
    // getIdTokenClient(audience) sets the ID token's audience = the tracker
    // base URL (== the tracker's MACHINE_AUTH_AUDIENCE) and attaches it.
    const client = await auth.getIdTokenClient(TRANSFER_TRACKER_URL);
    res = await client.request({
      url: `${TRANSFER_TRACKER_URL}/api/machine/acats/${encodeURIComponent(acatTransferId)}`,
      method: "GET",
      validateStatus: () => true, // handle status codes ourselves; no throw on non-2xx
    });
  } catch {
    // Token mint / network failure — STATIC marker only, never the id/url/token.
    console.error(`[${LOG_TAG}] transport_failed`);
    throw new AcatStatusError("Transfer Tracker request failed", "transport_error");
  }

  const status = res.status;
  if (status === 200) {
    return mapStatus(res.data, acatTransferId);
  }
  if (status === 404) {
    return null; // no ACAT linked yet
  }
  // STATUS ONLY — never the body (it carries the redacted record).
  console.error(`[${LOG_TAG}] status=${status}`);
  if (status === 401 || status === 403) {
    throw new AcatStatusError("Transfer Tracker unauthorized", "unauthorized");
  }
  throw new AcatStatusError(`Transfer Tracker ${status}`, "tracker_error");
}

/**
 * Fetch the redacted live ACAT status BY THE TRACKER RECORD `id` — the record
 * PK, which is UNIQUE and ALWAYS present (unlike `acatTransferId`, a nullable,
 * NON-UNIQUE placeholder that on real records is often "N/A" or null). Hits the
 * tracker's by-record read (#89) and returns the same typed projection as
 * `getAcatStatus`.
 *
 * This is the reliable read for the ACAT Tracking drawer: every list row
 * carries its own `id`, so keying on it gives EACH row its OWN record — where
 * the by-acatTransferId read collapses every "N/A" row onto the single newest
 * "N/A" record (the wrong-ACAT-in-every-modal bug this fixes).
 *
 *   200 → the typed projection.
 *   404 → null (no such record — e.g. a manual record with no by-id detail).
 *   401 / 5xx / transport throw → AcatStatusError (the drawer degrades to a
 *        quiet "unavailable" note; the page never breaks).
 * The id is ALWAYS encodeURIComponent'd into the path — never interpolated raw.
 *
 * Mirrors `getAcatStatus` authentication, no-log discipline and typed errors.
 * Uses the `by-record/{id}` path and record-id fixture key. A caller may supply
 * an abort signal to cancel a bounded preparation read; legacy reads retain
 * their existing behavior.
 */
export async function getAcatStatusByRecordId(
  recordId: string,
  options: { signal?: AbortSignal } = {},
): Promise<AcatStatus | null> {
  // DEV-ONLY fixture short-circuit (never in prod — see acatFixtureEnabled).
  // Keyed by record id (not acatTransferId) so two fixture rows sharing "N/A"
  // resolve to their OWN distinct detail.
  if (acatFixtureEnabled()) {
    const { acatStatusFixtureByRecordId } = await import("./acat-fixture");
    return acatStatusFixtureByRecordId(recordId);
  }

  if (options.signal?.aborted) {
    throw new AcatStatusError("Transfer Tracker request canceled", "transport_error");
  }
  let res;
  try {
    // getIdTokenClient(audience) sets the ID token's audience = the tracker
    // base URL (== the tracker's MACHINE_AUTH_AUDIENCE) and attaches it.
    const client = await auth.getIdTokenClient(TRANSFER_TRACKER_URL);
    if (options.signal?.aborted) {
      throw new AcatStatusError("Transfer Tracker request canceled", "transport_error");
    }
    res = await client.request({
      url: `${TRANSFER_TRACKER_URL}/api/machine/acats/by-record/${encodeURIComponent(recordId)}`,
      method: "GET",
      ...(options.signal ? { signal: options.signal, timeout: 8_000 } : {}),
      validateStatus: () => true, // handle status codes ourselves; no throw on non-2xx
    });
  } catch {
    // Token mint / network failure — STATIC marker only, never the id/url/token.
    console.error(`[${LOG_TAG}] transport_failed`);
    throw new AcatStatusError("Transfer Tracker request failed", "transport_error");
  }

  const status = res.status;
  if (status === 200) {
    // Fallback id is "" — NOT the record id: the record id is NOT an
    // acatTransferId, and a by-record response missing acatTransferId (a
    // placeholder record) must not be mislabeled with its record id.
    return mapStatus(res.data, "");
  }
  if (status === 404) {
    return null; // no such record (e.g. a manual record with no by-id detail)
  }
  // STATUS ONLY — never the body (it carries the redacted record).
  console.error(`[${LOG_TAG}] status=${status}`);
  if (status === 401 || status === 403) {
    throw new AcatStatusError("Transfer Tracker unauthorized", "unauthorized");
  }
  throw new AcatStatusError(`Transfer Tracker ${status}`, "tracker_error");
}

/** Record-id-first live read for a LINKED transfer: prefer the by-record path
 *  (#89 — unique, always-present PK) and fall back to the legacy by-UUID path
 *  for rows linked before record-id linking. Returns null when the transfer
 *  links nothing (callers gate on isAcatLinked, so that arm is defensive). */
export async function getAcatStatusForTransfer(link: {
  acat_record_id: string | null;
  acat_transfer_id: string | null;
}): Promise<AcatStatus | null> {
  if (link.acat_record_id != null)
    return getAcatStatusByRecordId(link.acat_record_id);
  if (link.acat_transfer_id != null)
    return getAcatStatus(link.acat_transfer_id);
  return null;
}

/** Request-level memo of the record-id-first live read (one tracker call per
 *  request no matter how many hub fragments consume it — today the ACAT-row
 *  expansion AND the asset-mapping count line). TWO SCALAR ARGS — never an
 *  inline object literal, which would be a fresh reference every render and
 *  defeat the memo key. Deliberately NOT cross-request (no unstable_cache):
 *  ACAT status is live and we don't want staleness. */
export const readAcatStatusForTransferCached = cache(
  (rid: string | null, tid: string | null) =>
    getAcatStatusForTransfer({ acat_record_id: rid, acat_transfer_id: tid }),
);

// ---------------------------------------------------------------------------
// LIST read (ticket lane) — the FIRM-WIDE in-flight ACAT list.
//
// Mirrors getAcatStatus exactly: same keyless OIDC mint (getIdTokenClient with
// audience == the tracker base URL), same no-log discipline, same typed
// graceful error. The tracker's list endpoint (#88) is OIDC-gated, returns the
// redacted-but-NAMED in-flight rows (suppression already applied server-side),
// sorted most-recent-first. The lane re-sorts defensively regardless.
// ---------------------------------------------------------------------------

/** The per-ACAT asset-map rollup carried on a list row (counts only — no
 *  position lines; the full table comes from the by-id read). */
export type AcatListAssetMap = {
  total: number | null;
  mapped: number | null;
  unmapped: number | null;
  pending: number | null;
  expected: number | null;
};

/** One row of the firm-wide in-flight list. Unlike the by-id projection this
 *  DOES carry `clientName` (the list is named). Advisor reads receive masked
 *  account and statement numbers. The operations list passes those two through
 *  in full. DTCC stays masked. */
export type AcatListRow = {
  /** The tracker RECORD id — ALWAYS present in the #88 list projection
   *  (`redactAcatForMachineList` returns `id: record.id`). This is the stable
   *  identity for every row; `acatTransferId` may be empty for a legacy/manual
   *  ACAT that was never assigned a tracker transfer UUID. */
  id: string;
  acatTransferId: string;
  clientName: string | null;
  controlNumber: string | null;
  direction: string | null;
  type: string | null;
  accountType: string | null;
  status: string | null;
  transferringContra: string | null;
  statementAmount: number | null;
  acatDate: string | null;
  lastActivityAt: string | null;
  apexAccountId: string | null;
  statementAccountNumber: string | null;
  dtccNumber: string | null; // masked
  assetMap: AcatListAssetMap;
};

/** Thrown for any list-read failure so the lane degrades to a quiet note and
 *  the board never crashes. Same reason vocabulary as AcatStatusError. */
export class AcatListError extends Error {
  constructor(
    message: string,
    readonly reason: "unauthorized" | "tracker_error" | "transport_error",
  ) {
    super(message);
    this.name = "AcatListError";
  }
}

function mapAssetMap(raw: unknown): AcatListAssetMap {
  const m = (raw ?? {}) as Record<string, unknown>;
  return {
    total: num(m.total),
    mapped: num(m.mapped),
    unmapped: num(m.unmapped),
    pending: num(m.pending),
    expected: num(m.expected),
  };
}

function mapListRow(raw: unknown): AcatListRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(r.id) ?? "",
    acatTransferId: str(r.acatTransferId) ?? "",
    clientName: str(r.clientName),
    controlNumber: str(r.controlNumber),
    direction: str(r.direction),
    type: str(r.type),
    accountType: str(r.accountType),
    status: str(r.status),
    transferringContra: str(r.transferringContra),
    statementAmount: num(r.statementAmount),
    acatDate: str(r.acatDate),
    lastActivityAt: str(r.lastActivityAt),
    apexAccountId: str(r.apexAccountId),
    statementAccountNumber: str(r.statementAccountNumber),
    dtccNumber: str(r.dtccNumber),
    assetMap: mapAssetMap(r.assetMap),
  };
}

/**
 * Fetch the firm-wide in-flight ACAT list from the tracker.
 *   200 → the typed rows (defensively coerced; a row with no tracker record
 *         `id` is dropped — it can key nothing). A row may legitimately have an
 *         EMPTY `acatTransferId` (a legacy/manual ACAT with no tracker transfer
 *         UUID) and is KEPT — the record `id` is its stable identity.
 *   401 / 5xx / transport throw → AcatListError (the lane renders a quiet
 *         "unavailable" note; the board is unaffected).
 * A 404/empty body yields an empty list, never an error.
 */
function withAcatReadSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AcatListError("ACAT list read canceled", "transport_error"));
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function fetchAcatList(options: { signal?: AbortSignal } = {}): Promise<AcatListRow[]> {
  if (options.signal?.aborted) throw new AcatListError("ACAT list read canceled", "transport_error");
  // DEV-ONLY fixture short-circuit (never in prod — see acatFixtureEnabled).
  if (acatFixtureEnabled()) {
    const { acatListFixture } = await import("./acat-fixture");
    return acatListFixture();
  }

  let res;
  try {
    // Credential discovery has no cancellable API. Stop awaiting it at the
    // caller's deadline and never start a late tracker request after abort.
    const client = await withAcatReadSignal(auth.getIdTokenClient(TRANSFER_TRACKER_URL), options.signal);
    if (options.signal?.aborted) throw new AcatListError("ACAT list read canceled", "transport_error");
    res = await withAcatReadSignal(client.request({
      url: `${TRANSFER_TRACKER_URL}/api/machine/acats`,
      method: "GET",
      validateStatus: () => true, // handle status codes ourselves
      ...(options.signal ? { signal: options.signal, retry: false } : {}),
    }), options.signal);
  } catch {
    // STATIC marker only — never the url/token.
    console.error(`[${LOG_TAG}] list_transport_failed`);
    throw new AcatListError("Transfer Tracker list request failed", "transport_error");
  }

  const status = res.status;
  if (status === 200) {
    const body = res.data as unknown;
    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as { acats?: unknown[] })?.acats)
        ? (body as { acats: unknown[] }).acats
        : [];
    // Drop only rows with no tracker record `id` — those can key nothing. A row
    // whose `acatTransferId` is empty (legacy/manual ACAT) is KEPT: the record
    // `id` is its stable identity, and it still renders under its status group.
    return rows.map(mapListRow).filter((r) => r.id !== "");
  }
  if (status === 404) {
    return []; // no in-flight ACATs — a normal, non-error empty state
  }
  // STATUS ONLY — never the body (it carries redacted-but-named rows).
  console.error(`[${LOG_TAG}] list_status=${status}`);
  if (status === 401 || status === 403) {
    throw new AcatListError("Transfer Tracker list unauthorized", "unauthorized");
  }
  throw new AcatListError(`Transfer Tracker list ${status}`, "tracker_error");
}

/** The full ACAT book (every live record, terminal statuses included) with the
 *  book-only fields. Same auth, abort, fixture, and status handling as
 *  fetchAcatList; that function's in-flight read is untouched. */
export async function fetchAcatBook(options: { signal?: AbortSignal; removed?: boolean } = {}): Promise<AcatBookRow[]> {
  if (options.signal?.aborted) throw new AcatListError("ACAT book read canceled", "transport_error");
  if (acatFixtureEnabled()) {
    if (options.removed) return [];
    const { acatListFixture } = await import("./acat-fixture");
    return acatListFixture()
      .map((row) => mapAcatBookRow({ ...row, wealthAdvisor: null, crmDealId: null,
        tradeInstructionsBlank: false, notes: null, tradeInstructions: null, custodianName: "",
        feeCharged: null, feeRequestCompleted: null, hasIssue: false }))
      .filter((row): row is AcatBookRow => row !== null);
  }

  let res;
  try {
    const client = await withAcatReadSignal(auth.getIdTokenClient(TRANSFER_TRACKER_URL), options.signal);
    if (options.signal?.aborted) throw new AcatListError("ACAT book read canceled", "transport_error");
    res = await withAcatReadSignal(client.request({
      url: `${TRANSFER_TRACKER_URL}/api/machine/acats?${options.removed ? ACAT_BOOK_REMOVED_QUERY : ACAT_BOOK_LIST_QUERY}`,
      method: "GET",
      validateStatus: () => true,
      ...(options.signal ? { signal: options.signal, retry: false } : {}),
    }), options.signal);
  } catch {
    console.error(`[${LOG_TAG}] book_transport_failed`);
    throw new AcatListError("Transfer Tracker book request failed", "transport_error");
  }

  const status = res.status;
  if (status === 200) {
    const body = res.data as { acats?: unknown } | unknown[];
    const rows = Array.isArray(body) ? body : Array.isArray(body?.acats) ? body.acats : [];
    return rows.map(mapAcatBookRow).filter((row): row is AcatBookRow => row !== null);
  }
  if (status === 404) return [];
  console.error(`[${LOG_TAG}] book_status=${status}`);
  if (status === 401 || status === 403) {
    throw new AcatListError("Transfer Tracker book unauthorized", "unauthorized");
  }
  throw new AcatListError(`Transfer Tracker book ${status}`, "tracker_error");
}

const ACAT_OPS_BOOK_PATH = "/api/machine/acats/ops-book";
const ACAT_OPS_LIST_PATH = "/api/machine/acats/ops-list";
const ACAT_OPS_RECORD_PATH = "/api/machine/acats/ops-record";

/** Operations book. Full Apex and statement numbers when the production AoA
 *  identity is accepted. A 401 (the dev identity) falls back to the masked book.
 *  Callers must already have passed the Admin/Operations gate. */
export async function fetchAcatOpsBook(options: { signal?: AbortSignal; removed?: boolean } = {}): Promise<AcatBookRow[]> {
  if (options.signal?.aborted) throw new AcatListError("ACAT book read canceled", "transport_error");
  if (acatFixtureEnabled()) return fetchAcatBook(options);

  let res;
  try {
    const client = await withAcatReadSignal(auth.getIdTokenClient(TRANSFER_TRACKER_URL), options.signal);
    if (options.signal?.aborted) throw new AcatListError("ACAT book read canceled", "transport_error");
    const removed = options.removed ? "?removed=only" : "";
    res = await withAcatReadSignal(client.request({
      url: `${TRANSFER_TRACKER_URL}${ACAT_OPS_BOOK_PATH}${removed}`,
      method: "GET",
      validateStatus: () => true,
      ...(options.signal ? { signal: options.signal, retry: false } : {}),
    }), options.signal);
  } catch {
    console.error(`[${LOG_TAG}] ops_book_transport_failed`);
    throw new AcatListError("Transfer Tracker book request failed", "transport_error");
  }
  if (res.status === 401) return fetchAcatBook(options);
  if (res.status === 200) {
    const body = res.data as { acats?: unknown } | unknown[];
    const rows = Array.isArray(body) ? body : Array.isArray(body?.acats) ? body.acats : [];
    return rows.map(mapAcatBookRow).filter((row): row is AcatBookRow => row !== null);
  }
  if (res.status === 404) return [];
  console.error(`[${LOG_TAG}] ops_book_status=${res.status}`);
  if (res.status === 403) throw new AcatListError("Transfer Tracker book unauthorized", "unauthorized");
  throw new AcatListError(`Transfer Tracker book ${res.status}`, "tracker_error");
}

/** Operations in-flight list. Same fallback as fetchAcatOpsBook. Advisor
 *  surfaces keep calling fetchAcatList. */
export async function fetchAcatOpsList(options: { signal?: AbortSignal } = {}): Promise<AcatListRow[]> {
  if (options.signal?.aborted) throw new AcatListError("ACAT list read canceled", "transport_error");
  if (acatFixtureEnabled()) return fetchAcatList(options);

  let res;
  try {
    const client = await withAcatReadSignal(auth.getIdTokenClient(TRANSFER_TRACKER_URL), options.signal);
    if (options.signal?.aborted) throw new AcatListError("ACAT list read canceled", "transport_error");
    res = await withAcatReadSignal(client.request({
      url: `${TRANSFER_TRACKER_URL}${ACAT_OPS_LIST_PATH}`,
      method: "GET",
      validateStatus: () => true,
      ...(options.signal ? { signal: options.signal, retry: false } : {}),
    }), options.signal);
  } catch {
    console.error(`[${LOG_TAG}] ops_list_transport_failed`);
    throw new AcatListError("Transfer Tracker list request failed", "transport_error");
  }
  if (res.status === 401) return fetchAcatList(options);
  if (res.status === 200) {
    const body = res.data as unknown;
    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as { acats?: unknown[] })?.acats)
        ? (body as { acats: unknown[] }).acats
        : [];
    return rows.map(mapListRow).filter((r) => r.id !== "");
  }
  if (res.status === 404) return [];
  console.error(`[${LOG_TAG}] ops_list_status=${res.status}`);
  if (res.status === 403) throw new AcatListError("Transfer Tracker list unauthorized", "unauthorized");
  throw new AcatListError(`Transfer Tracker list ${res.status}`, "tracker_error");
}

/** Operations drawer detail. Full Apex and statement numbers, or the masked
 *  by-record read when the tracker returns 401. Advisor pages keep calling
 *  getAcatStatusByRecordId. */
export async function getAcatOpsStatusByRecordId(
  recordId: string,
  options: { signal?: AbortSignal } = {},
): Promise<AcatStatus | null> {
  if (acatFixtureEnabled()) return getAcatStatusByRecordId(recordId, options);
  if (options.signal?.aborted) {
    throw new AcatStatusError("Transfer Tracker request canceled", "transport_error");
  }
  let res;
  try {
    const client = await auth.getIdTokenClient(TRANSFER_TRACKER_URL);
    if (options.signal?.aborted) {
      throw new AcatStatusError("Transfer Tracker request canceled", "transport_error");
    }
    res = await client.request({
      url: `${TRANSFER_TRACKER_URL}${ACAT_OPS_RECORD_PATH}/${encodeURIComponent(recordId)}`,
      method: "GET",
      ...(options.signal ? { signal: options.signal, timeout: 8_000 } : {}),
      validateStatus: () => true,
    });
  } catch {
    console.error(`[${LOG_TAG}] ops_record_transport_failed`);
    throw new AcatStatusError("Transfer Tracker request failed", "transport_error");
  }
  if (res.status === 401) return getAcatStatusByRecordId(recordId, options);
  if (res.status === 200) return mapStatus(res.data, "");
  if (res.status === 404) return null;
  console.error(`[${LOG_TAG}] ops_record_status=${res.status}`);
  if (res.status === 403) throw new AcatStatusError("Transfer Tracker unauthorized", "unauthorized");
  throw new AcatStatusError(`Transfer Tracker ${res.status}`, "tracker_error");
}

export type AcatWriteResponse = { status: number | null; data: unknown };

/** One machine read from the tracker. `status: null` means no answer. */
export async function readAcatMachine(path: string): Promise<AcatWriteResponse> {
  if (acatFixtureEnabled()) return { status: null, data: null };
  try {
    const client = await auth.getIdTokenClient(TRANSFER_TRACKER_URL);
    const res = await client.request({
      url: `${TRANSFER_TRACKER_URL}${path}`,
      method: "GET",
      validateStatus: () => true,
      retry: false,
      timeout: 10_000,
      headers: { "Cache-Control": "no-store" },
    });
    return { status: res.status, data: res.data };
  } catch {
    console.error(`[${LOG_TAG}] book_read_transport_failed`);
    return { status: null, data: null };
  }
}

/** One machine write to the tracker book. `DELETE` carries its JSON body like
 *  the other methods. `status: null` means no answer (fixture mode or
 *  transport failure); callers map it to a retry message. */
export async function writeAcatBookRecord(
  method: "PATCH" | "POST" | "DELETE",
  path: string,
  body: unknown,
): Promise<AcatWriteResponse> {
  if (acatFixtureEnabled()) return { status: null, data: null };
  try {
    const client = await auth.getIdTokenClient(TRANSFER_TRACKER_URL);
    const res = await client.request({
      url: `${TRANSFER_TRACKER_URL}${path}`,
      method,
      data: body,
      validateStatus: () => true,
      retry: false,
      timeout: 10_000,
      headers: { "Cache-Control": "no-store" },
    });
    if (res.status < 200 || res.status >= 300) console.error(`[${LOG_TAG}] book_write_status=${res.status}`);
    return { status: res.status, data: res.data };
  } catch {
    console.error(`[${LOG_TAG}] book_write_transport_failed`);
    return { status: null, data: null };
  }
}
