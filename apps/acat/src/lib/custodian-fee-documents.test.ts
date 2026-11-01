// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  buildFeeScheduleDocument,
  decideFeeScheduleByteRetirement,
  MAX_FEE_SCHEDULE_BYTES,
  MAX_FEE_SCHEDULE_REQUEST_BYTES,
  readFeeScheduleUpload,
  safeFeeScheduleFilename,
} from "./custodian-fee-documents";

const pdf = Buffer.from("%PDF-1.7\noriginal fee schedule\n%%EOF");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 0xff, 0xd9]);

function uploadRequest(form: FormData) {
  return new Request("http://localhost/upload", { method: "POST", body: form });
}

describe("fee schedule storage validation", () => {
  it.each([
    ["Schedule.PDF", "application/pdf", pdf],
    ["schedule.png", "image/png", png],
    ["schedule.jpg", "image/jpeg", jpeg],
    ["schedule.jpeg", "image/jpeg", jpeg],
  ])("preserves the bytes and fingerprints %s", (filename, contentType, content) => {
    const document = buildFeeScheduleDocument({ filename, contentType, content });
    expect(document.content).toEqual(content);
    expect(document.byteSize).toBe(content.byteLength);
    expect(document.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(document.contentType).toBe(contentType);
  });

  it.each([
    ["schedule.exe", "application/pdf", pdf],
    ["schedule.pdf", "image/png", pdf],
    ["schedule.pdf", "application/pdf", Buffer.from("<html>pretend pdf</html>")],
    ["schedule.png", "image/png", pdf],
    ["schedule.jpg", "image/jpeg", png],
    ["schedule.png", "image/png", png.subarray(0, 7)],
  ])("rejects mismatched or unsupported file %s / %s", (filename, contentType, content) => {
    expect(() => buildFeeScheduleDocument({ filename, contentType, content })).toThrow();
    try { buildFeeScheduleDocument({ filename, contentType, content }); }
    catch (error) { expect(error).toMatchObject({ status: 415 }); }
  });

  it.each(["", "application/octet-stream"])("infers MIME for %s only with a supported extension and matching signature", (contentType) => {
    expect(buildFeeScheduleDocument({ filename: "fees.pdf", contentType, content: pdf }).contentType).toBe("application/pdf");
    expect(() => buildFeeScheduleDocument({ filename: "fees.pdf", contentType, content: png })).toThrow("contents do not match");
    expect(() => buildFeeScheduleDocument({ filename: "fees.exe", contentType, content: pdf })).toThrow("matching file type");
  });

  it("rejects empty files and enforces the exact file size limit", () => {
    expect(() => buildFeeScheduleDocument({ filename: "fees.pdf", contentType: "application/pdf", content: Buffer.alloc(0) })).toThrow("non-empty");
    const content = Buffer.alloc(MAX_FEE_SCHEDULE_BYTES);
    pdf.copy(content);
    expect(buildFeeScheduleDocument({ filename: "fees.pdf", contentType: "application/pdf", content }).byteSize).toBe(MAX_FEE_SCHEDULE_BYTES);
    expect(() => buildFeeScheduleDocument({ filename: "fees.pdf", contentType: "application/pdf", content: Buffer.alloc(MAX_FEE_SCHEDULE_BYTES + 1) })).toThrow("10 MB");
  });

  it("sanitizes paths and header characters while preserving an extension", () => {
    expect(safeFeeScheduleFilename('../../private/fees"\r\n.pdf')).toBe("fees---.pdf");
    expect(safeFeeScheduleFilename('C:\\folder\\fees.pdf')).toBe("fees.pdf");
    expect(safeFeeScheduleFilename("...")).toBe("fee-schedule");
    expect(safeFeeScheduleFilename(`${"a".repeat(500)}.jpeg`)).toBe(`${"a".repeat(150)}.jpeg`);
  });

  it("reads a valid multipart file without modifying it", async () => {
    const form = new FormData();
    form.append("file", new Blob([pdf], { type: "application/pdf" }), "fees.pdf");
    expect(await readFeeScheduleUpload(uploadRequest(form))).toMatchObject({
      filename: "fees.pdf", content: pdf, byteSize: pdf.length,
    });
  });

  it.each(["missing", "text", "wrong-name", "multiple", "extra-field"])("rejects %s file form", async (kind) => {
    const form = new FormData();
    if (kind === "text") form.append("file", "text is not a file");
    if (kind === "wrong-name") form.append("document", new Blob([pdf], { type: "application/pdf" }), "fees.pdf");
    if (kind === "multiple" || kind === "extra-field") {
      form.append("file", new Blob([pdf], { type: "application/pdf" }), "fees.pdf");
      if (kind === "multiple") form.append("file", new Blob([pdf], { type: "application/pdf" }), "second.pdf");
      else form.append("notes", "extra field");
    }
    await expect(readFeeScheduleUpload(uploadRequest(form))).rejects.toMatchObject({ status: 400 });
  });

  it.each([undefined, "1"])("bounds actual streamed bytes even with content-length %s", async (advertisedSize) => {
    const cancel = vi.fn();
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    }, { highWaterMark: 0 });
    const request = new Request("http://localhost/upload", {
      method: "POST",
      body,
      duplex: "half",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        ...(advertisedSize ? { "content-length": advertisedSize } : {}),
      },
    } as RequestInit);
    await expect(readFeeScheduleUpload(request)).rejects.toMatchObject({ status: 413 });
    expect(reads).toBe(11);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an oversized advertised body without reading it", async () => {
    const request = new Request("http://localhost/upload", {
      method: "POST", body: "not read",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(MAX_FEE_SCHEDULE_REQUEST_BYTES + 1) },
    });
    await expect(readFeeScheduleUpload(request)).rejects.toMatchObject({ status: 413 });
    expect(request.bodyUsed).toBe(false);
  });

  it.each([
    ["application/json", "{}", 415],
    ["multipart/form-data", "bad", 400],
    ["multipart/form-data; boundary=missing", "bad", 400],
  ])("rejects malformed upload %s", async (contentType, body, status) => {
    await expect(readFeeScheduleUpload(new Request("http://localhost/upload", {
      method: "POST", body, headers: { "content-type": contentType },
    }))).rejects.toMatchObject({ status });
  });
});

