import {
  FUNDING_TYPES,
  FUNDING_TYPE_CASH,
  FUNDING_TYPE_OTHER,
  FUNDING_TYPE_ROLLOVER,
  ROLLING_INTO_OPTIONS,
  type DealInput,
  type DealRow,
} from "@/lib/data/deal-types";

// PURE form logic for the D3 deal-entry form (WO ticket) — no React, no
// Prisma, unit-tested (the deal-filter.ts idiom). Owns the three conversions
// around the frozen contract:
//   form state  --toDealInput-->  DealInput  (validated by the frozen
//                                             validateDealInput, ADR-8)
//   DealRow     --dealToFormValues-->  form state  (edit seeding)
//   before/after DealInput  --diffDealInput-->  audit change map (ADR-5)
//
// NOT here: plaid_linked. The scope change (the owner 2026-07-01) removed Plaid
// from ALL UI — the form never renders or collects it; created rows persist
// the DB default (false) and edits carry the stored value through untouched
// (the schema/contract field is retained for a future Plaid integration).
// Also NOT here since D6 (WO ticket): owner_name / secondary_owner. Owners
// are stored in the DB but hidden from ALL /deals UI, so the client never
// collects OR round-trips them — they live in DealInputBase, which only the
// server actions construct (create: owner_name = the signed-in user, silent
// attribution; update: preserved from the current row). A tampered client
// payload therefore cannot set or null an owner.

// What the form actually collects (TDD §6 form-facing subset, minus Plaid and
// owners). Strings straight from inputs; the server action owns coercion via
// toDealInput. `stage` is a string here (the select constrains it; the frozen
// validator still checks the enum server-side).
export type DealFormValues = {
  client_first_name: string;
  client_last_name: string;
  household_name: string;
  household_sf_id: string;
  amount: string; // raw input; Number()-coerced in toDealInput
  stage: string;
  close_date: string; // YYYY-MM-DD or ""
  cedar_ridge_user_id: string;
  statements: boolean;
  // D8 (WO ticket): the funding-type select's value — a FUNDING_TYPES entry
  // or a prepended legacy value (the mockup rule). "Other" stores the typed
  // funding_other text; the select value itself is never stored then.
  account_type: string;
  funding_other: string; // shown only when account_type === "Other"
  employer: string; // 401(k) Rollover only — cleared server-side otherwise
  rolling_into: string; // 401(k) Rollover only; "" = not specified
  account_last4: string;
  transferring_firm: string;
};

// Server-owned fields the form never edits (import-only / lifecycle / hidden
// owners). Create passes the APP defaults; update carries them over from the
// current row so the frozen validator (e.g. sf_deal_id required for IMPORT
// rows) keeps passing and existing owners are never nulled by an edit.
export type DealInputBase = {
  source: DealInput["source"];
  sf_deal_id: string | null;
  created_date: string; // YYYY-MM-DD (create: today; update: preserved)
  stage_raw: string | null;
  last_activity_date: string | null;
  owner_name: string | null; // create: signed-in user; update: preserved
  secondary_owner: string | null; // create: null; update: preserved
  person_aum: number | null;
  potential_aum: number | null;
};

export const APP_CREATE_BASE = (
  todayIso: string,
  ownerName: string | null,
): DealInputBase => ({
  source: "APP",
  sf_deal_id: null, // APP rows have no Salesforce twin yet (ADR-2)
  created_date: todayIso,
  stage_raw: null, // import-only provenance (ADR-3)
  last_activity_date: null,
  owner_name: ownerName, // silent attribution (D6) — never rendered
  secondary_owner: null,
  person_aum: null, // import-only
  potential_aum: null, // import-only
});

const trimOrNull = (s: string): string | null => {
  const t = s.trim();
  return t === "" ? null : t;
};

// D8 funding-type resolution (mockup semantics, applied SERVER-SIDE — the
// actions build DealInput through this module, so a tampered client cannot
// bypass it):
//   Other → the typed funding_other text when present (that text is what's
//           stored), else the literal "Other";
//   Cash  → account #/transferring firm are FORCED null;
//   401(k) Rollover → the only funding type that keeps employer/rolling_into.

/** The funding-type string that actually gets stored in account_type. */
export function resolvedFundingType(values: DealFormValues): string | null {
  const t = values.account_type.trim();
  if (t === FUNDING_TYPE_OTHER) {
    const o = values.funding_other.trim();
    if (o === "") return FUNDING_TYPE_OTHER;
    // QC LOW-1 (PR #80): Other-text that case-insensitively names a reserved
    // option resolves TO that option (canonical casing) — so "cash" is Cash,
    // with Cash's rules applied below, never a lookalike free-text twin.
    const canonical = (FUNDING_TYPES as readonly string[]).find(
      (f) => f.toLowerCase() === o.toLowerCase(),
    );
    return canonical ?? o;
  }
  return t === "" ? null : t;
}

