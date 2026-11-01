import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { POST } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const adminSession = {
  user: { email: "admin@example.com", role: "ADMIN" },
};
const userSession = {
  user: { email: "user@example.com", role: "USER" },
};

const deletedRecord = {
  id: "REC-DEL-100",
  clientName: "Sarah Jenkins",
  status: "PendingReview",
  deletedAt: new Date(),
};

const liveRecord = {
  id: "REC-LIVE-100",
  clientName: "Sarah Jenkins",
  status: "PendingReview",
  deletedAt: null,
};

function makeRequest(url: string, init?: RequestInit) {
  return new Request(url, init) as Parameters<typeof POST>[0];
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function restoreRequest(id: string, body: unknown = {}) {
  return makeRequest(`http://localhost/api/acats/${id}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
    (args: unknown[]) => Promise.all(args)
  );
});

describe("POST /api/acats/[id]/restore", () => {
  it("restores a soft-deleted record and writes an audit log row", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(deletedRecord);
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...deletedRecord,
      deletedAt: null,
    });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await POST(
      restoreRequest("REC-DEL-100", { reason: "restored by request" }),
      makeParams("REC-DEL-100")
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(prisma.acatRecord.update).toHaveBeenCalledWith({
      where: { id: "REC-DEL-100" },
      data: { deletedAt: null },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        acatRecordId: "REC-DEL-100",
        action: "RESTORE",
        newValue: "restored by request",
        performedBy: "admin@example.com",
      },
    });
  });

  it("accepts an empty body and stores a null reason", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(deletedRecord);
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...deletedRecord,
      deletedAt: null,
    });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await POST(
      makeRequest("http://localhost/api/acats/REC-DEL-100/restore", {
        method: "POST",
      }),
      makeParams("REC-DEL-100")
    );

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "RESTORE",
        newValue: null,
      }),
    });
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await POST(
      restoreRequest("REC-DEL-100"),
      makeParams("REC-DEL-100")
    );
    expect(res.status).toBe(403);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("returns 403 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      restoreRequest("REC-DEL-100"),
      makeParams("REC-DEL-100")
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when record does not exist", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(
      restoreRequest("REC-NONE"),
      makeParams("REC-NONE")
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when the record is not currently deleted", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(liveRecord);
    const res = await POST(
      restoreRequest("REC-LIVE-100"),
      makeParams("REC-LIVE-100")
    );
    expect(res.status).toBe(409);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/acats/REC-DEL-100/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
      makeParams("REC-DEL-100")
    );
    expect(res.status).toBe(400);
  });
});
