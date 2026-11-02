import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFButton, PDFCheckBox, PDFDocument, PDFName, PDFSignature, PDFTextField } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { WIRE_SPEC } from "@/lib/forms/wire-spec";
import { fillMappedPdf } from "@/lib/forms/mapped-form-pdf";
import { parseMappedDraft } from "@/lib/forms/mapped-form-validation";
import { mappedInputs, type MappedFormSpec } from "@/lib/forms/mapped-form-spec";

const templateBytes = (spec: MappedFormSpec) => readFile(path.join(process.cwd(), spec.definition.template.relativePath));
const parse = (spec: MappedFormSpec, fields: Record<string, unknown> = {}, account = "SYN-00001") =>
  parseMappedDraft(spec, { confirmAccount: true, fields }, account, "Jordan Sample");
async function generate(spec: MappedFormSpec, fields: Record<string, unknown> = {}) {
  const result = parse(spec, fields);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected valid fictional draft");
  const source = await templateBytes(spec);
  return { source: await PDFDocument.load(source), output: await PDFDocument.load(await fillMappedPdf(spec, source, result.value)) };
}

function checkOnlyExpectedValues(pdf: PDFDocument, expected: Record<string, string>, checked: string[] = []) {
  for (const field of pdf.getForm().getFields()) {
    if (field instanceof PDFTextField) {
      expect(field.getText() ?? "", field.getName()).toBe(expected[field.getName()] ?? "");
      expect(field.isReadOnly(), field.getName()).toBe(false);
    } else if (field instanceof PDFCheckBox) {
      expect(field.isChecked(), field.getName()).toBe(checked.includes(field.getName()));
    } else if (field instanceof PDFSignature) {
      expect(field.acroField.V(), field.getName()).toBeUndefined();
    } else expect(field).toBeInstanceOf(PDFButton); // Preserve decorative logo pushbutton.
  }
}

describe("Domestic wire source-template inventory", () => {
  it.each([
    [WIRE_SPEC, "9ab3af2efedb201541e600c34a7e5f6084e5c4a10a000bc0752005b573fcdc9d", 30],
  ] as const)("pins unchanged supplied template %s", async (spec, hash, count) => {
    const bytes = await templateBytes(spec);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
    expect(spec.definition.template.sha256).toBe(hash);
    expect(spec.definition.effectiveOn).toBeNull();
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getForm().getFields()).toHaveLength(count);
    for (const input of mappedInputs(spec)) {
      for (const fieldName of input.pdfFields ?? []) expect(pdf.getForm().getField(fieldName)).toBeInstanceOf(PDFTextField);
      for (const option of input.options ?? []) for (const fieldName of option.pdfFields) expect(pdf.getForm().getField(fieldName)).toBeInstanceOf(PDFCheckBox);
    }
  });

  it.each([WIRE_SPEC])("preserves blank signatures and decorative logo for %s", async (spec) => {
    const { source, output } = await generate(spec);
    const originalLogo = source.getForm().getButton("Logo Placement_af_image");
    const outputLogo = output.getForm().getButton("Logo Placement_af_image");
    expect(outputLogo.acroField.dict.toString()).toBe(originalLogo.acroField.dict.toString());
    for (const signature of source.getForm().getFields().filter(field => field instanceof PDFSignature)) {
      const after = output.getForm().getSignature(signature.getName());
      expect(after.acroField.dict.toString()).toBe(signature.acroField.dict.toString());
    }
  });

  it.each([WIRE_SPEC])("retains editable missing fields after save and reload for %s", async (spec) => {
    const { output } = await generate(spec);
    const fieldName = "Beneficiary Account No";
    const field = output.getForm().getTextField(fieldName);
    expect(field.isReadOnly()).toBe(false);
    field.setText("0000098765");
    const reloaded = await PDFDocument.load(await output.save());
    expect(reloaded.getForm().getTextField(fieldName).getText()).toBe("0000098765");
    expect(reloaded.getForm().getFields()).toHaveLength(spec.definition.template.fieldCount);
  });
});

