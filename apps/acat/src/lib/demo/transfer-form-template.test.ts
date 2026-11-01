// @vitest-environment node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, PDFSignature } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildTransferFormTemplate, TRANSFER_FORM_TEMPLATE_PATH } from "./transfer-form-template";

describe("demo transfer form template", () => {
  it("matches the committed file byte for byte", async () => {
    const committed = await readFile(join(process.cwd(), TRANSFER_FORM_TEMPLATE_PATH));
    const built = Buffer.from(await buildTransferFormTemplate());
    // Regenerate with `npx tsx scripts/build-transfer-form-template.ts` if this fails.
    expect(built.equals(committed)).toBe(true);
  });

  it("builds the same bytes every time", async () => {
    const [first, second] = await Promise.all([buildTransferFormTemplate(), buildTransferFormTemplate()]);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it("has two pages and blank, hand-signed signature fields", async () => {
    const document = await PDFDocument.load(await buildTransferFormTemplate());
    expect(document.getPageCount()).toBe(2);
    const form = document.getForm();
    for (const name of ["PRIMARY SIGNATURE", "JOINT SIGNATURE", "LOA CLIENT SIGNATURE", "LOA RECEIVING FIRM SIGNATURE"]) {
      expect(form.getField(name)).toBeInstanceOf(PDFSignature);
    }
    for (const field of form.getFields()) {
      if ("getText" in field && typeof field.getText === "function") expect(field.getText() ?? "").toBe("");
    }
  });
});
