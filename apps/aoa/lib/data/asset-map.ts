import "server-only";
import { createHash } from "node:crypto";
import { ServiceAuth } from "@/lib/demo/service-auth";
import type { Prisma } from "@prisma/client";
import { CLIENT_LINK_STALE_CODES, type ClientLinkDraft, type ClientLinkReviewState } from "@/lib/data/asset-map-client-link-contract";

// Asset-mapping bulk read for the Phase-1 ingest cron (app/api/cron/asset-map).
//
// The statement-pipeline exposes an OIDC-gated bulk endpoint that returns the
// household-keyed asset-mapping tree (household → accounts[] → positions[]) with
// UNMASKED account numbers, machine transfer classifications, and the human
// override workflow. AOA PULLS it here and mirrors it into mirror.acat_asset_map_*
// (a copy, staleness-tolerant history — NOT a live read like the tracker).
//
// KEYLESS OIDC, copied from lib/data/acat-status.ts: GoogleAuth().getIdTokenClient
// (STATEMENT_PIPELINE_URL) mints an ID token whose audience == the pipeline base URL
// and whose identity is aoa-run@ on Cloud Run (ADC locally). No key file. The
// pipeline allow-lists aoa-run@ in POSITIONS_API_ALLOWED_SAS.
//
// NO-LOG discipline (mirrors acat-status.ts): NEVER log the token, the URL, the
// response body, or ANY field of it — the payload carries UNMASKED account
// numbers + PII-adjacent client names. Only STATIC markers + status codes.
//
// This module holds the typed page projection + the row-mapping PURE functions
// so the route stays thin and the mapping is unit-testable. The route owns
// pagination (it loops fetchHouseholdsPage) and the DB write.

// Non-secret env: the pipeline's base URL, used verbatim as BOTH the OIDC token
// audience (which must match the pipeline's expected audience byte-for-byte) and
// the request path prefix. Any trailing slash is stripped (a stray one would
// mismatch the audience → silent 401, and double-slash the path). Unset → the
// route treats it as a config error (503) — there is no known default URL yet.
export function assetMapBaseUrl(): string | null {
  const raw = process.env.STATEMENT_PIPELINE_URL;
  if (!raw || raw.trim() === "") return null;
  return raw.replace(/\/+$/, "");
}

const LOG_TAG = "asset-map";

/** Thrown for any pipeline read failure. The route maps it to a counts-free 502
 *  and rolls the ingest tx back (never a half-write). */
export class AssetMapError extends Error {
  constructor(
    message: string,
    readonly reason: "unauthorized" | "pipeline_error" | "transport_error",
  ) {
    super(message);
    this.name = "AssetMapError";
  }
}

// --- Raw source shapes (snake_case DB column names, per the pipeline contract).
// Every field is untrusted external data — the mappers below coerce defensively.
type RawObj = Record<string, unknown>;

/** One page of the bulk /api/v1/households response. */
export type HouseholdsPage = {
  page: number;
  per_page: number;
  total: number;
  households: RawObj[];
  /** The envelope exactly as sent (no fallback/coercion), for census validation. */
  envelope: HouseholdsEnvelope;
};

/** Strict envelope view: a field that is not a nonnegative safe integer is null. */
export type HouseholdsEnvelope = {
  page: number | null;
  per_page: number | null;
  total: number | null;
  households_is_array: boolean;
};

// --- Row shapes: exactly the columns of the three mirror tables, in the order
// they are bound into the INSERT ... ON CONFLICT statements in the route. jsonb
// bags are carried as a already-stringified string | null (the route casts
// `${...}::jsonb`); an object here would not bind as a raw param.
export type HouseholdRow = {
  id: string;
  client_name: string | null;
  run_number: number | null;
  processed_at: Date | null;
  source_created_at: Date | null;
  superseded_by: string | null;
  source_folder_id: string | null;
  total_value: number | null;
  total_accounts: number | null;
  total_positions: number | null;
  status_tallies: string | null; // JSON string | null (cast ::jsonb in SQL)
};

export type AccountRow = {
  id: string;
  household_id: string;
  custodian: string | null;
  account_type: string | null;
  account_type_raw: string | null;
  account_type_other: string | null;
  account_type_override: string | null;
  account_number: string | null; // UNMASKED — never logged
  account_holder: string | null;
  statement_date: Date | null;
  cash_balance: number | null;
  total_value: number | null;
  is_rollover: boolean | null;
  is_inherited: boolean | null;
  inherited_notes: string | null;
  apex_restriction: string | null;
  cost_basis_status: string | null;
  validation_status: string | null;
  validation_issues: string | null; // JSON string | null (cast ::jsonb in SQL)
  statement_age_days: number | null;
  is_stale: boolean | null;
  is_deleted: boolean | null;
  custodian_intel: string | null; // JSON string | null (cast ::jsonb in SQL)
  account_type_overridden_by: string | null;
  account_type_overridden_at: Date | null;
};

