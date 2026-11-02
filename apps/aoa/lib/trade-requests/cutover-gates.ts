import type { EngineUseReport, StandaloneState } from "./standalone-control";

// Pure gate rules of the Trade Request cutover controller (ticket). Each gate reports passed, refused or (for the
// engine-use report in dev only) exempt, with a value-free detail line.

export type GateStatus = "passed" | "refused" | "exempt";
export type GateResult = { gate: string; status: GateStatus; detail: string };

export const ENGINE_USE_WINDOW_DAYS = 7;

const passed = (gate: string, detail: string): GateResult => ({ gate, status: "passed", detail });
const refused = (gate: string, detail: string): GateResult => ({ gate, status: "refused", detail });

/**
 * The owner exemption for the engine-use report gate. Accepted only when all of these hold: APP_ENV is exactly
 * "dev"; the command talks to the dev Trade Request service (so a workstation holding production credentials
 * cannot use it); inside the dev job when run by Cloud Run (CLOUD_RUN_JOB is platform-set, so an execution
 * override of APP_ENV on the production job is still refused); and the value is the Linear comment URL recording
 * the owner's approval. The dev service cannot serve the report (its deploy forbids machine configuration).
 */
const EXEMPTION_REFERENCE = /^https:\/\/linear\.app\/cedar-ridge-money\/issue\/TKT-\d+\/[a-z0-9-]+#comment-[0-9a-f]{8}$/;

export const DEV_CUTOVER_JOB = "aoa-trade-request-cutover-dev";
export const DEV_TRADE_REQUEST_API_URL = "https://trade-request-dev-123456789012.us-central1.run.app";

export class ExemptionMisuse extends Error {}

/** Returns the exemption reference when it may be used; throws when it is set anywhere it may not be. */
export function engineUseExemption(
  appEnv: string | undefined,
  value: string | undefined,
  cloudRunJob: string | undefined,
  apiUrl: string | undefined,
): string | null {
  if (value === undefined || value === "") return null;
  if (appEnv !== "dev") throw new ExemptionMisuse("the engine-use exemption is usable only when APP_ENV=dev");
  if ((apiUrl ?? "").replace(/\/+$/, "") !== DEV_TRADE_REQUEST_API_URL) {
    throw new ExemptionMisuse("the engine-use exemption is usable only against the dev Trade Request service");
  }
  if (cloudRunJob !== undefined && cloudRunJob !== DEV_CUTOVER_JOB) {
    throw new ExemptionMisuse(`the engine-use exemption is usable only in the ${DEV_CUTOVER_JOB} job`);
  }
  if (!EXEMPTION_REFERENCE.test(value)) {
    throw new ExemptionMisuse("the engine-use exemption must be the owner's Linear approval comment URL");
  }
  return value;
}

/** Epic AC-10, AC-89 and AC-11 from one engine-use report; `report` null means it could not be read. */
export function engineUseGates(report: EngineUseReport | null, exemption: string | null): GateResult[] {
  if (report === null) {
    if (exemption !== null) {
      const detail = `engine-use report not available in dev; owner exemption ${exemption}`;
      return [
        { gate: "engine_use_activity", status: "exempt", detail },
        { gate: "engine_use_coverage", status: "exempt", detail },
        { gate: "plan_generation_off", status: "exempt", detail },
      ];
    }
    const detail = "engine-use report unavailable";
    return [refused("engine_use_activity", detail), refused("engine_use_coverage", detail), refused("plan_generation_off", detail)];
  }
  const days = [...report.days, report.today];
  const service = days.reduce((n, d) => n + d.service.ran + d.service.refused, 0);
  const refusals = days.reduce((n, d) => n + d.mcp.refused + d.service.refused, 0);
  const windowOk = report.windowDays >= ENGINE_USE_WINDOW_DAYS && report.days.length >= ENGINE_USE_WINDOW_DAYS;
  return [
    service === 0 && refusals === 0
      ? passed("engine_use_activity", "no non-MCP engine call or refused attempt in the window")
      : refused("engine_use_activity", `non-MCP calls or attempts: ${service}; refused attempts: ${refusals}`),
    windowOk && report.coveredDays >= ENGINE_USE_WINDOW_DAYS
      ? passed("engine_use_coverage", `covered days: ${report.coveredDays}`)
      : refused("engine_use_coverage", `covered days: ${report.coveredDays} of ${ENGINE_USE_WINDOW_DAYS}`),
    report.planGeneration === "off"
      ? passed("plan_generation_off", "execution-plan generation is off")
      : refused("plan_generation_off", "execution-plan generation is not off"),
  ];
}

export function standaloneModeGate(gate: string, state: StandaloneState | null, wanted: StandaloneState["mode"]): GateResult {
  if (state === null) return refused(gate, "standalone service mode unavailable");
  if (state.override !== null) return refused(gate, `standalone emergency override is set (${state.override})`);
  return state.mode === wanted ? passed(gate, `standalone mode is ${wanted}`) : refused(gate, `standalone mode is ${state.mode}, not ${wanted}`);
}

export const isRefused = (gates: GateResult[]): boolean => gates.some((g) => g.status === "refused");
