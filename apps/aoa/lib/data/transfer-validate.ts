import {
  FUNDING_TYPES,
  TRANSFER_OWNERS,
  TRANSFER_SOURCES,
  TRANSFER_STAGES,
  type FundingType,
  type TransferInput,
  type TransferOwner,
  type TransferSource,
  type TransferStage,
} from "./transfer-types";

// Pure validation for transfer writes (TDD ticket §4) — the ONE contract
// shared by the T3 form actions and the seed, so the seed can never smuggle in
// a row the form would reject (the deal-validate idiom). Hand-rolled (no zod —
// the standing no-new-runtime-deps rule). Field-keyed errors so the T3 form
// renders them inline next to the offending input.

export type TransferValidationError = { field: string; message: string };

export type ValidationResult = {
  ok: boolean;
  errors: TransferValidationError[];
};

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

export function validateTransferInput(input: TransferInput): ValidationResult {
  const errors: TransferValidationError[] = [];
  const err = (field: string, message: string) =>
    errors.push({ field, message });

  // Required identity fields (NOT NULL in the §3 contract).
  if (isBlank(input.client_first_name))
    err("client_first_name", "Client first name is required.");
  if (isBlank(input.client_last_name))
    err("client_last_name", "Client last name is required.");

  // Value: required numeric, strictly positive (an in-flight transfer of $0 is
  // a data error, not a record). Callers Number()-coerce raw strings first.
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    err("value", "Value must be a number.");
  } else if (input.value <= 0) {
    err("value", "Value must be greater than zero.");
  }

  // Enums.
  if (!TRANSFER_STAGES.includes(input.stage as TransferStage))
    err("stage", `Stage must be one of: ${TRANSFER_STAGES.join(", ")}.`);
  if (!TRANSFER_SOURCES.includes(input.source as TransferSource))
    err("source", `Source must be one of: ${TRANSFER_SOURCES.join(", ")}.`);
  if (!TRANSFER_OWNERS.includes(input.owner_kind as TransferOwner))
    err(
      "owner_kind",
      `Owner kind must be one of: ${TRANSFER_OWNERS.join(", ")}.`,
    );

  // Funding rail (ticket Slice 2) — optional/nullable, but when present it
  // must be a legal FundingType (the enum backstop before it reaches the DB).
  if (
    input.funding_type != null &&
    !FUNDING_TYPES.includes(input.funding_type as FundingType)
  )
    err(
      "funding_type",
      `Funding type must be one of: ${FUNDING_TYPES.join(", ")}.`,
    );

  return { ok: errors.length === 0, errors };
}
