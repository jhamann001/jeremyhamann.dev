import { describe, it, expect, vi, beforeEach } from "vitest";

// acat-status.ts imports "server-only" (throws outside an RSC bundle) — stub it
// so the module loads under the vitest node env (the acat-status.test idiom).
vi.mock("server-only", () => ({}));

// Mock the keyless OIDC layer exactly as acat-status.test does: GoogleAuth()
// .getIdTokenClient(audience) → client.request(opts). No real token is minted.
const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import { fetchAcatList, AcatListError } from "@/lib/data/acat-status";

const BASE = "https://transfers.jeremyhamann.dev";

const ROWS = [
  {
    id: "rec-1",
    acatTransferId: "ACT-1",
    clientName: "Neil Walker",
    controlNumber: "CTRL-1",
    direction: "Incoming",
    type: "Full account transfer",
    accountType: "Brokerage",
    status: "Accepted",
    transferringContra: "Fidelity",
    statementAmount: 1871000,
    acatDate: "2026-07-10",
    lastActivityAt: "2026-07-13T00:00:00.000Z",
    apexAccountId: "********ZHLK",
    statementAccountNumber: "****9384",
    dtccNumber: "****9236",
    assetMap: { total: 41, mapped: 41, unmapped: 0, pending: 0, expected: 41 },
  },
  {
    // A malformed statementAmount must coerce to null (never NaN). Has a record
    // id, so it is KEPT.
    id: "rec-2",
    acatTransferId: "ACT-2",
    clientName: "Sam Stone",
    statementAmount: "not-a-number",
    status: "Rejected",
    assetMap: { total: 4, mapped: 2, unmapped: 2 },
  },
  {
    // LEGACY/MANUAL: a valid record id but a NULL acatTransferId (no tracker
    // transfer UUID). This MUST be KEPT now (the id is its stable identity) —
    // previously it was silently dropped, which hid it from the tracking page.
    id: "rec-3",
    acatTransferId: null,
    clientName: "Obie Armstrong",
    status: "PendingSettlement",
    assetMap: { total: 5, mapped: 5, unmapped: 0, pending: 0, expected: 5 },
  },
  // No record id at all → DROPPED (it can key nothing), even though it has an
  // acatTransferId.
  { acatTransferId: "ACT-BARTELL", clientName: "No Id — dropped", status: "Submitted" },
];

function response(status: number, data: unknown) {
  return { status, data };
}

describe("fetchAcatList (ticket)", () => {
  beforeEach(() => {
    requestMock.mockReset();
    getIdTokenClientMock.mockClear();
  });

  it("200 → typed rows; defensive coercion; only rows with NO record id dropped", async () => {
    requestMock.mockResolvedValue(response(200, ROWS));

    const rows = await fetchAcatList();
    // rec-1, rec-2 and the UUID-less rec-3 are all KEPT; only the id-less row
    // (ACT-BARTELL) is dropped.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id)).toEqual(["rec-1", "rec-2", "rec-3"]);
    expect(rows.some((r) => r.clientName === "No Id — dropped")).toBe(false);

    expect(rows[0].id).toBe("rec-1");
    expect(rows[0].acatTransferId).toBe("ACT-1");
    expect(rows[0].clientName).toBe("Neil Walker");
    expect(rows[0].statementAmount).toBe(1871000);
    expect(rows[0].assetMap).toEqual({
      total: 41,
      mapped: 41,
      unmapped: 0,
      pending: 0,
      expected: 41,
    });
    // malformed number → null, missing map fields → null
    expect(rows[1].statementAmount).toBeNull();
    expect(rows[1].assetMap.pending).toBeNull();
    expect(rows[1].assetMap.expected).toBeNull();
  });

  it("KEEPS a legacy/manual row with a null/empty acatTransferId but a valid id", async () => {
    requestMock.mockResolvedValue(response(200, ROWS));
    const rows = await fetchAcatList();
    const manual = rows.find((r) => r.id === "rec-3");
    expect(manual).toBeDefined();
    // The UUID is normalised to "" (never null) and the row survives on its id.
    expect(manual!.acatTransferId).toBe("");
    expect(manual!.clientName).toBe("Obie Armstrong");
    expect(manual!.status).toBe("PendingSettlement");
  });

  it("accepts an { acats: [...] } envelope as well as a bare array", async () => {
    requestMock.mockResolvedValue(response(200, { acats: [ROWS[0]] }));
    const rows = await fetchAcatList();
    expect(rows).toHaveLength(1);
    expect(rows[0].acatTransferId).toBe("ACT-1");
  });

  it("mints the ID token with audience = the tracker base URL and hits the list path", async () => {
    requestMock.mockResolvedValue(response(200, []));
    await fetchAcatList();
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);
    const opts = requestMock.mock.calls[0][0] as { url: string; method: string };
    expect(opts.method).toBe("GET");
    expect(opts.url).toBe(`${BASE}/api/machine/acats`);
  });

  it("404 → empty list (no in-flight ACATs — not an error)", async () => {
    requestMock.mockResolvedValue(response(404, { error: "none" }));
    expect(await fetchAcatList()).toEqual([]);
  });

  it("401 → AcatListError(unauthorized)", async () => {
    requestMock.mockResolvedValue(response(401, {}));
    await expect(fetchAcatList()).rejects.toBeInstanceOf(AcatListError);
    await expect(fetchAcatList()).rejects.toMatchObject({ reason: "unauthorized" });
  });

  it("5xx → AcatListError(tracker_error)", async () => {
    requestMock.mockResolvedValue(response(502, {}));
    await expect(fetchAcatList()).rejects.toMatchObject({ reason: "tracker_error" });
  });

  it("a transport throw → AcatListError(transport_error)", async () => {
    requestMock.mockRejectedValue(new Error("network down"));
    await expect(fetchAcatList()).rejects.toMatchObject({ reason: "transport_error" });
  });
});