export type PositionRow = {
  id: string;
  account_id: string;
  symbol: string | null;
  description: string | null;
  quantity: number | null;
  market_value: number | null;
  asset_type: string | null;
  transfer_eligible: string | null;
  classification_source: string | null;
  transfer_notes: string | null;
  effective_notes: string | null;
  notion_check: string | null; // JSON string | null (cast ::jsonb in SQL)
  cost_basis: number | null;
  cost_basis_granularity: string | null;
  lots: string | null; // JSON string | null (cast ::jsonb in SQL)
  original_transfer_eligible: string | null;
  override_status: string | null;
  override_notes: string | null;
  overridden_by: string | null;
  overridden_at: Date | null;
  transferring: boolean | null;
  transferring_by: string | null;
  transferring_at: Date | null;
  effective_status: string | null;
};

/** A whole household flattened into rows for the three tables. A household or
 *  child missing its own `id` is dropped into `rejected` (never aborts). */
export type FlattenedRows = {
  households: HouseholdRow[];
  accounts: AccountRow[];
  positions: PositionRow[];
  rejected: { level: "household" | "account" | "position"; index: string; reason: string }[];
};

// --- Defensive coercions (the acat-status.ts / account-aum idiom). An unknown
// numeric becomes NULL, never 0 — a missing valuation must stay distinguishable
// from a real $0.
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s === "" ? null : s;
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function int(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
}
function strictCount(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}
function bool(v: unknown): boolean | null {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return null;
}
// The pipeline stores transferring as 'YES' / 'NO' text (db.py positions.transferring).
function transferringFlag(v: unknown): boolean | null {
  if (v === "YES") return true;
  if (v === "NO") return false;
  return bool(v);
}
function date(v: unknown): Date | null {
  if (v == null) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** Serialize a nested source bag to a JSON string for a ::jsonb bind, or NULL
 *  when the source omitted it. Objects/arrays only; a scalar or missing → NULL. */
function jsonBag(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "object") return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function mapPosition(raw: RawObj, opts: { transferringText?: boolean }): PositionRow | null {
  const id = str(raw.id);
  const accountId = str(raw.account_id);
  if (!id || !accountId) return null;
  return {
    id,
    account_id: accountId,
    symbol: str(raw.symbol),
    description: str(raw.description),
    quantity: num(raw.quantity),
    market_value: num(raw.market_value),
    asset_type: str(raw.asset_type),
    transfer_eligible: str(raw.transfer_eligible),
    classification_source: str(raw.classification_source),
    transfer_notes: str(raw.transfer_notes),
    effective_notes: str(raw.effective_notes),
    notion_check: jsonBag(raw.notion_check),
    cost_basis: num(raw.cost_basis),
    cost_basis_granularity: str(raw.cost_basis_granularity),
    lots: jsonBag(raw.lots),
    original_transfer_eligible: str(raw.original_transfer_eligible),
    override_status: str(raw.override_status),
    override_notes: str(raw.override_notes),
    overridden_by: str(raw.overridden_by),
    overridden_at: date(raw.overridden_at),
    transferring: opts.transferringText ? transferringFlag(raw.transferring) : bool(raw.transferring),
    transferring_by: str(raw.transferring_by),
    transferring_at: date(raw.transferring_at),
    effective_status: str(raw.effective_status),
  };
}

function mapAccount(raw: RawObj, householdId: string): AccountRow | null {
  const id = str(raw.id);
  if (!id) return null;
  return {
    id,
    household_id: householdId,
    custodian: str(raw.custodian),
    account_type: str(raw.account_type),
    account_type_raw: str(raw.account_type_raw),
    account_type_other: str(raw.account_type_other),
    account_type_override: str(raw.account_type_override),
    account_number: str(raw.account_number),
    account_holder: str(raw.account_holder),
    statement_date: date(raw.statement_date),
    cash_balance: num(raw.cash_balance),
    total_value: num(raw.total_value),
    is_rollover: bool(raw.is_rollover),
    is_inherited: bool(raw.is_inherited),
    inherited_notes: str(raw.inherited_note),
    apex_restriction: str(raw.apex_restriction),
    cost_basis_status: str(raw.cost_basis_status),
    validation_status: str(raw.validation_status),
    validation_issues: jsonBag(raw.validation_issues),
    statement_age_days: int(raw.statement_age_days),
    is_stale: bool(raw.is_stale),
    is_deleted: bool(raw.is_deleted),
    custodian_intel: jsonBag(raw.custodian_intel),
    account_type_overridden_by: str(raw.account_type_overridden_by),
    account_type_overridden_at: date(raw.account_type_overridden_at),
  };
}

/** The status/rollup tallies collapsed into one bag (the design's status_tallies
 *  jsonb). Only keys the source actually sent are kept; all-absent → NULL. */
function statusTallies(raw: RawObj): string | null {
  const bag: Record<string, number> = {};
  for (const key of [
    "acat_count",
    "liquidate_count",
    "unsupported_count",
    "review_count",
    "transfer_count",
    "docs_total",
    "docs_extracted",
  ]) {
    const n = int(raw[key]);
    if (n != null) bag[key] = n;
  }
  return Object.keys(bag).length === 0 ? null : JSON.stringify(bag);
}

function mapHousehold(raw: RawObj): HouseholdRow | null {
  const id = str(raw.id);
  if (!id) return null;
  return {
    id,
    client_name: str(raw.client_name),
    run_number: int(raw.run_number),
    processed_at: date(raw.processed_at),
    // The contract does not list created_at; keep the column (design §2.1) and
    // map it defensively if the source ever sends it — else NULL.
    source_created_at: date(raw.created_at),
    superseded_by: str(raw.superseded_by),
    source_folder_id: str(raw.source_folder_id),
    total_value: num(raw.total_value),
    total_accounts: int(raw.total_accounts),
    total_positions: int(raw.total_positions),
    status_tallies: statusTallies(raw),
  };
}

/**
 * Flatten one page's `households[]` (each with embedded `accounts[]` →
 * `assets[]`) into the three row arrays, in FK-parent-first order. A household /
 * account / position missing its own `id` (or an account missing a parent id) is
 * dropped to `rejected` with an index+reason — NEVER aborts the batch (the
 * account-aum posture). Accepts an existing accumulator so the route can fold
 * every page into one set.
 */
export function flattenHouseholds(
  households: unknown[],
  acc: FlattenedRows = { households: [], accounts: [], positions: [], rejected: [] },
  opts: { transferringText?: boolean } = {},
): FlattenedRows {
  households.forEach((rawH, hi) => {
    const h = (rawH ?? {}) as RawObj;
    const hRow = mapHousehold(h);
    if (!hRow) {
      acc.rejected.push({ level: "household", index: `h${hi}`, reason: "id_missing" });
      return;
    }
    acc.households.push(hRow);
    const accounts = Array.isArray(h.accounts) ? h.accounts : [];
    accounts.forEach((rawA, ai) => {
      const a = (rawA ?? {}) as RawObj;
      const aRow = mapAccount(a, hRow.id);
      if (!aRow) {
        acc.rejected.push({ level: "account", index: `${hRow.id}:a${ai}`, reason: "id_missing" });
        return;
      }
      acc.accounts.push(aRow);
      const assets = Array.isArray(a.assets) ? a.assets : [];
      assets.forEach((rawP, pi) => {
        const p = (rawP ?? {}) as RawObj;
        const pRow = mapPosition({ ...p, account_id: p.account_id ?? aRow.id }, opts);
        if (!pRow) {
          acc.rejected.push({ level: "position", index: `${aRow.id}:p${pi}`, reason: "id_missing" });
          return;
        }
        acc.positions.push(pRow);
      });
    });
  });
  return acc;
}

// One GoogleAuth per module — the token client caches/refreshes ID tokens
// internally, so we don't re-mint on every page request.
const auth = new ServiceAuth();

/**
 * Fetch ONE page of households from the pipeline's bulk endpoint.
 *   GET {base}/api/v1/households?page=<n>&per_page=<perPage>&include_superseded=true
 * The route loops this until the accumulated count reaches `total`.
 *
 * ALL-VERSIONS PULL (self-healing liveness) — `include_superseded=true` pulls
 * EVERY version, not just the live set. The statement-pipeline is append-only: each
 * document drop INSERTs a NEW household row (fresh UUID) and flips the PRIOR
 * live row's `superseded_by` → the new UUID, keyed on the stable
 * `source_folder_id` (statement-pipeline db.py write_household + supersede_previous_runs).
 * Version chains are SHORT (a handful per client — supersession fires only on a
 * doc drop, not per scan), so pulling all versions stays bounded (the route's
 * MAX_ITEMS / MAX_PAGES guards still apply).
 *
 * Why all-versions, not live-only: a live-only pull (`include_superseded=false`)
 * never re-emits a household's OLD version once it's superseded at source, so the
 * old mirror row keeps its stale `superseded_by IS NULL` forever — a ghost "live"
 * row a reader filtering on `superseded_by IS NULL` would double-count. Pulling
 * all versions re-emits the old rows WITH their now-set `superseded_by`; the
 * upsert-by-`id` (superseded_by carried verbatim — see the route's
 * upsertHousehold) demotes them, so the mirror's `superseded_by IS NULL` live-set
 * self-heals with no extra reconciliation sweep. The pipeline's `total` respects
 * the same `include_superseded` param, so page filter and count agree (both all-
 * versions now) and pagination terminates correctly.
 *
 * NOTE (Phase-2, NOT built here): person/client linking must key on the stable
 * `source_folder_id`, NOT the per-version `id` (which changes every doc drop).
 *
 * 200 → the typed page (households is coerced to [] if the body shape is off,
 *       so a single odd page never crashes the run).
 * 401/403 → AssetMapError(unauthorized); other non-2xx → pipeline_error;
 * transport throw → transport_error. The route maps any of these to a 502 and
 * rolls back. NEVER logs the url/token/body — only STATIC markers + status.
 */
export async function fetchHouseholdsPage(
  baseUrl: string,
  page: number,
  perPage: number,
): Promise<HouseholdsPage> {
  let res;
  try {
    const client = await auth.getIdTokenClient(baseUrl);
    // Always pull ALL versions (see the docstring above): superseded rows are
    // re-emitted with their now-set superseded_by so the upsert-by-id demotes the
    // mirror's stale ghosts and the live set self-heals. Param-free constant —
    // there is no caller that wants live-only.
    const qs = `page=${encodeURIComponent(String(page))}&per_page=${encodeURIComponent(
      String(perPage),
    )}&include_superseded=true`;
    res = await client.request({
      url: `${baseUrl}/api/v1/households?${qs}`,
      method: "GET",
      validateStatus: () => true, // handle status codes ourselves; no throw on non-2xx
    });
  } catch {
    console.error(`[${LOG_TAG}] transport_failed`);
    throw new AssetMapError("asset-map pipeline request failed", "transport_error");
  }

  const status = res.status;
  if (status === 200) {
    const raw = res.data;
    const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as RawObj;
    return {
      page: int(body.page) ?? page,
      per_page: int(body.per_page) ?? perPage,
      total: int(body.total) ?? 0,
      households: Array.isArray(body.households) ? (body.households as RawObj[]) : [],
      envelope: {
        page: strictCount(body.page),
        per_page: strictCount(body.per_page),
        total: strictCount(body.total),
        households_is_array: Array.isArray(body.households),
      },
    };
  }
  // STATUS ONLY — never the body (it carries unmasked account numbers + names).
  console.error(`[${LOG_TAG}] status=${status}`);
  if (status === 401 || status === 403) {
    throw new AssetMapError("asset-map pipeline unauthorized", "unauthorized");
  }
  throw new AssetMapError(`asset-map pipeline ${status}`, "pipeline_error");
}

// --- In-app workspace reads. Mirror reads must run on the caller's
// withUserScope tx so RLS applies.

export type AssetMapHouseholdStatus = "blocked" | "attention" | "caution" | "ok" | "neutral";
export type AssetMapRunSummary = {
  id: string; clientName: string | null; runNumber: number | null;
  processedAt: string | null; supersededBy: string | null;
  totalAccounts: number | null; totalPositions: number | null;
  /** Worst routing status from the pipeline's status_tallies; can lag later operator edits. */
  status: AssetMapHouseholdStatus;
};
export type AssetMapLot = { acquisitionDate: string | null; quantity: number | null; costBasis: number | null };
export type AssetMapPositionView = {
  id: string; symbol: string | null; description: string | null; assetType: string | null;
  quantity: number | null; marketValue: number | null;
  transferEligible: string | null; effectiveStatus: string | null;
  transferNotes: string | null; effectiveNotes: string | null;
  costBasis: number | null; costBasisGranularity: string | null;
  transferring: boolean | null; lots: AssetMapLot[];
};
/** Who set the account type by hand, and when. `by` is null when no person can be named. */
export type AssetMapAccountTypeOverride = { by: string | null; at: string };
export type AssetMapAccountView = {
  id: string; custodian: string | null; accountType: string | null; accountTypeOther: string | null;
  accountNumberMasked: string | null; accountHolder: string | null;
  statementDate: string | null; // "YYYY-MM-DD"
  statementAgeDays: number | null; isStale: boolean | null;
  totalValue: number | null; isRollover: boolean | null; isInherited: boolean | null;
  inheritedNotes: string | null; apexRestriction: string | null;
  costBasisStatus: string | null; validationStatus: string | null; validationIssues: string[];
  custodianIntel: { dtccNumber: string | null; acatTimeline: string | null } | null;
  accountTypeOverride?: AssetMapAccountTypeOverride | null;
  positions: AssetMapPositionView[];
};
export type AssetMapHouseholdView = {
  id: string; clientName: string | null; processedAt: string | null;
  docsTotal: number | null; docsExtracted: number | null;
  accounts: AssetMapAccountView[];
};
export type AssetMapScheduleStatus = {
  active: boolean; scanIntervalMinutes: number; businessDays: string; businessHours: string;
};
export type AssetMapDocResult = {
  filename: string | null; status: string | null; reason: string | null;
  accountsExtracted: number | null; positionsExtracted: number | null;
};
export type AssetMapReviewState = {
  reviewedAt: string | null; reviewedBy: string | null; updatedAt: string | null;
};
export type AssetMapHouseholdLiveExtras = {
  docResults: AssetMapDocResult[];
  rolloverNotes: Record<string, string>; // account id → note (non-empty only)
  review?: AssetMapReviewState;
};

type MirrorHouseholdListRow = {
  id: string; client_name: string | null; run_number: unknown; processed_at: Date | null;
  superseded_by: string | null; total_accounts: unknown; total_positions: unknown; status_tallies: unknown;
};
type MirrorHouseholdRow = {
  id: string; client_name: string | null; processed_at: Date | null; status_tallies: unknown;
};
type MirrorAccountRow = {
  id: string; custodian: string | null; account_type: string | null; account_type_other: string | null;
  account_number: string | null; account_holder: string | null; statement_date: unknown;
  statement_age_days: unknown; is_stale: boolean | null; total_value: unknown;
  is_rollover: boolean | null; is_inherited: boolean | null; inherited_notes: string | null;
  apex_restriction: string | null; cost_basis_status: string | null; validation_status: string | null;
  validation_issues: unknown; custodian_intel: unknown;
  account_type_overridden_by: string | null; account_type_overridden_at: Date | null;
  account_type_audit_actor: string | null;
};
type MirrorPositionRow = {
  id: string; account_id: string; symbol: string | null; description: string | null;
  asset_type: string | null; quantity: unknown; market_value: unknown;
  transfer_eligible: string | null; effective_status: string | null;
  transfer_notes: string | null; effective_notes: string | null;
  cost_basis: unknown; cost_basis_granularity: string | null;
  transferring: boolean | null; lots: unknown;
};

function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function maskAccount(accountNumber: string | null): string | null {
  return accountNumber == null ? null : `••••${accountNumber.slice(-4)}`;
}

function isoDayOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function isoOrNull(v: Date | null): string | null {
  return v instanceof Date ? v.toISOString() : null;
}

function isPlainObject(v: unknown): v is RawObj {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function parseValidationIssues(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseCustodianIntel(v: unknown): AssetMapAccountView["custodianIntel"] {
  if (!isPlainObject(v)) return null;
  return { dtccNumber: stringOrNull(v.dtcc_number), acatTimeline: stringOrNull(v.acat_timeline) };
}

function parseLots(v: unknown): AssetMapLot[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isPlainObject).map((l) => ({
    acquisitionDate: stringOrNull(l.acquisition_date),
    quantity: num(l.quantity),
    costBasis: num(l.cost_basis),
  }));
}

export function householdStatusFromTallies(tallies: unknown): AssetMapHouseholdStatus {
  const t = isPlainObject(tallies) ? tallies : {};
  const count = (key: string) => num(t[key]) ?? 0;
  if (count("unsupported_count") > 0) return "blocked";
  if (count("liquidate_count") > 0) return "attention";
  if (count("review_count") > 0) return "caution";
  if (count("acat_count") > 0 || count("transfer_count") > 0) return "ok";
  return "neutral";
}

/** AoA's Cloud Run runtime identity per environment. The pipeline records this
 *  email as the override person when AoA saves on an operator's behalf; the AoA
 *  audit row then names the operator. */
export const AOA_RUNTIME_SERVICE_ACCOUNTS = {
  prod: "aoa-run@ops-portal.iam.gserviceaccount.com",
  dev: "aoa-run@ops-portal-dev.iam.gserviceaccount.com",
} as const;

/** This environment's identity only, so another environment's service account
 *  is never credited to a local audit row. */
export function aoaRuntimeServiceAccount(): string | null {
  const env = process.env.APP_ENV;
  return env === "prod" || env === "dev" ? AOA_RUNTIME_SERVICE_ACCOUNTS[env] : null;
}

export function accountTypeOverride(
  by: string | null,
  at: Date | null,
  auditActor: string | null,
): AssetMapAccountTypeOverride | null {
  if (!(at instanceof Date)) return null;
  const self = aoaRuntimeServiceAccount();
  const viaAoa = self != null && by != null && by.trim().toLowerCase() === self;
  return { by: viaAoa ? auditActor : by, at: at.toISOString() };
}

export async function readAssetMapHouseholdList(
  tx: Prisma.TransactionClient,
): Promise<AssetMapRunSummary[]> {
  const rows = await tx.$queryRaw<MirrorHouseholdListRow[]>`
    SELECT id, client_name, run_number, processed_at, superseded_by, total_accounts, total_positions, status_tallies
    FROM mirror.acat_asset_map_household
    ORDER BY client_name NULLS LAST, processed_at DESC NULLS LAST, id
    LIMIT 20000`;
  return rows.map((r) => ({
    id: r.id,
    clientName: r.client_name,
    runNumber: numOrNull(r.run_number),
    processedAt: isoOrNull(r.processed_at),
    supersededBy: r.superseded_by,
    totalAccounts: numOrNull(r.total_accounts),
    totalPositions: numOrNull(r.total_positions),
    status: householdStatusFromTallies(r.status_tallies),
  }));
}

export async function readAssetMapHousehold(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<AssetMapHouseholdView | null> {
  const households = await tx.$queryRaw<MirrorHouseholdRow[]>`
    SELECT id, client_name, processed_at, status_tallies
    FROM mirror.acat_asset_map_household
    WHERE id = ${id}`;
  const h = households[0];
  if (h == null) return null;

  const accounts = await tx.$queryRaw<MirrorAccountRow[]>`
    SELECT id, custodian, account_type, account_type_other, account_number, account_holder,
           statement_date, statement_age_days, is_stale, total_value, is_rollover, is_inherited,
           inherited_notes, apex_restriction, cost_basis_status, validation_status,
           validation_issues, custodian_intel, account_type_overridden_by, account_type_overridden_at,
           type_edit."actorEmail" AS account_type_audit_actor
    FROM mirror.acat_asset_map_account acc
    LEFT JOIN LATERAL (
      SELECT "actorEmail" FROM audit."AuditLog"
      WHERE action = ${"asset_map_edit.account_type"}
        AND "entityType" = ${"asset_map_account"} AND "entityId" = acc.id
      ORDER BY at DESC, id DESC LIMIT 1
    ) type_edit ON true
    WHERE household_id = ${id} AND is_deleted IS NOT TRUE
    ORDER BY custodian NULLS LAST, account_type NULLS LAST, id`;

  const accountIds = accounts.map((a) => a.id);
  const positions = accountIds.length === 0
    ? []
    : await tx.$queryRaw<MirrorPositionRow[]>`
        SELECT id, account_id, symbol, description, asset_type, quantity, market_value,
               transfer_eligible, effective_status, transfer_notes, effective_notes,
               cost_basis, cost_basis_granularity, transferring, lots
        FROM mirror.acat_asset_map_position
        WHERE account_id = ANY(${accountIds}) AND is_deleted IS NOT TRUE
        ORDER BY market_value DESC NULLS LAST, id`;

  const byAccount = new Map<string, AssetMapPositionView[]>();
  for (const p of positions) {
    const list = byAccount.get(p.account_id) ?? [];
    list.push({
      id: p.id,
      symbol: p.symbol,
      description: p.description,
      assetType: p.asset_type,
      quantity: numOrNull(p.quantity),
      marketValue: numOrNull(p.market_value),
      transferEligible: p.transfer_eligible,
      effectiveStatus: p.effective_status,
      transferNotes: p.transfer_notes,
      effectiveNotes: p.effective_notes,
      costBasis: numOrNull(p.cost_basis),
      costBasisGranularity: p.cost_basis_granularity,
      transferring: p.transferring,
      lots: parseLots(p.lots),
    });
    byAccount.set(p.account_id, list);
  }

  const tallies = isPlainObject(h.status_tallies) ? h.status_tallies : {};
  return {
    id: h.id,
    clientName: h.client_name,
    processedAt: isoOrNull(h.processed_at),
    docsTotal: num(tallies.docs_total),
    docsExtracted: num(tallies.docs_extracted),
    accounts: accounts.map((a) => ({
      id: a.id,
      custodian: a.custodian,
      accountType: a.account_type,
      accountTypeOther: a.account_type_other,
      accountNumberMasked: maskAccount(a.account_number),
      accountHolder: a.account_holder,
      statementDate: isoDayOrNull(a.statement_date),
      statementAgeDays: numOrNull(a.statement_age_days),
      isStale: a.is_stale,
      totalValue: numOrNull(a.total_value),
      isRollover: a.is_rollover,
      isInherited: a.is_inherited,
      inheritedNotes: a.inherited_notes,
      apexRestriction: a.apex_restriction,
      costBasisStatus: a.cost_basis_status,
      validationStatus: a.validation_status,
      validationIssues: parseValidationIssues(a.validation_issues),
      custodianIntel: parseCustodianIntel(a.custodian_intel),
      accountTypeOverride: accountTypeOverride(a.account_type_overridden_by, a.account_type_overridden_at, a.account_type_audit_actor),
      positions: byAccount.get(a.id) ?? [],
    })),
  };
}

/** 0-based position of household `id` in the pipeline bulk order
 *  `processed_at DESC, id` (Postgres DESC puts NULLs first). */
export async function readAssetMapBulkOffset(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<number | null> {
  const present = await tx.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one FROM mirror.acat_asset_map_household WHERE id = ${id}`;
  if (present.length === 0) return null;
  const rows = await tx.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM mirror.acat_asset_map_household o, mirror.acat_asset_map_household t
    WHERE t.id = ${id}
      AND (o.processed_at > t.processed_at
           OR (o.processed_at = t.processed_at AND o.id < t.id)
           OR (o.processed_at IS NULL AND t.processed_at IS NOT NULL))`;
  return Number(rows[0]?.n ?? 0);
}

export async function fetchAssetMapScheduleStatus(
  baseUrl: string,
): Promise<AssetMapScheduleStatus | null> {
  let res;
  try {
    const client = await auth.getIdTokenClient(baseUrl);
    res = await client.request({
      url: `${baseUrl}/api/schedule-status`,
      method: "GET",
      validateStatus: () => true,
    });
  } catch {
    console.error(`[${LOG_TAG}] schedule_transport_failed`);
    return null;
  }
  if (res.status !== 200) {
    console.error(`[${LOG_TAG}] schedule_status=${res.status}`);
    return null;
  }
  const raw = res.data;
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as RawObj;
  if (
    typeof body.active !== "boolean" ||
    typeof body.scan_interval_minutes !== "number" ||
    !Number.isFinite(body.scan_interval_minutes) ||
    typeof body.business_days !== "string" ||
    typeof body.business_hours !== "string"
  ) {
    return null;
  }
  return {
    active: body.active,
    scanIntervalMinutes: body.scan_interval_minutes,
    businessDays: body.business_days,
    businessHours: body.business_hours,
  };
}

function mapDocResult(raw: unknown): AssetMapDocResult {
  const d = isPlainObject(raw) ? raw : {};
  return {
    filename: str(d.filename),
    status: str(d.status),
    reason: str(d.reason),
    accountsExtracted: num(d.accounts_extracted),
    positionsExtracted: num(d.positions_extracted),
  };
}

/** Keeps only the target household's doc_results and rollover notes; the rest of
 *  the page (unmasked account numbers, other clients) is discarded. The mirror
 *  offset drifts from the pipeline, so the next and previous pages are tried too. */
export async function fetchAssetMapHouseholdLiveExtras(
  baseUrl: string,
  householdId: string,
  offset: number,
): Promise<AssetMapHouseholdLiveExtras | null> {
  const PER = 200;
  const first = Math.floor(offset / PER) + 1;
  try {
    for (const page of [first, first + 1, first - 1]) {
      if (page < 1) continue;
      const { households } = await fetchHouseholdsPage(baseUrl, page, PER);
      const h = households.find((x) => String(x.id) === householdId);
      if (h == null) continue;
      const docs = Array.isArray(h.doc_results) ? h.doc_results : [];
      const accounts: unknown[] = Array.isArray(h.accounts) ? h.accounts : [];
      const rolloverNotes: Record<string, string> = Object.fromEntries(
        accounts.filter(isPlainObject).flatMap((a) =>
          typeof a.rollover_note === "string" && a.rollover_note !== ""
            ? [[String(a.id), a.rollover_note] as const]
            : [],
        ),
      );
      return {
        docResults: docs.map(mapDocResult),
        rolloverNotes,
        review: { reviewedAt: str(h.reviewed_at), reviewedBy: str(h.reviewed_by), updatedAt: str(h.updated_at) },
      };
    }
    return null;
  } catch (err) {
    if (err instanceof AssetMapError) return null;
    throw err;
  }
}

// --- In-app edits (ticket). The pipeline is the system of record; these call
// its seven position/account edit routes on the same keyless OIDC client, which
// the pipeline accepts through POSITIONS_API_ALLOWED_SAS. Same no-log rule:
// static markers and status codes only.

export type AssetMapPositionStatus = "ACAT" | "LIQUIDATE" | "UNSUPPORTED" | "REVIEW" | "ACH/WIRE";
export type AssetMapTransferringValue = "YES" | "NO" | null;

export type AssetMapEditRequest =
  | { kind: "positionStatus"; positionId: string; status: AssetMapPositionStatus }
  | { kind: "positionTransferring"; positionId: string; value: AssetMapTransferringValue }
  | { kind: "accountType"; accountId: string; accountType: string; accountTypeOther: string | null }
  | { kind: "removePosition"; positionId: string }
  | { kind: "restorePosition"; positionId: string }
  | { kind: "removeAccount"; accountId: string }
  | { kind: "restoreAccount"; accountId: string };

export type AssetMapEditOutcome =
  | { ok: true; body: RawObj }
  | { ok: false; reason: "rejected" | "unavailable" };

const EDIT_TIMEOUT_MS = 15_000;

/** The note the pipeline UI sends with a status override, and the note the
 *  pipeline then stores on the position. */
export function statusOverrideNote(status: AssetMapPositionStatus): string {
  return `Manual override to ${status}`;
}

function editRoute(req: AssetMapEditRequest): { method: "PATCH" | "DELETE"; path: string; data?: RawObj } {
  switch (req.kind) {
    case "positionStatus":
      return {
        method: "PATCH",
        path: `/api/positions/${encodeURIComponent(req.positionId)}/status`,
        data: { status: req.status, notes: statusOverrideNote(req.status) },
      };
    case "positionTransferring":
      return { method: "PATCH", path: `/api/positions/${encodeURIComponent(req.positionId)}/transferring`, data: { value: req.value } };
    case "accountType":
      return {
        method: "PATCH",
        path: `/api/accounts/${encodeURIComponent(req.accountId)}/type`,
        data: { account_type: req.accountType, account_type_other: req.accountTypeOther },
      };
    case "removePosition":
      return { method: "DELETE", path: `/api/positions/${encodeURIComponent(req.positionId)}` };
    case "restorePosition":
      return { method: "PATCH", path: `/api/positions/${encodeURIComponent(req.positionId)}/restore` };
    case "removeAccount":
      return { method: "DELETE", path: `/api/accounts/${encodeURIComponent(req.accountId)}` };
    case "restoreAccount":
      return { method: "PATCH", path: `/api/accounts/${encodeURIComponent(req.accountId)}/restore` };
  }
}

/** 2xx → the response body; 5xx, timeout, or transport failure → unavailable;
 *  any other status → rejected. Never logs the url, token, or body. */
export async function sendAssetMapEdit(baseUrl: string, req: AssetMapEditRequest): Promise<AssetMapEditOutcome> {
  const { method, path, data } = editRoute(req);
  let res;
  try {
    const client = await auth.getIdTokenClient(baseUrl);
    res = await client.request({
      url: `${baseUrl}${path}`,
      method,
      data,
      timeout: EDIT_TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch {
    console.error(`[${LOG_TAG}] edit_transport_failed`);
    return { ok: false, reason: "unavailable" };
  }
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, body: isPlainObject(res.data) ? res.data : {} };
  }
  console.error(`[${LOG_TAG}] edit_status=${res.status}`);
  return { ok: false, reason: res.status >= 500 ? "unavailable" : "rejected" };
}

// --- Client linking (ticket). Live calls to the pipeline's client-link routes
// on the same keyless OIDC client. The pipeline accepts AoA's service account
// there (server.py client_link_user) and records its email as the actor.
// Nothing here is mirrored.

export type ClientLinkRequest =
  | { kind: "config" }
  | { kind: "queue"; q: string; reviewState: ClientLinkReviewState | null; cursor: string | null; limit: number }
  | { kind: "run"; runId: string }
  | { kind: "search"; q: string }
  | { kind: "preview"; draft: ClientLinkDraft }
  | { kind: "apply"; previewId: string; payloadHash: string; idempotencyKey: string }
  | { kind: "retry"; runId: string }
  | { kind: "batch"; batchId: string }
  | { kind: "revertPreview"; batchId: string };

export type ClientLinkFailure = "disabled" | "writes_disabled" | "stale" | "rejected" | "unavailable";
export type ClientLinkOutcome =
  | { ok: true; body: unknown }
  | { ok: false; reason: ClientLinkFailure; message: string | null };

const CLIENT_LINK_TIMEOUT_MS = 15_000;

function clientLinkRoute(req: ClientLinkRequest): { method: "GET" | "POST"; path: string; params?: Record<string, string>; data?: unknown } {
  switch (req.kind) {
    case "config": return { method: "GET", path: "/api/config" };
    case "queue": {
      const params: Record<string, string> = { q: req.q, limit: String(req.limit) };
      if (req.reviewState) params.review_state = req.reviewState;
      if (req.cursor) params.cursor = req.cursor;
      return { method: "GET", path: "/api/client-links", params };
    }
    case "run": return { method: "GET", path: `/api/households/${encodeURIComponent(req.runId)}/client-link` };
    case "search": return { method: "GET", path: "/api/client-directory/search", params: { q: req.q } };
    case "preview": return { method: "POST", path: "/api/client-links/preview", data: req.draft };
    case "apply":
      return {
        method: "POST",
        path: "/api/client-links/apply",
        data: { preview_id: req.previewId, payload_hash: req.payloadHash, idempotency_key: req.idempotencyKey, acknowledged: true },
      };
    case "retry": return { method: "POST", path: `/api/households/${encodeURIComponent(req.runId)}/client-link/retry` };
    case "batch": return { method: "GET", path: `/api/client-links/batches/${encodeURIComponent(req.batchId)}` };
    case "revertPreview": return { method: "POST", path: `/api/client-links/batches/${encodeURIComponent(req.batchId)}/revert-preview` };
  }
}

/** Pipeline error body {detail: {code, message}} → the UI's failure kind. */
export function classifyClientLinkFailure(status: number, body: unknown): { reason: ClientLinkFailure; message: string | null } {
  const detail = isPlainObject(body) && isPlainObject(body.detail) ? body.detail : null;
  const code = typeof detail?.code === "string" ? detail.code : null;
  const message = typeof detail?.message === "string" ? detail.message
    : isPlainObject(body) && typeof body.detail === "string" ? body.detail : null;
  if (code === "feature_disabled") return { reason: "disabled", message };
  if (code === "writes_disabled") return { reason: "writes_disabled", message };
  if (code && (CLIENT_LINK_STALE_CODES as readonly string[]).includes(code)) return { reason: "stale", message };
  if (status >= 500) return { reason: "unavailable", message };
  return { reason: "rejected", message };
}

/** Same preview and hash → same key, so "Retry same apply" replays, never duplicates. */
export function clientLinkIdempotencyKey(previewId: string, payloadHash: string): string {
  return `aoa-${createHash("sha256").update(`${previewId}:${payloadHash}`).digest("hex")}`;
}

/** Never logs the url, token, query, or body. */
export async function sendAssetMapClientLink(baseUrl: string, req: ClientLinkRequest): Promise<ClientLinkOutcome> {
  const { method, path, params, data } = clientLinkRoute(req);
  let res;
  try {
    const client = await auth.getIdTokenClient(baseUrl);
    res = await client.request({ url: `${baseUrl}${path}`, method, params, data, timeout: CLIENT_LINK_TIMEOUT_MS, validateStatus: () => true });
  } catch {
    console.error(`[${LOG_TAG}] client_link_transport_failed kind=${req.kind}`);
    return { ok: false, reason: "unavailable", message: null };
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, body: res.data };
  console.error(`[${LOG_TAG}] client_link_status=${res.status} kind=${req.kind}`);
  return { ok: false, ...classifyClientLinkFailure(res.status, res.data) };
}
