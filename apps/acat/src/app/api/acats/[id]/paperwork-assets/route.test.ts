// @vitest-environment node
import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
const { prisma } = await import("@/lib/prisma");
const { GET, PUT } = await import("./route");
const ctx = { params: Promise.resolve({ id: "REC-1" }) };
const request = (assets: unknown) => new NextRequest("http://localhost/api/acats/REC-1/paperwork-assets", { method: "PUT", body: JSON.stringify({ assets }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { email: "ops@example.test", role: "USER" } });
  vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue({ assets: [{ id: "A1", includeInTransfer: true }, { id: "A2", includeInTransfer: false }] } as never);
});
describe("persisted paperwork selections", () => {
  it("reads saved choices without an upload or sync", async () => {
    const response = await GET(request([]), ctx);
    expect((await response.json()).assets).toEqual([{ id: "A1", includeInTransfer: true }, { id: "A2", includeInTransfer: false }]);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });
  it.each([true, false, null])("saves an explicit choice %s with an audit entry, never changing quantities", async (includeInTransfer) => {
    const response = await PUT(request([{ id: "A2", includeInTransfer }]), ctx);
    expect(response.status).toBe(200);
    expect(prisma.acatRecord.update).toHaveBeenCalledWith({
      where: { id: "REC-1", deletedAt: null },
      data: expect.objectContaining({ assets: { update: [{ where: { id: "A2" }, data: { includeInTransfer } }] }, auditLogs: { create: expect.objectContaining({ action: "paperwork-selections-save", performedBy: "ops@example.test" }) } }),
    });
  });
  it.each([
    { assets: [] },
    { assets: [{ id: "A1", includeInTransfer: "Yes" }] },
    { assets: [{ id: "A1", includeInTransfer: true, expectedQty: 999 }] },
    { assets: [{ id: "A1", includeInTransfer: true }, { id: "A1", includeInTransfer: false }] },
  ])("rejects malformed or duplicate choices", async ({ assets }) => {
    expect((await PUT(request(assets), ctx)).status).toBe(400);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });
  it("rejects a security owned by a different transfer without writing any choices", async () => {
    expect((await PUT(request([{ id: "OTHER", includeInTransfer: true }]), ctx)).status).toBe(409);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });
  it("rejects missing and soft-deleted transfers", async () => {
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(null);
    expect((await PUT(request([{ id: "A1", includeInTransfer: true }]), ctx)).status).toBe(404);
  });
  it.each([null, { user: { email: "advisor@example.test", role: "ADVISOR" } }])("protects both reads and writes", async (session) => {
    mockAuth.mockResolvedValue(session);
    expect((await GET(request([]), ctx)).status).toBe(session ? 403 : 401);
    expect((await PUT(request([]), ctx)).status).toBe(session ? 403 : 401);
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
  });
});
