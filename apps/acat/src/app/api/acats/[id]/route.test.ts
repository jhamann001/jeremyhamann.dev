import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const mockRecord = {
  id: "REC-001",
  clientName: "Sarah Jenkins",
  status: "PendingReview",
  notes: "Old note",
  deletedAt: null,
  assets: [],
  clientLinks: [],
};

function makeRequest(url: string, init?: RequestInit) {
  return new Request(url, init) as Parameters<typeof GET>[0];
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
});

describe("GET /api/acats/[id]", () => {
  it("returns a record by id", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockRecord);
    const res = await GET(
      makeRequest("http://localhost/api/acats/REC-001"),
      makeParams("REC-001")
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.clientName).toBe("Sarah Jenkins");
  });

  it("returns 404 for unknown id", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(
      makeRequest("http://localhost/api/acats/REC-999"),
      makeParams("REC-999")
    );
    expect(res.status).toBe(404);
  });

  // Phase 3.3: single-record reads must produce an AuditLog row so
  // we have a forensic trail of "who looked at this client's record".
  it("writes an AuditLog entry with action=read on successful GET", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockRecord);
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const res = await GET(
      makeRequest("http://localhost/api/acats/REC-001"),
      makeParams("REC-001")
    );
    expect(res.status).toBe(200);
    // Audit write is fire-and-forget; settle microtasks before asserting.
    await new Promise((r) => setTimeout(r, 0));
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        acatRecordId: "REC-001",
        action: "read",
        performedBy: "admin@example.com",
      },
    });
  });

  it("does NOT write an AuditLog when the record is not found (no fake-data noise)", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(
      makeRequest("http://localhost/api/acats/REC-404"),
      makeParams("REC-404")
    );
    expect(res.status).toBe(404);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("still returns 200 if the audit log write fails", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockRecord);
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB busy")
    );
    const res = await GET(
      makeRequest("http://localhost/api/acats/REC-001"),
      makeParams("REC-001")
    );
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/acats/[id]", () => {
  const recordWithAssets = {
    ...mockRecord,
    assets: [{ id: "ASSET-1", acatRecordId: "REC-001", symbol: "AAPL" }],
  };

  it("clears a saved mapping link when the transfer identity changes", async () => {
    const existing = { ...recordWithAssets, statementAccountNumber: "OLD123", mappingAccountId: "aab63872-c77f-4791-8000-dd876b012345" };
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.acatRecord.update).mockResolvedValue(existing as never);
    vi.mocked(prisma.$transaction).mockImplementation(((args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)) as never);
    const res = await PATCH(makeRequest("http://localhost/api/acats/REC-001", { method: "PATCH", body: JSON.stringify({ statementAccountNumber: "NEW123" }) }), makeParams("REC-001"));
    expect(res.status).toBe(200);
    expect(prisma.acatRecord.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ mappingAccountId: null }) }));
    expect(prisma.auditLog.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ field: "mappingAccountId", oldValue: existing.mappingAccountId, newValue: null })]) }));
  });

  it("updates a record and returns it", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    const updated = { ...recordWithAssets, notes: "New note" };
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
    (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
    );

    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({ notes: "New note" }),
      }),
      makeParams("REC-001")
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.notes).toBe("New note");
  });

  it("normalizes a positive amount when direction changes to Out", async () => {
    const existing = { ...recordWithAssets, direction: "In", statementAmount: 250000 };
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...existing,
      direction: "Out",
      statementAmount: -250000,
    });
    (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args));

    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({ direction: "Out" }),
      }),
      makeParams("REC-001")
    );
    expect(res.status).toBe(200);
    const updateCall = (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.data.statementAmount).toBe(-250000);
  });

  it("applies outgoing operational defaults when an existing full transfer becomes Out", async () => {
    const existing = {
      ...recordWithAssets,
      direction: "In",
      type: "Full",
      feeCharged: "",
      residualMonitoringRequired: false,
      residualFollowUpDate: "",
    };
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...existing, ...data })
    );
    (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 4 });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args));

    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({ direction: "Out" }),
      }),
      makeParams("REC-001")
    );

    expect(res.status).toBe(200);
    const data = (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data).toMatchObject({ feeCharged: "Yes", residualMonitoringRequired: true });
    expect(data.residualFollowUpDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("applies monitoring defaults when an outgoing residual is reclassified as Full", async () => {
    const existing = {
      ...recordWithAssets,
      direction: "Out",
      type: "Residual Credit",
      feeCharged: "",
      residualMonitoringRequired: false,
      residualFollowUpDate: "",
    };
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...existing, ...data })
    );
    (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 4 });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args));

    await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({ type: "Full" }),
      }),
      makeParams("REC-001")
    );

    const data = (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data).toMatchObject({ type: "Full", feeCharged: "Yes", residualMonitoringRequired: true });
    expect(data.residualFollowUpDate).toBeTruthy();
  });

  it.each(["Full", "Partial", null])("persists and audits Residual Credit when an existing %s workflow becomes residual", async (type) => {
    const existing = {
      ...recordWithAssets, type, transferWorkflow: "ACAT", direction: "Out", status: "Completed",
      custodianId: "CUST-001", feeCharged: "", feeAmount: null,
      residualMonitoringRequired: false, residualFollowUpDate: "",
    };
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.acatRecord.update).mockImplementation(
      ({ data }) => Promise.resolve({ ...existing, ...data }) as never
    );
    vi.mocked(prisma.auditLog.createMany).mockResolvedValue({ count: 2 });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args));
    const res = await PATCH(makeRequest("http://localhost/api/acats/REC-001", {
      method: "PATCH", body: JSON.stringify({ transferWorkflow: "RESIDUAL" }),
    }), makeParams("REC-001"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ transferWorkflow: "RESIDUAL", type: "Residual Credit" });
    const data = vi.mocked(prisma.acatRecord.update).mock.calls[0][0].data;
    expect(data).toMatchObject({ transferWorkflow: "RESIDUAL", type: "Residual Credit" });
    expect(data.feeCharged).toBeUndefined();
    expect(data.residualMonitoringRequired).toBeUndefined();
    expect(data.residualFollowUpDate).toBeUndefined();
    expect(prisma.custodian.findUnique).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.auditLog.createMany).mock.calls[0][0]?.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "transferWorkflow", oldValue: "ACAT", newValue: "RESIDUAL" }),
      expect.objectContaining({ field: "type", oldValue: type, newValue: "Residual Credit" }),
    ]));
  });

  it("does not reclassify an existing record during an unrelated edit", async () => {
    const existing = { ...recordWithAssets, type: "Full", transferWorkflow: "ACAT" };
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.acatRecord.update).mockResolvedValue(existing as never);
    vi.mocked(prisma.auditLog.createMany).mockResolvedValue({ count: 1 });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args));
    await PATCH(makeRequest("http://localhost/api/acats/REC-001", {
      method: "PATCH", body: JSON.stringify({ notes: "Updated note" }),
    }), makeParams("REC-001"));
    const data = vi.mocked(prisma.acatRecord.update).mock.calls[0][0].data;
    expect(data.type).toBeUndefined();
    expect(data.transferWorkflow).toBeUndefined();
  });

  describe("DRS fee defaults", () => {
    it.each([
      { name: "classifying an incoming transfer", existing: { transferWorkflow: "ACAT", direction: "In" }, patch: { transferWorkflow: "DRS" }, expectedDefault: "No" },
      { name: "classifying a full outgoing transfer", existing: { transferWorkflow: "ACAT" }, patch: { transferWorkflow: "DRS" }, expectedDefault: "No" },
      { name: "changing a DRS transfer to Out", existing: { direction: "In" }, patch: { direction: "Out" }, expectedDefault: "No" },
      { name: "changing a DRS transfer to Full", existing: { type: "Partial" }, patch: { type: "Full" }, expectedDefault: "No" },
      { name: "completing an unanswered DRS transfer", existing: {}, patch: { status: "Completed" }, expectedDefault: "No" },
      { name: "preserving a saved Yes", existing: { feeCharged: "Yes" }, patch: { status: "Completed" }, expectedDefault: undefined },
      { name: "preserving a saved No", existing: { feeCharged: "No" }, patch: { direction: "Out" }, expectedDefault: undefined },
      { name: "preserving an existing fee amount", existing: { feeAmount: "$25.00" }, patch: { status: "Completed" }, expectedDefault: undefined },
      { name: "preserving an incoming fee amount", existing: {}, patch: { feeAmount: "$25.00", status: "Completed" }, expectedDefault: undefined },
      { name: "respecting an explicit Yes", existing: {}, patch: { feeCharged: "Yes", status: "Completed" }, expectedDefault: "Yes" },
      { name: "respecting an explicit clear", existing: { feeCharged: "No" }, patch: { feeCharged: null, status: "Completed" }, expectedDefault: null },
    ])("$name", async ({ existing: overrides, patch, expectedDefault }) => {
      const existing = {
        ...recordWithAssets,
        direction: "Out",
        type: "Full",
        transferWorkflow: "DRS",
        custodianId: "CUST-001",
        feeCharged: "",
        feeAmount: null,
        ...overrides,
      };
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...existing, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args));

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
        makeParams("REC-001")
      );

      expect(res.status).toBe(200);
      const data = (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
      expect(data.feeCharged).toBe(expectedDefault);
      // Never silently apply a general ACAT fee schedule to DRS.
      expect(prisma.custodian.findUnique).not.toHaveBeenCalled();
      expect(data.feeMemo).toBeUndefined();
      if (expectedDefault === "No") {
        expect(prisma.auditLog.createMany).toHaveBeenCalledWith({
          data: expect.arrayContaining([expect.objectContaining({
            field: "feeCharged",
            oldValue: "",
            newValue: "No",
            performedBy: adminSession.user.email,
          })]),
        });
      }
    });
  });

  it("updates and audits trade request fields", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    const updated = {
      ...recordWithAssets,
      tradeRequestId: "TRQ-456",
      tradeRequestUrl: "https://trades.example.com/requests/TRQ-456",
    };
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
    (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
    );

    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({
          tradeRequestId: "TRQ-456",
          tradeRequestUrl: "https://trades.example.com/requests/TRQ-456",
        }),
      }),
      makeParams("REC-001")
    );

    expect(res.status).toBe(200);
    expect(prisma.acatRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tradeRequestId: "TRQ-456",
          tradeRequestUrl: "https://trades.example.com/requests/TRQ-456",
        }),
      })
    );
    const auditCall = (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditCall.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "tradeRequestId", newValue: "TRQ-456" }),
        expect.objectContaining({
          field: "tradeRequestUrl",
          newValue: "https://trades.example.com/requests/TRQ-456",
        }),
      ])
    );
  });

  it("returns 404 for non-existent record", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-999", {
        method: "PATCH",
        body: JSON.stringify({ notes: "test" }),
      }),
      makeParams("REC-999")
    );
    expect(res.status).toBe(404);
  });

  // ticket: editing the contra text must re-resolve the custodian FK so it
  // never drifts from the displayed contra.
  it("re-resolves custodianId + custodianName when transferringContra is edited", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    (prisma.custodian.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "CUST-ET",
      name: "E*Trade",
    });
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...recordWithAssets, ...data })
    );
    (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
    );

    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({ transferringContra: "E*Trade" }),
      }),
      makeParams("REC-001")
    );
    expect(res.status).toBe(200);
    const updateCall = (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.data.custodianId).toBe("CUST-ET");
    expect(updateCall.data.custodianName).toBe("E*Trade");
    expect(updateCall.data.transferringContra).toBe("E*Trade");
  });

  it("clears custodianId when transferringContra is cleared", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...recordWithAssets,
      transferringContra: "E*Trade",
    });
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...recordWithAssets, ...data })
    );
    (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
    );

    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({ transferringContra: "" }),
      }),
      makeParams("REC-001")
    );
    expect(res.status).toBe(200);
    const updateCall = (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.data.custodianId).toBeNull();
    expect(updateCall.data.custodianName).toBe("");
    expect(prisma.custodian.findFirst).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid fields", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({ clientName: "" }),
      }),
      makeParams("REC-001")
    );
    expect(res.status).toBe(400);
  });

  it("rejects asset updates that don't belong to the ACAT record", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({
          assets: [{ id: "ASSET-OTHER", actualQty: 100 }],
        }),
      }),
      makeParams("REC-001")
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("ASSET-OTHER");
  });

  it("rejects mass-assignment attempts on system-managed fields", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);

    const forbiddenPayloads = [
      { deletedAt: "1970-01-01T00:00:00.000Z" },
      { id: "REC-INJECTED" },
      { createdAt: "1970-01-01T00:00:00.000Z" },
      { updatedAt: "1970-01-01T00:00:00.000Z" },
      { mappingSource: "attacker" },
      { apexSource: "attacker" },
      { custodianId: "cus-injected" },
      { custodianName: "Injected Custodian" },
      { slackAlerted: "yes please" },
    ];

    for (const payload of forbiddenPayloads) {
      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
        makeParams("REC-001")
      );
      expect(res.status, `payload ${JSON.stringify(payload)} should be rejected`).toBe(400);
    }

    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("allows asset updates that belong to the ACAT record", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    const updated = { ...recordWithAssets };
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
    (prisma.asset.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
    );

    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({
          assets: [{ id: "ASSET-1", actualQty: 50 }],
        }),
      }),
      makeParams("REC-001")
    );
    expect(res.status).toBe(200);
  });

  it("writes asset notes when included on an asset update payload", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    (prisma.asset.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
    );

    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({
          assets: [
            {
              id: "ASSET-1",
              issue: "Confirmed quantity against PDF",
              notes: "Verified by JH 2026-04-27",
            },
          ],
        }),
      }),
      makeParams("REC-001")
    );
    expect(res.status).toBe(200);
    expect(prisma.asset.update).toHaveBeenCalledWith({
      where: { id: "ASSET-1" },
      data: {
        issue: "Confirmed quantity against PDF",
        notes: "Verified by JH 2026-04-27",
      },
    });
  });

  it("clears asset notes when null is sent (server treats null as 'delete the value')", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    (prisma.asset.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
    );

    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({
          assets: [{ id: "ASSET-1", notes: null }],
        }),
      }),
      makeParams("REC-001")
    );
    expect(res.status).toBe(200);
    expect(prisma.asset.update).toHaveBeenCalledWith({
      where: { id: "ASSET-1" },
      data: { notes: null },
    });
  });

  it("creates new assets via newAssets[] for apex-only Unexpected positions", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    (prisma.asset.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "NEW-ASSET-1",
    });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
    );

    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({
          newAssets: [
            {
              symbol: "MSFT",
              description: "Microsoft Corp.",
              cusip: "594918104",
              expectedQty: 0,
              actualQty: 50,
              mapStatus: "Unmapped",
              issue: "Not in expected positions",
              notes: "Extra share lot — confirm with client",
            },
          ],
        }),
      }),
      makeParams("REC-001")
    );
    expect(res.status).toBe(200);
    // The route must bind acatRecordId from the URL param, not from the
    // request body — otherwise a client could create assets on someone
    // else's ACAT.
    const createCall = (prisma.asset.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.data.acatRecordId).toBe("REC-001");
    expect(createCall.data.symbol).toBe("MSFT");
    expect(createCall.data.expectedQty).toBe(0);
    expect(createCall.data.actualQty).toBe(50);
    expect(createCall.data.mapStatus).toBe("Unmapped");
    expect(createCall.data.notes).toBe("Extra share lot — confirm with client");
  });

  it("rejects newAssets[] entries with unknown fields (no acatRecordId smuggling)", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);

    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({
          newAssets: [
            {
              symbol: "MSFT",
              description: "Microsoft Corp.",
              acatRecordId: "REC-OTHER",
              actualQty: 50,
            },
          ],
        }),
      }),
      makeParams("REC-001")
    );
    expect(res.status).toBe(400);
    expect(prisma.asset.create).not.toHaveBeenCalled();
  });

  it("returns the post-asset-write record so clients never see a stale snapshot", async () => {
    // Regression: previously the transaction ran
    //   [acatRecord.update({ include: { assets: true } }), audit, asset.update]
    // which returned the pre-write asset rows. The SecurityReconTab "old
    // results after save" symptom was traced to that stale response body
    // seeding the SWR cache. The fix runs asset writes FIRST, then records
    // the acatRecord.update (with `include: { assets: true }`) last so the
    // response reflects the newly-written qty/mapStatus/issue.
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    const postUpdateAsset = {
      id: "ASSET-1",
      acatRecordId: "REC-001",
      symbol: "AAPL",
      actualQty: 50,
      mapStatus: "Mapped",
    };
    (prisma.asset.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      postUpdateAsset
    );
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...recordWithAssets,
      assets: [postUpdateAsset],
    });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
    );

    const res = await PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({
          apexSource: "Uploaded",
          assets: [{ id: "ASSET-1", actualQty: 50, mapStatus: "Mapped" }],
        }),
      }),
      makeParams("REC-001")
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.assets).toHaveLength(1);
    expect(data.assets[0].actualQty).toBe(50);
    expect(data.assets[0].mapStatus).toBe("Mapped");
  });

  describe("auto-apply custodian fee on Completed transition", () => {
    const recordPreCompleted = {
      ...mockRecord,
      status: "Accepted",
      accountType: "Individual",
      type: "Full",
      custodianId: "CUST-001",
      feeAmount: null,
      feeCharged: null,
      feeMemo: null,
    };

    const etradeCustodian = {
      id: "CUST-001",
      name: "E*TRADE",
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
        {
          id: "F2",
          custodianId: "CUST-001",
          feeType: "Partial Transfer",
          accountType: "ANY",
          transferType: "PARTIAL",
          amount: 0,
          amountText: null,
          notes: null,
          documentation: null,
        },
      ],
    };

    it("fills feeAmount from the custodian fee schedule when status becomes Completed", async () => {
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordPreCompleted);
      (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(etradeCustodian);
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...recordPreCompleted, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ status: "Completed" }),
        }),
        makeParams("REC-001")
      );
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.feeAmount).toBe("$75.00");
      expect(data.feeCharged).toBe("Yes");
      expect(data.feeMemo).toContain("Full Transfer: $75.00");

      const auditCall = (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const feeAuditEntry = auditCall.data.find(
        (e: { action: string }) => e.action === "fee-auto-apply"
      );
      expect(feeAuditEntry).toBeDefined();
      expect(feeAuditEntry.newValue).toBe("$75.00");
    });

    // ticket (F6): when the same PATCH re-resolves the contra AND completes
    // the record, fee auto-apply must use the NEWLY-resolved custodian, not
    // the stale one on the existing row.
    it("applies the newly-resolved custodian's fees when contra changes and status becomes Completed", async () => {
      const recordOnOldCustodian = {
        ...recordPreCompleted,
        custodianId: "CUST-OLD",
        transferringContra: "Old Contra",
      };
      const newCustodianWithFees = {
        id: "CUST-NEW",
        name: "E*Trade",
        fees: [
          {
            id: "F-NEW",
            custodianId: "CUST-NEW",
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

      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordOnOldCustodian);
      // Contra re-resolve (resolveCustodianForContra) returns the NEW custodian.
      (prisma.custodian.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "CUST-NEW",
        name: "E*Trade",
      });
      // Fee-schedule lookup: only the NEW custodian carries fees.
      (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve(where.id === "CUST-NEW" ? newCustodianWithFees : null)
      );
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...recordOnOldCustodian, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ transferringContra: "E*Trade", status: "Completed" }),
        }),
        makeParams("REC-001")
      );
      const data = await res.json();
      expect(res.status).toBe(200);
      // Fee came from the NEW custodian, proving effectiveCustodianId was used.
      expect(data.feeAmount).toBe("$75.00");
      expect(prisma.custodian.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "CUST-NEW" } })
      );
      expect(prisma.custodian.findUnique).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "CUST-OLD" } })
      );
    });

    it("does not auto-apply when an existing residual credit becomes Completed", async () => {
      const residual = {
        ...recordPreCompleted,
        type: "Residual Credit",
      };
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(residual);
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...residual, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ status: "Completed" }),
        }),
        makeParams("REC-001")
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.status).toBe("Completed");
      expect(data.feeAmount).toBeNull();
      expect(data.feeCharged).toBeNull();
      expect(data.feeMemo).toBeNull();
      expect(prisma.custodian.findUnique).not.toHaveBeenCalled();
    });

    it("does not auto-apply when the same PATCH changes the type to Residual Credit", async () => {
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordPreCompleted);
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...recordPreCompleted, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({
            status: "Completed",
            type: "Residual Credit",
          }),
        }),
        makeParams("REC-001")
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.type).toBe("Residual Credit");
      expect(data.feeAmount).toBeNull();
      expect(prisma.custodian.findUnique).not.toHaveBeenCalled();
    });

    it("does not auto-apply when feeCharged is explicitly No", async () => {
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...recordPreCompleted,
        feeCharged: "No",
      });
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...recordPreCompleted, feeCharged: "No", ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ status: "Completed" }),
        }),
        makeParams("REC-001")
      );
      expect(res.status).toBe(200);
      expect(prisma.custodian.findUnique).not.toHaveBeenCalled();
    });

    it("does not auto-apply when feeAmount is already set", async () => {
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...recordPreCompleted,
        feeAmount: "$50.00",
      });
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...recordPreCompleted, feeAmount: "$50.00", ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ status: "Completed" }),
        }),
        makeParams("REC-001")
      );
      expect(res.status).toBe(200);
      expect(prisma.custodian.findUnique).not.toHaveBeenCalled();
    });

    it("does not auto-apply when status changes to a non-Completed terminal state", async () => {
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordPreCompleted);
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...recordPreCompleted, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ status: "Rejected" }),
        }),
        makeParams("REC-001")
      );
      expect(res.status).toBe(200);
      expect(prisma.custodian.findUnique).not.toHaveBeenCalled();
    });

    it("auto-applies when feeCharged flips to Yes on an already-Completed record", async () => {
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...recordPreCompleted,
        status: "Completed",
        feeCharged: null,
        feeAmount: null,
      });
      (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(etradeCustodian);
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...recordPreCompleted, status: "Completed", ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ feeCharged: "Yes" }),
        }),
        makeParams("REC-001")
      );
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.feeAmount).toBe("$75.00");
    });

    it("completes the main update even when the fee lookup throws (table missing, DB error)", async () => {
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordPreCompleted);
      (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("The table `public.CustodianFee` does not exist in the current database.")
      );
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...recordPreCompleted, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ status: "Completed" }),
        }),
        makeParams("REC-001")
      );
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.status).toBe("Completed");
      // Fee wasn't applied because lookup failed, but the record update still landed.
      expect(data.feeAmount).toBeFalsy();
    });

    it("skips OUT-tagged fees when the record direction is Out (auto-apply respects direction)", async () => {
      // The contra's ACAT Out fee should not hit a record whose direction
      // is "Out" — that's an outbound transfer from our firm, and the
      // contra doesn't charge anything. Auto-apply must mirror the UI
      // filter from selectApplicableFees.
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...recordPreCompleted,
        type: "Full",
        direction: "Out",
      });
      (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...etradeCustodian,
        fees: [
          {
            id: "F1",
            custodianId: "CUST-001",
            feeType: "Full Transfer",
            accountType: "ANY",
            transferType: "FULL",
            direction: "OUT",
            amount: 75,
            amountText: null,
            notes: null,
            documentation: null,
          },
        ],
      });
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            ...recordPreCompleted,
            direction: "Out",
            ...data,
          })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ status: "Completed" }),
        }),
        makeParams("REC-001")
      );
      const data = await res.json();
      expect(res.status).toBe(200);
      // Fee schedule had one row (OUT) but record direction is Out, so
      // selectApplicableFees returns an empty set and auto-apply is a
      // no-op on the fee fields.
      expect(data.feeAmount).toBeFalsy();
      expect(data.feeCharged).not.toBe("Yes");
    });

    it("applies OUT-tagged fees when the record direction is In", async () => {
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...recordPreCompleted,
        type: "Full",
        direction: "In",
      });
      (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...etradeCustodian,
        fees: [
          {
            id: "F1",
            custodianId: "CUST-001",
            feeType: "Full Transfer",
            accountType: "ANY",
            transferType: "FULL",
            direction: "OUT",
            amount: 75,
            amountText: null,
            notes: null,
            documentation: null,
          },
        ],
      });
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            ...recordPreCompleted,
            direction: "In",
            ...data,
          })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ status: "Completed" }),
        }),
        makeParams("REC-001")
      );
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.feeAmount).toBe("$75.00");
      expect(data.feeCharged).toBe("Yes");
    });

    it("records feeMemo but leaves feeAmount null when the schedule has only unknown-amount fees", async () => {
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordPreCompleted);
      (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...etradeCustodian,
        fees: [
          {
            id: "F1",
            custodianId: "CUST-001",
            feeType: "Full Transfer",
            accountType: "ANY",
            transferType: "FULL",
            amount: null,
            amountText: "Varies — see notes",
            notes: null,
            documentation: null,
          },
        ],
      });
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...recordPreCompleted, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ status: "Completed" }),
        }),
        makeParams("REC-001")
      );
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.feeAmount).toBeFalsy();
      expect(data.feeMemo).toContain("Varies");
      expect(data.feeCharged).toBe("Yes");
    });
  });

  // -------------------------------------------------------------------------
  // ticket: Recon auto-complete. When a PATCH brings the record to >= 90%
  // matched assets AND positions are from GCP AND the Apex CSV has been
  // uploaded, the server stamps `reconCompletedAt`. The stamp marks the
  // *recon* complete — it does NOT change the ACAT status.
  // -------------------------------------------------------------------------
  describe("ticket recon auto-complete on PATCH", () => {
    const buildAsset = (id: string, mapStatus: string) => ({
      id,
      acatRecordId: "REC-001",
      symbol: "TST",
      description: "Test",
      cusip: null,
      expectedQty: 10,
      actualQty: mapStatus === "Mapped" ? 10 : 0,
      mapStatus,
      issue: null,
      notes: null,
      amount: 0,
      assetClass: null,
      settlingLocation: null,
      settlingLocationReason: null,
    });

    const reconReadyRecord = {
      ...mockRecord,
      status: "PendingReview",
      mappingSource: "GCP Project API",
      // Apex hasn't been uploaded yet — we'll PATCH it to "Uploaded" in
      // the success case so the auto-complete branch fires.
      apexSource: "Pending Upload",
      reconCompletedAt: null,
      assets: [
        ...Array.from({ length: 9 }, (_, i) => buildAsset(`m${i}`, "Mapped")),
        buildAsset("u0", "Unmapped"),
      ],
    };

    it("stamps reconCompletedAt when rate >= 90% and apex CSV is freshly uploaded", async () => {
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        reconReadyRecord
      );
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...reconReadyRecord, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({
        count: 1,
      });
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
      );

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ apexSource: "Uploaded" }),
        }),
        makeParams("REC-001")
      );

      expect(res.status).toBe(200);
      const updateCall = (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      // reconCompletedAt should have been added to the update payload by
      // the server-side heuristic (we didn't send it).
      expect(updateCall.data.reconCompletedAt).toEqual(expect.any(String));
      expect(new Date(updateCall.data.reconCompletedAt as string).toString()).not.toBe(
        "Invalid Date"
      );
      // Status must NOT be touched — auto-completing the recon is not
      // the same as completing the ACAT.
      expect(updateCall.data.status).toBeUndefined();

      // Audit entry should call it out as recon-auto-complete (not a
      // generic field update) so the trail explains the system action.
      const auditCall = (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      const reconEntry = auditCall.data.find(
        (e: { action: string }) => e.action === "recon-auto-complete"
      );
      expect(reconEntry).toBeDefined();
      expect(reconEntry.field).toBe("reconCompletedAt");
    });

    it("does not stamp when both sources are present but rate is below 90%", async () => {
      const below = {
        ...reconReadyRecord,
        apexSource: "Pending Upload",
        assets: [
          ...Array.from({ length: 8 }, (_, i) => buildAsset(`m${i}`, "Mapped")),
          buildAsset("u0", "Unmapped"),
          buildAsset("u1", "Unmapped"),
        ],
      };
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(below);
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...below, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({
        count: 1,
      });
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
      );

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ apexSource: "Uploaded" }),
        }),
        makeParams("REC-001")
      );

      expect(res.status).toBe(200);
      const updateCall = (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateCall.data).not.toHaveProperty("reconCompletedAt");
    });

    it("does not stamp when GCP positions are missing", async () => {
      const noGcp = {
        ...reconReadyRecord,
        mappingSource: "Manual Entry",
        apexSource: "Uploaded",
      };
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(noGcp);
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...noGcp, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({
        count: 1,
      });
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
      );

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({
            assets: [{ id: "u0", mapStatus: "Mapped" }],
          }),
        }),
        makeParams("REC-001")
      );

      expect(res.status).toBe(200);
      const updateCall = (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateCall.data).not.toHaveProperty("reconCompletedAt");
    });

    it("does not re-stamp when reconCompletedAt is already set", async () => {
      const alreadyStamped = {
        ...reconReadyRecord,
        apexSource: "Uploaded",
        reconCompletedAt: "2026-04-12T00:00:00Z",
      };
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        alreadyStamped
      );
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...alreadyStamped, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({
        count: 1,
      });
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
      );

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({ notes: "ping" }),
        }),
        makeParams("REC-001")
      );

      expect(res.status).toBe(200);
      const updateCall = (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateCall.data).not.toHaveProperty("reconCompletedAt");
    });

    it("clears reconCompletedAt when an override drags the rate back below 90%", async () => {
      // Record is already auto-completed. Ops sends a manual override
      // that flips two Mapped rows back to Unmapped, dropping the rate
      // to 7/10 = 70%. Server should null out the stamp and emit a
      // recon-auto-uncomplete audit row.
      const alreadyStamped = {
        ...reconReadyRecord,
        apexSource: "Uploaded",
        reconCompletedAt: "2026-04-12T00:00:00Z",
      };
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        alreadyStamped
      );
      (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...alreadyStamped, ...data })
      );
      (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({
        count: 1,
      });
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
      );

      const res = await PATCH(
        makeRequest("http://localhost/api/acats/REC-001", {
          method: "PATCH",
          body: JSON.stringify({
            assets: [
              { id: "m0", mapStatus: "Unmapped" },
              { id: "m1", mapStatus: "Unmapped" },
              { id: "m2", mapStatus: "Unmapped" },
            ],
          }),
        }),
        makeParams("REC-001")
      );

      expect(res.status).toBe(200);
      const updateCall = (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateCall.data.reconCompletedAt).toBeNull();

      const auditCall = (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      const uncompleteEntry = auditCall.data.find(
        (e: { action: string }) => e.action === "recon-auto-uncomplete"
      );
      expect(uncompleteEntry).toBeDefined();
    });
  });
});

