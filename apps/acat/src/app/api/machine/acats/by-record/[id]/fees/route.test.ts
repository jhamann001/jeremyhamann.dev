import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

const mockVerifyIdToken = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: class MockOAuth2Client {
    verifyIdToken = mockVerifyIdToken;
  },
}));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
vi.mock("@/lib/client-directory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-directory")>();
  return { ...actual, lockDirectory: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59 }),
}));

const { GET, POST } = await import("./route");
const { prisma } = await import("@/lib/prisma");
const { rateLimit } = await import("@/lib/rate-limit-redis");
const { logger } = await import("@/lib/logger");

const ALLOWED = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const DEV = "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com";
const PATH = "/api/machine/acats/by-record/REC-326/fees";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "REC-326",
    clientName: "Synthetic Fee Client",
    apexAccountId: "APX-FEE-SECRET-326",
    status: "AcatReceived",
    feeApexTicket: "FEE-326",
    feeCreditRequestId: "CR-326",
    feeAmount: "$10.00",
    feeCharged: "Yes",
    feeMemo: "memo",
    feeRequestSubmitted: "2026-01-02",
    feeRequestCompleted: null,
    assets: [],
    clientLinks: [],
    identityVersion: 0,
    deletedAt: null,
    direction: "In",
    type: "Partial",
    transferWorkflow: "ACAT",
    accountType: "Individual",
    acatDate: "2026-01-01",
    custodian: {
      id: "custodian-326",
      fees: [
        { id: "fee-out", feeType: "Transfer Out", amount: 75, amountText: null },
        { id: "fee-close", feeType: "Account Closing", amount: 50, amountText: null },
      ],
    },
    ...overrides,
  };
}

let current: ReturnType<typeof row>;

function wireRow() {
  vi.mocked(prisma.acatRecord.findUnique).mockImplementation((async () => current) as never);
  vi.mocked(prisma.acatRecord.update).mockImplementation((async (args: { data: Record<string, unknown> }) => {
    current = { ...current, ...args.data };
    return current;
  }) as never);
}

function token(email = ALLOWED) {
  mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ email, email_verified: true }) });
}

async function call(method: "GET" | "POST", body?: unknown, email = ALLOWED) {
  token(email);
  const request = new Request(`https://tracker.test${PATH}`, {
    method,
    headers: { authorization: "Bearer synthetic", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await (method === "GET" ? GET : POST)(request, { params: Promise.resolve({ id: "REC-326" }) });
  return { status: response.status, json: await response.json() };
}

function mockFetch(options: {
  list?: unknown;
  create?: unknown;
  createStatus?: number;
  deleteStatus?: number;
  createThrows?: boolean;
  failList?: boolean;
} = {}) {
  const list = options.list ?? [];
  global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST") {
      if (options.createThrows) return { ok: true, status: 200, json: async () => { throw new Error("bad json"); } };
      const status = options.createStatus ?? 201;
      return { ok: status < 300, status, json: async () => options.create ?? { id: "9", status: "Pending", fee_amount: 10 } };
    }
    if (method === "DELETE") {
      const status = options.deleteStatus ?? 200;
      return { ok: status < 300, status, json: async () => ({}) };
    }
    if (options.failList) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => list };
  }) as unknown as typeof fetch;
}

function posts() {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[1]?.method === "POST");
}
function deletes() {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[1]?.method === "DELETE");
}

