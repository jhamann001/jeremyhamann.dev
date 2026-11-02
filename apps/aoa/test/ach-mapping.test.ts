import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFButton, PDFCheckBox, PDFDocument, PDFName, PDFSignature, PDFTextField } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { ACH_SPEC } from "@/lib/forms/ach-spec";
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

describe("ACH source-template inventory", () => {
  it.each([
    [ACH_SPEC, "6fb4ba455e7df40bf51733fe922ba199e2af2c572ccde0125724be6f2d2ba3be", 59],
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

  it.each([ACH_SPEC])("preserves blank signatures and decorative logo for %s", async (spec) => {
    const { source, output } = await generate(spec);
    const originalLogo = source.getForm().getButton("Logo Placement_af_image");
    const outputLogo = output.getForm().getButton("Logo Placement_af_image");
    expect(outputLogo.acroField.dict.toString()).toBe(originalLogo.acroField.dict.toString());
    for (const signature of source.getForm().getFields().filter(field => field instanceof PDFSignature)) {
      const after = output.getForm().getSignature(signature.getName());
      expect(after.acroField.dict.toString()).toBe(signature.acroField.dict.toString());
    }
  });

  it.each([ACH_SPEC])("retains editable missing fields after save and reload for %s", async (spec) => {
    const { output } = await generate(spec);
    const fieldName = "Bank Account No";
    const field = output.getForm().getTextField(fieldName);
    expect(field.isReadOnly()).toBe(false);
    field.setText("0000098765");
    const reloaded = await PDFDocument.load(await output.save());
    expect(reloaded.getForm().getTextField(fieldName).getText()).toBe("0000098765");
    expect(reloaded.getForm().getFields()).toHaveLength(spec.definition.template.fieldCount);
  });
});

describe("ACH independent owner and bank mappings", () => {
  it("allows client completion without any bank details or financial elections", async () => {
    const { source, output } = await generate(ACH_SPEC);
    checkOnlyExpectedValues(output, {
      "Branch 1": "S", "Branch 2": "Y", "Branch 3": "N",
      "Digit 1": "0", "Digit 2": "0", "Digit 3": "0", "Digit 4": "0", "Digit 5": "1",
      "PRIMARY ACCOUNT OWNER NAME": "Jordan Sample",
    });
    expect(output.getPage(0).node.get(PDFName.of("Contents"))?.toString()).toBe(source.getPage(0).node.get(PDFName.of("Contents"))?.toString());
    expect(output.getForm().getFields()).toHaveLength(59);
    // T/C are distinct boxes, not the tail of a longer authorized identifier.
    for (const name of ["T", "C", "Account Title", "AMOUNT", "DAY OF MONTH", "DATE", "DATE_2"]) expect(output.getForm().getTextField(name).getText() ?? "").toBe("");
  });

  it.each(["SYN00001", "SYN-000011", "SY-00001", "SYN-0000A", "SYN-00001-00", "SYNTH-0001"])("rejects unsupported account layout without truncation: %s", (account) => {
    expect(parse(ACH_SPEC, {}, account)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: "accountIds" })]) });
  });

  it("maps each ABA digit, leading zeros and independently supplied primary/joint/bank details", async () => {
    const { output } = await generate(ACH_SPEC, {
      primaryOwnerName: "Jordan Sample", bankAccountTitle: "Sample Joint Bank Title", bankName: "Fictional Bank",
      bankRoutingNumber: "012345678", bankAccountNumber: "0001234567", bankAccountType: "checking",
      primaryAddress: "100 Example Lane", primaryCity: "Example City", primaryState: "VA", primaryZip: "00000",
      jointOwnerName: "Adah Sample", jointAddress: "200 Sample Road", jointCity: "Sample City", jointState: "MD", jointZip: "00001",
    });
    checkOnlyExpectedValues(output, {
      "Branch 1": "S", "Branch 2": "Y", "Branch 3": "N", "Digit 1": "0", "Digit 2": "0", "Digit 3": "0", "Digit 4": "0", "Digit 5": "1",
      "PRIMARY ACCOUNT OWNER NAME": "Jordan Sample", "Account Title": "Sample Joint Bank Title", "Name of Bank": "Fictional Bank", "Bank Account No": "0001234567",
      ...Object.fromEntries(Array.from("012345678", (value, index) => [`ABA NO. ${index + 1}`, value])),
      ADDRESS: "100 Example Lane", CITY: "Example City", STATE: "VA", "ZIP CODE": "00000",
      "JOINT ACCOUNT OWNER NAME": "Adah Sample", ADDRESS_2: "200 Sample Road", CITY_2: "Sample City", STATE_2: "MD", "ZIP CODE_2": "00001",
    }, ["Checking"]);
  });

  it("does not retain the opposite account-type election", async () => {
    const { output } = await generate(ACH_SPEC, { bankAccountType: "savings" });
    expect(output.getForm().getCheckBox("Savings").isChecked()).toBe(true);
    expect(output.getForm().getCheckBox("Checking").isChecked()).toBe(false);
    expect(parse(ACH_SPEC, { bankAccountType: "checking,savings" }).ok).toBe(false);
  });

  it.each(["1234", "12345678", "0123456789", "01234A678", "012-345-678"])("rejects an invalid ABA value %s rather than printing partial digits", (bankRoutingNumber) => {
    expect(parse(ACH_SPEC, { bankRoutingNumber })).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: "bankRoutingNumber" })]) });
  });

  it.each(["apexBranch", "apexNumber", "T", "C", "profile", "recurringAmount", "signature", "DATE"])("rejects unsupported or server-owned input %s", (key) => {
    const result = parse(ACH_SPEC, { [key]: "PRIVATE-SENTINEL" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-SENTINEL");
  });
});


it("requires explicit account-role confirmation", () => {
  for (const confirmAccount of [undefined, false, "true", 1]) {
    expect(parseMappedDraft(ACH_SPEC, { fields: {}, confirmAccount }, "SYN-00001", "Jordan Sample")).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: "confirmAccount" })]) });
  }
});