describe("fee schedule byte retirement comparison", () => {
  const stored = { id: "doc-1", byteSize: 4, sha256: "aaa" };

  it("clears when the stored file matches the evidence, including an empty catalog", () => {
    expect(decideFeeScheduleByteRetirement([stored], [stored])).toEqual({ action: "clear", ids: ["doc-1"] });
    expect(decideFeeScheduleByteRetirement([], [])).toEqual({ action: "clear", ids: [] });
  });

  it("refuses when evidence omits a stored file", () => {
    expect(decideFeeScheduleByteRetirement([stored], [])).toEqual({ action: "refuse", reason: "missing-stored-file" });
  });

  it("refuses when evidence adds a file", () => {
    expect(decideFeeScheduleByteRetirement([stored], [stored, { id: "doc-2", byteSize: 4, sha256: "aaa" }])).toEqual({
      action: "refuse",
      reason: "unexpected-evidence-file",
    });
  });

  it("refuses a different byte count", () => {
    expect(decideFeeScheduleByteRetirement([stored], [{ ...stored, byteSize: 5 }])).toEqual({
      action: "refuse",
      reason: "byte-count",
    });
  });

  it("refuses a different checksum", () => {
    expect(decideFeeScheduleByteRetirement([stored], [{ ...stored, sha256: "bbb" }])).toEqual({
      action: "refuse",
      reason: "checksum",
    });
  });

  it("refuses a duplicate evidence id", () => {
    expect(decideFeeScheduleByteRetirement([stored], [stored, stored])).toEqual({ action: "refuse", reason: "duplicate-id" });
  });
});
