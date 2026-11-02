export const TAX_BUDGET_WRITE_ROLES = new Set([
  "ADMIN",
  "OPERATIONS",
  "ADVISOR",
  "CLIENT_SERVICE",
]);

export const TAX_BUDGET_NOTE_MAX = 2000;
export const TAX_BUDGET_AMOUNT_MAX = 9_999_999_999_999.99;

export type TaxBudgetWriteValues = {
  budget: number;
  realized: number;
  note: string;
};

export type TaxBudgetValidationError = {
  field: "budget" | "realized" | "note";
  message: string;
};

export type TaxBudgetValidationResult =
  | { ok: true; values: TaxBudgetWriteValues }
  | { ok: false; errors: TaxBudgetValidationError[] };

/** UI convenience only; app.tax_budget RLS is the authoritative write gate. */
export function canWriteTaxBudget(role: string | null | undefined): boolean {
  return TAX_BUDGET_WRITE_ROLES.has(role ?? "");
}

/** Accept exact dollar entry with optional currency punctuation. */
function parseTaxBudgetAmount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;

  const normalized = value.trim().replace(/^\$\s*/, "").replace(/,/g, "");
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) {
    return Number.NaN;
  }
  return Number(normalized);
}

/** One validation contract for the client form and the server action. */
export function validateTaxBudgetValues(input: {
  budget: unknown;
  realized: unknown;
  note: unknown;
}): TaxBudgetValidationResult {
  const budget = parseTaxBudgetAmount(input.budget);
  const realized = parseTaxBudgetAmount(input.realized);
  const note = typeof input.note === "string" ? input.note.trim() : "";
  const errors: TaxBudgetValidationError[] = [];

  if (!Number.isFinite(budget) || budget < 0 || budget > TAX_BUDGET_AMOUNT_MAX) {
    errors.push({
      field: "budget",
      message: "Enter a non-negative realized-gains budget.",
    });
  }
  if (!Number.isFinite(realized) || realized < 0 || realized > TAX_BUDGET_AMOUNT_MAX) {
    errors.push({
      field: "realized",
      message: "Enter a non-negative realized YTD amount.",
    });
  }
  if (note.length > TAX_BUDGET_NOTE_MAX) {
    errors.push({
      field: "note",
      message: `Planning note must be ${TAX_BUDGET_NOTE_MAX.toLocaleString()} characters or fewer.`,
    });
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, values: { budget, realized, note } };
}
