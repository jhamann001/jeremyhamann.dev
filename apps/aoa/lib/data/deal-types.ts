// Deals contract module (TDD ticket §3/§4, ADR-8) — PURE: no Prisma import,
// so the D4 scripts and unit tests consume it without touching the client.
// Shared by the D2 seam (`lib/data/deals.ts`), the D3 form actions, and the D4
// import — one vocabulary, one row shape, one input shape.

// The cedar_ridge_user_id visibility gate reuses the Client Portrait's PURE
// predicate (single source of truth for the ADMIN/OPERATIONS role set — see the
// blueprint). client-field-authz.ts imports nothing, so there is no cycle.
import { canViewCedarRidgeUserId } from "./client-field-authz";
import type { HouseholdDeal, HouseholdDealSummary } from "./types";

// Pipeline stages in pipeline order (ADR-3). String-literal union is
// structurally identical to the Prisma `DealStage` enum.
export const DEAL_STAGES = [
  "POTENTIAL",
  "COMMITTED",
  "FUNDING",
  "WON",
  "LOST",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

/** Pure summary used by the household Deals card. WON is displayed as Funded. */
export function summarizeHouseholdDeals(
  deals: ReadonlyArray<Pick<HouseholdDeal, "stage" | "amount">>,
): HouseholdDealSummary {
  let outstandingAmount = 0;
  let outstandingCount = 0;
  let fundedAmount = 0;
  let fundedCount = 0;
  for (const deal of deals) {
    if (deal.stage === "WON") {
      fundedCount += 1;
      fundedAmount += deal.amount;
    } else if (deal.stage !== "LOST") {
      outstandingCount += 1;
      outstandingAmount += deal.amount;
    }
  }
  return {
    openPipeline: outstandingAmount,
    count: deals.length,
    wonCount: fundedCount,
    outstandingCount,
    outstandingAmount,
    fundedCount,
    fundedAmount,
  };
}

// Row provenance (ADR-2): APP = entered in AOA; IMPORT = the one-time import
// (carries the real Salesforce deal id — the future sync's dedupe key).
export const DEAL_SOURCES = ["APP", "IMPORT"] as const;
export type DealSource = (typeof DEAL_SOURCES)[number];

// Pipeline ordering for KPI tiles / stage selects (D2/D3 render in this order).
export const STAGE_ORDER: readonly DealStage[] = DEAL_STAGES;

// Display vocabulary (TKT deals relabel): the ENUM KEYS are UNCHANGED (the
// pipeline order + all won/lost logic ride on them) — only the human LABELS
// change. Label ⇄ key mapping:
//   Potential            ⇄ POTENTIAL
//   Potential-Committed  ⇄ COMMITTED
//   Potential-In Process ⇄ FUNDING
//   Funded               ⇄ WON
//   Lost                 ⇄ LOST
export const STAGE_LABEL: Record<DealStage, string> = {
  POTENTIAL: "Potential",
  COMMITTED: "Potential-Committed",
  FUNDING: "Potential-In Process",
  WON: "Funded",
  LOST: "Lost",
};

export function stageLabel(stage: DealStage): string {
  return STAGE_LABEL[stage];
}

// ticket: linking imported deals to synced households. The two systems store
// the Salesforce id at DIFFERENT widths:
//   • `mirror.household.sf_id`  — 18-char (15-char base + 3-char case-safe checksum)
//   • `app.deal.household_sf_id` — 15-char (the CRM import kept the short form)
// They are the SAME record: the 18-char id is the 15-char id plus a checksum, so
// the first 15 chars are identical and lossless to compare on. A naive `=` join
// matches ZERO rows (18 ≠ 15); normalizing the household id to its 15-char prefix
// makes the join exact. PURE (no Prisma) so the seam and the unit test share ONE
// definition of the key. Shorter/edge inputs are returned as-is (slice(0,15) is
// a no-op below 15 chars); null/undefined → null (fail-closed: no key, no match).
export function householdDealKey(
  sfId: string | null | undefined,
): string | null {
  if (sfId == null) return null;
  return sfId.slice(0, 15);
}

// tkt-deals-client-link (AUM layer): `person_aum` is the INDIVIDUAL client's
// TOTAL managed AUM (the report's "Person: AUM"), repeated verbatim on EVERY
// one of that person's deal rows — NOT a per-deal figure. So any sum across a
// household's deals MUST dedupe by `client_sf_id` (one person_aum per client)
// or a client with N deals is counted N×. These pure reducers live here (with
// householdDealKey) so both the household seam and the portrait seam share ONE
// definition and can never disagree. Minimal row shape (client id + person aum)
// so BOTH `DealRow` and the household `HouseholdDeal` projection satisfy it;
// `person_aum` is Number()-coerced at the seam (never a raw Decimal here).
export type ClientAumRow = {
  client_sf_id: string | null;
  person_aum: number | null;
};

/**
 * Managed AUM summed over DISTINCT clients: one `person_aum` per distinct
 * `client_sf_id`. Rows with a null `client_sf_id` OR a null `person_aum`
 * contribute nothing. Returns null when NO row contributes.
 *
 * Per-client pick is the MAX person_aum — deliberately ORDER-INDEPENDENT so the
 * household-detail and portrait queries (which ORDER BY differently) always
 * agree, even if a re-ingest ever leaves a client's rows carrying different
 * person_aum values. (Normally every row for a client repeats the same figure,
 * so max == first == any; max just removes the row-order dependency.)
 *
 * NOTE: prefer `householdAumFromDeals` for a household total — this bare sum
 * has NO completeness gate, so a partially-backfilled household undercounts.
 */
export function sumDistinctClientAum(
  deals: readonly ClientAumRow[],
): number | null {
  const byClient = new Map<string, number>();
  for (const d of deals) {
    if (d.client_sf_id == null || d.person_aum == null) continue;
    const prev = byClient.get(d.client_sf_id);
    if (prev == null || d.person_aum > prev) {
      byClient.set(d.client_sf_id, d.person_aum);
    }
  }
  if (byClient.size === 0) return null;
  let sum = 0;
  for (const v of byClient.values()) sum += v;
  return sum;
}

/**
 * A household's deals-derived managed AUM, WITH a completeness gate: only trust
 * the deals-derived total when the household is FULLY backfilled — i.e. every
 * deal row already carries a `client_sf_id`. If ANY row is still un-backfilled
 * (null client_sf_id), return null so the caller falls back to
 * `mirror.household.aum`. Without this gate a mid-backfill household (client A
 * linked, client B not yet) would sum A alone → a non-null UNDERSTATED total
 * that suppresses the mirror fallback. The feed backfills all of a household's
 * deals in one run, so the partial state is transient: mirror until complete,
 * then deals-derived — no undercount window.
 *
 * An empty deal set has no un-backfilled row, so it yields null via the sum
 * (no contributors) → mirror fallback, as before.
 */
export function householdAumFromDeals(
  deals: readonly ClientAumRow[],
): number | null {
  if (deals.some((d) => d.client_sf_id == null)) return null;
  return sumDistinctClientAum(deals);
}

// tkt-households-aum-rollup: the households LIST page needs the deals-derived
// fallback for EVERY visible household at once (one bulk query, no per-row
// N+1). This groups a flat pull of (household_sf_id, client_sf_id, person_aum)
// deal rows by the 15-char household key (`householdDealKey` — the SAME width
// normalization the detail page's join uses) and applies `householdAumFromDeals`
// per group, so the list can never disagree with the detail page on either the
// join key or the completeness gate. Rows with no household key are dropped
// (they can't attach to any list row). PURE (no Prisma) — unit-tested alongside
// the single-household helpers it composes.
export type HouseholdClientAumRow = ClientAumRow & {
  household_sf_id: string | null;
};

/** Deals-derived AUM per household, keyed by the 15-char household key.
 *  Each household's value is `householdAumFromDeals` over its rows — i.e. null
 *  (→ next fallback) when ANY of its deals is still un-backfilled. */
export function householdAumFromDealsByKey(
  rows: readonly HouseholdClientAumRow[],
): Map<string, number | null> {
  const byHousehold = new Map<string, ClientAumRow[]>();
  for (const r of rows) {
    const key = householdDealKey(r.household_sf_id);
    if (key == null) continue;
    const group = byHousehold.get(key);
    if (group) group.push(r);
    else byHousehold.set(key, [r]);
  }
  const out = new Map<string, number | null>();
  for (const [key, deals] of byHousehold) {
    out.set(key, householdAumFromDeals(deals));
  }
  return out;
}

/**
 * The single `person_aum` for ONE client's deals — the first non-null value
 * (all rows for a client repeat the same figure), or null when none carry it.
 * The Client Portrait uses this to show the client's own managed AUM.
 */
export function clientPersonAum(deals: readonly ClientAumRow[]): number | null {
  for (const d of deals) {
    if (d.person_aum != null) return d.person_aum;
  }
  return null;
}

// tkt account-AUM feed: the headline-AUM fallback chain, Apex-first. The Apex
// per-account total (SOD from Warehouse card 6436) is the most authoritative
// figure now, ahead of the deals-derived person_aum sum and the mirror.household
// snapshot. PURE (no Prisma) so the selection is unit-testable and the household
// seam + the portrait/reminders seams can never disagree on precedence. Returns
// the winning value AND a source label for the header/badge.
export type AumSource = "apex" | "custodians" | "deals" | "mirror";

export function pickHouseholdAum(
  apex: number | null,
  deals: number | null,
  mirror: number | null,
): { aum: number | null; source: AumSource } {
  if (apex != null) return { aum: apex, source: "apex" };
  if (deals != null) return { aum: deals, source: "deals" };
  return { aum: mirror, source: "mirror" };
}

// D8 (WO ticket): funding-type vocabulary — the mockup's DEAL_ACCT_TYPES,
// verbatim and in its order. Stored in the existing `account_type` TEXT column
// (no rename migration); legacy/imported values outside this list are
// prepended as an extra selectable option by the form (mockup rule).
export const FUNDING_TYPES = [
  "Traditional IRA",
  "Roth IRA",
  "Inherited Traditional IRA",
  "Inherited Roth IRA",
  "Individual Brokerage",
  "JT TIC",
  "JT WROS",
  "Community Property",
  "SEP IRA",
  "401(k) Rollover",
  "Annuity",
  "Cash",
  "Trust",
  "Other",
] as const;

// The two funding types with companion behavior (shared by form + actions so
// the strings can never drift between show/hide and server-side clearing).
export const FUNDING_TYPE_ROLLOVER = "401(k) Rollover";
export const FUNDING_TYPE_CASH = "Cash";
export const FUNDING_TYPE_OTHER = "Other";

// "Rolling into" options for a 401(k) Rollover (mockup's optional select).
export const ROLLING_INTO_OPTIONS = ["Traditional IRA", "Roth IRA"] as const;

// One stage-timeline entry (D8): appended on create and on every stage change,
// in the SAME transaction as the row write + audit row. `from` is null on
// create; `at` is an ISO timestamp; `by` is the acting user's name or email.
export type StageHistoryEntry = {
  stage: DealStage;
  from: DealStage | null;
  at: string;
  by: string | null;
};

// The full app.deal row as the D2 seam returns it (TDD §3 contract).
//
// DECIMAL TRAP (carried, see lib/data/households.ts): `amount`, `person_aum`
// and `potential_aum` are Postgres `numeric` columns — Prisma hands back
// Decimal objects at runtime, which do NOT serialize across the Server →
// Client Component boundary. The seam MUST coerce them with Number() before a
// row leaves lib/data/deals.ts; these fields are typed `number` to encode that
// contract. Dates come back as Date objects (RSC-serializable as-is).
export type DealRow = {
  id: string;
  source: DealSource;
  sf_deal_id: string | null;
  name: string;
  client_first_name: string;
  client_last_name: string;
  household_name: string | null;
  household_sf_id: string | null;
  client_sf_id: string | null; // 18-char SF Contact id — matches mirror.client.sf_id directly
  amount: number; // Number() at the seam — never a raw Decimal
  stage: DealStage;
  stage_raw: string | null;
  created_date: Date;
  close_date: Date | null;
  last_activity_date: Date | null;
  owner_name: string | null; // null = unassigned (em-dash in the table)
  owner_sf_user_id: string | null;
  secondary_owner: string | null;
  person_aum: number | null; // Number() at the seam
  potential_aum: number | null; // Number() at the seam
  cedar_ridge_user_id: string | null;
  // Visibility flag set by the seam (NOT a DB column): true when a real
  // cedar_ridge_user_id exists but was withheld for this caller's role. The UI
  // renders MASKED_CEDAR_RIDGE_ID when true + cedar_ridge_user_id === null.
  cedar_ridge_user_id_masked: boolean;
  statements: boolean;
  asset_mapped: boolean; // ops-owned "asset mapper run" flag (S1); toggle-only
  plaid_linked: boolean;
  account_last4: string | null;
  account_type: string | null; // funding type (D8) — column name kept
  transferring_firm: string | null;
  // D8 (WO ticket): 401(k)-Rollover companions (null for other funding
  // types), win/loss provenance, archive reason, stage timeline. jsonb comes
  // back from $queryRaw already parsed (RSC-serializable as-is).
  employer: string | null;
  rolling_into: string | null;
  lost_from: string | null;
  archived_reason: string | null;
  stage_history: StageHistoryEntry[];
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  // D7 soft delete (WO ticket): non-null archived_at = removed from the
  // pipeline (excluded from table/KPIs/search/export at the seam); the row
  // survives — hard DELETE stays revoked. Dates serialize across the RSC
  // boundary as-is (no coercion needed).
  archived_at: Date | null;
  archived_by: string | null;
};

/** Fixed, length-agnostic mask for cedar_ridge_user_id (never reveals real length). */
export const MASKED_CEDAR_RIDGE_ID = "••••••••";

/**
 * Role-gated projection of one DealRow's cedar_ridge_user_id. Authorized roles
 * (canViewCedarRidgeUserId) get the real value + masked=false. Everyone else
 * gets cedar_ridge_user_id=null + masked=(a real value was present) — so the
 * raw string never leaves the seam. PURE: unit-tested in deal-types.test.ts.
 */
export function maskCedarRidgeUserId(
  row: DealRow,
  role: string | null | undefined,
): DealRow {
  if (canViewCedarRidgeUserId(role)) {
    return { ...row, cedar_ridge_user_id_masked: false };
  }
  return {
    ...row,
    cedar_ridge_user_id: null,
    cedar_ridge_user_id_masked: row.cedar_ridge_user_id != null,
  };
}

// The write-facing shape shared by the D3 form actions and the D4 import
// (validated by `validateDealInput` — one contract, so the import can't
// smuggle in rows the form would reject). Dates are `YYYY-MM-DD` strings
// (what <input type="date"> and the CSV both produce); amounts are numbers —
// callers coerce raw form/CSV strings with Number() before validating.
export type DealInput = {
  source: DealSource;
  /** Required for IMPORT rows (the idempotent upsert key); null for APP rows. */
  sf_deal_id?: string | null;
  name: string;
  client_first_name: string;
  client_last_name: string;
  household_name?: string | null;
  household_sf_id?: string | null;
  /** 18-char SF Contact id ("Person: Contact ID") — direct match to mirror.client.sf_id. */
  client_sf_id?: string | null;
  amount: number;
  stage: DealStage;
  /** Import-only raw CRM stage provenance; never set by the form. */
  stage_raw?: string | null;
  created_date: string; // YYYY-MM-DD (app rows: today)
  close_date?: string | null; // YYYY-MM-DD
  last_activity_date?: string | null; // YYYY-MM-DD
  owner_name?: string | null;
  owner_sf_user_id?: string | null;
  secondary_owner?: string | null;
  person_aum?: number | null; // import-only
  potential_aum?: number | null; // import-only
  cedar_ridge_user_id?: string | null;
  statements?: boolean;
  plaid_linked?: boolean;
  account_last4?: string | null;
  account_type?: string | null; // funding type (D8)
  transferring_firm?: string | null;
  /** 401(k) Rollover only — the server clears both for any other funding type. */
  employer?: string | null;
  rolling_into?: string | null;
};