beforeEach(() => {
  vi.clearAllMocks();
  current = row();
  wireRow();
  mockFetch();
  vi.stubEnv("EPIC_ACAT_FEE_REIMBURSEMENT", "1");
  vi.stubEnv("ROLLOUT_ACAT_FEE_REIMBURSEMENT", "1");
  vi.stubEnv("FEE_STORE_API_KEY", "test-key");
  vi.stubEnv("FEE_STORE_DB_URL", "https://fee-store.test/db");
  vi.stubEnv("FEE_STORE_FEES_TABLE_ID", "fees");
  vi.stubEnv("MACHINE_AUTH_ALLOWED_SAS", ALLOWED);
  vi.mocked(rateLimit).mockResolvedValue({ allowed: true, remaining: 59 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("machine-acat-fees", () => {
  it("returns 404 while either fee switch is off and touches nothing", async () => {
    markCase("machine-acat-fees", "returns 404 while either fee switch is off and touches nothing");
    for (const [epic, rollout] of [["0", "0"], ["1", "0"], ["0", "1"]] as const) {
      vi.clearAllMocks();
      vi.stubEnv("EPIC_ACAT_FEE_REIMBURSEMENT", epic);
      vi.stubEnv("ROLLOUT_ACAT_FEE_REIMBURSEMENT", rollout);
      const result = await call("GET");
      expect(result.status).toBe(404);
      expect(result.json).toEqual({ error: "not_found" });
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
      expect(vi.mocked(prisma.acatRecord.findUnique)).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    }
  });

  it("rejects a caller that is not on the route allow-list", async () => {
    markCase("machine-acat-fees", "rejects a caller that is not on the route allow-list");
    const result = await call("GET", undefined, "other@example.com");
    expect(result.status).toBe(401);
    expect(result.json).toEqual({ error: "unauthorized" });
  });

  it("read returns the seven fee fields and masked log rows", async () => {
    markCase("machine-acat-fees", "read returns the seven fee fields and masked log rows");
    mockFetch({
      list: ["Pending", "Approved", "Credited", "Denied", "Other"].map((status, index) => ({
        id: String(index + 1),
        status,
        fee_amount: 10,
        fee_type: "ACAT Transfer Fee",
        client_name: "Synthetic Fee Client",
        account_numbers: "APX-FEE-SECRET-326",
      })),
    });
    const result = await call("GET");
    expect(result.status).toBe(200);
    expect(result.json.fee.feeApexTicket).toBe("FEE-326");
    expect(result.json.fee.feeCreditRequestId).toBe("CR-326");
    expect(result.json.log.map((entry: { status: string }) => entry.status)).toEqual(["Pending", "Approved", "Credited", "Denied", "Pending"]);
    const listUrl = String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    const filter = JSON.parse(decodeURIComponent(listUrl.split("filter=")[1] ?? "").replace(/\+/g, " "));
    expect(filter.client_name).toBe("Synthetic Fee Client");
    expect(filter.account_numbers).toBe("APX-FEE-SECRET-326");
    const text = JSON.stringify(result.json);
    expect(text).not.toContain("APX-FEE-SECRET-326");
    expect(text).not.toContain("account_numbers");
  });

  it("read accepts the dev identity only when the allow-list includes it", async () => {
    markCase("machine-acat-fees", "read accepts the dev identity only when the allow-list includes it");
    vi.stubEnv("MACHINE_AUTH_ALLOWED_SAS", `${ALLOWED},${DEV}`);
    const result = await call("GET", undefined, DEV);
    expect(result.status).toBe(200);
  });

  it("read returns log_unavailable with the stored fee when the store fails", async () => {
    markCase("machine-acat-fees", "read returns log_unavailable with the stored fee when the store fails");
    mockFetch({ failList: true });
    const result = await call("GET");
    expect(result.status).toBe(502);
    expect(result.json.error).toBe("log_unavailable");
    expect(result.json.fee.feeCreditRequestId).toBe("CR-326");
    expect(result.json.log).toBeNull();
  });

  it("read answers 200 with the stored fee and no log, and logs no error, when the store is unconfigured", async () => {
    markCase("machine-acat-fees", "read answers 200 with the stored fee and no log, and logs no error, when the store is unconfigured");
    vi.stubEnv("FEE_STORE_API_KEY", "");
    const result = await call("GET");
    expect(result.status).toBe(200);
    expect(result.json.error).toBeUndefined();
    expect(result.json.log).toBeNull();
    expect(result.json.fee.feeApexTicket).toBe("FEE-326");
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result.json)).not.toContain("APX-FEE-SECRET-326");
  });

  it("read still fails closed and logs an error when a configured store answers 5xx", async () => {
    markCase("machine-acat-fees", "read still fails closed and logs an error when a configured store answers 5xx");
    mockFetch({ failList: true });
    const result = await call("GET");
    expect(result.status).toBe(502);
    expect(result.json.error).toBe("log_unavailable");
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith({ status: 503, reason: "upstream" }, "fee credit list failed");
  });

  it("read still fails closed and logs an error when a configured store is unreachable", async () => {
    markCase("machine-acat-fees", "read still fails closed and logs an error when a configured store is unreachable");
    global.fetch = vi.fn(async () => {
      throw new Error("connect refused");
    }) as unknown as typeof fetch;
    const result = await call("GET");
    expect(result.status).toBe(502);
    expect(result.json.error).toBe("log_unavailable");
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith({ reason: "network" }, "fee credit list failed");
  });

  it("read does not turn an unexpected record failure into a success", async () => {
    markCase("machine-acat-fees", "read does not turn an unexpected record failure into a success");
    vi.stubEnv("FEE_STORE_API_KEY", "");
    vi.mocked(prisma.acatRecord.findUnique).mockRejectedValue(new Error("db down"));
    token();
    const request = new Request(`https://tracker.test${PATH}`, { method: "GET", headers: { authorization: "Bearer synthetic" } });
    await expect(GET(request, { params: Promise.resolve({ id: "REC-326" }) })).rejects.toThrow("db down");
  });

  it("read returns not_found for a missing record", async () => {
    markCase("machine-acat-fees", "read returns not_found for a missing record");
    current = null as unknown as ReturnType<typeof row>;
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(null);
    const result = await call("GET");
    expect(result.status).toBe(404);
    expect(result.json).toEqual({ error: "not_found" });
  });

  it("save returns the stored fee value", async () => {
    markCase("machine-acat-fees", "save returns the stored fee value");
    const result = await call("POST", { action: "save", fields: { feeAmount: "$20.00" } });
    expect(result.status).toBe(200);
    expect(result.json.fee.feeAmount).toBe("$20.00");
    expect(current.status).toBe("AcatReceived");
    const data = vi.mocked(prisma.acatRecord.update).mock.calls.at(-1)?.[0].data as Record<string, unknown>;
    expect(data.feeAmount).toBe("$20.00");
    expect(data.status).toBeUndefined();
  });

  it("a refused save returns the unchanged fee and log", async () => {
    markCase("machine-acat-fees", "a refused save returns the unchanged fee and log");
    mockFetch({ list: [{ id: "1", status: "Pending", fee_amount: 10 }] });
    const result = await call("POST", { action: "save", fields: { feeAmount: "nope" } });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("refused");
    expect(result.json.fee.feeAmount).toBe("$10.00");
    expect(result.json.log).toHaveLength(1);
    expect(vi.mocked(prisma.acatRecord.update)).not.toHaveBeenCalled();
  });

  it("save refuses a non-fee field and writes nothing", async () => {
    markCase("machine-acat-fees", "save refuses a non-fee field and writes nothing");
    const result = await call("POST", { action: "save", fields: { status: "Completed" } });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("refused");
    expect(vi.mocked(prisma.acatRecord.update)).not.toHaveBeenCalled();
  });

  it("a thrown transfer save returns the pre-write fee", async () => {
    markCase("machine-acat-fees", "a thrown transfer save returns the pre-write fee");
    vi.mocked(prisma.acatRecord.update).mockRejectedValue(new Error("write failed"));
    const result = await call("POST", { action: "save", fields: { feeAmount: "$20.00" } });
    expect(result.status).toBe(500);
    expect(result.json.error).toBe("internal_error");
    expect(result.json.fee.feeAmount).toBe("$10.00");
  });

  it("apply returns the stored amount and memo and leaves fee rules unchanged", async () => {
    markCase("machine-acat-fees", "apply returns the stored amount and memo and leaves fee rules unchanged");
    const result = await call("POST", { action: "apply", feeRuleIds: ["fee-out", "fee-close"] });
    expect(result.status).toBe(200);
    expect(result.json.fee.feeAmount).toBe("$125.00");
    expect(result.json.fee.feeMemo).toBe("Transfer Out: $75.00 + Account Closing: $50.00");
    expect(result.json.fee.feeCharged).toBe("Yes");
    expect(vi.mocked(prisma.custodianFee.create)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.custodianFee.update)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.custodianFee.delete)).not.toHaveBeenCalled();
  });

  it("apply with an unknown rule id refuses and writes nothing", async () => {
    markCase("machine-acat-fees", "apply with an unknown rule id refuses and writes nothing");
    const result = await call("POST", { action: "apply", feeRuleIds: ["fee-missing"] });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("refused");
    expect(vi.mocked(prisma.acatRecord.update)).not.toHaveBeenCalled();
  });

  it("apply with no custodian rules refuses with no_rules", async () => {
    markCase("machine-acat-fees", "apply with no custodian rules refuses with no_rules");
    current = row({ custodian: null });
    wireRow();
    const result = await call("POST", { action: "apply", feeRuleIds: ["fee-out"] });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("no_rules");
    expect(vi.mocked(prisma.acatRecord.update)).not.toHaveBeenCalled();
  });

  it("log returns the Pending row and stores the credit request id", async () => {
    markCase("machine-acat-fees", "log returns the Pending row and stores the credit request id");
    mockFetch({
      create: { id: "9", status: "Pending", fee_amount: 10 },
      list: [{ id: "9", status: "Pending", fee_amount: 10, fee_type: "ACAT Transfer Fee" }],
    });
    const result = await call("POST", { action: "log" });
    expect(result.status).toBe(201);
    expect(result.json.fee.feeCreditRequestId).toBe("9");
    expect(result.json.log).toContainEqual(expect.objectContaining({ id: "9", status: "Pending" }));
    expect((vi.mocked(prisma.acatRecord.update).mock.calls.at(-1)?.[0].data as Record<string, unknown>).feeCreditRequestId).toBe("9");
  });

  it("log keeps an existing Pending row", async () => {
    markCase("machine-acat-fees", "log keeps an existing Pending row");
    mockFetch({
      create: { id: "9", status: "Pending", fee_amount: 10 },
      list: [
        { id: "1", status: "Pending", fee_amount: 10 },
        { id: "9", status: "Pending", fee_amount: 10 },
      ],
    });
    const result = await call("POST", { action: "log" });
    expect(result.json.log).toHaveLength(2);
    expect(deletes()).toHaveLength(0);
  });

  it("a blank created id is stored on the transfer", async () => {
    markCase("machine-acat-fees", "a blank created id is stored on the transfer");
    current = row({ feeCreditRequestId: null, feeRequestSubmitted: null });
    wireRow();
    mockFetch({ create: { status: "Pending", fee_amount: 10 } });
    const first = await call("POST", { action: "log" });
    expect(first.status).toBe(201);
    expect(first.json.fee.feeCreditRequestId).toBeNull();
    expect(vi.mocked(prisma.acatRecord.update).mock.calls.some((entry) => "feeRequestSubmitted" in (entry[0].data as Record<string, unknown>))).toBe(true);
    expect(deletes()).toHaveLength(0);

    current = row({ feeCreditRequestId: "CR-326" });
    wireRow();
    const second = await call("POST", { action: "log" });
    expect(second.json.fee.feeCreditRequestId).toBe("");
    expect((vi.mocked(prisma.acatRecord.update).mock.calls.at(-1)?.[0].data as Record<string, unknown>).feeCreditRequestId).toBe("");
  });

  it("a failed credit request id store deletes the new row and returns the fee and log unchanged", async () => {
    markCase("machine-acat-fees", "a failed credit request id store deletes the new row and returns the fee and log unchanged");
    mockFetch({ create: { id: "9" }, list: [{ id: "1", status: "Pending", fee_amount: 10 }] });
    vi.mocked(prisma.acatRecord.update).mockRejectedValue(new Error("link failed"));
    const result = await call("POST", { action: "log" });
    expect(result.status).toBe(502);
    expect(result.json.error).toBe("credit_request_id_not_stored");
    expect(result.json.fee.feeCreditRequestId).toBe("CR-326");
    expect(JSON.stringify(result.json.log)).not.toContain('"9"');
    expect(String(deletes()[0][0])).toContain("/rows/9");
  });

  it("a failed store with a failed delete reports the retained row", async () => {
    markCase("machine-acat-fees", "a failed store with a failed delete reports the retained row");
    mockFetch({
      create: { id: "9" },
      deleteStatus: 500,
      list: [{ id: "9", status: "Pending", fee_amount: 10 }],
    });
    vi.mocked(prisma.acatRecord.update).mockRejectedValue(new Error("link failed"));
    const result = await call("POST", { action: "log" });
    expect(result.status).toBe(502);
    expect(result.json.error).toBe("log_row_retained");
    expect(JSON.stringify(result.json.log)).toContain('"9"');
  });

  it("a fee amount that is not above zero creates no row", async () => {
    markCase("machine-acat-fees", "a fee amount that is not above zero creates no row");
    current = row({ feeAmount: "$0.00" });
    wireRow();
    const result = await call("POST", { action: "log" });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("refused");
    expect(posts()).toHaveLength(0);
  });

  it("a failed log create adds no row and returns the fee and log unchanged", async () => {
    markCase("machine-acat-fees", "a failed log create adds no row and returns the fee and log unchanged");
    mockFetch({ createStatus: 500, list: [{ id: "1", status: "Pending", fee_amount: 10 }] });
    const result = await call("POST", { action: "log" });
    expect(result.status).toBe(502);
    expect(result.json.error).toBe("log_failed");
    expect(result.json.fee.feeCreditRequestId).toBe("CR-326");
    expect(deletes()).toHaveLength(0);
  });

  it("an invalid fee action returns the unchanged fee and writes nothing", async () => {
    markCase("machine-acat-fees", "an invalid fee action returns the unchanged fee and writes nothing");
    const result = await call("POST", { action: "nope" });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("refused");
    expect(result.json.fee.feeAmount).toBe("$10.00");
    expect(vi.mocked(prisma.acatRecord.update)).not.toHaveBeenCalled();
  });

  it("a log with an account the fee schema rejects creates no row", async () => {
    markCase("machine-acat-fees", "a log with an account the fee schema rejects creates no row");
    current = row({ apexAccountId: "" });
    wireRow();
    const result = await call("POST", { action: "log" });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("refused");
    expect(posts()).toHaveLength(0);
  });

  it("a log returns log_not_configured and does not create a row when the store is unset", async () => {
    markCase("machine-acat-fees", "a log returns log_not_configured and does not create a row when the store is unset");
    vi.stubEnv("FEE_STORE_API_KEY", "");
    const result = await call("POST", { action: "log" });
    expect(result.status).toBe(503);
    expect(result.json.error).toBe("log_not_configured");
    expect(posts()).toHaveLength(0);
  });

  it("a blank created id whose link fails does not delete", async () => {
    markCase("machine-acat-fees", "a blank created id whose link fails does not delete");
    current = row({ feeCreditRequestId: null });
    wireRow();
    mockFetch({ create: { status: "Pending" } });
    vi.mocked(prisma.acatRecord.update).mockRejectedValue(new Error("link failed"));
    const result = await call("POST", { action: "log" });
    expect(result.status).toBe(502);
    expect(result.json.error).toBe("log_row_retained");
    expect(deletes()).toHaveLength(0);
  });

  it("a stored credit request id is not deleted when the link throws", async () => {
    markCase("machine-acat-fees", "a stored credit request id is not deleted when the link throws");
    mockFetch({ create: { id: "9" }, list: [{ id: "9", status: "Pending", fee_amount: 10 }] });
    vi.mocked(prisma.acatRecord.update).mockImplementation((async () => {
      current = { ...current, feeCreditRequestId: "9" };
      throw new Error("after commit");
    }) as never);
    const result = await call("POST", { action: "log" });
    expect(result.status).toBe(201);
    expect(result.json.fee.feeCreditRequestId).toBe("9");
    expect(deletes()).toHaveLength(0);
  });

  it("a thrown credit request id read-back does not delete", async () => {
    markCase("machine-acat-fees", "a thrown credit request id read-back does not delete");
    mockFetch({ create: { id: "9" } });
    let failRead = false;
    vi.mocked(prisma.acatRecord.findUnique).mockImplementation((async () => {
      if (failRead) throw new Error("db down");
      return current;
    }) as never);
    vi.mocked(prisma.acatRecord.update).mockImplementation((async () => {
      failRead = true;
      throw new Error("link failed");
    }) as never);
    const result = await call("POST", { action: "log" });
    expect(result.status).toBe(500);
    expect(result.json.error).toBe("internal_error");
    expect(result.json.fee.feeCreditRequestId).toBe("CR-326");
    expect(result.json.log).toBeNull();
    expect(deletes()).toHaveLength(0);
  });

  it("an unreadable created row is retained", async () => {
    markCase("machine-acat-fees", "an unreadable created row is retained");
    mockFetch({ createThrows: true });
    const result = await call("POST", { action: "log" });
    expect(result.status).toBe(502);
    expect(result.json.error).toBe("log_row_retained");
    expect(result.json.fee.feeCreditRequestId).toBe("CR-326");
    expect(result.json.log).toBeNull();
    expect(deletes()).toHaveLength(0);
  });

  it("returns rate_limited without touching the transfer", async () => {
    markCase("machine-acat-fees", "returns rate_limited without touching the transfer");
    vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const result = await call("POST", { action: "log" });
    expect(result.status).toBe(429);
    expect(result.json).toEqual({ error: "rate_limited" });
    expect(vi.mocked(prisma.acatRecord.findUnique)).not.toHaveBeenCalled();
  });
});
