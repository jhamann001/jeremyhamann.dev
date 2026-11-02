import { describe, expect, it, vi } from "vitest";
import { createStandaloneControl, StandaloneUnavailable, type MachineTransport } from "@/lib/trade-requests/standalone-control";

const STATE = {
  mode: "frozen", persistedMode: "frozen", override: null, digestSender: "on", driftSender: "off",
  modeChangedAt: "2026-10-20T15:00:00.000Z", writesSettledAt: "2026-10-20T15:05:00.000Z",
  updatedAt: "2026-10-20T15:00:00.000Z", updatedBy: "Gtyiwf9bRptzzwuy-account@example-project.iam.gserviceaccount.com",
};
const day = (d: string) => ({ day: d, mcp: { ran: 1, refused: 0 }, service: { ran: 0, refused: 0 } });
const REPORT = {
  planGeneration: "off", windowDays: 7, coveredDays: 7, countingStarted: "2026-10-01", planGenerationOffSince: "2026-10-02",
  days: ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"].map(day),
  today: day("2026-10-18"),
};

describe("standalone control", () => {
  it("reads the service mode from GET /api/machine/service-mode and drops fields it does not use", async () => {
    const transport = vi.fn<MachineTransport>().mockResolvedValue({ status: 200, data: STATE });
    const state = await createStandaloneControl(transport).readState();
    expect(transport).toHaveBeenCalledWith({ method: "GET", path: "/api/machine/service-mode", body: undefined });
    expect(state).toEqual({
      mode: "frozen", persistedMode: "frozen", override: null, digestSender: "on", driftSender: "off",
      modeChangedAt: "2026-10-20T15:00:00.000Z", writesSettledAt: "2026-10-20T15:05:00.000Z",
    });
  });

  it("changes the mode with PUT and exactly the change plus its reason", async () => {
    const transport = vi.fn<MachineTransport>().mockResolvedValue({ status: 200, data: { ...STATE, digestSender: "off" } });
    const state = await createStandaloneControl(transport).changeState({ digestSender: "off" }, "digest sender to AOA");
    expect(transport).toHaveBeenCalledWith({ method: "PUT", path: "/api/machine/service-mode", body: { digestSender: "off", reason: "digest sender to AOA" } });
    expect(state.digestSender).toBe("off");
  });

  it("reads the seven-day engine-use report", async () => {
    const transport = vi.fn<MachineTransport>().mockResolvedValue({ status: 200, data: REPORT });
    const report = await createStandaloneControl(transport).readEngineUse(7);
    expect(transport).toHaveBeenCalledWith({ method: "GET", path: "/api/machine/engine-use?days=7", body: undefined });
    expect(report.coveredDays).toBe(7);
  });

  it("turns any non-200 status into a static status code, never the body", async () => {
    for (const status of [401, 403, 409, 503]) {
      const transport = vi.fn<MachineTransport>().mockResolvedValue({ status, data: { error: "secret-looking body" } });
      const err = await createStandaloneControl(transport).readState().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StandaloneUnavailable);
      expect((err as StandaloneUnavailable).code).toBe(`status_${status}`);
      expect((err as Error).message).not.toContain("secret-looking");
    }
  });

  it("turns a transport failure into transport_error", async () => {
    const transport = vi.fn<MachineTransport>().mockRejectedValue(new Error("connect ECONNREFUSED https://example.test/?token=abc"));
    const err = await createStandaloneControl(transport).readEngineUse(7).catch((e: unknown) => e);
    expect((err as StandaloneUnavailable).code).toBe("transport_error");
    expect((err as Error).message).not.toContain("token");
  });

  it("rejects malformed bodies instead of guessing", async () => {
    const bad = [{ ...STATE, mode: "paused" }, { ...STATE, digestSender: true }, { ...STATE, writesSettledAt: "soon" }, null];
    for (const data of bad) {
      const err = await createStandaloneControl(vi.fn<MachineTransport>().mockResolvedValue({ status: 200, data })).readState().catch((e: unknown) => e);
      expect((err as StandaloneUnavailable).code).toBe("malformed_service_mode");
    }
    const report = await createStandaloneControl(vi.fn<MachineTransport>().mockResolvedValue({ status: 200, data: { ...REPORT, coveredDays: -1 } }))
      .readEngineUse(7)
      .catch((e: unknown) => e);
    expect((report as StandaloneUnavailable).code).toBe("malformed_engine_use");
  });
});
