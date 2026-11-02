type Status = "success" | "failure";
const PHASES = ["acquire_begin", "setup", "sql", "commit"] as const;

/** Numeric application-boundary timings only. Never receives identity or data. */
export function startHouseholdPreviewTiming() {
  if (process.env.HOUSEHOLD_DIRECTORY_FAST_PATH !== "1") return undefined;
  let start: number;
  try { start = performance.now(); } catch { return undefined; }
  if (!Number.isFinite(start)) return undefined;
  let boundary = start;
  let phase = 0;
  let finished = false;
  let valid = true;
  const durations: Array<number | null> = [null, null, null, null];

  const closePhase = (): number | undefined => {
    try {
      const now = performance.now();
      if (!Number.isFinite(now) || now < boundary) { valid = false; return; }
      durations[phase] = Math.round(now - boundary);
      boundary = now;
      return now;
    } catch { valid = false; return; }
  };
  const advance = (next: number) => {
    if (finished || !valid) return;
    if (next !== phase + 1) { valid = false; return; }
    if (closePhase() !== undefined) phase = next;
  };

  return {
    acquired: () => advance(1),
    scoped: () => advance(2),
    queried: () => advance(3),
    finish: (status: Status) => {
      if (finished) return;
      finished = true;
      if (!valid || (status === "success" && phase !== 3)) return;
      const end = closePhase();
      if (end === undefined) return;
      // The failed phase's elapsed interval includes rollback/cleanup. Report
      // only completed phases; total_ms retains the complete failure envelope.
      if (status === "failure") durations[phase] = null;
      try {
        console.info(JSON.stringify({
          severity: "INFO",
          message: "Households preview transaction phases completed",
          event: "directory.preview_phases",
          component: "households",
          status,
          failed_phase: status === "failure" ? PHASES[phase] : null,
          acquire_begin_ms: durations[0],
          setup_ms: durations[1],
          sql_ms: durations[2],
          commit_ms: durations[3],
          total_ms: Math.round(end - start),
        }));
      } catch {
        // A diagnostic failure must never replace the operation's result/error.
      }
    },
  };
}
