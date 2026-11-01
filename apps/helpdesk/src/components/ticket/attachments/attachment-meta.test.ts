/**
 * Pure presentation helpers for the attachments panel. The allowlist half matters beyond cosmetics:
 * the picker's `accept` and the client-side refusal must agree with what `createUploadIntent` will
 * accept, or a rep picks a file and is told no after the round trip.
 */
import { describe, expect, it } from "vitest";
import { ATTACHMENT_KINDS, ATTACHMENT_MIME_ALLOWLIST, INGEST_LIMITS } from "@/types/domain";
import type { UserRef } from "@/types/domain";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_BYTES,
  EMAIL_PART_ORIGIN_LABEL,
  SYSTEM_ORIGIN_LABEL,
  UNKNOWN_UPLOADER_LABEL,
  attachmentOriginLabel,
  formatBytes,
  isAllowedMime,
  isInboundAttachment,
  mimeIcon,
  mimeLabel,
} from "@/components/ticket/attachments/attachment-meta";

describe("allowlist", () => {
  it("accepts exactly the nine server-side types", () => {
    for (const mime of ATTACHMENT_MIME_ALLOWLIST) expect(isAllowedMime(mime)).toBe(true);
    expect(ATTACHMENT_MIME_ALLOWLIST).toHaveLength(9);
  });

  it("refuses executables, archives, HTML and an unknown type", () => {
    for (const mime of [
      "text/html",
      "image/svg+xml",
      "application/x-msdownload",
      "application/zip",
      "application/octet-stream",
      "",
    ]) {
      expect(isAllowedMime(mime)).toBe(false);
    }
  });

  it("offers every allowed type in the picker's accept attribute", () => {
    for (const mime of ATTACHMENT_MIME_ALLOWLIST) expect(ATTACHMENT_ACCEPT).toContain(mime);
  });

  it("uses the contract's 25 MiB cap, not a second copy of it", () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(INGEST_LIMITS.attachmentMaxBytes);
    expect(ATTACHMENT_MAX_BYTES).toBe(26_214_400);
  });
});

describe("mimeLabel", () => {
  it("names the families a desk reader recognises", () => {
    expect(mimeLabel("application/pdf")).toBe("PDF");
    expect(mimeLabel("image/heic")).toBe("HEIC");
    expect(mimeLabel("text/csv")).toBe("CSV");
    expect(mimeLabel("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("Excel");
    expect(mimeLabel("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("Word");
  });

  it("falls back to a short subtype for anything else", () => {
    expect(mimeLabel("application/postscript")).toBe("POSTSCRI");
    expect(mimeLabel("weird")).toBe("WEIRD");
  });
});

describe("mimeIcon", () => {
  it("gives every allowed type an icon, and groups the families", () => {
    for (const mime of ATTACHMENT_MIME_ALLOWLIST) expect(mimeIcon(mime)).toBeTruthy();
    expect(mimeIcon("image/png")).toBe(mimeIcon("image/jpeg"));
    expect(mimeIcon("text/csv")).toBe(
      mimeIcon("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    );
    expect(mimeIcon("application/pdf")).not.toBe(mimeIcon("image/png"));
  });
});

describe("formatBytes", () => {
  it("reads the way a file manager does", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1_048_576)).toBe("1.0 MB");
    expect(formatBytes(26_214_400)).toBe("25.0 MB");
    expect(formatBytes(157_286_400)).toBe("150 MB");
  });

  it("does not invent a number for a nonsense size", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

/**
 * The misattribution this pins: `src/server/email-intake.ts` stores an inbound email part with
 * `uploaderId: null` and `kind: "EMAIL_PART"`, so an uploader-only line rendered a form the CLIENT
 * emailed in as "Help desk" — the firm, on a surface an examiner reads.
 */
describe("attachmentOriginLabel", () => {
  const staff: UserRef = { id: "u1", name: "Olivia Ops", email: "olivia@wm.example", image: null };

  it("never attributes an inbound email part to the desk or to a person", () => {
    const label = attachmentOriginLabel("EMAIL_PART", null);
    expect(label).toBe(EMAIL_PART_ORIGIN_LABEL);
    expect(label).not.toBe(UNKNOWN_UPLOADER_LABEL);
    expect(label.toLowerCase()).toContain("client");
    // Even if a row somehow carried an uploader, the KIND decides the direction.
    expect(attachmentOriginLabel("EMAIL_PART", staff)).toBe(EMAIL_PART_ORIGIN_LABEL);
  });

  it("names the staff uploader for an ordinary upload, preferring the name over the address", () => {
    expect(attachmentOriginLabel("UPLOAD", staff)).toBe("Olivia Ops");
    expect(attachmentOriginLabel("UPLOAD", { ...staff, name: null })).toBe("olivia@wm.example");
    expect(attachmentOriginLabel("UPLOAD", { ...staff, name: "   " })).toBe("olivia@wm.example");
    expect(attachmentOriginLabel("UPLOAD", null)).toBe(UNKNOWN_UPLOADER_LABEL);
  });

  it("marks a system-produced file as automatic rather than as a person", () => {
    expect(attachmentOriginLabel("SYSTEM", null)).toBe(SYSTEM_ORIGIN_LABEL);
  });

  it("answers for every kind the schema allows, and never returns an empty string", () => {
    for (const kind of ATTACHMENT_KINDS) {
      expect(attachmentOriginLabel(kind, null).length).toBeGreaterThan(0);
      expect(attachmentOriginLabel(kind, staff).length).toBeGreaterThan(0);
    }
  });
});

describe("isInboundAttachment", () => {
  it("is true for exactly the kind that came IN from the client", () => {
    expect(isInboundAttachment("EMAIL_PART")).toBe(true);
    expect(isInboundAttachment("UPLOAD")).toBe(false);
    expect(isInboundAttachment("SYSTEM")).toBe(false);
  });
});
