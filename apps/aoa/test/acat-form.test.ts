import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFSignature, PDFTextField } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { ACAT_DEFINITION } from "@/lib/forms/acat-definition";
import { AcatRenderError, AcatTemplateError, fillAcatPdf, parseAcatDraft, type AcatDraft } from "@/lib/forms/acat";
import { isDefinitionEligibleForAccountType } from "@/lib/forms/form-definition";
import { IRA_BENEFICIARY_DEFINITION } from "@/lib/forms/ira-beneficiary-definition";

vi.mock("server-only", () => ({}));
import { FormTemplateIntegrityError, loadFormTemplate } from "@/lib/forms/template.server";

const values = { accountHolderName: "Jordan Sample", confirmAccountTitle: true };
const draft: AcatDraft = { ...values, confirmAccountTitle: true, accountHolderTaxId: "900000001", accountNumber: "SYNTH-0001" };
const templateBytes = () => readFile(path.join(process.cwd(), ACAT_DEFINITION.template.relativePath));

describe("generic ACAT input boundary", () => {
  it.each([undefined, "", "   "])("accepts a confirmed title with an optional blank tax ID (%s)", (accountHolderTaxId) => {
    expect(parseAcatDraft({ ...values, accountHolderName: "  Jordan   Sample  ", accountHolderTaxId }, "SYNTH-0001")).toEqual({
      ok: true, value: { ...draft, accountHolderTaxId: "" },
    });
  });

  it("normalizes a manually supplied tax ID without inventing any other field", () => {
    expect(parseAcatDraft({ ...values, accountHolderTaxId: "900-00-0001" }, "SYNTH-0001")).toEqual({ ok: true, value: draft });
  });

  it.each(["123", "9000000010", "abc900000001", "900.00.0001", null, 900000001])("rejects an invalid provided tax ID (%s)", (accountHolderTaxId) => {
    expect(parseAcatDraft({ ...values, accountHolderTaxId }, "SYNTH-0001")).toMatchObject({
      ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: "accountHolderTaxId" })]),
    });
  });

  it.each([undefined, false, "true", 1])("requires explicit boolean registration-title confirmation (%s)", (confirmAccountTitle) => {
    expect(parseAcatDraft({ ...values, confirmAccountTitle }, "SYNTH-0001")).toMatchObject({
      ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: "confirmAccountTitle" })]),
    });
  });

  it.each([undefined, "", "   ", 1])("requires a nonblank receiving title (%s)", (accountHolderName) => {
    expect(parseAcatDraft({ ...values, accountHolderName }, "SYNTH-0001")).toMatchObject({
      ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: "accountHolderName" })]),
    });
  });

  it.each(["", "  ", "A".repeat(33)])("requires an authorized receiving number (%s)", (accountNumber) => {
    expect(parseAcatDraft(values, accountNumber)).toMatchObject({
      ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: "accountIds" })]),
    });
  });

  it.each(["accountNumber", "deliveringAccountTitle", "transferType", "assets", "liquidate", "signature", "private-key-900000001"])("rejects unsupported values without echoing key or value (%s)", (key) => {
    const result = parseAcatDraft({ ...values, [key]: "PRIVATE-SENTINEL" }, "SYNTH-0001");
    expect(result).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "form" })] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE-SENTINEL");
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it.each([null, [], "wrong"])("rejects malformed values (%s)", (raw) => {
    expect(parseAcatDraft(raw, "SYNTH-0001")).toMatchObject({ ok: false });
  });

  it.each([null, undefined, "", "Individual Brokerage", "Joint", "Roth IRA"])("allows generic account type %s without weakening IRA eligibility", (accountType) => {
    expect(isDefinitionEligibleForAccountType(ACAT_DEFINITION, accountType)).toBe(true);
    expect(isDefinitionEligibleForAccountType(IRA_BENEFICIARY_DEFINITION, accountType)).toBe(accountType === "Roth IRA");
  });
});