describe("DELETE /api/acats/[id]", () => {
  function makeDeleteRequest(id: string, body: unknown = { reason: "bad data" }) {
    return makeRequest(`http://localhost/api/acats/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("soft-deletes a record and writes an audit log row", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockRecord);
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockRecord,
      deletedAt: new Date(),
    });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
    );

    const res = await DELETE(
      makeDeleteRequest("REC-DEL-1", { reason: "client closed account" }),
      makeParams("REC-DEL-1")
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(prisma.acatRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "REC-DEL-1" },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        acatRecordId: "REC-DEL-1",
        action: "DELETE",
        newValue: "client closed account",
        performedBy: "admin@example.com",
      },
    });
  });

  it("returns 404 for non-existent record", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await DELETE(
      makeDeleteRequest("REC-DEL-404"),
      makeParams("REC-DEL-404")
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await DELETE(
      makeDeleteRequest("REC-DEL-2"),
      makeParams("REC-DEL-2")
    );
    expect(res.status).toBe(403);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("returns 403 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      makeDeleteRequest("REC-DEL-3"),
      makeParams("REC-DEL-3")
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when reason is missing", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockRecord);
    const res = await DELETE(
      makeDeleteRequest("REC-DEL-4", {}),
      makeParams("REC-DEL-4")
    );
    expect(res.status).toBe(400);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("returns 400 when reason is too short", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockRecord);
    const res = await DELETE(
      makeDeleteRequest("REC-DEL-5", { reason: "no" }),
      makeParams("REC-DEL-5")
    );
    expect(res.status).toBe(400);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await DELETE(
      makeRequest("http://localhost/api/acats/REC-DEL-6", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
      makeParams("REC-DEL-6")
    );
    expect(res.status).toBe(400);
  });

  it("returns 429 after the per-admin hourly delete budget is exhausted", async () => {
    // Use a dedicated email so we don't contaminate the bucket for the
    // admin used by other tests.
    const limitedAdmin = {
      user: { email: "ratelimit-admin@example.com", role: "ADMIN" },
    };
    mockAuth.mockResolvedValue(limitedAdmin);
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockRecord);
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockRecord,
      deletedAt: new Date(),
    });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
    );

    // Burn through the 20-token hourly budget.
    for (let i = 0; i < 20; i++) {
      const ok = await DELETE(
        makeDeleteRequest(`REC-RL-${i}`, { reason: "rate limit test" }),
        makeParams(`REC-RL-${i}`)
      );
      expect(ok.status).toBe(200);
    }

    const res = await DELETE(
      makeDeleteRequest("REC-RL-21", { reason: "rate limit test" }),
      makeParams("REC-RL-21")
    );
    expect(res.status).toBe(429);
  });
});

describe("PATCH new positions in the public demo", () => {
  const recordWithAssets = {
    ...mockRecord,
    assets: [{ id: "ASSET-1", acatRecordId: "REC-001", symbol: "AAPL" }],
  };
  const addPositions = (count: number) =>
    PATCH(
      makeRequest("http://localhost/api/acats/REC-001", {
        method: "PATCH",
        body: JSON.stringify({
          newAssets: Array.from({ length: count }, (_, i) => ({ symbol: `NEW${i}`, actualQty: 1 })),
        }),
      }),
      makeParams("REC-001")
    );
  // Positions on this transfer when `where` is given; on the whole demo otherwise.
  const counts = (onTransfer: number, overall: number) =>
    vi.mocked(prisma.asset.count).mockImplementation(((args?: { where?: unknown }) =>
      Promise.resolve(args?.where ? onTransfer : overall)) as never);

  beforeEach(() => {
    vi.stubEnv("PERSONA_SIGN_IN", "on");
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue(recordWithAssets);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown[] | ((tx: unknown) => unknown)) => typeof args === "function" ? args(prisma) : Promise.all(args)
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses positions past the per-transfer limit, which keeps the transfer form affordable", async () => {
    counts(99, 800);
    const res = await addPositions(2);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("In the demo a transfer holds up to 100 positions, and this change would add 2 with room for 1.");
    expect(prisma.asset.create).not.toHaveBeenCalled();
  });

  it("refuses positions once the demo holds its cap", async () => {
    counts(7, 2500);
    const res = await addPositions(1);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/^The demo holds up to 2500 positions/);
    expect(prisma.asset.create).not.toHaveBeenCalled();
  });

  it("refuses an oversized list before checking its items", async () => {
    const res = await addPositions(501);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Too many items: at most 500");
  });
});