// The special-type rules key on the RESOLVED funding type (QC LOW-1): resolve
// first, then apply rules — Other→"cash" gets Cash's nulling.
const isRollover = (values: DealFormValues): boolean =>
  resolvedFundingType(values) === FUNDING_TYPE_ROLLOVER;

const isCash = (values: DealFormValues): boolean =>
  resolvedFundingType(values) === FUNDING_TYPE_CASH;

// D8 follow-on (ruling, the owner 2026-07-02 — keep employer on Other): the
// employer is cleared ONLY when the resolved funding type is a RESERVED
// option other than 401(k) Rollover (and other than the "Other" literal —
// the whole Other bucket keeps it). Real data carries employers on
// Other-typed plans (profit-sharing, RSUs, 403b). rolling_into stays
// 401(k)-Rollover-only.
const clearsEmployer = (values: DealFormValues): boolean => {
  const resolved = resolvedFundingType(values);
  return (
    resolved != null &&
    resolved !== FUNDING_TYPE_ROLLOVER &&
    resolved !== FUNDING_TYPE_OTHER &&
    (FUNDING_TYPES as readonly string[]).includes(resolved)
  );
};

/**
 * Derive the deal name from the contract's parseable convention
 * "<Client> - <Firm> - <Account Type> - <last4>" using whichever segments are
 * present (TDD §3: account fields are form-entered going forward; §6's field
 * list deliberately has no free-text name input — the name IS the data).
 * D8: uses the RESOLVED funding type (Other's typed text) and respects Cash's
 * cleared account #/firm, so the name always mirrors what's stored.
 */
export function buildDealName(values: DealFormValues): string {
  const client = `${values.client_first_name.trim()} ${values.client_last_name.trim()}`.trim();
  const cash = isCash(values);
  const segments = [
    client,
    cash ? "" : values.transferring_firm.trim(),
    resolvedFundingType(values) ?? "",
    cash ? "" : values.account_last4.trim(),
  ].filter((s) => s !== "");
  return segments.join(" - ");
}

/** Form state → the frozen DealInput contract (validated by validateDealInput). */
export function toDealInput(values: DealFormValues, base: DealInputBase): DealInput {
  const amountRaw = values.amount.trim();
  const rollover = isRollover(values);
  const rollingInto = values.rolling_into.trim();
  return {
    source: base.source,
    sf_deal_id: base.sf_deal_id,
    name: buildDealName(values),
    client_first_name: values.client_first_name.trim(),
    client_last_name: values.client_last_name.trim(),
    household_name: trimOrNull(values.household_name),
    household_sf_id: trimOrNull(values.household_sf_id),
    // "" → NaN → the validator's "Amount must be a number." field error
    // (Number("") is 0, which would silently accept a blank amount).
    amount: amountRaw === "" ? Number.NaN : Number(amountRaw),
    stage: values.stage as DealInput["stage"], // enum enforced by the validator
    stage_raw: base.stage_raw,
    created_date: base.created_date,
    close_date: trimOrNull(values.close_date),
    last_activity_date: base.last_activity_date,
    owner_name: base.owner_name, // server-owned (D6) — never client-supplied
    owner_sf_user_id: null, // not on the form; update preserves it separately
    secondary_owner: base.secondary_owner, // server-owned (D6)
    person_aum: base.person_aum,
    potential_aum: base.potential_aum,
    cedar_ridge_user_id: trimOrNull(values.cedar_ridge_user_id),
    statements: values.statements,
    // Cash forces both null (server-side — the disabled inputs are UX only).
    account_last4: isCash(values) ? null : trimOrNull(values.account_last4),
    account_type: resolvedFundingType(values),
    transferring_firm: isCash(values) ? null : trimOrNull(values.transferring_firm),
    // Employer survives for 401(k) Rollover and the whole Other bucket
    // (cleared only for a reserved non-rollover type — D8 follow-on ruling);
    // rolling_into stays rollover-only, one of the two IRA options or null
    // ("— not specified" / tampered payloads).
    employer: clearsEmployer(values) ? null : trimOrNull(values.employer),
    rolling_into:
      rollover && (ROLLING_INTO_OPTIONS as readonly string[]).includes(rollingInto)
        ? rollingInto
        : null,
  };
}

// DB `date` columns arrive as UTC-midnight Dates (D2's rendering note); slice
// the ISO string so the <input type="date"> value never shifts a day.
export const isoDay = (d: Date | string | null): string =>
  d == null ? "" : new Date(d).toISOString().slice(0, 10);

