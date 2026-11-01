// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
const { prisma } = await import("@/lib/prisma");
const { GET } = await import("./route");
const ctx = { params: Promise.resolve({ id: "CUST-1", documentId: "DOC-1" }) };
const request = () => new Request("http://localhost/api/custodians/CUST-1/fee-schedules/DOC-1");
const content = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 255, 1, 2]);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.EPIC_CUSTODIAN_DATABASE_AUTHORITY;
  delete process.env.ENFORCE_CUSTODIAN_FEE_SCHEDULE_METADATA_ONLY;
  mockAuth.mockResolvedValue({ user: { email: "ops@example.test", role: "USER" } });
  vi.mocked(prisma.custodianFeeScheduleDocument.findFirst).mockResolvedValue({
    filename: "fees.pdf", contentType: "application/pdf", content,
  } as never);
});

describe("download saved custodian fee schedule", () => {
  it.each([null, { user: { email: "advisor@example.test", role: "ADVISOR" } }])("requires an operations session", async (session) => {
    mockAuth.mockResolvedValue(session);
    expect((await GET(request(), ctx)).status).toBe(session ? 403 : 401);
    expect(prisma.custodianFeeScheduleDocument.findFirst).not.toHaveBeenCalled();
  });

  it.each(["USER", "ADMIN"])("downloads exact bytes for %s using a custodian-scoped lookup", async (role) => {
    mockAuth.mockResolvedValue({ user: { email: "ops@example.test", role } });
    const response = await GET(request(), ctx);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="fees.pdf"');
    expect(response.headers.get("content-length")).toBe(String(content.length));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(prisma.custodianFeeScheduleDocument.findFirst).toHaveBeenCalledWith({
      where: { id: "DOC-1", custodianId: "CUST-1" },
      select: { filename: true, contentType: true, content: true },
    });
    expect(prisma.custodianFeeScheduleDocument.create).not.toHaveBeenCalled();
    expect(prisma.custodianFee.update).not.toHaveBeenCalled();
  });

  it("sanitizes a stored filename before placing it in a header", async () => {
    vi.mocked(prisma.custodianFeeScheduleDocument.findFirst).mockResolvedValue({
      filename: '../fees"\r\n.pdf', contentType: "application/pdf", content,
    } as never);
    expect((await GET(request(), ctx)).headers.get("content-disposition")).toBe('attachment; filename="fees---.pdf"');
  });

  it("returns 404 for a missing or another custodian's document", async () => {
    vi.mocked(prisma.custodianFeeScheduleDocument.findFirst).mockResolvedValue(null);
    expect((await GET(request(), ctx)).status).toBe(404);
  });

  it("does not expose storage failures", async () => {
    vi.mocked(prisma.custodianFeeScheduleDocument.findFirst).mockRejectedValueOnce(new Error("sensitive error"));
    const response = await GET(request(), ctx);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not download fee schedule" });
  });

  it("refuses a download when fee-schedule bytes are retired", async () => {
    process.env.EPIC_CUSTODIAN_DATABASE_AUTHORITY = "1";
    process.env.ENFORCE_CUSTODIAN_FEE_SCHEDULE_METADATA_ONLY = "1";
    const response = await GET(request(), ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Fee schedule bytes are retired" });
    expect(prisma.custodianFeeScheduleDocument.findFirst).not.toHaveBeenCalled();
  });

  it("does not serve a metadata-only file", async () => {
    vi.mocked(prisma.custodianFeeScheduleDocument.findFirst).mockResolvedValue({
      filename: "fees.pdf", contentType: "application/pdf", content: null,
    } as never);
    const response = await GET(request(), ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Fee schedule file is not stored" });
  });
});
