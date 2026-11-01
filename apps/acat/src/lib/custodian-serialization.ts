/**
 * `requiresManualReview` is a retired custodian field. Keep the database
 * column temporarily for migration safety, but never expose it through an API
 * or treat it as current playbook information.
 */
export function toCustodianResponse<T extends object>(
  custodian: T
): Omit<T, "requiresManualReview"> {
  const safe = { ...custodian } as T & { requiresManualReview?: unknown };
  delete safe.requiresManualReview;
  return safe;
}
