export type DirectoryAumState =
  | { available: false; total: null; firm: null; employee: null }
  | { available: true; total: number; firm: number; employee: number };

/** Keep the directory KPI fail-closed until every visible open account belongs
 * to the same governed current snapshot. */
export function directoryAumState(input: {
  total: number | null;
  firm: number | null;
  employee: number | null;
  available: boolean;
  employeeScopeComplete?: boolean;
}, excludeEmployees = false): DirectoryAumState {
  if (!input.available || input.total == null || input.firm == null || input.employee == null
      || (excludeEmployees && input.employeeScopeComplete === false)) {
    return { available: false, total: null, firm: null, employee: null };
  }
  // Convert each already-rounded two-decimal aggregate to cents first. Firm
  // and employee buckets are disjoint; negative balances must retain their sign.
  const totalCents = Math.round(input.total * 100) - Math.round(input.firm * 100)
    - (excludeEmployees ? Math.round(input.employee * 100) : 0);
  return { available: true, total: totalCents / 100, firm: input.firm, employee: input.employee };
}