describe("domestic wire role-safe draft mappings", () => {
  it("allows a minimal draft without amount, recipient, bank details or authorizations", async () => {
    const { source, output } = await generate(WIRE_SPEC);
    checkOnlyExpectedValues(output, { "APEX ACCOUNT NO": "SYN-00001" });
    expect(output.getPage(0).node.get(PDFName.of("Contents"))?.toString()).toBe(source.getPage(0).node.get(PDFName.of("Contents"))?.toString());
    expect(output.getForm().getFields()).toHaveLength(30);
  });

  it("does not confuse sending, receiving, ultimate-recipient or intermediary details", async () => {
    const { output } = await generate(WIRE_SPEC, {
      wireAmount: "$1,234.56", transferReason: "Fictional test request",
      receivingRoutingNumber: "012345678", receivingBankName: "Receiving Test Bank", bankSectionBeneficiaryAddress: "100 Bank Section Lane, Example City, VA 00000, US",
      receivingAccountNumber: "0000111122", forCreditTo: "Receiving Bank Credit Title",
      ultimateRecipientName: "Adah Sample", ultimateRecipientAccount: "0000998877", ultimateRecipientAddress: "200 Recipient Road, Example City, MD 00001, US",
      intermediaryRoutingNumber: "761704106", intermediaryBankName: "Intermediary Test Bank", intermediarySectionBankAddress: "300 Intermediary Way, Example City, DC 00002, US",
    });
    checkOnlyExpectedValues(output, {
      "APEX ACCOUNT NO": "SYN-00001", "WIRE AMOUNT": "1234.56", "Reason for Transfer": "Fictional test request",
      "Bank Routing Transfer No": "012345678", "Bank Name Required": "Receiving Test Bank", "Beneficiary Address City State Zip Country Required": "100 Bank Section Lane, Example City, VA 00000, US",
      "Account No": "0000111122", "For Credit To": "Receiving Bank Credit Title",
      "BeneficiaryRecipientFor Further Credit to Name": "Adah Sample", "Beneficiary Account No": "0000998877", "Beneficiary Address City State Zip Country Required_2": "200 Recipient Road, Example City, MD 00001, US",
      "Correspondent Bank ABA": "761704106", "Bank Name Required_2": "Intermediary Test Bank", "Beneficiary Bank Address City State Zip Country Required": "300 Intermediary Way, Example City, DC 00002, US",
    });
  });

  it("does not populate another section from one known recipient value", async () => {
    const { output } = await generate(WIRE_SPEC, { ultimateRecipientName: "Adah Sample" });
    checkOnlyExpectedValues(output, { "APEX ACCOUNT NO": "SYN-00001", "BeneficiaryRecipientFor Further Credit to Name": "Adah Sample" });
  });

  it.each(["0", "-1", "12.345", "1e6", "all", "NaN"])("rejects invalid entered amount %s but permits blank", (wireAmount) => {
    expect(parse(WIRE_SPEC, { wireAmount }).ok).toBe(false);
    expect(parse(WIRE_SPEC, { wireAmount: "" }).ok).toBe(true);
  });

  it.each(["apexAccountNumber", "DATE", "IAA Print Name", "IAA Title", "IAA Date", "Print Name", "COA/RPA Print Name", "signature", "approveWire"])("rejects authority or account injection through %s", (key) => {
    const result = parse(WIRE_SPEC, { [key]: "PRIVATE-SENTINEL" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-SENTINEL");
  });

});

it("requires explicit account-role confirmation", () => {
  for (const confirmAccount of [undefined, false, "true", 1]) {
    expect(parseMappedDraft(WIRE_SPEC, { fields: {}, confirmAccount }, "SYN-00001", "Jordan Sample")).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: "confirmAccount" })]) });
  }
});
