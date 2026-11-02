const REQUEST_PHASES = [
  "session_lookup",
  "session_renewal",
  "render_session",
  "roster_reminder",
] as const;

export type RequestPhase = (typeof REQUEST_PHASES)[number];

/** Optional timing only: never inspect the operation's inputs, result or error. */
export async function measureRequestPhase<T>(
  phase: RequestPhase,
  run: () => T | PromiseLike<T>,
): Promise<T> {
  // Reject unexpected runtime labels without changing the measured operation.
  if (process.env.HOUSEHOLD_DIRECTORY_FAST_PATH !== "1" || !REQUEST_PHASES.includes(phase)) {
    return run();
  }

  const startedAt = performance.now();
  let status: "success" | "failure" = "failure";
  try {
    const result = await run();
    status = "success";
    return result;
  } finally {
    try {
      const durationMs = performance.now() - startedAt;
      console.info(JSON.stringify({
        severity: "INFO",
        message: "Request phase completed",
        event: "request.phase",
        component: "request",
        phase,
        duration_ms: Number.isFinite(durationMs)
          ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(durationMs))) : 0,
        status,
      }));
    } catch {
      // Observability must not replace an authorization result or thrown error.
    }
  }
}
