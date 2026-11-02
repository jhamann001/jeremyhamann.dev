const RUN_ID_RE = /^[a-z0-9]{10,40}$/i;

export function isTradeReconciliationRunId(value: string): boolean {
  return RUN_ID_RE.test(value);
}

/** A completed run is loaded only when the URL explicitly names that run. */
export function requestedTradeReconciliationRunId(
  requestedRunId: string | undefined,
  availableRunIds: readonly string[],
): string | undefined {
  if (!requestedRunId || !isTradeReconciliationRunId(requestedRunId)) return undefined;
  return availableRunIds.includes(requestedRunId) ? requestedRunId : undefined;
}
