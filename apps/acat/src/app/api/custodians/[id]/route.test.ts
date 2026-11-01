import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { GET, PATCH, DELETE } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const adminSession = {
  user: { email: "admin@example.com", role: "ADMIN" },
};
const userSession = {
  user: { email: "user@example.com", role: "USER" },
};

function makeRequest(url: string, init?: RequestInit) {
  return new Request(url, init) as Parameters<typeof GET>[0];
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

const mockCustodian = {
  id: "CUST-001",
  name: "E*TRADE",
  acatFeeAmount: 0,
  requiresManualReview: false,
  avgProcessingDays: 7,
  contactEmail: null,
  contactMethod: null,
  contactDetails: null,
  fees: [
    {
      id: "F1",
      custodianId: "CUST-001",
      feeType: "Full Transfer",
      accountType: "ANY",
      transferType: "FULL",
      amount: 75,
      amountText: null,
      notes: null,
      documentation: null,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
  vi.mocked(prisma.custodianFeeScheduleDocument.count).mockResolvedValue(0);
});

describe("GET /api/custodians/[id]", () => {
  it("returns a custodian with its fees", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodian);
    const res = await GET(
      makeRequest("http://localhost/api/custodians/CUST-001"),
      makeParams("CUST-001")
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.name).toBe("E*TRADE");
    expect(data.fees).toHaveLength(1);
    expect(data).not.toHaveProperty("requiresManualReview");
  });

  it("returns 404 when the custodian does not exist", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(
      makeRequest("http://localhost/api/custodians/missing"),
      makeParams("missing")
    );
    expect(res.status).toBe(404);
  });

  it("returns structured contact details", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockCustodian,
      contactMethod: "PORTAL",
      contactDetails: "https://custodian.example/transfers",
    });
    const res = await GET(
      makeRequest("http://localhost/api/custodians/CUST-001"),
      makeParams("CUST-001")
    );
    expect(await res.json()).toMatchObject({
      contactMethod: "PORTAL",
      contactDetails: "https://custodian.example/transfers",
    });
  });
});

