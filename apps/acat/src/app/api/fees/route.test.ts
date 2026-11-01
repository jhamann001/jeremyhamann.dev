import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

function makeRequest(
  url: string,
  init?: ConstructorParameters<typeof NextRequest>[1]
): NextRequest {
  return new NextRequest(url, init);
}

describe("GET /api/fees", () => {
  it("returns 200 with an empty log when the retired Fee Store store is not configured", async () => {
    // Observed in production on transfer-tracker-00185: GET /api/fees?clientName=..&accountNumber=.. answered 503
    // "Fee Store DB not configured", which Cloud Run records at ERROR severity on every drawer open.
    const originalFetch = global.fetch;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    try {
      const res = await GET(
        makeRequest("http://localhost/api/fees?clientName=Test+Client&accountNumber=APX-0000001")
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("POST /api/fees", () => {
  it("returns 503 when env vars are not configured", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/fees", {
        method: "POST",
        body: JSON.stringify({
          clientName: "Test",
          feeAmount: 50,
          accountNumber: "APX-0000001",
        }),
      })
    );
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toContain("Fee Store DB not configured");
  });
});

describe("fees route with Fee Store configured", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("FEE_STORE_API_KEY", "test-api-key");
    vi.stubEnv("FEE_STORE_DB_URL", "https://fee-store.example/api/v1/db/fee_store_db");
    vi.stubEnv("FEE_STORE_FEES_TABLE_ID", "fees_table_123");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = originalFetch;
  });

  async function importFresh() {
    vi.resetModules();
    return await import("./route");
  }

  describe("GET /api/fees (configured)", () => {
    it("returns fee records from FeeStore", async () => {
      const mockRecords = [
        { id: 1, client_name: "Sarah Jenkins", fee_amount: 50, status: "Pending" },
      ];
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockRecords),
      });

      const { GET: ConfiguredGET } = await importFresh();
      const res = await ConfiguredGET(
        makeRequest("http://localhost/api/fees?clientName=Sarah+Jenkins")
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual(mockRecords);

      expect(global.fetch).toHaveBeenCalledOnce();
      const fetchUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(fetchUrl).toContain("fees_table_123/rows");
    });

    it("forwards Fee Store error status", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: () => Promise.resolve("Validation error"),
      });

      const { GET: ConfiguredGET } = await importFresh();
      const res = await ConfiguredGET(
        makeRequest("http://localhost/api/fees?clientName=Test")
      );
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toContain("Failed to fetch fee records");
    });

    it("returns 500 on network error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

      const { GET: ConfiguredGET } = await importFresh();
      const res = await ConfiguredGET(
        makeRequest("http://localhost/api/fees")
      );
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("Failed to connect to Fee Store DB");
    });
  });

  describe("POST /api/fees (configured)", () => {
    it("creates a fee record and returns 201", async () => {
      const createdRecord = { id: 42, client_name: "Test", fee_amount: 50, status: "Pending" };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(createdRecord),
      });

      const { POST: ConfiguredPOST } = await importFresh();
      const res = await ConfiguredPOST(
        makeRequest("http://localhost/api/fees", {
          method: "POST",
          body: JSON.stringify({
            clientName: "Test",
            feeAmount: 50,
            accountNumber: "APX-0000001",
          }),
        })
      );
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data).toEqual(createdRecord);

      const fetchBody = JSON.parse(
        (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
      );
      expect(fetchBody.client_name).toBe("Test");
      expect(fetchBody.fee_amount).toBe(50);
      expect(fetchBody.status).toBe("Pending");
    });

    it("forwards Fee Store POST error status", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad request"),
      });

      const { POST: ConfiguredPOST } = await importFresh();
      const res = await ConfiguredPOST(
        makeRequest("http://localhost/api/fees", {
          method: "POST",
          body: JSON.stringify({
            clientName: "Test",
            feeAmount: 50,
            accountNumber: "APX-0000001",
          }),
        })
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Failed to create fee record");
    });

    it("returns 500 on network error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

      const { POST: ConfiguredPOST } = await importFresh();
      const res = await ConfiguredPOST(
        makeRequest("http://localhost/api/fees", {
          method: "POST",
          body: JSON.stringify({ clientName: "Test", feeAmount: 50, accountNumber: "APX-1" }),
        })
      );
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("Failed to connect to Fee Store DB");
    });
  });
});

describe("POST /api/fees in the public demo", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.stubEnv("PERSONA_SIGN_IN", "on");
    vi.stubEnv("FEE_STORE_API_KEY", "demo-fee-key");
    vi.stubEnv("FEE_STORE_DB_URL", "http://127.0.0.1:8091/fee-store");
    vi.stubEnv("FEE_STORE_FEES_TABLE_ID", "fees");
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("explains the cap when the fee store refuses a reimbursement for it", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "full" }), { status: 429 }));
    const res = await POST(
      makeRequest("http://localhost/api/fees", {
        method: "POST",
        body: JSON.stringify({ clientName: "Maeve Brennan", feeAmount: 95, accountNumber: "DEMO-191188" }),
      })
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe(
      "The demo holds up to 300 fee reimbursements until its nightly reset at 07:00 UTC. Please try again tomorrow."
    );
  });
});
