/** Inclusive calendar dates in UTC, never the browser/database local timezone. */
export function validAuditDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function auditDateRange(from: string | null | undefined, to: string | null | undefined) {
  const lower = from ?? "", upper = to ?? "";
  if ((lower && !validAuditDate(lower)) || (upper && !validAuditDate(upper)) ||
    (lower && upper && lower > upper)) throw new Error("invalid_audit_date_range");
  return { from: lower, to: upper };
}
