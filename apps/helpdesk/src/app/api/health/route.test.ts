/**
 * GET /api/health without a database: the Prisma client and the serving-invariant gate are mocked so
 * both outcomes are exercised. The route is public and sessionless; guardrail G13 pins its import allowlist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs, type LogCapture } from "@/test-support/capture-logs";
import { EnvInvariantError } from "@/lib/env";

const queryRaw = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const gate = vi.fn<() => void>();

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
}));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, assertServingInvariants: () => gate() };
});

async function load() {
  return import("./route");
}

describe("GET /api/health", () => {
  let logs: LogCapture;
  /** The ERROR records the probe emitted, each serialised — what the old `console.error` spy joined. */
  const errorLines = (): string[] => logs.at("ERROR").map((r) => JSON.stringify(r));

  beforeEach(() => {
    queryRaw.mockReset();
    gate.mockReset();
    // The probe logs through `@/lib/logger` (G13's third allowed import), which never calls
    // `console` — `console` is the sink CWE-209 watches — so the line is captured off the stream.
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
    vi.restoreAllMocks();
  });

  it("exports force-dynamic (G9) and the node runtime", async () => {
    const mod = await load();
    expect(mod.dynamic).toBe("force-dynamic");
    expect(mod.runtime).toBe("nodejs");
    expect(typeof mod.GET).toBe("function");
  });

  it('200 {"ok":true,"db":true} with Cache-Control: no-store when the gate passes and SELECT 1 returns', async () => {
    queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    const { GET } = await load();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true, db: true });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    // The probe is a tagged-template call: its first argument is the template strings array for `SELECT 1`.
    const [strings] = queryRaw.mock.calls[0] as [TemplateStringsArray];
    expect(Array.from(strings)).toEqual(["SELECT 1"]);
    expect(logs.all()).toEqual([]);
  });

  it('503 {"ok":false,"db":false} when the database probe rejects; the body carries no error text and the log names host and user never', async () => {
    const err = Object.assign(new Error("Can't reach database server at `10.20.30.40:5432` as user `wm_helpdesk_app`"), {
      name: "PrismaClientInitializationError",
      code: "P1001",
    });
    queryRaw.mockRejectedValueOnce(err);
    const { GET } = await load();
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: false, db: false });
    expect(JSON.stringify(body)).not.toContain("10.20.30.40");
    const lines = errorLines();
    expect(lines).toHaveLength(1);
    expect(logs.at("ERROR")[0]).toMatchObject({
      severity: "ERROR",
      logScope: "route:/api/health",
      event: "failed",
      // `errorLabel(e)` — the class name, and for an `AppError` its code. A Prisma driver error is
      // neither, so the DRIVER code no longer reaches the line either: the logger records the class
      // and nothing else, which is what makes the two negative assertions below unconditional
      // rather than dependent on a filter staying correct.
      error: "PrismaClientInitializationError",
    });
    expect(lines[0]).not.toContain("P1001");
    expect(lines[0]).not.toContain("10.20.30.40");
    expect(lines[0]).not.toContain("wm_helpdesk_app");
    expect(lines[0]).not.toContain("Can't reach database server");
  });

  it("503 when the serving-invariant gate throws — a misconfigured process is never reported healthy — and the database is not probed", async () => {
    gate.mockImplementationOnce(() => {
      throw new EnvInvariantError("deployed", ["AUTH_SECRET", "TRUSTED_PROXY_HOPS"]);
    });
    const { GET } = await load();
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: false });
    expect(queryRaw).not.toHaveBeenCalled();
    // The offending KEY NAMES are back on the line — as a FIELD read off `EnvInvariantError.keys`,
    // not as the error's message. That distinction is the whole point: `logError` still records
    // `errorLabel(e)` and nothing derived from the message (CWE-209), and the names are safe to log
    // for the same reason they were always safe to throw — they are variable names, never values.
    const lines = errorLines();
    expect(lines).toHaveLength(1);
    expect(logs.at("ERROR")[0]).toMatchObject({
      severity: "ERROR",
      logScope: "route:/api/health",
      event: "failed",
      error: "EnvInvariantError",
      envKeys: "AUTH_SECRET,TRUSTED_PROXY_HOPS",
    });
    // …and still nothing from the message itself.
    expect(lines[0]).not.toContain("Deployed environment invariants violated");
  });

  it("logs no env keys for a failure that is not a configuration one", async () => {
    // `envInvariantKeys` is a type guard, not a message sniffer: a Prisma failure carries no keys and
    // the field is absent rather than empty, so a query for it finds only real misconfigurations.
    queryRaw.mockRejectedValueOnce(new Error("connection refused"));
    const { GET } = await load();
    expect((await GET()).status).toBe(503);
    const record = logs.at("ERROR")[0];
    expect(record).toMatchObject({ logScope: "route:/api/health", error: "Error" });
    expect("envKeys" in record).toBe(false);
  });

  it("a plain Error from the gate logs no env keys either — the signal is the typed error, not the text", async () => {
    gate.mockImplementationOnce(() => {
      throw new Error("Deployed environment invariants violated for: AUTH_SECRET, TRUSTED_PROXY_HOPS");
    });
    const { GET } = await load();
    expect((await GET()).status).toBe(503);
    const lines = errorLines();
    expect(lines).toHaveLength(1);
    expect(logs.at("ERROR")[0]).toMatchObject({ logScope: "route:/api/health", error: "Error" });
    expect("envKeys" in logs.at("ERROR")[0]).toBe(false);
    expect(lines[0]).not.toContain("AUTH_SECRET");
    expect(lines[0]).not.toContain("TRUSTED_PROXY_HOPS");
  });

  it("a non-Error rejection is still a 503 with the same body", async () => {
    queryRaw.mockRejectedValueOnce("boom");
    const { GET } = await load();
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: false });
    // A thrown string is attacker-shaped, so `errorLabel` refuses `String(e)` and labels it NonError.
    const lines = errorLines();
    expect(lines).toHaveLength(1);
    expect(logs.at("ERROR")[0]).toMatchObject({ logScope: "route:/api/health", event: "failed", error: "NonError" });
    expect(lines[0]).not.toContain("boom");
  });
});
