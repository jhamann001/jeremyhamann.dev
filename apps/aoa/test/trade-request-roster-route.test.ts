import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, findUnique, servingState, readRoster, changeRoster, writesPaused } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  findUnique: vi.fn(),
  servingState: vi.fn(),
  readRoster: vi.fn(),
  changeRoster: vi.fn(),
  writesPaused: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique } } }));
vi.mock("@/lib/trade-requests/serving-state", () => ({ readServingState: servingState }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: writesPaused }));
vi.mock("@/lib/trade-requests/roster", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/trade-requests/roster")>();
  return { RosterRefusal: real.RosterRefusal, readRoster, changeRoster };
});

import { GET, POST } from "@/app/api/trade-requests/roster/route";
import { RosterRefusal } from "@/lib/trade-requests/roster";

const URL = "http://localhost/api/trade-requests/roster";
const ROSTER = [{ id: "00000000-0000-4000-8000-000000000001", name: "Trader One", email: "t1@example.test", slackUserId: null, aoaRole: "ADMIN", eligible: true }];
const get = (site = "same-origin") => GET(new Request(URL, { headers: { "sec-fetch-site": site } }));
const post = (body: unknown, site: string | null = "same-origin") =>
  POST(new Request(URL, { method: "POST", headers: site ? { "sec-fetch-site": site, "content-type": "application/json" } : { "content-type": "application/json" }, body: JSON.stringify(body) }));
const ADD = { action: "add", email: "ops@example.test" };

function switches(epic: boolean, roster: boolean) {
  if (epic) process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE = "1";
  else delete process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE;
  if (roster) process.env.TRADE_REQUESTS_ROSTER_ADMIN = "1";
  else delete process.env.TRADE_REQUESTS_ROSTER_ADMIN;
}

beforeEach(() => {
  vi.clearAllMocks();
  switches(true, true);
  servingState.mockResolvedValue({ servingSource: "aoa", digestSender: "standalone", driftSender: "standalone" });
  writesPaused.mockReturnValue(false);
  authSpy.mockResolvedValue({ user: { id: "usr_admin1" } });
  findUnique.mockResolvedValue({ role: "ADMIN", email: "admin@example.test" });
  readRoster.mockResolvedValue(ROSTER);
  changeRoster.mockResolvedValue(ROSTER);
});

afterEach(() => switches(false, false));

describe("Trade Request roster route", () => {
  it("answers 404 with both switches unset", async () => {
    switches(false, false);
    expect((await get()).status).toBe(404);
    expect(readRoster).not.toHaveBeenCalled();
  });

  it("answers 404 with only the epic master on", async () => {
    switches(true, false);
    expect((await get()).status).toBe(404);
  });

  it("answers 404 with only the roster switch on", async () => {
    switches(false, true);
    expect((await get()).status).toBe(404);
  });

  it("refuses a change while Trade Requests are standalone-served", async () => {
    servingState.mockResolvedValue({ servingSource: "standalone", digestSender: "standalone", driftSender: "standalone" });
    expect((await post(ADD)).status).toBe(404);
    expect(changeRoster).not.toHaveBeenCalled();
  });

  it("refuses a cross-site read", async () => {
    expect((await get("cross-site")).status).toBe(403);
  });

  it("refuses a write that is not same-origin", async () => {
    expect((await post(ADD, null)).status).toBe(403);
    expect(changeRoster).not.toHaveBeenCalled();
  });

  it("answers 503 while app writes are paused", async () => {
    writesPaused.mockReturnValue(true);
    expect((await post(ADD)).status).toBe(503);
    expect(changeRoster).not.toHaveBeenCalled();
  });

  it("answers 401 without a signed-in user", async () => {
    authSpy.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });

  it("answers 503 when the session cannot be read", async () => {
    authSpy.mockRejectedValue(new Error("auth down"));
    expect((await get()).status).toBe(503);
  });

  it("refuses an OPERATIONS change", async () => {
    findUnique.mockResolvedValue({ role: "OPERATIONS", email: "ops@example.test" });
    expect((await post(ADD)).status).toBe(403);
    expect(changeRoster).not.toHaveBeenCalled();
  });

  it("refuses ADVISOR, CLIENT_SERVICE and VIEWER changes", async () => {
    for (const role of ["ADVISOR", "CLIENT_SERVICE", "VIEWER"]) {
      findUnique.mockResolvedValueOnce({ role, email: "someone@example.test" });
      expect((await post(ADD)).status).toBe(403);
    }
    expect(changeRoster).not.toHaveBeenCalled();
  });

  it("applies an ADMIN add with the stored identity and returns the roster", async () => {
    const res = await post(ADD);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ ok: true, data: ROSTER });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "usr_admin1" }, select: { role: true, email: true } });
    expect(changeRoster).toHaveBeenCalledWith({ aoaUserId: "usr_admin1", email: "admin@example.test" }, { action: "add", email: "ops@example.test" });
  });

  it("answers 422 not_eligible when the person has no eligible AOA account", async () => {
    changeRoster.mockRejectedValue(new RosterRefusal("not_eligible"));
    const res = await post(ADD);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, outcome: "not_eligible" });
  });

  it("answers 400 for an invalid member id", async () => {
    changeRoster.mockRejectedValue(new RosterRefusal("invalid_member"));
    const res = await post({ action: "remove", memberId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, outcome: "invalid_member" });
  });

  it("answers 422 last_trader when removing the last active trader", async () => {
    changeRoster.mockRejectedValue(new RosterRefusal("last_trader"));
    const res = await post({ action: "remove", memberId: "00000000-0000-4000-8000-000000000001" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, outcome: "last_trader" });
  });
});
