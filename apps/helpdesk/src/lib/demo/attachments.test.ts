import { describe, expect, it } from "vitest";
import { INGEST_LIMITS } from "@/types/domain";
import { buildDemoAttachments, demoTicketId } from "./attachments";
import { loadUniverse } from "./universe";

describe("seeded attachments", () => {
  const universe = loadUniverse();
  const files = buildDemoAttachments(universe);

  it("are byte-for-byte the same on every build, so the image matches what the reset stamps", () => {
    const again = buildDemoAttachments(universe);
    expect(again.map((f) => f.sha256)).toEqual(files.map((f) => f.sha256));
  });

  it("are a check image and two PDFs at their story tickets' object keys", () => {
    expect(files.map((f) => [f.objectKey, f.mime])).toEqual([
      [`${demoTicketId(2470)}/att-lindqvist-voided-check`, "image/png"],
      [`${demoTicketId(2481)}/att-okafor-beneficiary-form`, "application/pdf"],
      [`${demoTicketId(2468)}/att-nakamura-statement-page`, "application/pdf"],
    ]);
    const png = files[0]!.bytes;
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const pdf of files.slice(1)) {
      const text = new TextDecoder().decode(pdf.bytes);
      expect(text.startsWith("%PDF-1.4\n")).toBe(true);
      expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
      // Plain ASCII: the name check reads every byte of what ships.
      expect([...pdf.bytes].every((b) => b === 10 || (b >= 32 && b < 127))).toBe(true);
    }
  });

  it("fit the upload limit and say on their face that they are demo documents", () => {
    for (const f of files) expect(f.bytes.length).toBeLessThan(INGEST_LIMITS.attachmentMaxBytes);
    for (const f of files.slice(1)) expect(new TextDecoder().decode(f.bytes)).toContain("DEMO DOCUMENT");
  });
});