describe("generic ACAT template and PDF", () => {
  it("uses the checksum-pinned two-page 95-field tracker snapshot", async () => {
    const bytes = await loadFormTemplate(ACAT_DEFINITION);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("2eab2ec7d9d6fc244a1ea8e0b665273844b7df7482fffa21ce1dc111b61cd814");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getForm().getFields()).toHaveLength(95);
    expect(ACAT_DEFINITION.effectiveOn).toBeNull();
    await expect(loadFormTemplate({ ...ACAT_DEFINITION, template: { ...ACAT_DEFINITION.template, sha256: "0".repeat(64) } })).rejects.toBeInstanceOf(FormTemplateIntegrityError);
  });

  it.each(["", "900000001"])("fills only the receiving title/number and optional tax ID (%s)", async (accountHolderTaxId) => {
    const bytes = await templateBytes();
    const source = await PDFDocument.load(bytes);
    const pdf = await PDFDocument.load(await fillAcatPdf(bytes, { ...draft, accountHolderTaxId }));
    const form = pdf.getForm();
    const expected: Record<string, string> = {
      "ACCOUNT TITLE": "Jordan Sample",
      "APEX CLEARING ACCOUNT NO": "SYNTH-0001",
      "SSNTAX ID NO": accountHolderTaxId,
    };
    expect(pdf.getPageCount()).toBe(2);
    expect(form.getFields().map((field) => field.getName())).toEqual(source.getForm().getFields().map((field) => field.getName()));
    let signatureCount = 0;
    for (const field of form.getFields()) {
      if (field instanceof PDFTextField) {
        expect(field.getText() ?? "", field.getName()).toBe(expected[field.getName()] ?? "");
        expect(field.isReadOnly(), field.getName()).toBe(false);
      } else if (field instanceof PDFCheckBox) {
        expect(field.isChecked(), field.getName()).toBe(false);
        expect(field.isReadOnly(), field.getName()).toBe(false);
      } else {
        expect(field).toBeInstanceOf(PDFSignature);
        expect(field.acroField.V(), field.getName()).toBeUndefined();
        expect(field.acroField.getFlags(), field.getName()).toBe(source.getForm().getField(field.getName()).acroField.getFlags());
        signatureCount += 1;
      }
    }
    expect(signatureCount).toBe(5);
    // Independent field identifiers protect against mapping the receiving title
    // into the delivering account or the conditional ownership-change LOA.
    for (const name of ["ACCOUNT TITLE_2", "ACCOUNT TITLE_3", "ACCOUNT TITLE_4", "ACCOUNT NO", "ACCOUNT NO_2", "APEX CLEARING ACCOUNT NO_2", "RECEIVING FIRM NAME", "DELIVERING FIRM NAME", "SUCCESSOR CUSTODIAN TAX ID NO", "DATE OF TRUST"]) {
      expect(form.getTextField(name).getText() ?? "", name).toBe("");
    }
    for (let index = 0; index < 2; index++) {
      expect(pdf.getPage(index).node.get(PDFName.of("Contents"))?.toString()).toBe(source.getPage(index).node.get(PDFName.of("Contents"))?.toString());
    }
    expect(pdf.getTitle()).toBe("ACAT Transfer");
    expect(pdf.getSubject()).toContain("requires CS completion and human review before signing or submission");
  });

  it("preserves later editable fields and unchecked elections across save/reload", async () => {
    const pdf = await PDFDocument.load(await fillAcatPdf(await templateBytes(), draft));
    const form = pdf.getForm();
    form.getTextField("ACCOUNT TITLE_2").setText("Separate Delivering Title");
    form.getCheckBox("PARTIAL TRANSFER").check();
    const reloaded = await PDFDocument.load(await pdf.save());
    expect(reloaded.getForm().getFields()).toHaveLength(95);
    expect(reloaded.getForm().getTextField("ACCOUNT TITLE_2").getText()).toBe("Separate Delivering Title");
    expect(reloaded.getForm().getCheckBox("PARTIAL TRANSFER").isChecked()).toBe(true);
  });

  it("uses a registered editable font and fits the confirmed title without truncation", async () => {
    const accountHolderName = "W".repeat(62);
    const pdf = await PDFDocument.load(await fillAcatPdf(await templateBytes(), { ...draft, accountHolderName }));
    const field = pdf.getForm().getTextField("ACCOUNT TITLE");
    expect(field.getText()).toBe(accountHolderName);
    const appearance = field.acroField.getDefaultAppearance()!;
    const match = /\/Helvetica\s+([\d.]+)\s+Tf/.exec(appearance);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(8);
    expect(Number(match![1])).toBeLessThan(10);
    for (const widget of field.acroField.getWidgets()) expect(widget.getDefaultAppearance()).toBe(appearance);
    const fonts = pdf.catalog.lookup(PDFName.of("AcroForm"), PDFDict).lookup(PDFName.of("DR"), PDFDict).lookup(PDFName.of("Font"), PDFDict);
    expect(fonts.has(PDFName.of("Helvetica"))).toBe(true);
  });

  it.each(["W".repeat(200), "Unsupported 🐈 Title"])("rejects unrenderable values without a clipped PDF or value disclosure", async (accountHolderName) => {
    const result = fillAcatPdf(await templateBytes(), { ...draft, accountHolderName });
    await expect(result).rejects.toBeInstanceOf(AcatRenderError);
    await result.catch((error: AcatRenderError) => {
      expect(error.issues).toEqual([expect.objectContaining({ path: "accountHolderName" })]);
      expect(JSON.stringify(error.issues)).not.toContain(accountHolderName);
    });
  });

  it.each(["page", "field", "expected-field", "signed"])("rejects changed template structure (%s)", async (change) => {
    const pdf = await PDFDocument.load(await templateBytes());
    const form = pdf.getForm();
    if (change === "page") pdf.addPage();
    if (change === "field") form.removeField(form.getField("ACCOUNT TITLE"));
    if (change === "expected-field") {
      form.removeField(form.getField("ACCOUNT TITLE"));
      form.createTextField("Unexpected field");
    }
    if (change === "signed") form.getSignature("PRIMARY SIGNATURE").acroField.dict.set(PDFName.of("V"), pdf.context.obj({}));
    await expect(fillAcatPdf(await pdf.save(), draft)).rejects.toBeInstanceOf(AcatTemplateError);
  });
});
