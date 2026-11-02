import type {
  TransferInput,
  TransferOwner,
  TransferRow,
  TransferStage,
} from "@/lib/data/transfer-types";

// Pure form contract for the shared create/edit TransferForm (WO ticket,
// TDD §6) — the deals `deal-form.ts` idiom: all-string form values so the
// controlled inputs round-trip exactly what the user typed, converted to the
// validated TransferInput at the submit boundary. No React, no Prisma —
// unit-tested in test/transfer-form.test.ts.

export type TransferFormValues = {
  client_first_name: string;
  client_last_name: string;
  client_sf_id: string;
  household_name: string;
  household_sf_id: string;
  value: string; // raw text; Number()-coerced in toTransferInput
  stage: string;
  owner_kind: string;
  owner_name: string;
  next_step: string;
  next_step_owner: string;
  pending_nudge: string;
  acat_transfer_id: string;
};

export const EMPTY_TRANSFER_FORM: TransferFormValues = {
  client_first_name: "",
  client_last_name: "",
  client_sf_id: "",
  household_name: "",
  household_sf_id: "",
  value: "",
  stage: "DECISION",
  owner_kind: "OPERATIONS",
  owner_name: "",
  next_step: "",
  next_step_owner: "",
  pending_nudge: "",
  acat_transfer_id: "",
};

/** Trimmed string, or null when blank — optional text columns are null, not "". */
const orNull = (s: string): string | null => {
  const t = s.trim();
  return t === "" ? null : t;
};

/**
 * Form values → the shared write contract. `source` is pinned to "APP" (ADR-1
 * — the app is the only producer this phase; IMPORT is reserved). A blank
 * value becomes NaN so the frozen validateTransferInput rejects it with the
 * field-keyed "must be a number" error (never silently 0).
 */
export function toTransferInput(values: TransferFormValues): TransferInput {
  return {
    source: "APP",
    client_first_name: values.client_first_name.trim(),
    client_last_name: values.client_last_name.trim(),
    client_sf_id: orNull(values.client_sf_id),
    household_name: orNull(values.household_name),
    household_sf_id: orNull(values.household_sf_id),
    value: values.value.trim() === "" ? NaN : Number(values.value),
    stage: values.stage as TransferStage,
    owner_kind: values.owner_kind as TransferOwner,
    owner_name: orNull(values.owner_name),
    next_step: orNull(values.next_step),
    next_step_owner: orNull(values.next_step_owner),
    pending_nudge: orNull(values.pending_nudge),
    acat_transfer_id: orNull(values.acat_transfer_id),
  };
}

/** Seam row → edit-form values (nulls render as empty inputs).
 *
 *  The ACAT field shows the STORED LINK — record id first (the primary link
 *  key since record-id linking), legacy UUID fallback. Before this, a
 *  record-id-only linked transfer seeded a BLANK field, so an untouched save
 *  read as an explicit clear and silently unlinked it. Resubmitting the shown
 *  value is a no-op: the update action's either-id routing compares the
 *  submitted value against BOTH stored columns (planAcatLinkChange). */
export function transferToFormValues(row: TransferRow): TransferFormValues {
  return {
    client_first_name: row.client_first_name,
    client_last_name: row.client_last_name,
    client_sf_id: row.client_sf_id ?? "",
    household_name: row.household_name ?? "",
    household_sf_id: row.household_sf_id ?? "",
    value: String(row.value),
    stage: row.stage,
    owner_kind: row.owner_kind,
    owner_name: row.owner_name ?? "",
    next_step: row.next_step ?? "",
    next_step_owner: row.next_step_owner ?? "",
    pending_nudge: row.pending_nudge ?? "",
    acat_transfer_id: row.acat_record_id ?? row.acat_transfer_id ?? "",
  };
}

// The fields the edit form owns (source is pinned; ids/timestamps are not
// form data). The audit change map iterates this list so `transfer.update`
// detail carries exactly the edited fields' {from, to}.
//
// ticket Slice 2 scope note: the new deal-sourced columns (funding_type, the
// checklist booleans, cash_in_flight, deal_id/deal_sf_id, transferring_firm,
// archived_*, sync_flag, acat_record_id) are DELIBERATELY NOT in this list.
// They are card- or sync-managed (the DecisionChecklistCard's setChecklistFlag/
// setCashInFlight/approveFundingPlan actions and the S4 sync), each with its own
// audited write path — so the create/edit form neither renders nor diffs them,
// and toTransferInput leaves them undefined. Adding them here would double-own
// the write and audit them twice.
//
// EXCEPTION (either-id ACAT routing): the form's single ACAT input can now
// resolve into BOTH link columns (acat_record_id + acat_transfer_id) after
// tracker verification. The create/update actions therefore EXCLUDE
// acat_transfer_id from this generic diff and build the audit entries for both
// columns from the verified resolution instead — the entry in FORM_FIELDS only
// keeps the TransferChangeMap key legal.
export const FORM_FIELDS = [
  "client_first_name",
  "client_last_name",
  "client_sf_id",
  "household_name",
  "household_sf_id",
  "value",
  "stage",
  "owner_kind",
  "owner_name",
  "next_step",
  "next_step_owner",
  "pending_nudge",
  "acat_transfer_id",
] as const satisfies readonly (keyof TransferInput)[];

export type TransferChangeMap = Partial<
  Record<
    (typeof FORM_FIELDS)[number],
    { from: string | number | null; to: string | number | null }
  >
>;

/**
 * Field-level change map between two inputs (form-editable fields only) —
 * the payload for the `transfer.update` audit detail (ids/enums/numbers, no
 * narratives beyond the operational text columns the user typed). Empty map
 * = no-op: the action writes nothing and audits nothing.
 */
export function diffTransferInput(
  before: TransferInput,
  after: TransferInput,
): TransferChangeMap {
  const changes: TransferChangeMap = {};
  for (const field of FORM_FIELDS) {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}
