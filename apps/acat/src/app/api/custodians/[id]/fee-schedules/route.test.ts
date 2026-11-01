// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { feeScheduleMetadataSelect, MAX_FEE_SCHEDULE_BYTES } from "@/lib/custodian-fee-documents";
const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
const { prisma } = await import("@/lib/prisma");
const { GET, POST } = await import("./route");
const ctx = { params: Promise.resolve({ id: "CUST-1" }) };
const url = "http://localhost/api/custodians/CUST-1/fee-schedules";
const pdf = Buffer.from("%PDF-1.7\noriginal fee schedule\n%%EOF");
const metadata = {
  id: "DOC-1", filename: "fees.pdf", contentType: "application/pdf",
  byteSize: pdf.length, createdAt: new Date("2026-10-19T16:00:00Z"), createdBy: "admin@example.test",
};
function upload(content = pdf, filename = "fees.pdf", type = "application/pdf") {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), filename);
  return new Request(url, { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.EPIC_CUSTODIAN_DATABASE_AUTHORITY;
  delete process.env.ENFORCE_CUSTODIAN_FEE_SCHEDULE_METADATA_ONLY;
  mockAuth.mockResolvedValue({ user: { email: "admin@example.test", role: "ADMIN" } });
  vi.mocked(prisma.custodian.findUnique).mockResolvedValue({ id: "CUST-1" } as never);
  vi.mocked(prisma.custodianFeeScheduleDocument.findMany).mockResolvedValue([]);
  vi.mocked(prisma.custodianFeeScheduleDocument.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.custodianFeeScheduleDocument.create).mockResolvedValue(metadata as never);
});

afterEach(() => {
  expect(prisma.custodianFee.create).not.toHaveBeenCalled();
  expect(prisma.custodianFee.update).not.toHaveBeenCalled();
  expect(prisma.custodianFee.delete).not.toHaveBeenCalled();
  expect(prisma.custodianFee.createMany).not.toHaveBeenCalled();
  expect(prisma.custodianFee.deleteMany).not.toHaveBeenCalled();
});

describe("GET fee schedules", () => {
  it.each([null, { user: { email: "advisor@example.test", role: "ADVISOR" } }])("requires an operations session", async (session) => {
    mockAuth.mockResolvedValue(session);
    const response = await GET(new Request(url), ctx);
    expect(response.status).toBe(session ? 403 : 401);
    expect(prisma.custodian.findUnique).not.toHaveBeenCalled();
    expect(prisma.custodianFeeScheduleDocument.findMany).not.toHaveBeenCalled();
  });

  it.each(["USER", "ADMIN"])("allows %s to read metadata", async (role) => {
    mockAuth.mockResolvedValue({ user: { email: "ops@example.test", role } });
    vi.mocked(prisma.custodianFeeScheduleDocument.findMany).mockResolvedValue([metadata] as never);
    const response = await GET(new Request(url), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documents: [{ ...metadata, createdAt: metadata.createdAt.toISOString() }], nextCursor: null });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(prisma.custodianFeeScheduleDocument.findMany).toHaveBeenCalledWith({
      where: { custodianId: "CUST-1" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 21, select: feeScheduleMetadataSelect,
    });
    expect(feeScheduleMetadataSelect).not.toHaveProperty("content");
    expect(feeScheduleMetadataSelect).not.toHaveProperty("sha256");
  });

  it("returns twenty entries with a stable next cursor", async () => {
    vi.mocked(prisma.custodianFeeScheduleDocument.findMany).mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({ ...metadata, id: `DOC-${index}` })) as never
    );
    const body = await (await GET(new Request(url), ctx)).json();
    expect(body.documents).toHaveLength(20);
    expect(body.nextCursor).toBe("DOC-19");
  });

  it("validates that a cursor belongs to the requested custodian", async () => {
    expect((await GET(new Request(`${url}?cursor=OTHER`), ctx)).status).toBe(400);
    expect(prisma.custodianFeeScheduleDocument.findFirst).toHaveBeenCalledWith({
      where: { id: "OTHER", custodianId: "CUST-1" }, select: { id: true },
    });
    expect(prisma.custodianFeeScheduleDocument.findMany).not.toHaveBeenCalled();
  });

  it.each(["", "x".repeat(201), "%0A"])("rejects invalid cursor syntax %s", async (cursor) => {
    expect((await GET(new Request(`${url}?cursor=${cursor}`), ctx)).status).toBe(400);
    expect(prisma.custodianFeeScheduleDocument.findFirst).not.toHaveBeenCalled();
  });

  it("uses an owned cursor to load the next page", async () => {
    vi.mocked(prisma.custodianFeeScheduleDocument.findFirst).mockResolvedValue({ id: "DOC-20" } as never);
    expect((await GET(new Request(`${url}?cursor=DOC-20`), ctx)).status).toBe(200);
    expect(prisma.custodianFeeScheduleDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({ cursor: { id: "DOC-20" }, skip: 1, take: 21 }));
  });

  it("returns 404 for a missing custodian", async () => {
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue(null);
    expect((await GET(new Request(url), ctx)).status).toBe(404);
    expect(prisma.custodianFeeScheduleDocument.findMany).not.toHaveBeenCalled();
  });
});

