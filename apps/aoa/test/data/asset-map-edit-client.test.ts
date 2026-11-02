import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { sendAssetMapEdit, statusOverrideNote, type AssetMapEditRequest } from "@/lib/data/asset-map";

const BASE = "https://pipeline.example.test";
const POS = "11111111-1111-4111-8111-111111111111";
const ACC = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ status: 200, data: {} });
  getIdTokenClientMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendAssetMapEdit", () => {
  const cases: [AssetMapEditRequest["kind"], AssetMapEditRequest, string, string, unknown][] = [
    ["positionStatus", { kind: "positionStatus", positionId: POS, status: "LIQUIDATE" }, "PATCH", `/api/positions/${POS}/status`, { status: "LIQUIDATE", notes: "Manual override to LIQUIDATE" }],
    ["positionTransferring", { kind: "positionTransferring", positionId: POS, value: "YES" }, "PATCH", `/api/positions/${POS}/transferring`, { value: "YES" }],
    ["accountType", { kind: "accountType", accountId: ACC, accountType: "Other", accountTypeOther: "Synthetic label" }, "PATCH", `/api/accounts/${ACC}/type`, { account_type: "Other", account_type_other: "Synthetic label" }],
    ["removePosition", { kind: "removePosition", positionId: POS }, "DELETE", `/api/positions/${POS}`, undefined],
    ["restorePosition", { kind: "restorePosition", positionId: POS }, "PATCH", `/api/positions/${POS}/restore`, undefined],
    ["removeAccount", { kind: "removeAccount", accountId: ACC }, "DELETE", `/api/accounts/${ACC}`, undefined],
    ["restoreAccount", { kind: "restoreAccount", accountId: ACC }, "PATCH", `/api/accounts/${ACC}/restore`, undefined],
  ];

  it.each(cases)("sends %s to the matching pipeline route", async (_kind, req, method, path, data) => {
    await sendAssetMapEdit(BASE, req);
    expect(requestMock).toHaveBeenCalledTimes(1);
    const arg = requestMock.mock.calls[0][0];
    expect(arg.url).toBe(`${BASE}${path}`);
    expect(arg.method).toBe(method);
    expect(arg.data).toEqual(data);
  });

  it("status saves send the pipeline UI's override note", async () => {
    expect(statusOverrideNote("REVIEW")).toBe("Manual override to REVIEW");
    await sendAssetMapEdit(BASE, { kind: "positionStatus", positionId: POS, status: "ACH/WIRE" });
    expect(requestMock.mock.calls[0][0].data).toEqual({ status: "ACH/WIRE", notes: "Manual override to ACH/WIRE" });
  });

  it("uses the pipeline base URL as the token audience and a 15-second timeout", async () => {
    await sendAssetMapEdit(BASE, { kind: "removePosition", positionId: POS });
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);
    expect(requestMock.mock.calls[0][0].timeout).toBe(15000);
  });

  it("returns the response body on a 2xx", async () => {
    requestMock.mockResolvedValue({ status: 200, data: { position_id: POS, new_status: "REVIEW" } });
    await expect(sendAssetMapEdit(BASE, { kind: "positionStatus", positionId: POS, status: "REVIEW" }))
      .resolves.toEqual({ ok: true, body: { position_id: POS, new_status: "REVIEW" } });
  });

  it("returns rejected on 400, 403, and 404", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [400, 403, 404]) {
      requestMock.mockResolvedValueOnce({ status, data: { detail: "synthetic" } });
      await expect(sendAssetMapEdit(BASE, { kind: "removeAccount", accountId: ACC }))
        .resolves.toEqual({ ok: false, reason: "rejected" });
    }
  });

  it("returns unavailable on 500 and 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [500, 503]) {
      requestMock.mockResolvedValueOnce({ status, data: {} });
      await expect(sendAssetMapEdit(BASE, { kind: "restoreAccount", accountId: ACC }))
        .resolves.toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("returns unavailable on a transport failure or timeout and logs only a static marker", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    requestMock.mockRejectedValueOnce(new Error(`timeout of 15000ms exceeded ${POS} synthetic-token`));
    await expect(sendAssetMapEdit(BASE, { kind: "positionTransferring", positionId: POS, value: "NO" }))
      .resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[asset-map] edit_transport_failed");
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(POS);
    expect(logged).not.toContain("synthetic-token");
  });

  it("encodes the id path segment", async () => {
    await sendAssetMapEdit(BASE, { kind: "removePosition", positionId: "a/b" });
    expect(requestMock.mock.calls[0][0].url).toBe(`${BASE}/api/positions/a%2Fb`);
  });
});
