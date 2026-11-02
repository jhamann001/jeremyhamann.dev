import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { scope, directoryTiming, directoryFailure } = vi.hoisted(() => ({
  scope: vi.fn(), directoryTiming: vi.fn(), directoryFailure: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scope }));
vi.mock("@/lib/observability/structured-log", () => ({
  logDirectoryTiming: directoryTiming, logDirectoryFailure: directoryFailure,
  logDetailTiming: vi.fn(),
}));

import { getHouseholdDirectoryPreview } from "@/lib/data/households";
import { startHouseholdPreviewTiming } from "@/lib/observability/household-preview-timing";

const PHASES = ["acquire_begin", "setup", "sql", "commit"] as const;
type Outcome = "success" | (typeof PHASES)[number];
const identity = { role: "ADVISOR", email: "private-advisor@example.invalid" };
const rows = [{ sf_id: "private-source", name: "Private Household", stage: "Client",
  lead_advisor_email: identity.email, advisor_name: "Private Advisor" }];
const eventKeys = ["severity", "message", "event", "component", "status", "failed_phase",
  "acquire_begin_ms", "setup_ms", "sql_ms", "commit_ms", "total_ms"].sort();

describe("Households preview transaction diagnostics", () => {
  beforeEach(() => {
    vi.stubEnv("HOUSEHOLD_DIRECTORY_FAST_PATH", "1");
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    scope.mockReset(); directoryTiming.mockReset(); directoryFailure.mockReset();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  function transaction(outcome: Outcome = "success", clockFaultAt?: number) {
    let now = 0;
    let clockCalls = 0;
    let open = false;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => {
      if (++clockCalls === clockFaultAt) throw new Error("diagnostic clock unavailable");
      return now;
    });
    const error = Object.assign(new Error("private-query private-token private-advisor@example.invalid"), {
      query: "private-sql", role: identity.role,
    });
    const query = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
      now = 42;
      if (outcome === "sql") throw error;
      return rows;
    });
    scope.mockImplementationOnce(async (_identity, run, options) => {
      open = true;
      try {
        now = 5;
        if (outcome === "acquire_begin") throw error;
        options.onTransactionAcquired?.();
        now = 12;
        if (outcome === "setup") throw error;
        const result = await run({ $queryRaw: query });
        now = 50;
        if (outcome === "commit") throw error;
        return result;
      } finally {
        // A failure's outer envelope includes rollback/cleanup. It must not
        // be attributed to the unfinished SQL/setup/commit phase.
        now = outcome === "success" ? 50 : 60;
        open = false;
      }
    });
    return { clock, query, error, isOpen: () => open };
  }

  it("reports all four boundaries once, after release, without changing results or query bounds", async () => {
    const tx = transaction();
    const heldConnectionAtLog: boolean[] = [];
    const log = vi.spyOn(console, "info").mockImplementation(() => {
      heldConnectionAtLog.push(tx.isOpen());
    });

    expect(await getHouseholdDirectoryPreview(identity)).toBe(rows);
    expect(scope).toHaveBeenCalledOnce();
    expect(scope.mock.calls[0][0]).toBe(identity);
    const options = scope.mock.calls[0][2];
    expect(options).toMatchObject({ timeout: 5_000, maxWait: 2_000,
      onTransactionAcquired: expect.any(Function) });
    expect(options.initialSettingsSql.sql.replace(/\s+/g, " ").trim()).toBe(
      ", set_config('jit', 'off', true), set_config('statement_timeout', ?, true), " +
      "set_config('lock_timeout', ?, true), set_config('enable_nestloop', 'off', true), " +
      "set_config('plan_cache_mode', 'force_generic_plan', true)",
    );
    expect(options.initialSettingsSql.values).toEqual(["4000", "1000"]);
    expect(tx.query).toHaveBeenCalledOnce();
    expect(directoryTiming).toHaveBeenCalledExactlyOnceWith("households_preview", 50, 1);
    expect(directoryFailure).not.toHaveBeenCalled();
    expect(heldConnectionAtLog).toEqual([false]);
    expect(log).toHaveBeenCalledOnce();
    const event = JSON.parse(String(log.mock.calls[0][0]));
    expect(event).toEqual({ severity: "INFO", message: "Households preview transaction phases completed",
      event: "directory.preview_phases", component: "households", status: "success", failed_phase: null,
      acquire_begin_ms: 5, setup_ms: 7, sql_ms: 30, commit_ms: 8, total_ms: 50 });
    expect(Object.keys(event).sort()).toEqual(eventKeys);
    expect(JSON.stringify(event)).not.toMatch(/private|Private|ADVISOR|email|token|query|sf_id|rows|stack/);
  });

  it.each(PHASES)("preserves a %s error with only completed phases and no cleanup misattribution", async outcome => {
    const tx = transaction(outcome);
    const heldConnectionAtLog: boolean[] = [];
    const log = vi.spyOn(console, "info").mockImplementation(() => {
      heldConnectionAtLog.push(tx.isOpen());
    });

    await expect(getHouseholdDirectoryPreview(identity)).rejects.toBe(tx.error);
    expect(scope).toHaveBeenCalledOnce();
    expect(tx.query).toHaveBeenCalledTimes(["sql", "commit"].includes(outcome) ? 1 : 0);
    expect(directoryTiming).not.toHaveBeenCalled();
    expect(directoryFailure).toHaveBeenCalledExactlyOnceWith("households_preview", 60, tx.error);
    expect(log).toHaveBeenCalledOnce();
    expect(heldConnectionAtLog).toEqual([false]);
    const event = JSON.parse(String(log.mock.calls[0][0]));
    expect(Object.keys(event).sort()).toEqual(eventKeys);
    expect(event).toMatchObject({ status: "failure", failed_phase: outcome, total_ms: 60 });
    expect(PHASES.map(phase => event[`${phase}_ms`])).toEqual(
      [5, 7, 30, 8].map((elapsed, index) => index < PHASES.indexOf(outcome) ? elapsed : null),
    );
    expect(JSON.stringify(event)).not.toMatch(/private|Private|ADVISOR|email|token|query|sf_id|rows|stack/);
  });

  it("preserves the complete query text and bound values with diagnostics on or off", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const enabled = transaction();
    await getHouseholdDirectoryPreview(identity);
    const [enabledStrings, ...enabledValues] = enabled.query.mock.calls[0];
    const enabledSql = Prisma.sql(enabledStrings, ...enabledValues);
    vi.stubEnv("HOUSEHOLD_DIRECTORY_FAST_PATH", "0");
    const disabled = transaction();
    await getHouseholdDirectoryPreview(identity);
    const [disabledStrings, ...disabledValues] = disabled.query.mock.calls[0];
    const disabledSql = Prisma.sql(disabledStrings, ...disabledValues);

    expect(enabledSql.sql).toBe(disabledSql.sql);
    expect(enabledSql.values).toEqual(disabledSql.values);
    expect(enabledSql.sql).toContain("LIMIT 100");
    expect(enabled.query).toHaveBeenCalledOnce();
    expect(disabled.query).toHaveBeenCalledOnce();
    expect(scope).toHaveBeenCalledTimes(2);
    expect(scope.mock.calls[1][2].onTransactionAcquired).toBeUndefined();
    expect(scope.mock.calls[0][2].initialSettingsSql).toEqual(scope.mock.calls[1][2].initialSettingsSql);
  });

  it.each([undefined, "0", "true"])("adds no diagnostic clocks, observer or event with flag %s", async flag => {
    vi.stubEnv("HOUSEHOLD_DIRECTORY_FAST_PATH", flag);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const tx = transaction();

    expect(await getHouseholdDirectoryPreview(identity)).toBe(rows);
    expect(tx.query).toHaveBeenCalledOnce();
    expect(scope.mock.calls[0][2].onTransactionAcquired).toBeUndefined();
    expect(tx.clock).toHaveBeenCalledTimes(2); // Existing whole-directory timer only.
    expect(log).not.toHaveBeenCalled();
    expect(directoryTiming).toHaveBeenCalledExactlyOnceWith("households_preview", 50, 1);
  });

  it.each<Outcome>(["success", ...PHASES])("preserves %s when the diagnostic logger throws", async outcome => {
    vi.spyOn(console, "info").mockImplementation(() => { throw new Error("sink unavailable"); });
    const tx = transaction(outcome);
    if (outcome === "success") expect(await getHouseholdDirectoryPreview(identity)).toBe(rows);
    else await expect(getHouseholdDirectoryPreview(identity)).rejects.toBe(tx.error);
  });

  it.each([2, 3, 4, 5, 6])("preserves a successful read when diagnostic clock call %s throws", async clockCall => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const tx = transaction("success", clockCall);

    expect(await getHouseholdDirectoryPreview(identity)).toBe(rows);
    expect(tx.query).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(directoryTiming).toHaveBeenCalledExactlyOnceWith("households_preview", 50, 1);
  });

  it("keeps interleaved transactions independent and completion idempotent", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const first = startHouseholdPreviewTiming()!;
    now = 2; const second = startHouseholdPreviewTiming()!;
    now = 5; first.acquired();
    now = 7; second.acquired();
    now = 12; first.scoped();
    now = 14; second.scoped();
    now = 22; second.queried();
    now = 25; second.finish("success");
    now = 42; first.queried();
    now = 50; first.finish("success");
    first.finish("failure"); second.finish("failure");

    const events = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ acquire_begin_ms: 5, setup_ms: 7, sql_ms: 8, commit_ms: 3, total_ms: 23 });
    expect(events[1]).toMatchObject({ acquire_begin_ms: 5, setup_ms: 7, sql_ms: 30, commit_ms: 8, total_ms: 50 });
    for (const event of events) expect(Object.keys(event).sort()).toEqual(eventKeys);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("discards an invalid boundary %s instead of publishing misleading durations", invalid => {
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(invalid);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const timing = startHouseholdPreviewTiming()!;
    timing.acquired(); timing.scoped(); timing.queried(); timing.finish("success");
    expect(clock).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });
});
