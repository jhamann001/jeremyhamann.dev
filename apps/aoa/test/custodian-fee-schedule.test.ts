import { describe, expect, it } from "vitest";
import {
  buildFeeScheduleDocument,
  FeeScheduleUploadError,
  MAX_FEE_SCHEDULE_BYTES,
  safeFeeScheduleFilename,
} from "@/lib/data/custodian-fee-documents";
import { markCase } from "./acat-book-flywheel";

const PDF = Buffer.from("%PDF-1.4 minimal");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe("custodian fee schedule documents", () => {
  it("accepts PDF PNG and JPEG signatures", () => {
    expect(buildFeeScheduleDocument({
      filename: "schedule.pdf", contentType: "application/pdf", content: PDF,
    }).contentType).toBe("application/pdf");
    expect(buildFeeScheduleDocument({
      filename: "schedule.png", contentType: "image/png", content: PNG,
    }).contentType).toBe("image/png");
    expect(buildFeeScheduleDocument({
      filename: "schedule.jpg", contentType: "image/jpeg", content: JPEG,
    }).contentType).toBe("image/jpeg");
    markCase("custodian-fee-schedule", "accepts PDF PNG and JPEG signatures");
  });

  it("rejects an empty fee-schedule file", () => {
    expect(() => buildFeeScheduleDocument({
      filename: "empty.pdf", contentType: "application/pdf", content: new Uint8Array(),
    })).toThrow(FeeScheduleUploadError);
    markCase("custodian-fee-schedule", "rejects an empty fee-schedule file");
  });

  it("rejects an oversize fee-schedule file", () => {
    expect(() => buildFeeScheduleDocument({
      filename: "big.pdf",
      contentType: "application/pdf",
      content: Buffer.concat([PDF, Buffer.alloc(MAX_FEE_SCHEDULE_BYTES)]),
    })).toThrow(FeeScheduleUploadError);
    markCase("custodian-fee-schedule", "rejects an oversize fee-schedule file");
  });

  it("rejects application/pdf whose bytes are html", () => {
    expect(() => buildFeeScheduleDocument({
      filename: "fake.pdf", contentType: "application/pdf", content: Buffer.from("<html>"),
    })).toThrow(FeeScheduleUploadError);
    markCase("custodian-fee-schedule", "rejects application/pdf whose bytes are html");
  });

  it("safe filename keeps the basename and replaces unsafe characters", () => {
    const name = safeFeeScheduleFilename("../My Fee (schedule).PDF");
    expect(name.endsWith(".PDF")).toBe(true);
    expect(name).not.toMatch(/[\\/() ]/);
    expect(name.replace(/\.PDF$/i, "").length).toBeLessThanOrEqual(150);
    expect(safeFeeScheduleFilename("...")).toBe("fee-schedule");
    markCase("custodian-fee-schedule", "safe filename keeps the basename and replaces unsafe characters");
  });

  it("empty or octet-stream type is inferred from the extension", () => {
    expect(buildFeeScheduleDocument({
      filename: "schedule.pdf", contentType: "", content: PDF,
    }).contentType).toBe("application/pdf");
    expect(buildFeeScheduleDocument({
      filename: "schedule.pdf", contentType: "application/octet-stream", content: PDF,
    }).contentType).toBe("application/pdf");
    markCase("custodian-fee-schedule", "empty or octet-stream type is inferred from the extension");
  });
});
