/**
 * Next.js instrumentation hook (stable in 15.x; no config flag needed). Runs once per server process at
 * `next start` / `next dev`, before the first request — so a process labelled APP_ENV=production that carries
 * AUTH_DEV_LOGIN=true, or any serving process whose env violates its invariants, dies at boot rather than on
 * first use. The classification is APP_ENV, not NODE_ENV: Cloud Run runs the dev service with
 * NODE_ENV=production too.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertDevLoginNotInProduction } = await import("@/lib/dev-login");
    assertDevLoginNotInProduction();
    // Importing @/lib/env evaluates `env` (the contract's boot-time parse). The explicit strict call that follows
    // is independent of NEXT_PHASE and NEXT_RUNTIME, so a serving process can never inherit a non-serving
    // process's relaxed parse (decisions #43, #57): every invariant runs at boot, not at first request.
    const { parseEnv } = await import("@/lib/env");
    parseEnv(process.env);
    // The demo's stand-ins for Slack and the mail sender, on loopback inside this process (demo mode only).
    const { demoMode } = await import("@/lib/demo/mode");
    if (demoMode()) {
      const { startDemoStandIns } = await import("@/lib/demo/stand-ins/start");
      await startDemoStandIns();
    }
  }
}
