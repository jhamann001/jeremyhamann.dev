import { describe, it, expect, vi, beforeEach } from "vitest";

// acat-status.ts imports "server-only" (throws outside an RSC bundle) — stub it
// so the module loads under the vitest node env (the twr-warehouse idiom).
vi.mock("server-only", () => ({}));

// Mock the keyless OIDC layer: GoogleAuth().getIdTokenClient(audience) →
// client.request(opts). The tests drive `requestMock` per case and assert the
// audience + the encoded request URL. No real token is ever minted. The mocks
// are created via vi.hoisted so the (hoisted) vi.mock factory can reference
// them without a TDZ error.
const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  // Regular function so it is usable with `new GoogleAuth()` in the module.
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import {
  getAcatStatus,
  getAcatStatusByRecordId,
  getAcatStatusForTransfer,
  AcatStatusError,
} from "@/lib/data/acat-status";

const BASE = "https://transfers.jeremyhamann.dev";

// A full REDACTED projection (masked account/cusip/DTCC, no clientName/advisor).
const PROJECTION = {
  acatTransferId: "ACT-abc123",
  controlNumber: "CTRL-9",
  direction: "INCOMING",
  type: "FULL",
  accountType: "BROKERAGE",
  status: "IN_TRANSFER",
  transferringContra: "Fidelity",
  statementAmount: 152340.55,
  methodRequested: "ACATS",
  feeCharged: true,
  feeAmount: 75,
  acatDate: "2026-07-10",
  apexAccountId: "********ZHLK",
  statementAccountNumber: "****9384",
  dtccNumber: "****9236",
  assets: [
    {
      symbol: "AAPL",
      description: "Apple Inc",
      cusip: "****4303",
      expectedQty: 100,
      actualQty: 100,
      mapStatus: "MAPPED",
      issue: null,
      amount: 21500,
      assetClass: "EQUITY",
    },
    {
      symbol: "XYZ",
      description: "Mystery Fund",
      cusip: "****9999",
      expectedQty: 50,
      actualQty: 40,
      mapStatus: "REVIEW",
      issue: "QTY_MISMATCH",
      amount: "not-a-number", // defensive: coerces to null, never NaN
      assetClass: "FI-ETF",
    },
  ],
};

function response(status: number, data: unknown) {
  return { status, data };
}

describe("getAcatStatus (ticket)", () => {
  beforeEach(() => {
    requestMock.mockReset();
    getIdTokenClientMock.mockClear();
  });

  it("200 → typed projection, with defensive numeric coercion and assets mapped", async () => {
    requestMock.mockResolvedValue(response(200, PROJECTION));

    const status = await getAcatStatus("ACT-abc123");
    expect(status).not.toBeNull();
    expect(status!.acatTransferId).toBe("ACT-abc123");
    expect(status!.status).toBe("IN_TRANSFER");
    expect(status!.transferringContra).toBe("Fidelity");
    expect(status!.statementAmount).toBe(152340.55);
    expect(status!.feeCharged).toBe(true);
    expect(status!.feeAmount).toBe(75);
    expect(status!.apexAccountId).toBe("********ZHLK"); // masked, shown verbatim
    expect(status!.assets).toHaveLength(2);
    expect(status!.assets[0].expectedQty).toBe(100);
    expect(status!.assets[1].issue).toBe("QTY_MISMATCH");
    // A non-numeric amount must coerce to null, never NaN.
    expect(status!.assets[1].amount).toBeNull();
  });

  it("mints the ID token with audience = the tracker base URL and encodeURIComponent's the id", async () => {
    requestMock.mockResolvedValue(response(200, PROJECTION));

    // An id with characters that MUST be percent-encoded into the path.
    await getAcatStatus("a/b c?d#e");

    // getIdTokenClient(audience): the audience is the base URL (== the
    // tracker's MACHINE_AUTH_AUDIENCE), never the full request path.
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);

    const opts = requestMock.mock.calls[0][0] as {
      url: string;
      method: string;
      validateStatus: () => boolean;
    };
    expect(opts.method).toBe("GET");
    // The id is encoded, never interpolated raw.
    expect(opts.url).toBe(
      `${BASE}/api/machine/acats/${encodeURIComponent("a/b c?d#e")}`,
    );
    expect(opts.url).toContain("a%2Fb%20c%3Fd%23e");
    expect(opts.url).not.toContain("a/b c?d#e");
    // We handle status codes ourselves (no throw on non-2xx).
    expect(opts.validateStatus()).toBe(true);
  });

  it("404 → null (no ACAT linked yet — not an error)", async () => {
    requestMock.mockResolvedValue(response(404, { error: "not found" }));
    expect(await getAcatStatus("ACT-none")).toBeNull();
  });

  it("401 → AcatStatusError(unauthorized)", async () => {
    requestMock.mockResolvedValue(response(401, {}));
    await expect(getAcatStatus("ACT-x")).rejects.toBeInstanceOf(AcatStatusError);
    await expect(getAcatStatus("ACT-x")).rejects.toMatchObject({
      reason: "unauthorized",
    });
  });

  it("5xx → AcatStatusError(tracker_error)", async () => {
    requestMock.mockResolvedValue(response(503, {}));
    await expect(getAcatStatus("ACT-x")).rejects.toMatchObject({
      reason: "tracker_error",
    });
  });

  it("a transport throw → AcatStatusError(transport_error)", async () => {
    requestMock.mockRejectedValue(new Error("network down"));
    await expect(getAcatStatus("ACT-x")).rejects.toMatchObject({
      reason: "transport_error",
    });
  });
});

