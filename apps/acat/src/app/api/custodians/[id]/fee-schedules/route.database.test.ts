// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { mergeCustodianInto } from "@/lib/custodian-admin";
import { DELETE as deleteCustodian } from "../route";
import { GET as list, POST as upload } from "./route";
import { GET as download } from "./[documentId]/route";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));

const enabled = process.env.ACAT_DOCUMENT_DATABASE_TEST === "1";
const custodianIds: string[] = [];
const recordIds: string[] = [];
const uploader = "synthetic-fee-admin@example.test";
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const documentContext = (id: string, documentId: string) => ({
  params: Promise.resolve({ id, documentId }),
});
const getRequest = (path = "/fee-schedules") => new Request(`http://localhost${path}`);
const png = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=",
  "base64",
));

function uploadRequest(content: Uint8Array, filename: string, contentType: string) {
  const body = new FormData();
  body.set("file", new File([Uint8Array.from(content)], filename, { type: contentType }));
  return new Request("http://localhost/fee-schedules", { method: "POST", body });
}

async function makeCustodian(label: string) {
  const custodian = await prisma.custodian.create({
    data: { name: `Synthetic Fee Document ${label} ${randomUUID()}` },
  });
  custodianIds.push(custodian.id);
  return custodian;
}

async function putDocument(custodianId: string, content: Uint8Array, filename = "schedule.pdf", contentType = "application/pdf") {
  const response = await upload(uploadRequest(content, filename, contentType), context(custodianId));
  expect(response.status, await response.clone().text()).toBe(201);
  const result = await response.json();
  expect(result.duplicate).toBe(false);
  return prisma.custodianFeeScheduleDocument.findUniqueOrThrow({ where: { id: result.document.id } });
}

