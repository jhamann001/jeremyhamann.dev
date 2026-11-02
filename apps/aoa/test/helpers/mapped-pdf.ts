import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFCheckBox, PDFDocument, PDFRadioGroup, PDFSignature, PDFTextField } from "pdf-lib";
import { expect } from "vitest";
import { fillMappedPdf } from "@/lib/forms/mapped-form-pdf";
import { mappedInputs, type MappedFormSpec } from "@/lib/forms/mapped-form-spec";
import { parseMappedDraft } from "@/lib/forms/mapped-form-validation";

export const ACCOUNT = "SYN-12345";
export const OWNER = "Morgan Sample";

const template = (spec: MappedFormSpec) => readFile(path.join(process.cwd(), spec.definition.template.relativePath));

export function draft(spec: MappedFormSpec, fields: Record<string, string> = {}) {
  const parsed = parseMappedDraft(spec, { fields, confirmAccount: true }, ACCOUNT, OWNER);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.value;
}

export async function render(spec: MappedFormSpec, fields: Record<string, string> = {}) {
  try { return PDFDocument.load(await fillMappedPdf(spec, await template(spec), draft(spec, fields))); }
  catch (error) { if (error && typeof error === "object" && "issues" in error) throw new Error(JSON.stringify(error.issues)); throw error; }
}

export async function verifySourceTemplate(spec: MappedFormSpec) {
  const bytes = await template(spec);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(spec.definition.template.sha256);
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBe(spec.definition.template.pageCount);
  expect(pdf.getForm().getFields()).toHaveLength(spec.definition.template.fieldCount);
}

export async function verifyUnknownFieldsBlank(spec: MappedFormSpec, ownerField: string, accountField: string) {
  const pdf = await render(spec);
  expect(pdf.getPageCount()).toBe(spec.definition.template.pageCount);
  for (const field of pdf.getForm().getFields()) {
    if (field instanceof PDFTextField) {
      const expected = field.getName() === ownerField ? OWNER : field.getName() === accountField ? ACCOUNT : "";
      expect(field.getText() ?? "", field.getName()).toBe(expected);
    } else if (field instanceof PDFCheckBox) expect(field.isChecked(), field.getName()).toBe(false);
    else if (field instanceof PDFRadioGroup) expect(field.getSelected(), field.getName()).toBeUndefined();
    else if (field instanceof PDFSignature) expect(field.acroField.V(), field.getName()).toBeUndefined();
  }
}

export async function verifyAllMappedInputsRender(spec: MappedFormSpec, ownerField: string) {
  const fields: Record<string, string> = {};
  for (const input of mappedInputs(spec)) {
    if (input.source === "accountNumber") continue;
    fields[input.key] = input.kind === "choice" ? ""
      : input.kind === "taxId" ? "900000001"
      : input.kind === "taxIdLast4" ? "0001"
      : input.kind === "date" ? "01/02/1970"
      : input.kind === "phone" ? "202-555-0100"
      : input.kind === "routing" ? "000000001"
      : input.kind === "money" ? "1234.50"
      : /State$/.test(input.key) ? "NY"
      : /Zip$/.test(input.key) ? "10001"
      : /Account|accountNumber/.test(input.key) ? "SYN-00002"
      : "Sample Value";
  }
  const pdf = await render(spec, fields);
  expect(pdf.getPageCount()).toBe(spec.definition.template.pageCount);
  expect(pdf.getForm().getTextField(ownerField).getText()).toBe("Sample Value");
}
