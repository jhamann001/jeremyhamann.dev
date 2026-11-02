import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ticket: the scheduler route, its mode and drift-sender gating, and its failure statuses.
const m = vi.hoisted(() => ({
  authOk: vi.fn(async () => true),
  serving: vi.fn(async () => ({ servingSource: "standalone", digestSender: "standalone", driftSender: "standalone" })),
  run: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/cron/trade-request-drift-auth", () => ({ requireTradeRequestDriftCronAuth: m.authOk }));
vi.mock("@/lib/trade-requests/serving-state", () => ({ readServingState: m.serving }));
vi.mock("@/lib/trade-requests/pg-compat", () => ({ appPool: async () => ({ query: vi.fn(), transaction: vi.fn() }) }));
vi.mock("@/lib/trade-requests/drift/registry-drift-runner", () => ({ runDriftCheck: m.run }));

import { GET, POST } from "@/app/api/cron/trade-request-drift/route";
import { SnapshotLoadError } from "@/lib/trade-requests/sources/meridian-snapshot";
import { ActiveAccountsLoadError } from "@/lib/trade-requests/sources/meridian-active-accounts";

const req = () => new Request("https://ops-portal.example.test/api/cron/trade-request-drift", { method: "POST", headers: { authorization: "Bearer t" } });
const SUMMARY = {
  runDateLocal: "2026-05-13",
  totalHouseholds: 2,
  insertedRows: 2,
  unmappedPositionsAccounts: ["ULID-NEVER-RETURNED"],
  accountDrift: { totalAccounts: 3, outAccounts: 1, uninvestedAccounts: 0, insertedRows: 3, alert: { sent: false, alertingAccountIds: [], suppressedAllowListed: [] } },
};
const sender = (driftSender: string) => m.serving.mockResolvedValue({ servingSource: "aoa", digestSender: "aoa", driftSender });

beforeEach(() => {
  vi.clearAllMocks();
  m.authOk.mockResolvedValue(true);
  sender("standalone");
  m.run.mockResolvedValue(SUMMARY);
  process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE = "1";
  process.env.TRADE_REQUESTS_DRIFT_JOB = "shadow";
});
afterEach(() => {
  delete process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE;
  delete process.env.TRADE_REQUESTS_DRIFT_JOB;
});

describe("POST /api/cron/trade-request-drift", () => {
  it("answers 401 and runs nothing without the scheduler identity", async () => {
    m.authOk.mockResolvedValue(false);
    expect((await POST(req())).status).toBe(401);
    expect(m.run).not.toHaveBeenCalled();
  });

  it("answers 204 and runs nothing while the mode is off (epic switch unset)", async () => {
    delete process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE;
    expect((await POST(req())).status).toBe(204);
    expect(m.run).not.toHaveBeenCalled();
  });

  it("treats any mode other than exactly shadow or live as off", async () => {
    for (const mode of ["LIVE", "true", "1", ""]) {
      process.env.TRADE_REQUESTS_DRIFT_JOB = mode;
      expect((await POST(req())).status).toBe(204);
    }
    expect(m.run).not.toHaveBeenCalled();
  });

  it("runs a shadow check in shadow mode and returns counts only", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(m.run).toHaveBeenCalledWith(expect.objectContaining({ pool: expect.anything() }), { kind: "shadow" });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ mode: "shadow", runDateLocal: "2026-05-13", households: 2, householdRowsInserted: 2, accounts: 3, outAccounts: 1, accountRowsInserted: 3, alertSent: false });
    expect(text).not.toContain("ULID-NEVER-RETURNED");
  });

  it("runs shadow in live mode while AOA is not the drift sender", async () => {
    process.env.TRADE_REQUESTS_DRIFT_JOB = "live";
    sender("standalone");
    expect((await (await POST(req())).json()).mode).toBe("shadow");
    expect(m.run.mock.calls[0][1]).toEqual({ kind: "shadow" });
  });

  it("runs live while AOA is the drift sender, re-reading the sender before each send", async () => {
    process.env.TRADE_REQUESTS_DRIFT_JOB = "live";
    sender("aoa");
    expect((await (await POST(req())).json()).mode).toBe("live");
    const target = m.run.mock.calls[0][1];
    expect(target.kind).toBe("live");
    sender("standalone");
    expect(await target.stillSender()).toBe(false);
  });

  it("answers 503 snapshot_unavailable when the templates feed fails or is malformed", async () => {
    m.run.mockRejectedValue(new SnapshotLoadError("templates malformed", "s3"));
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "snapshot_unavailable" });
  });

  it("answers 503 active_accounts_unavailable when the household feed fails", async () => {
    m.run.mockRejectedValue(new ActiveAccountsLoadError("unavailable", "s3"));
    expect(await (await POST(req())).json()).toEqual({ error: "active_accounts_unavailable" });
  });

  it("answers 503 drift_check_failed when Warehouse or anything else fails", async () => {
    m.run.mockRejectedValue(new Error("Warehouse question 6139 returned 502"));
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "drift_check_failed" });
  });

  it("refuses GET with 405", async () => {
    expect(GET().status).toBe(405);
  });
});