describe.skipIf(!enabled)("custodian fee schedule storage against PostgreSQL", () => {
  let pdf: Uint8Array;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/transfer_tracker_test"
    ) {
      throw new Error("Fee schedule tests require an explicit localhost transfer_tracker_test database");
    }
    const document = await PDFDocument.create();
    document.addPage().drawText("Synthetic fee schedule: full transfer $75; partial transfer $0.");
    pdf = await document.save();
  });

  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { email: uploader, role: "ADMIN" } });
  });

  afterAll(async () => {
    // Only this suite's synthetic rows; never truncate shared CI tables.
    if (recordIds.length) await prisma.acatRecord.deleteMany({ where: { id: { in: recordIds } } });
    if (custodianIds.length) {
      await prisma.custodianFeeScheduleDocument.deleteMany({ where: { custodianId: { in: custodianIds } } });
      await prisma.custodian.deleteMany({ where: { id: { in: custodianIds } } });
    }
  });

  it.each(["pdf", "png"] as const)("persists the original %s, lists metadata only, and returns identical download bytes without creating fees", async (format) => {
    const custodian = await makeCustodian(format);
    const content = format === "pdf" ? pdf : png;
    const contentType = format === "pdf" ? "application/pdf" : "image/png";
    const filename = `synthetic-schedule.${format}`;
    const stored = await putDocument(custodian.id, content, filename, contentType);
    expect(stored).toMatchObject({
      custodianId: custodian.id, filename, contentType, createdBy: uploader,
      byteSize: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    if (stored.content == null) throw new Error("expected stored fee schedule bytes");
    expect(Buffer.from(stored.content)).toEqual(Buffer.from(content));

    // A fresh database read and a separately authorized request prove that the
    // response is the saved original, not a browser-local file or regenerated PDF.
    mockAuth.mockResolvedValue({ user: { email: "synthetic-reader@example.test", role: "USER" } });
    const listing = await list(getRequest(), context(custodian.id));
    expect(listing.status).toBe(200);
    const body = await listing.json();
    expect(body.nextCursor).toBeNull();
    expect(body.documents).toEqual([{
      id: stored.id, filename, contentType, byteSize: content.byteLength,
      createdAt: stored.createdAt.toISOString(), createdBy: uploader,
    }]);
    expect(body.documents[0]).not.toHaveProperty("content");
    expect(body.documents[0]).not.toHaveProperty("sha256");

    const response = await download(getRequest(), documentContext(custodian.id, stored.id));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(contentType);
    expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename="${filename}"`);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(content));
    expect(await prisma.custodianFee.count({ where: { custodianId: custodian.id } })).toBe(0);
  });

  it("reuses the saved original for a same-custodian upload retry without rewriting its provenance", async () => {
    const custodian = await makeCustodian("retry");
    const original = await putDocument(custodian.id, pdf, "original-name.pdf");
    mockAuth.mockResolvedValue({ user: { email: "synthetic-second-admin@example.test", role: "ADMIN" } });
    const response = await upload(uploadRequest(pdf, "renamed-copy.pdf", "application/pdf"), context(custodian.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      duplicate: true,
      document: { id: original.id, filename: "original-name.pdf", createdBy: uploader, createdAt: original.createdAt.toISOString() },
    });
    expect(await prisma.custodianFeeScheduleDocument.count({ where: { custodianId: custodian.id } })).toBe(1);
    expect(await prisma.custodianFeeScheduleDocument.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await prisma.custodianFee.count({ where: { custodianId: custodian.id } })).toBe(0);
  });

  it("keeps downloads and pagination cursors scoped to their custodian", async () => {
    const owner = await makeCustodian("owner");
    const other = await makeCustodian("other");
    const stored = await putDocument(owner.id, pdf);
    expect((await download(getRequest(), documentContext(other.id, stored.id))).status).toBe(404);
    expect((await list(getRequest(`/fee-schedules?cursor=${stored.id}`), context(other.id))).status).toBe(400);
    expect(await (await list(getRequest(), context(other.id))).json()).toEqual({ documents: [], nextCursor: null });
  });

  it("merges attachments without losing either same-content original or its upload metadata", async () => {
    const source = await makeCustodian("merge-source");
    const target = await makeCustodian("merge-target");
    const sourceOriginal = await putDocument(source.id, pdf, "source-original.pdf");
    mockAuth.mockResolvedValue({ user: { email: "synthetic-target-admin@example.test", role: "ADMIN" } });
    const targetOriginal = await putDocument(target.id, pdf, "target-original.pdf");
    const sourceImage = await putDocument(source.id, png, "source-image.png", "image/png");
    expect(sourceOriginal.sha256).toBe(targetOriginal.sha256);
    const record = await prisma.acatRecord.create({ data: {
      clientName: "Synthetic Fee Document Merge", apexAccountId: "SYNTHETIC",
      acatDate: "2026-10-19", lastUpdated: "2026-10-19T00:00:00Z",
      custodianId: source.id, custodianName: source.name, transferringContra: source.name,
    } });
    recordIds.push(record.id);

    expect(await mergeCustodianInto({ sourceId: source.id, target, performedBy: uploader })).toBe(1);
    expect(await prisma.custodian.findUnique({ where: { id: source.id } })).toBeNull();
    expect(await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
      custodianId: target.id, custodianName: target.name, transferringContra: target.name,
    });
    expect(await prisma.custodianFeeScheduleDocument.count({ where: { custodianId: target.id } })).toBe(3);
    for (const original of [sourceOriginal, targetOriginal, sourceImage]) {
      const moved = await prisma.custodianFeeScheduleDocument.findUniqueOrThrow({ where: { id: original.id } });
      expect(moved).toEqual({ ...original, custodianId: target.id });
      const response = await download(getRequest(), documentContext(target.id, original.id));
      expect(response.status).toBe(200);
      if (original.content == null) throw new Error("expected stored fee schedule bytes");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(original.content));
    }
    expect((await download(getRequest(), documentContext(source.id, sourceOriginal.id))).status).toBe(404);
    expect(await prisma.custodianFee.count({ where: { custodianId: target.id } })).toBe(0);
  });

  it("rejects both direct and API deletion of a custodian with a document while permitting an empty custodian", async () => {
    const custodian = await makeCustodian("delete-protected");
    const stored = await putDocument(custodian.id, pdf);
    await expect(prisma.custodian.delete({ where: { id: custodian.id } })).rejects.toMatchObject({ code: "P2003" });
    const response = await deleteCustodian(new NextRequest(`http://localhost/api/custodians/${custodian.id}`, { method: "DELETE" }), context(custodian.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ linkedRecordCount: 0, feeScheduleDocumentCount: 1 });
    expect(await prisma.custodianFeeScheduleDocument.findUniqueOrThrow({ where: { id: stored.id } })).toEqual(stored);
    expect(await prisma.custodian.findUnique({ where: { id: custodian.id } })).not.toBeNull();

    const empty = await makeCustodian("delete-empty");
    const deleted = await deleteCustodian(new NextRequest(`http://localhost/api/custodians/${empty.id}`, { method: "DELETE" }), context(empty.id));
    expect(deleted.status).toBe(200);
    expect(await prisma.custodian.findUnique({ where: { id: empty.id } })).toBeNull();
  });
});