describe("PATCH /api/custodians/[id]", () => {
  it("updates a custodian and returns the updated record", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodian);
    (prisma.custodian.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockCustodian,
      contactEmail: "ops@etrade.example",
      avgProcessingDays: 5,
    });

    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001", {
        method: "PATCH",
        body: JSON.stringify({ contactEmail: "ops@etrade.example", avgProcessingDays: 5 }),
      }),
      makeParams("CUST-001")
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.contactEmail).toBe("ops@etrade.example");
    expect(data.avgProcessingDays).toBe(5);
    expect(data).not.toHaveProperty("requiresManualReview");
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001", {
        method: "PATCH",
        body: JSON.stringify({ contactEmail: "ops@etrade.example" }),
      }),
      makeParams("CUST-001")
    );
    expect(res.status).toBe(403);
    expect(prisma.custodian.update).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown id", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/missing", {
        method: "PATCH",
        body: JSON.stringify({ contactEmail: "x@y.com" }),
      }),
      makeParams("missing")
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 on invalid email", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodian);
    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001", {
        method: "PATCH",
        body: JSON.stringify({ contactEmail: "not-an-email" }),
      }),
      makeParams("CUST-001")
    );
    expect(res.status).toBe(400);
    expect(prisma.custodian.update).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed JSON body", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodian);
    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001", {
        method: "PATCH",
        body: "not-json",
      }),
      makeParams("CUST-001")
    );
    expect(res.status).toBe(400);
  });

  // ticket: "Mark reviewed" flips a NEEDS_SETUP card to VERIFIED.
  it("marks a NEEDS_SETUP custodian VERIFIED via reviewStatus", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockCustodian,
      reviewStatus: "NEEDS_SETUP",
    });
    (prisma.custodian.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockCustodian,
      reviewStatus: "VERIFIED",
    });

    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001", {
        method: "PATCH",
        body: JSON.stringify({ reviewStatus: "VERIFIED" }),
      }),
      makeParams("CUST-001")
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.reviewStatus).toBe("VERIFIED");
    expect(prisma.custodian.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reviewStatus: "VERIFIED" }),
      })
    );
  });

  it("rejects an invalid reviewStatus value", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodian);
    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001", {
        method: "PATCH",
        body: JSON.stringify({ reviewStatus: "BOGUS" }),
      }),
      makeParams("CUST-001")
    );
    expect(res.status).toBe(400);
    expect(prisma.custodian.update).not.toHaveBeenCalled();
  });

  // ticket: the contra transfer-playbook fields round-trip through PATCH → GET.
  it("persists and returns the new contra-playbook fields", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodian);
    const playbook = {
      dtcNumber: "0164",
      receivingAccountNumber: "DEMOOMNI01",
      transferType: "ACAT_API",
      documentationStatus: "DOCUMENTED",
      signature: "DocuSign OK",
      letterOfAcceptance: "Not required",
      medallionRequired: "Not required",
      liquidationMethod: null,
      returnMethod: "N/A for a standard ACAT",
      watchouts: "• Submit as a full ACAT",
      paperworkOnFile: true,
      transfersToDate: 21,
      recentClients: "Browning, Dodd, Lindell",
    };
    (prisma.custodian.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockCustodian,
      ...playbook,
    });

    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001", {
        method: "PATCH",
        body: JSON.stringify(playbook),
      }),
      makeParams("CUST-001")
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.dtcNumber).toBe("0164");
    expect(data.receivingAccountNumber).toBe("DEMOOMNI01");
    expect(data.transferType).toBe("ACAT_API");
    expect(data.transfersToDate).toBe(21);
    expect(data.recentClients).toBe("Browning, Dodd, Lindell");
    // The whole validated payload flows into the Prisma write.
    expect(prisma.custodian.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(playbook) })
    );
  });

  it("rejects an out-of-enum transferType", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodian);
    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001", {
        method: "PATCH",
        body: JSON.stringify({ transferType: "NOT_A_TYPE" }),
      }),
      makeParams("CUST-001")
    );
    expect(res.status).toBe(400);
    expect(prisma.custodian.update).not.toHaveBeenCalled();
  });

  describe("structured contacts", () => {
    const patchContact = (body: unknown) => PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
      makeParams("CUST-001")
    );

    beforeEach(() => {
      (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockCustodian,
        contactEmail: "legacy@custodian.example",
      });
      (prisma.custodian.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => Promise.resolve({
          ...mockCustodian,
          contactEmail: "legacy@custodian.example",
          ...data,
        })
      );
    });

    it.each([
      ["PHONE", "+1 800 555 0100, option 2"],
      ["PORTAL", "https://custodian.example/transfers"],
      ["OTHER", "Mail to the transfers team"],
    ])("persists %s details and preserves the legacy email", async (method, details) => {
      const res = await patchContact({ contactMethod: method, contactDetails: details });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        contactMethod: method,
        contactDetails: details,
        contactEmail: "legacy@custodian.example",
      });
      expect(prisma.custodian.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { contactMethod: method, contactDetails: details },
      }));
    });

    it("synchronizes Email details to contactEmail", async () => {
      const res = await patchContact({ contactMethod: "EMAIL", contactDetails: "new@custodian.example" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        contactMethod: "EMAIL",
        contactDetails: "new@custodian.example",
        contactEmail: "new@custodian.example",
      });
      expect(prisma.custodian.update).toHaveBeenCalledWith(expect.objectContaining({
        data: {
          contactMethod: "EMAIL",
          contactDetails: "new@custodian.example",
          contactEmail: "new@custodian.example",
        },
      }));
    });

    it.each(["EMAIL", null])("clears the legacy email when clearing %s contact", async (method) => {
      const res = await patchContact({ contactMethod: method, contactDetails: null });
      expect(res.status).toBe(200);
      expect(prisma.custodian.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { contactMethod: method, contactDetails: null, contactEmail: null },
      }));
    });

    it.each(["updated@custodian.example", null])("keeps structured Email in sync for legacy email-only updates (%s)", async (email) => {
      (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockCustodian,
        contactMethod: "EMAIL",
        contactDetails: "old@custodian.example",
        contactEmail: "old@custodian.example",
      });
      const res = await patchContact({ contactEmail: email });
      expect(res.status).toBe(200);
      expect(prisma.custodian.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { contactEmail: email, contactDetails: email },
      }));
    });

    it("retains legacy email-only writes when no structured contact is set", async () => {
      const res = await patchContact({ contactEmail: "new@custodian.example" });
      expect(res.status).toBe(200);
      expect(prisma.custodian.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { contactEmail: "new@custodian.example" },
      }));
    });

    it.each([
      { contactMethod: "EMAIL" },
      { contactDetails: "ops@custodian.example" },
      { contactMethod: null, contactDetails: "Call us" },
      { contactMethod: "FAX", contactDetails: "123" },
      { contactMethod: "EMAIL", contactDetails: "not-an-email" },
      { contactMethod: "PHONE", contactDetails: "1".repeat(2001) },
      { contactMethod: "EMAIL", contactDetails: "ops@custodian.example", contactEmail: "different@custodian.example" },
      { contactMethod: null, contactDetails: null, contactEmail: "ops@custodian.example" },
    ])("rejects invalid or conflicting contact payload %#", async (body) => {
      const res = await patchContact(body);
      expect(res.status).toBe(400);
      expect(prisma.custodian.update).not.toHaveBeenCalled();
    });

    it("rejects structured contact changes from a non-admin", async () => {
      mockAuth.mockResolvedValue(userSession);
      const res = await patchContact({ contactMethod: "PHONE", contactDetails: "800 555 0100" });
      expect(res.status).toBe(403);
      expect(prisma.custodian.findUnique).not.toHaveBeenCalled();
      expect(prisma.custodian.update).not.toHaveBeenCalled();
    });
  });
});

