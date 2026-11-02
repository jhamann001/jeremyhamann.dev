import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// trade-requests.ts imports "server-only" (throws outside an RSC bundle) — stub
// it so the module loads under the vitest node env (the acat-status idiom).
vi.mock("server-only", () => ({}));

// Mock the keyless OIDC layer: GoogleAuth().getIdTokenClient(audience) →
// client.request(opts). The tests drive `requestMock` per case and assert the
// audience + the request URL. No real token is ever minted. The mocks are
// created via vi.hoisted so the (hoisted) vi.mock factory can reference them
// without a TDZ error.
const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import {
  getTradeRequestsForUser,
  getTradeRequestsForUsers,
  getAuthoritativeTradeRequestsForUsers,
  TradeRequestReadError,
  TRADE_REQUEST_READ_TIMEOUT_MS,
} from "@/lib/data/trade-requests";

const BASE = "https://trade-request-123456789012.us-central1.run.app";
const PATH = `${BASE}/api/machine/trade-requests`;

describe("trade-request read deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestMock.mockReset();
    getIdTokenClientMock.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("settles an unresponsive source and aborts the authenticated GET", async () => {
    requestMock.mockImplementation(() => new Promise(() => {}));
    const reading = getTradeRequestsForUser("synthetic-timeout-user");
    const rejected = expect(reading).rejects.toMatchObject({ reason: "transport_error" });
    await vi.advanceTimersByTimeAsync(TRADE_REQUEST_READ_TIMEOUT_MS);
    await rejected;
    expect(requestMock).toHaveBeenCalledTimes(1);
    const options = requestMock.mock.calls[0][0];
    expect(options.signal.aborted).toBe(true);
    expect(options.retry).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds credential discovery and never starts a request after its deadline", async () => {
    let resolveClient!: (client: { request: typeof requestMock }) => void;
    getIdTokenClientMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveClient = resolve;
    }));
    const reading = getTradeRequestsForUser("synthetic-timeout-user");
    const rejected = expect(reading).rejects.toMatchObject({ reason: "transport_error" });
    await vi.advanceTimersByTimeAsync(TRADE_REQUEST_READ_TIMEOUT_MS);
    await rejected;
    resolveClient({ request: requestMock });
    await vi.advanceTimersByTimeAsync(0);
    expect(requestMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline when an ordinary empty result succeeds", async () => {
    requestMock.mockResolvedValue({ status: 200, data: { data: [] } });
    expect(await getTradeRequestsForUser("synthetic-empty-user")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// A full REDACTED projection row (masked account numbers, no clientName/notes).
const ROW = {
  id: "tr-1",
  clientId: "user-aaa",
  clientIds: ["user-aaa"],
  status: "Approved",
  tradeType: "Buy",
  priority: "Normal",
  createdAt: "2026-07-14T15:20:00.000Z",
  updatedAt: "2026-07-15T09:05:00.000Z",
  totalValue: 84200,
  advisor: "Rachel Moss",
  householdId: 4101,
  householdName: "Moss Family",
  selectedAccounts: ["****1234"],
  accounts: [
    { accountNumber: "****1234", accountType: "Individual", balance: 84200 },
  ],
  liquidateOption: null,
  liquidationApproval: null,
};

function response(status: number, data: unknown) {
  return { status, data };
}

describe("getTradeRequestsForUser (trade-request-linking S1)", () => {
  beforeEach(() => {
    requestMock.mockReset();
    getIdTokenClientMock.mockClear();
  });

  it("200 {data:[...]} → typed rows, defensive numeric coercion, arrays preserved", async () => {
    requestMock.mockResolvedValue(
      response(200, {
        data: [
          ROW,
          {
            ...ROW,
            id: "tr-2",
            totalValue: "not-a-number", // must coerce to null, never NaN
            accounts: [
              { accountNumber: "****9999", accountType: "Joint", balance: "x" },
            ],
          },
        ],
      }),
    );

    const rows = await getTradeRequestsForUser("user-aaa");
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("tr-1");
    expect(rows[0].status).toBe("Approved");
    expect(rows[0].totalValue).toBe(84200);
    expect(rows[0].clientIds).toEqual(["user-aaa"]);
    expect(rows[0].selectedAccounts).toEqual(["****1234"]);
    expect(rows[0].accounts[0].accountNumber).toBe("****1234"); // masked, verbatim
    // Non-numeric values coerce to null, never NaN.
    expect(rows[1].totalValue).toBeNull();
    expect(rows[1].accounts[0].balance).toBeNull();
  });

  it("mints the ID token with audience = the app base URL and builds the query via URLSearchParams", async () => {
    requestMock.mockResolvedValue(response(200, { data: [] }));

    await getTradeRequestsForUser("user-aaa");

    // Audience is the base URL (== the app's MACHINE_AUDIENCE), never the full path.
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);

    const opts = requestMock.mock.calls[0][0] as {
      url: string;
      method: string;
      validateStatus: () => boolean;
    };
    expect(opts.method).toBe("GET");
    expect(opts.url).toBe(`${PATH}?cedar_ridge_user_id=user-aaa`);
    expect(opts.validateStatus()).toBe(true);
  });

  it("200 {data:[]} (client with no requests) → []", async () => {
    requestMock.mockResolvedValue(response(200, { data: [] }));
    expect(await getTradeRequestsForUser("user-none")).toEqual([]);
  });

  it("200 with a missing/absent wrapper → [] (defensive)", async () => {
    requestMock.mockResolvedValueOnce(response(200, []));
    expect(await getTradeRequestsForUser("user-x")).toEqual([]);
    requestMock.mockResolvedValueOnce(response(200, {}));
    expect(await getTradeRequestsForUser("user-x")).toEqual([]);
  });

  it("drops a row with no id", async () => {
    requestMock.mockResolvedValue(
      response(200, { data: [ROW, { ...ROW, id: undefined }] }),
    );
    const rows = await getTradeRequestsForUser("user-aaa");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("tr-1");
  });

  it("404 → [] (degrade, not throw)", async () => {
    requestMock.mockResolvedValue(response(404, { error: "not found" }));
    expect(await getTradeRequestsForUser("user-aaa")).toEqual([]);
  });

  it("401 → TradeRequestReadError(unauthorized)", async () => {
    requestMock.mockResolvedValue(response(401, {}));
    await expect(getTradeRequestsForUser("user-x")).rejects.toBeInstanceOf(
      TradeRequestReadError,
    );
    await expect(getTradeRequestsForUser("user-x")).rejects.toMatchObject({
      reason: "unauthorized",
    });
  });

  it("403 → TradeRequestReadError(unauthorized)", async () => {
    requestMock.mockResolvedValue(response(403, {}));
    await expect(getTradeRequestsForUser("user-x")).rejects.toMatchObject({
      reason: "unauthorized",
    });
  });

  it("5xx → TradeRequestReadError(endpoint_error)", async () => {
    requestMock.mockResolvedValue(response(503, {}));
    await expect(getTradeRequestsForUser("user-x")).rejects.toMatchObject({
      reason: "endpoint_error",
    });
  });

  it("a transport throw → TradeRequestReadError(transport_error)", async () => {
    requestMock.mockRejectedValue(new Error("network down"));
    await expect(getTradeRequestsForUser("user-x")).rejects.toMatchObject({
      reason: "transport_error",
    });
  });
});

describe("getTradeRequestsForUsers (household batch)", () => {
  beforeEach(() => {
    requestMock.mockReset();
    getIdTokenClientMock.mockClear();
  });

  it("builds an cedar_ridge_user_ids CSV query, audience = base URL", async () => {
    requestMock.mockResolvedValue(response(200, { data: [ROW] }));

    const rows = await getTradeRequestsForUsers(["user-aaa", "user-bbb"]);
    expect(rows).toHaveLength(1);
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);

    const opts = requestMock.mock.calls[0][0] as { url: string };
    // URLSearchParams encodes the comma as %2C.
    expect(opts.url).toBe(`${PATH}?cedar_ridge_user_ids=user-aaa%2Cuser-bbb`);
  });

  it("de-dupes (isolated from the clamp — fewer than 50 uniques)", async () => {
    requestMock.mockResolvedValue(response(200, { data: [] }));

    // 3 uniques, heavily duplicated (+ a whitespace-padded dup that must trim
    // and collapse). Well under the 50 clamp, so this proves the DEDUPE alone.
    await getTradeRequestsForUsers([
      "user-a",
      "user-b",
      "user-a",
      " user-b ",
      "user-c",
      "user-c",
    ]);

    const opts = requestMock.mock.calls[0][0] as { url: string };
    const csv = new URL(opts.url).searchParams.get("cedar_ridge_user_ids")!;
    expect(csv.split(",")).toEqual(["user-a", "user-b", "user-c"]);
  });

  it("clamps to 50 ids", async () => {
    requestMock.mockResolvedValue(response(200, { data: [] }));

    const many = Array.from({ length: 60 }, (_, i) => `user-${i}`);
    await getTradeRequestsForUsers(many);

    const opts = requestMock.mock.calls[0][0] as { url: string };
    const csv = new URL(opts.url).searchParams.get("cedar_ridge_user_ids")!;
    const emitted = csv.split(",");
    expect(emitted.length).toBe(50);
    expect(new Set(emitted).size).toBe(50); // all unique
  });

  it("empty input → [] with NO request made", async () => {
    const rows = await getTradeRequestsForUsers([]);
    expect(rows).toEqual([]);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("propagates errors the same way (401 → unauthorized)", async () => {
    requestMock.mockResolvedValue(response(401, {}));
    await expect(
      getTradeRequestsForUsers(["user-aaa"]),
    ).rejects.toMatchObject({ reason: "unauthorized" });
  });
});

describe("getAuthoritativeTradeRequestsForUsers (review queue reconciliation)", () => {
  beforeEach(() => {
    requestMock.mockReset();
    getIdTokenClientMock.mockClear();
  });

  it("rejects 404 because only a 200 batch can authorize queue clearing", async () => {
    requestMock.mockResolvedValue(response(404, { error: "not found" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(getAuthoritativeTradeRequestsForUsers(["user-aaa"]))
      .rejects.toMatchObject({ reason: "non_authoritative" });
    expect(errorSpy).toHaveBeenCalledWith("[trade-requests] authoritative_batch_rejected");
    errorSpy.mockRestore();
  });

  it("rejects malformed 200 wrappers and rows", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const body of [{}, { data: null }, { data: [{ id: "tr-1" }] }]) {
      requestMock.mockResolvedValueOnce(response(200, body));
      await expect(getAuthoritativeTradeRequestsForUsers(["user-aaa"]))
        .rejects.toMatchObject({ reason: "non_authoritative" });
    }
    expect(errorSpy).toHaveBeenCalledTimes(3);
    errorSpy.mockRestore();
  });

  it("accepts an authoritative empty 200 as a legitimate completed batch", async () => {
    requestMock.mockResolvedValue(response(200, { data: [] }));
    await expect(getAuthoritativeTradeRequestsForUsers(["user-aaa"]))
      .resolves.toEqual([]);
  });
});