describe("getAcatStatusByRecordId (by-record read, fixes wrong-modal bug)", () => {
  beforeEach(() => {
    requestMock.mockReset();
    getIdTokenClientMock.mockClear();
  });

  it("passes a preparation caller's cancellation signal and request timeout", async () => {
    const controller = new AbortController();
    requestMock.mockResolvedValue(response(200, PROJECTION));
    await getAcatStatusByRecordId("rec-preparation", { signal: controller.signal });
    expect(requestMock.mock.calls[0][0]).toMatchObject({ signal: controller.signal, timeout: 8_000 });
  });

  it("does not discover credentials for an already canceled read", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getAcatStatusByRecordId("rec-preparation", { signal: controller.signal }))
      .rejects.toMatchObject({ reason: "transport_error" });
    expect(getIdTokenClientMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("does not start a request if credentials arrive after cancellation", async () => {
    const controller = new AbortController();
    let finishCredentials!: (value: { request: typeof requestMock }) => void;
    getIdTokenClientMock.mockImplementationOnce(() => new Promise((resolve) => { finishCredentials = resolve; }));
    const result = getAcatStatusByRecordId("rec-preparation", { signal: controller.signal });
    controller.abort();
    finishCredentials({ request: requestMock });
    await expect(result).rejects.toMatchObject({ reason: "transport_error" });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("200 → typed projection (same shape/coercion as getAcatStatus)", async () => {
    requestMock.mockResolvedValue(response(200, PROJECTION));

    const status = await getAcatStatusByRecordId("rec-abc");
    expect(status).not.toBeNull();
    expect(status!.status).toBe("IN_TRANSFER");
    expect(status!.apexAccountId).toBe("********ZHLK"); // masked, verbatim
    expect(status!.assets).toHaveLength(2);
    // A non-numeric amount must coerce to null, never NaN.
    expect(status!.assets[1].amount).toBeNull();
  });

  it("hits the /api/machine/acats/by-record/{id} path with audience = base URL and encoded id", async () => {
    requestMock.mockResolvedValue(response(200, PROJECTION));

    // An id with characters that MUST be percent-encoded into the path.
    await getAcatStatusByRecordId("a/b c?d#e");

    // Audience is the base URL (== the tracker's MACHINE_AUTH_AUDIENCE).
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);

    const opts = requestMock.mock.calls[0][0] as {
      url: string;
      method: string;
      validateStatus: () => boolean;
    };
    expect(opts.method).toBe("GET");
    // The BY-RECORD path, with the id encoded (never interpolated raw).
    expect(opts.url).toBe(
      `${BASE}/api/machine/acats/by-record/${encodeURIComponent("a/b c?d#e")}`,
    );
    expect(opts.url).toContain("/api/machine/acats/by-record/");
    expect(opts.url).toContain("a%2Fb%20c%3Fd%23e");
    expect(opts.url).not.toContain("a/b c?d#e");
    expect(opts.validateStatus()).toBe(true);
  });

  it("resolves DISTINCT records for two ids sharing acatTransferId 'N/A'", async () => {
    // Two records both carry acatTransferId "N/A" but distinct record ids —
    // each id must return ITS OWN record (the whole point of the by-record read).
    requestMock.mockResolvedValueOnce(
      response(200, { ...PROJECTION, acatTransferId: "N/A", statementAmount: 742900 }),
    );
    const a = await getAcatStatusByRecordId("rec-manual-hayes");

    requestMock.mockResolvedValueOnce(
      response(200, { ...PROJECTION, acatTransferId: "N/A", statementAmount: 218400 }),
    );
    const b = await getAcatStatusByRecordId("rec-manual-armstrong");

    expect(requestMock.mock.calls[0][0].url).toContain("by-record/rec-manual-hayes");
    expect(requestMock.mock.calls[1][0].url).toContain("by-record/rec-manual-armstrong");
    expect(a!.acatTransferId).toBe("N/A");
    expect(b!.acatTransferId).toBe("N/A");
    expect(a!.statementAmount).toBe(742900);
    expect(b!.statementAmount).toBe(218400);
    expect(a!.statementAmount).not.toBe(b!.statementAmount);
  });

  it("404 → null (no such record — e.g. a manual record with no by-id detail)", async () => {
    requestMock.mockResolvedValue(response(404, { error: "not found" }));
    expect(await getAcatStatusByRecordId("rec-none")).toBeNull();
  });

  it("401 → AcatStatusError(unauthorized)", async () => {
    requestMock.mockResolvedValue(response(401, {}));
    await expect(getAcatStatusByRecordId("rec-x")).rejects.toMatchObject({
      reason: "unauthorized",
    });
  });

  it("5xx → AcatStatusError(tracker_error)", async () => {
    requestMock.mockResolvedValue(response(503, {}));
    await expect(getAcatStatusByRecordId("rec-x")).rejects.toMatchObject({
      reason: "tracker_error",
    });
  });

  it("a transport throw → AcatStatusError(transport_error)", async () => {
    requestMock.mockRejectedValue(new Error("network down"));
    await expect(getAcatStatusByRecordId("rec-x")).rejects.toMatchObject({
      reason: "transport_error",
    });
  });
});

describe("getAcatStatusForTransfer (record-id-first router)", () => {
  beforeEach(() => {
    requestMock.mockReset();
    getIdTokenClientMock.mockClear();
  });

  it("record id set (uuid also set) → exactly ONE request, on the encoded by-record path — the record id WINS", async () => {
    requestMock.mockResolvedValue(response(200, PROJECTION));

    const status = await getAcatStatusForTransfer({
      acat_record_id: "rec/1", // needs percent-encoding into the path
      acat_transfer_id: "ACT-abc123",
    });

    expect(status).not.toBeNull();
    expect(requestMock).toHaveBeenCalledTimes(1);
    const opts = requestMock.mock.calls[0][0] as { url: string };
    expect(opts.url).toBe(`${BASE}/api/machine/acats/by-record/rec%2F1`);
  });

  it("record id null, uuid set → the legacy by-UUID path", async () => {
    requestMock.mockResolvedValue(response(200, PROJECTION));

    const status = await getAcatStatusForTransfer({
      acat_record_id: null,
      acat_transfer_id: "ACT-abc123",
    });

    expect(status).not.toBeNull();
    expect(requestMock).toHaveBeenCalledTimes(1);
    const opts = requestMock.mock.calls[0][0] as { url: string };
    expect(opts.url).toBe(`${BASE}/api/machine/acats/ACT-abc123`);
  });

  it("both null → resolves null with NO request (defensive arm — callers gate on isAcatLinked)", async () => {
    const status = await getAcatStatusForTransfer({
      acat_record_id: null,
      acat_transfer_id: null,
    });
    expect(status).toBeNull();
    expect(requestMock).not.toHaveBeenCalled();
  });
});