describe("DELETE /api/custodians/[id]", () => {
  it("preserves an attached schedule even when there are no linked transfers", async () => {
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue(mockCustodian as never);
    vi.mocked(prisma.acatRecord.count).mockResolvedValue(0);
    vi.mocked(prisma.custodianFeeScheduleDocument.count).mockResolvedValue(1);

    const res = await DELETE(makeRequest("http://localhost/api/custodians/CUST-001", { method: "DELETE" }), makeParams("CUST-001"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ linkedRecordCount: 0, feeScheduleDocumentCount: 1 });
    expect(prisma.custodian.delete).not.toHaveBeenCalled();
  });

  it("reports a conflict when a concurrent attachment prevents deletion", async () => {
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue(mockCustodian as never);
    vi.mocked(prisma.acatRecord.count).mockResolvedValue(0);
    vi.mocked(prisma.custodian.delete).mockRejectedValueOnce({ code: "P2003" });
    const res = await DELETE(makeRequest("http://localhost/api/custodians/CUST-001", { method: "DELETE" }), makeParams("CUST-001"));
    expect(res.status).toBe(409);
  });

  it("deletes a custodian with zero linked records", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodian);
    (prisma.acatRecord.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.custodian.delete as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodian);

    const res = await DELETE(
      makeRequest("http://localhost/api/custodians/CUST-001", { method: "DELETE" }),
      makeParams("CUST-001")
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(prisma.custodian.delete).toHaveBeenCalledWith({ where: { id: "CUST-001" } });
  });

  it("returns 409 with linkedRecordCount when records are still linked", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodian);
    (prisma.acatRecord.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);

    const res = await DELETE(
      makeRequest("http://localhost/api/custodians/CUST-001", { method: "DELETE" }),
      makeParams("CUST-001")
    );
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.linkedRecordCount).toBe(3);
    expect(prisma.custodian.delete).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown custodian", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await DELETE(
      makeRequest("http://localhost/api/custodians/missing", { method: "DELETE" }),
      makeParams("missing")
    );
    expect(res.status).toBe(404);
    expect(prisma.custodian.delete).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await DELETE(
      makeRequest("http://localhost/api/custodians/CUST-001", { method: "DELETE" }),
      makeParams("CUST-001")
    );
    expect(res.status).toBe(403);
    expect(prisma.custodian.delete).not.toHaveBeenCalled();
  });
});
