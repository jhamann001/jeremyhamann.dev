import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ call: vi.fn(), auth: vi.fn(), flag: vi.fn() }));
vi.mock("@/lib/trade-requests/client", () => ({ callTradeRequestService: m.call }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.flag }));

import { readPriorAllocation } from "@/lib/trade-requests/allocation";
import { loadPriorAllocation } from "@/app/(authenticated)/trade-requests/new/actions";

const BODY = {
  riskProfile: 12, baseAllocation: { equity: 61, fixed: 34.5, cash: 4.5 },
  equityStrategies: [{ id: 1, benchmark: "SPY", allocation: 60, rationale: "core" }, { id: 2, benchmark: "EFA", allocation: "40", rationale: "intl" }],
};

beforeEach(() => {
  m.call.mockReset();
  m.auth.mockResolvedValue({ user: { email: "avery@example.com", role: "ADVISOR" } });
  m.flag.mockReturnValue(true);
});

describe("prior allocation read (Business Rules → Prior allocation)", () => {
  it("reads the delegated last-allocation route for the client and normalises it", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: BODY });
    await expect(readPriorAllocation("trw11 morgan/1")).resolves.toEqual({
      riskProfile: 12, baseAllocation: { equity: 61, fixed: 34.5, cash: 4.5 },
      equityStrategies: [{ id: 1, benchmark: "SPY", allocation: 60, rationale: "core" }, { id: 2, benchmark: "EFA", allocation: 40, rationale: "intl" }],
    });
    expect(m.call).toHaveBeenCalledWith({
      operation: "lastAllocation", method: "GET", path: "/requests/last-allocation/trw11%20morgan%2F1", defaultMessage: "prior_allocation_unavailable",
    });
  });

  it("treats none on file, a refusal (an advisor without the client), a failure or an unreadable body as no prior allocation", async () => {
    m.call.mockResolvedValueOnce({ ok: true, status: 200, data: null });
    await expect(readPriorAllocation("c1")).resolves.toBeNull();
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: 403, message: "You do not have access to this client" });
    await expect(readPriorAllocation("c1")).resolves.toBeNull();
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: null, message: "Network Error" });
    await expect(readPriorAllocation("c1")).resolves.toBeNull();
    m.call.mockResolvedValueOnce({ ok: false, outcome: "not_set_up", message: "not set up" });
    await expect(readPriorAllocation("c1")).resolves.toBeNull();
    m.call.mockResolvedValueOnce({ ok: true, status: 200, data: { ...BODY, riskProfile: 40 } });
    await expect(readPriorAllocation("c1")).resolves.toBeNull();
    m.call.mockResolvedValueOnce({ ok: true, status: 200, data: { ...BODY, equityStrategies: [{ id: 1, benchmark: 5, allocation: 1 }] } });
    await expect(readPriorAllocation("c1")).resolves.toBeNull();
  });
});

describe("loadPriorAllocation action", () => {
  it("calls the service for a workspace role with the flag on", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: BODY });
    await expect(loadPriorAllocation("c1")).resolves.toMatchObject({ riskProfile: 12 });
  });

  it("returns nothing without a call when the flag is off, the role has no access, or the id is not a short string", async () => {
    m.flag.mockReturnValueOnce(false);
    await expect(loadPriorAllocation("c1")).resolves.toBeNull();
    for (const role of ["CLIENT_SERVICE", "VIEWER"]) {
      m.auth.mockResolvedValueOnce({ user: { email: "x@example.com", role } });
      await expect(loadPriorAllocation("c1")).resolves.toBeNull();
    }
    for (const id of [42, "", "x".repeat(51), null]) await expect(loadPriorAllocation(id)).resolves.toBeNull();
    expect(m.call).not.toHaveBeenCalled();
  });
});
