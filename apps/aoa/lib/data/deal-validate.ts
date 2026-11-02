import {
  DEAL_SOURCES,
  DEAL_STAGES,
  type DealInput,
  type DealSource,
  type DealStage,
} from "./deal-types";

// Pure validation for deal writes (TDD ticket ADR-8) — the ONE contract
// shared by the D3 form actions and the D4 import, so the import can never
// smuggle in a row the form would reject. Hand-rolled (no zod — the standing
// no-new-runtime-deps rule). Field-keyed errors so the form renders them
// inline next to the offending input.

export type DealValidationError = { field: string; message: string };

export type ValidationResult = {
  ok: boolean;
  errors: DealValidationError[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// D8 follow-on (ruling, the owner 2026-07-02): real custodian account numbers
// are not always 4 digits ('81-154', 'M1DU', 'x207', '*005') — accept 1–10
// chars of letters/digits/*/-. Shared with the importer's Account Number
// normalization so the two rules can never drift. (The column stays
// account_last4; the display convention is unchanged.)
export const ACCOUNT_NUMBER_RE = /^[A-Za-z0-9*-]{1,10}$/;

/** True for a real calendar date in YYYY-MM-DD form within 1900–2100. */
// Exported for the D8 inline close-date action (same rule as the form path);
// validateDealInput itself is unchanged — the contract stays frozen.
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (y < 1900 || y > 2100) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

export function validateDealInput(input: DealInput): ValidationResult {
  const errors: DealValidationError[] = [];
  const err = (field: string, message: string) => errors.push({ field, message });

  // Required identity fields (NOT NULL in the §3 contract).
  if (isBlank(input.name)) err("name", "Deal name is required.");
  if (isBlank(input.client_first_name))
    err("client_first_name", "Client first name is required.");
  if (isBlank(input.client_last_name))
    err("client_last_name", "Client last name is required.");

  // Amount: required numeric (callers Number()-coerce raw strings first).
  if (typeof input.amount !== "number" || !Number.isFinite(input.amount)) {
    err("amount", "Amount must be a number.");
  } else if (input.amount < 0) {
    err("amount", "Amount cannot be negative.");
  }

  // Enums.
  if (!DEAL_STAGES.includes(input.stage as DealStage))
    err("stage", `Stage must be one of: ${DEAL_STAGES.join(", ")}.`);
  if (!DEAL_SOURCES.includes(input.source as DealSource))
    err("source", `Source must be one of: ${DEAL_SOURCES.join(", ")}.`);

  // Provenance (ADR-2): imported rows must carry their Salesforce deal id —
  // it is the idempotent upsert key and the future sync's dedupe key.
  if (input.source === "IMPORT" && isBlank(input.sf_deal_id))
    err("sf_deal_id", "sf_deal_id is required for imported deals.");

  // Date sanity: created_date is NOT NULL; the rest validate when present.
  if (isBlank(input.created_date)) {
    err("created_date", "Created date is required.");
  } else if (!isValidIsoDate(input.created_date)) {
    err("created_date", "Created date must be a valid YYYY-MM-DD date.");
  }
  for (const field of ["close_date", "last_activity_date"] as const) {
    const value = input[field];
    if (!isBlank(value) && !isValidIsoDate(value!.trim()))
      err(field, "Must be a valid YYYY-MM-DD date.");
  }

  // Account fields are optional (unparseable deal names leave them null);
  // a present account # must fit the relaxed real-world rule (D8 follow-on).
  if (
    !isBlank(input.account_last4) &&
    !ACCOUNT_NUMBER_RE.test(input.account_last4!.trim())
  )
    err(
      "account_last4",
      "Account # must be 1–10 characters: letters, digits, '*' or '-'.",
    );

  return { ok: errors.length === 0, errors };
}
