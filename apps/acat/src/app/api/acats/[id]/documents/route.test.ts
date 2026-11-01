// @vitest-environment node
import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
const { prisma } = await import("@/lib/prisma");
const { GET } = await import("./route");
const { GET: download } = await import("./[documentId]/route");
const ctx = { params: Promise.resolve({ id: "REC-1" }) };
const downloadCtx = { params: Promise.resolve({ id: "REC-1", documentId: "DOC-1" }) };
const request = (query = "") => new NextRequest(`http://localhost/api/acats/REC-1/documents${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { email: "ops@example.test", role: "USER" } });
  vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue({ id: "REC-1" } as never);
  vi.mocked(prisma.acatDocument.findMany).mockResolvedValue([]);
  vi.mocked(prisma.acatDocument.findFirst).mockResolvedValue(null);
});

describe("saved document history", () => {
  it.each([null, { user: { email: "advisor@example.test", role: "ADVISOR" } }])("rejects unprivileged list and download requests", async (session) => {
    mockAuth.mockResolvedValue(session);
    expect((await GET(request(), ctx)).status).toBe(session ? 403 : 401);
    expect((await download(request(), downloadCtx)).status).toBe(session ? 403 : 401);
    expect(prisma.acatDocument.findMany).not.toHaveBeenCalled();
    expect(prisma.acatDocument.findFirst).not.toHaveBeenCalled();
  });
  it("returns only metadata, bounded pagination and no-store", async () => {
    vi.mocked(prisma.acatDocument.findMany).mockResolvedValue(Array.from({ length: 21 }, (_, index) => ({ id: `DOC-${index}` })) as never);
    const response = await GET(request(), ctx);
    const body = await response.json();
    expect(body.documents).toHaveLength(20);
    expect(body.nextCursor).toBe("DOC-19");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const query = vi.mocked(prisma.acatDocument.findMany).mock.calls[0][0]!;
    expect(query.where).toEqual({ acatRecordId: "REC-1" });
    expect(query.select).not.toHaveProperty("content");
    expect(query.select).not.toHaveProperty("inputCsv");
  });
  it("refuses another transfer's cursor", async () => {
    expect((await GET(request("?cursor=OTHER"), ctx)).status).toBe(400);
    expect(prisma.acatDocument.findMany).not.toHaveBeenCalled();
    expect(prisma.acatDocument.findFirst).toHaveBeenCalledWith({ where: { id: "OTHER", acatRecordId: "REC-1" }, select: { id: true } });
  });
  it("fetches older entries with an owned cursor", async () => {
    vi.mocked(prisma.acatDocument.findFirst).mockResolvedValue({ id: "DOC-20" } as never);
    expect((await GET(request("?cursor=DOC-20"), ctx)).status).toBe(200);
    expect(prisma.acatDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({ cursor: { id: "DOC-20" }, skip: 1, take: 21 }));
  });
  it("does not expose history for missing or deleted records", async () => {
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(null);
    expect((await GET(request(), ctx)).status).toBe(404);
    expect(prisma.acatRecord.findUnique).toHaveBeenCalledWith({ where: { id: "REC-1", deletedAt: null }, select: { id: true } });
    expect(prisma.acatDocument.findMany).not.toHaveBeenCalled();
  });
  it("downloads exact stored bytes without generating or altering holdings", async () => {
    vi.mocked(prisma.acatDocument.findFirst).mockResolvedValue({ kind: "TRANSFER_FORM", filename: "saved.pdf", content: Buffer.from("%PDF-saved-version"), inputCsv: "frozen inputs" } as never);
    const response = await download(request(), downloadCtx);
    expect(await response.text()).toBe("%PDF-saved-version");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(prisma.acatDocument.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "DOC-1", acatRecordId: "REC-1", acatRecord: { deletedAt: null } } }));
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(prisma.acatDocument.create).not.toHaveBeenCalled();
  });
  it("downloads the frozen inputs paired with a form", async () => {
    vi.mocked(prisma.acatDocument.findFirst).mockResolvedValue({ kind: "TRANSFER_FORM", filename: "saved.pdf", content: Buffer.from("pdf"), inputCsv: "frozen inputs" } as never);
    const response = await download(request("?input=1"), downloadCtx);
    expect(await response.text()).toBe("frozen inputs");
    expect(response.headers.get("content-disposition")).toContain("saved-inputs.csv");
    expect(response.headers.get("content-type")).toContain("text/csv");
  });
  it("returns 404 for another transfer's document or a deleted parent", async () => {
    expect((await download(request(), downloadCtx)).status).toBe(404);
  });
  it("reports unavailable storage without leaking document contents", async () => {
    vi.mocked(prisma.acatDocument.findMany).mockRejectedValueOnce(new Error("Storage offline"));
    const response = await GET(request(), ctx);
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Could not load saved inputs and paperwork");
  });
});
