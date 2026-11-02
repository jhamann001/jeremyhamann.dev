import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureRequestPhase, type RequestPhase } from "@/lib/observability/request-timing";

describe("request phase timing", () => {
  beforeEach(() => vi.stubEnv("HOUSEHOLD_DIRECTORY_FAST_PATH", "1"));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each<RequestPhase>(["session_lookup", "session_renewal", "render_session", "roster_reminder"])(
    "preserves the %s result and logs one bounded event without data",
    async phase => {
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(123.6);
      const value = { email: "synthetic@example.invalid", sessionToken: "private-token" };
      const operation = vi.fn(async (input: typeof value) => input);

      expect(await measureRequestPhase(phase, () => operation(value))).toBe(value);
      expect(operation).toHaveBeenCalledExactlyOnceWith(value);
      expect(log).toHaveBeenCalledOnce();
      const line = String(log.mock.calls[0][0]);
      expect(JSON.parse(line)).toEqual({
        severity: "INFO", message: "Request phase completed", event: "request.phase",
        component: "request", phase, duration_ms: 24, status: "success",
      });
      expect(line).not.toMatch(/synthetic@|sessionToken|private-token|email/);
    },
  );

  it.each(["rejection", "synchronous throw"])("preserves an original %s without logging its details", async kind => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(performance, "now").mockReturnValueOnce(50).mockReturnValueOnce(61);
    const error = Object.assign(new Error("private-token synthetic@example.invalid"), {
      query: "private-query", role: "OPERATIONS",
    });
    const run = vi.fn(() => {
      if (kind === "synchronous throw") throw error;
      return Promise.reject(error);
    });

    await expect(measureRequestPhase("session_lookup", run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({ phase: "session_lookup", duration_ms: 11, status: "failure" });
    expect(line).not.toMatch(/private|synthetic|query|OPERATIONS|role|stack/);
  });

  it.each([undefined, "0", "true"])("does not time or log with flag %s", async flag => {
    vi.stubEnv("HOUSEHOLD_DIRECTORY_FAST_PATH", flag);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const clock = vi.spyOn(performance, "now");
    const value = { session: "synthetic" };
    const run = vi.fn(() => value);

    expect(await measureRequestPhase("render_session", run)).toBe(value);
    expect(run).toHaveBeenCalledOnce();
    expect(clock).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("does not log unexpected runtime labels", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const clock = vi.spyOn(performance, "now");
    const run = vi.fn(() => "unchanged");

    expect(await measureRequestPhase("private@example.invalid" as RequestPhase, run)).toBe("unchanged");
    expect(run).toHaveBeenCalledOnce();
    expect(clock).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("preserves %s when the logging sink throws", async outcome => {
    vi.spyOn(console, "info").mockImplementation(() => { throw new Error("logging unavailable"); });
    const original = new Error("original operation error");
    const value = { ok: true };
    const run = vi.fn(() => {
      if (outcome === "failure") throw original;
      return value;
    });

    const result = measureRequestPhase("roster_reminder", run);
    if (outcome === "failure") await expect(result).rejects.toBe(original);
    else expect(await result).toBe(value);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([-5, Number.NaN, Number.POSITIVE_INFINITY])("bounds invalid duration %s", async elapsed => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(elapsed);

    await measureRequestPhase("session_renewal", () => null);
    expect(JSON.parse(String(log.mock.calls[0][0])).duration_ms).toBe(0);
  });
});