describe("POST fee schedules", () => {
  it("refuses uploads in the demo, before reading the file", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    try {
      const res = await POST(upload(), { params: Promise.resolve({ id: "CUST-1" }) });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Uploads are off in this demo." });
      expect(prisma.custodianFeeScheduleDocument.create).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([null, { user: { email: "ops@example.test", role: "USER" } }, { user: { email: "advisor@example.test", role: "ADVISOR" } }])("only accepts an admin upload", async (session) => {
    mockAuth.mockResolvedValue(session);
    const request = upload();
    expect((await POST(request, ctx)).status).toBe(session ? 403 : 401);
    expect(request.bodyUsed).toBe(false);
    expect(prisma.custodianFeeScheduleDocument.create).not.toHaveBeenCalled();
  });

  it("stores the exact file, hash and uploader and returns only metadata", async () => {
    const response = await POST(upload(), ctx);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ document: { ...metadata, createdAt: metadata.createdAt.toISOString() }, duplicate: false });
    expect(prisma.custodianFeeScheduleDocument.create).toHaveBeenCalledWith({
      data: {
        custodianId: "CUST-1", filename: "fees.pdf", contentType: "application/pdf", content: pdf,
        byteSize: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex"), createdBy: "admin@example.test",
      },
      select: feeScheduleMetadataSelect,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns the existing attachment for a same-custodian hash retry", async () => {
    vi.mocked(prisma.custodianFeeScheduleDocument.findFirst).mockResolvedValue(metadata as never);
    const response = await POST(upload(pdf, "renamed.pdf"), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: true, document: { id: "DOC-1", filename: "fees.pdf" } });
    expect(prisma.custodianFeeScheduleDocument.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { custodianId: "CUST-1", sha256: createHash("sha256").update(pdf).digest("hex") },
    }));
    expect(prisma.custodianFeeScheduleDocument.create).not.toHaveBeenCalled();
  });

  it("accepts a supported file whose browser provides no MIME metadata", async () => {
    const response = await POST(upload(pdf, "fees.pdf", ""), ctx);
    expect(response.status).toBe(201);
    expect(prisma.custodianFeeScheduleDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contentType: "application/pdf", content: pdf }),
    }));
  });

  it("rejects empty and mismatched files", async () => {
    expect((await POST(upload(Buffer.alloc(0)), ctx)).status).toBe(400);
    expect((await POST(upload(Buffer.from("fake PDF")), ctx)).status).toBe(415);
    expect((await POST(upload(pdf, "fees.txt"), ctx)).status).toBe(415);
    expect(prisma.custodianFeeScheduleDocument.create).not.toHaveBeenCalled();
  });

  it("rejects a file exceeding 10 MiB even with permitted multipart overhead", async () => {
    const content = Buffer.alloc(MAX_FEE_SCHEDULE_BYTES + 1);
    pdf.copy(content);
    expect((await POST(upload(content), ctx)).status).toBe(413);
    expect(prisma.custodianFeeScheduleDocument.create).not.toHaveBeenCalled();
  });

  it("rejects malformed multipart data", async () => {
    const response = await POST(new Request(url, { method: "POST", body: "broken", headers: { "content-type": "multipart/form-data; boundary=x" } }), ctx);
    expect(response.status).toBe(400);
    expect(prisma.custodianFeeScheduleDocument.create).not.toHaveBeenCalled();
  });

  it("does not read the file when the custodian is missing", async () => {
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue(null);
    const request = upload();
    expect((await POST(request, ctx)).status).toBe(404);
    expect(request.bodyUsed).toBe(false);
    expect(prisma.custodianFeeScheduleDocument.create).not.toHaveBeenCalled();
  });

  it("returns 404 if the custodian was removed during the upload", async () => {
    vi.mocked(prisma.custodian.findUnique).mockResolvedValueOnce({ id: "CUST-1" } as never).mockResolvedValueOnce(null);
    vi.mocked(prisma.custodianFeeScheduleDocument.create).mockRejectedValueOnce({ code: "P2003" });
    expect((await POST(upload(), ctx)).status).toBe(404);
  });

  it("reports a storage failure without exposing file contents", async () => {
    vi.mocked(prisma.custodianFeeScheduleDocument.create).mockRejectedValueOnce(new Error("sensitive document failure"));
    const response = await POST(upload(), ctx);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not save fee schedule" });
  });

  it("lists metadata when fee-schedule bytes are retired", async () => {
    process.env.EPIC_CUSTODIAN_DATABASE_AUTHORITY = "1";
    process.env.ENFORCE_CUSTODIAN_FEE_SCHEDULE_METADATA_ONLY = "1";
    mockAuth.mockResolvedValue({ user: { email: "ops@example.test", role: "USER" } });
    vi.mocked(prisma.custodianFeeScheduleDocument.findMany).mockResolvedValue([metadata] as never);
    const response = await GET(new Request(url), ctx);
    expect(response.status).toBe(200);
    expect(prisma.custodianFeeScheduleDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: feeScheduleMetadataSelect,
    }));
    const body = await response.json();
    expect(body.documents[0]).not.toHaveProperty("content");
    expect(JSON.stringify(body)).not.toContain(pdf.toString("utf8"));
  });

  it("refuses an upload when fee-schedule bytes are retired", async () => {
    process.env.EPIC_CUSTODIAN_DATABASE_AUTHORITY = "1";
    process.env.ENFORCE_CUSTODIAN_FEE_SCHEDULE_METADATA_ONLY = "1";
    const response = await POST(upload(), ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Fee schedule bytes are retired" });
    expect(prisma.custodian.findUnique).not.toHaveBeenCalled();
    expect(prisma.custodianFeeScheduleDocument.create).not.toHaveBeenCalled();
  });

  it("still stores an upload when only the child metadata switch is on", async () => {
    process.env.ENFORCE_CUSTODIAN_FEE_SCHEDULE_METADATA_ONLY = "1";
    const response = await POST(upload(), ctx);
    expect(response.status).toBe(201);
    expect(prisma.custodianFeeScheduleDocument.create).toHaveBeenCalled();
  });
});
