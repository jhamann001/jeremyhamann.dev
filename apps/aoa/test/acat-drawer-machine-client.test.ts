import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

vi.mock("server-only", () => ({}));

const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import { writeAcatBookRecord } from "@/lib/data/acat-status";

const SUITE = "acat-drawer-machine-client";
const BASE = "https://transfers.jeremyhamann.dev";

beforeEach(() => {
  requestMock.mockReset();
  getIdTokenClientMock.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("machine write client", () => {
  it("tkt332 machine: a DELETE reaches the tracker with the JSON body and no-store headers", async () => {
    requestMock.mockResolvedValue({ status: 200, data: { removed: true } });
    const res = await writeAcatBookRecord("DELETE", "/api/machine/acats/by-record/rec-1/drawer", { reason: "Wrong client" });
    expect(res).toEqual({ status: 200, data: { removed: true } });
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);
    const call = requestMock.mock.calls[0][0];
    expect(call.method).toBe("DELETE");
    expect(call.url).toBe(`${BASE}/api/machine/acats/by-record/rec-1/drawer`);
    expect(call.data).toEqual({ reason: "Wrong client" });
    expect(call.headers).toEqual({ "Cache-Control": "no-store" });
    markCase(SUITE, "tkt332 machine: a DELETE reaches the tracker with the JSON body and no-store headers");
  });

  it("tkt332 machine: a PATCH to the drawer route keeps the existing request shape", async () => {
    requestMock.mockResolvedValue({ status: 200, data: { transfer: { id: "rec-1" } } });
    const body = { action: "reject", reason: "Wrong custodian" };
    const res = await writeAcatBookRecord("PATCH", "/api/machine/acats/by-record/rec-1/drawer", body);
    expect(res.status).toBe(200);
    expect(requestMock).toHaveBeenCalledWith({
      url: `${BASE}/api/machine/acats/by-record/rec-1/drawer`,
      method: "PATCH",
      data: body,
      validateStatus: expect.any(Function),
      retry: false,
      timeout: 10_000,
      headers: { "Cache-Control": "no-store" },
    });
    markCase(SUITE, "tkt332 machine: a PATCH to the drawer route keeps the existing request shape");
  });

  it("tkt332 machine: a transport failure or fixture mode returns status null without a request", async () => {
    requestMock.mockRejectedValue(new Error("socket hang up"));
    expect(await writeAcatBookRecord("DELETE", "/api/machine/acats/by-record/rec-1/drawer", { reason: "Wrong client" }))
      .toEqual({ status: null, data: null });
    expect(requestMock).toHaveBeenCalledTimes(1);
    requestMock.mockClear();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ACAT_FIXTURE", "1");
    expect(await writeAcatBookRecord("DELETE", "/api/machine/acats/by-record/rec-1/drawer", { reason: "Wrong client" }))
      .toEqual({ status: null, data: null });
    expect(requestMock).not.toHaveBeenCalled();
    markCase(SUITE, "tkt332 machine: a transport failure or fixture mode returns status null without a request");
  });
});
