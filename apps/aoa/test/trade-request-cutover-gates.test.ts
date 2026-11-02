import { describe, expect, it } from "vitest";
import { engineUseExemption, engineUseGates, ExemptionMisuse, standaloneModeGate } from "@/lib/trade-requests/cutover-gates";
import type { EngineUseReport, StandaloneState } from "@/lib/trade-requests/standalone-control";

const REF = "https://linear.app/cedar-ridge-money/issue/TKT-11/trb-11-aoa-cutover-and-rollback-controller#comment-0a1b2c3d";

function report(overrides: Partial<EngineUseReport> = {}): EngineUseReport {
  const day = (n: number) => ({ day: `2026-10-${String(10 + n).padStart(2, "0")}`, mcp: { ran: 3, refused: 0 }, service: { ran: 0, refused: 0 } });
  return {
    planGeneration: "off",
    windowDays: 7,
    coveredDays: 7,
    countingStarted: "2026-10-01",
    planGenerationOffSince: "2026-10-02",
    days: [1, 2, 3, 4, 5, 6, 7].map(day),
    today: { day: "2026-10-18", mcp: { ran: 1, refused: 0 }, service: { ran: 0, refused: 0 } },
    ...overrides,
  };
}
const statuses = (r: EngineUseReport | null, exemption: string | null = null) =>
  Object.fromEntries(engineUseGates(r, exemption).map((g) => [g.gate, g.status]));

describe("engine-use gates", () => {
  it("pass when only MCP used the engine over seven covered days with plan generation off", () => {
    expect(statuses(report())).toEqual({ engine_use_activity: "passed", engine_use_coverage: "passed", plan_generation_off: "passed" });
  });

  it("refuse on any non-MCP call, any refused attempt (either caller class) or non-MCP activity today", () => {
    const withDay = (i: number, patch: object) => report({ days: report().days.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
    expect(statuses(withDay(0, { service: { ran: 1, refused: 0 } })).engine_use_activity).toBe("refused");
    expect(statuses(withDay(6, { service: { ran: 0, refused: 2 } })).engine_use_activity).toBe("refused");
    expect(statuses(withDay(3, { mcp: { ran: 0, refused: 1 } })).engine_use_activity).toBe("refused");
    expect(statuses(report({ today: { day: "2026-10-18", mcp: { ran: 0, refused: 0 }, service: { ran: 1, refused: 0 } } })).engine_use_activity).toBe("refused");
  });

  it("refuse when fewer than seven days are covered or the window is short", () => {
    expect(statuses(report({ coveredDays: 6 })).engine_use_coverage).toBe("refused");
    expect(statuses(report({ windowDays: 6, days: report().days.slice(1) })).engine_use_coverage).toBe("refused");
  });

  it("refuse when the service does not report plan generation off", () => {
    expect(statuses(report({ planGeneration: "on", coveredDays: 0 }))).toMatchObject({ plan_generation_off: "refused", engine_use_coverage: "refused" });
  });

  it("refuse all three when the report is unavailable and no exemption applies", () => {
    expect(statuses(null)).toEqual({ engine_use_activity: "refused", engine_use_coverage: "refused", plan_generation_off: "refused" });
  });

  it("record all three as exempt, naming the owner reference, only when the report is unavailable under an exemption", () => {
    const gates = engineUseGates(null, REF);
    expect(gates.map((g) => g.status)).toEqual(["exempt", "exempt", "exempt"]);
    expect(gates[0].detail).toContain(REF);
    // An exemption never overrides a report that was read.
    expect(statuses(report({ coveredDays: 2 }), REF).engine_use_coverage).toBe("refused");
  });
});

describe("engine-use exemption", () => {
  const DEV = "https://trade-request-dev-123456789012.us-central1.run.app";
  const PROD = "https://trade-request-123456789012.us-central1.run.app";

  it("is accepted only with APP_ENV=dev against the dev service, in the dev job, with a Linear approval comment URL", () => {
    expect(engineUseExemption("dev", REF, undefined, DEV)).toBe(REF);
    expect(engineUseExemption("dev", REF, "aoa-trade-request-cutover-dev", `${DEV}/`)).toBe(REF);
    expect(engineUseExemption("prod", undefined, undefined, PROD)).toBeNull();
    expect(engineUseExemption("dev", "", undefined, DEV)).toBeNull();
  });

  it("fails closed when set outside dev, against another service, in another job or with any other value", () => {
    expect(() => engineUseExemption("prod", REF, undefined, PROD)).toThrow(ExemptionMisuse);
    expect(() => engineUseExemption(undefined, REF, undefined, DEV)).toThrow(ExemptionMisuse);
    expect(() => engineUseExemption("local", REF, undefined, DEV)).toThrow(ExemptionMisuse);
    expect(() => engineUseExemption("dev", REF, undefined, PROD)).toThrow(/only against the dev Trade Request service/);
    expect(() => engineUseExemption("dev", REF, undefined, undefined)).toThrow(/only against the dev Trade Request service/);
    expect(() => engineUseExemption("dev", REF, "aoa-trade-request-cutover", DEV)).toThrow(/only in the aoa-trade-request-cutover-dev job/);
    expect(() => engineUseExemption("dev", "yes", undefined, DEV)).toThrow(/Linear approval comment URL/);
  });
});

describe("standalone mode gate", () => {
  const state = (patch: Partial<StandaloneState>): StandaloneState => ({
    mode: "frozen", persistedMode: "frozen", override: null, digestSender: "on", driftSender: "on",
    modeChangedAt: "2026-10-20T15:00:00.000Z", writesSettledAt: "2026-10-20T15:05:00.000Z", ...patch,
  });
  it("passes only for the wanted mode with no override, and refuses when unreadable", () => {
    expect(standaloneModeGate("g", state({}), "frozen").status).toBe("passed");
    expect(standaloneModeGate("g", state({ mode: "active" }), "frozen").status).toBe("refused");
    expect(standaloneModeGate("g", state({ override: "frozen" }), "frozen").status).toBe("refused");
    expect(standaloneModeGate("g", null, "frozen").status).toBe("refused");
  });
});
