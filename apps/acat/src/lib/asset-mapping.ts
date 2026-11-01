/**
 * Normalizes an account number for the pipeline lookup.
 * Many custodian account numbers are stored without hyphens (e.g. "CPL000915")
 * but the pipeline indexes them with one (e.g. "CPL-000915").
 * Inserts a hyphen when a 2-3 char prefix (letter-leading, alphanumeric) runs
 * directly into a 5+ digit numeric suffix.
 */
export function normalizePipelineAccountNumber(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-")) return trimmed;
  const match = trimmed.match(/^([A-Za-z][A-Za-z0-9]{1,2})(\d{5,})$/);
  if (match) return `${match[1]}-${match[2]}`;
  return trimmed;
}

const CUSIP_PATTERN = /^[A-Z0-9]{9}$/;

export function isCusipFormat(value: string | null | undefined): boolean {
  if (value == null) return false;
  return CUSIP_PATTERN.test(value.trim().toUpperCase());
}