/** Seed the edit form from a seam row. */
export function dealToFormValues(row: DealRow): DealFormValues {
  return {
    client_first_name: row.client_first_name,
    client_last_name: row.client_last_name,
    household_name: row.household_name ?? "",
    household_sf_id: row.household_sf_id ?? "",
    amount: String(row.amount),
    stage: row.stage,
    close_date: isoDay(row.close_date),
    cedar_ridge_user_id: row.cedar_ridge_user_id ?? "",
    statements: row.statements,
    // The stored funding type seeds the select directly; values outside
    // FUNDING_TYPES render as a prepended legacy option (DealForm, mockup
    // rule) — never coerced here, so a no-op edit stays a no-op.
    account_type: row.account_type ?? "",
    funding_other: "",
    employer: row.employer ?? "",
    rolling_into: row.rolling_into ?? "",
    account_last4: row.account_last4 ?? "",
    transferring_firm: row.transferring_firm ?? "",
  };
}

// The fields an edit can actually change (form-facing + the derived name).
// The deal.update audit detail records exactly these diffs (ADR-5: field-level
// diffs; stage additionally gets its own deal.stage_change event). Owners left
// this list in D6: they are server-carried on update, so they can never diff.
export const EDITABLE_FIELDS = [
  "name",
  "client_first_name",
  "client_last_name",
  "household_name",
  "household_sf_id",
  "amount",
  "stage",
  "close_date",
  "cedar_ridge_user_id",
  "statements",
  "account_type",
  "account_last4",
  "transferring_firm",
  "employer",
  "rolling_into",
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export type DealChange = { from: unknown; to: unknown };

// The fields the derived deal name is built from. On update the stored name is
// preserved unless one of these actually changed — so editing, say, the stage
// of a row whose stored name doesn't follow the parseable convention (possible
// for future real-import rows) never silently rewrites its name.
const NAME_DRIVERS = [
  "client_first_name",
  "client_last_name",
  "transferring_firm",
  "account_type",
  "account_last4",
] as const;

/** Name to persist on update: stored name unless a name-driving field changed. */
export function updatedDealName(
  storedName: string,
  before: DealInput,
  after: DealInput,
): string {
  const driversChanged = NAME_DRIVERS.some(
    (f) => (before[f] ?? null) !== (after[f] ?? null),
  );
  return driversChanged ? after.name : storedName;
}

// --- D8 typeahead suggestions (WO ticket) -------------------------------
// Built from EXISTING deals only (mirror.household is empty locally — the WO's
// ruling), distinct by full client name / household name. The page derives
// them from the rows it already fetched; no extra read. Everything degrades
// gracefully: no matches → the datalist is empty and the inputs stay plain
// text.

export type ClientSuggestion = {
  first: string;
  last: string;
  full: string; // "First Last" — the datalist option value
  household_name: string | null;
  household_sf_id: string | null;
};

export type DealSuggestions = {
  clients: ClientSuggestion[];
  households: string[];
};

type SuggestibleDeal = Pick<
  DealRow,
  "client_first_name" | "client_last_name" | "household_name" | "household_sf_id"
>;

/**
 * Distinct clients + households from existing deals. Rows arrive newest-first
 * from the seam, so the first sighting of a client wins; a later row backfills
 * the household only when the first sighting had none (that is how "picking a
 * client auto-fills its household when derivable" stays deterministic).
 */
export function buildDealSuggestions(
  rows: readonly SuggestibleDeal[],
): DealSuggestions {
  const clients = new Map<string, ClientSuggestion>();
  const households = new Set<string>();
  for (const r of rows) {
    const first = r.client_first_name.trim();
    const last = r.client_last_name.trim();
    const full = `${first} ${last}`.trim();
    if (full !== "") {
      const seen = clients.get(full);
      if (!seen) {
        clients.set(full, {
          first,
          last,
          full,
          household_name: r.household_name,
          household_sf_id: r.household_sf_id,
        });
      } else if (seen.household_name == null && r.household_name != null) {
        seen.household_name = r.household_name;
        seen.household_sf_id = r.household_sf_id;
      }
    }
    if (r.household_name != null && r.household_name.trim() !== "")
      households.add(r.household_name);
  }
  return {
    clients: [...clients.values()].sort((a, b) => a.full.localeCompare(b.full)),
    households: [...households].sort((a, b) => a.localeCompare(b)),
  };
}

/** Clients narrowed to a household; all clients when it narrows to nothing. */
export function clientsForHousehold(
  suggestions: DealSuggestions,
  household: string,
): ClientSuggestion[] {
  const h = household.trim();
  if (h === "") return suggestions.clients;
  const members = suggestions.clients.filter((c) => c.household_name === h);
  return members.length > 0 ? members : suggestions.clients;
}

/** Exact full-name match (what a datalist pick produces), or null. */
export function findClientByFullName(
  suggestions: DealSuggestions,
  fullName: string,
): ClientSuggestion | null {
  const full = fullName.trim();
  return suggestions.clients.find((c) => c.full === full) ?? null;
}

/** Changed-field map between two DealInput-shaped states (empty = no-op edit). */
export function diffDealInput(
  before: DealInput,
  after: DealInput,
): Partial<Record<EditableField, DealChange>> {
  const changes: Partial<Record<EditableField, DealChange>> = {};
  for (const field of EDITABLE_FIELDS) {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}
