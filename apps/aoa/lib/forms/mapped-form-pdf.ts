import { PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFRadioGroup, PDFSignature, PDFTextField, StandardFonts, type PDFFont } from "pdf-lib";
import { mappedInputs, type MappedFormSpec } from "./mapped-form-spec";
import type { MappedDraft, MappedFormIssue } from "./mapped-form-validation";
import { MAPPED_TEMPLATE_REPAIRS } from "./mapped-template-repairs";

export class MappedFormRenderError extends Error {
  constructor(readonly issues: MappedFormIssue[]) { super("A supplied value cannot be safely displayed"); this.name = "MappedFormRenderError"; }
}
export class MappedFormTemplateError extends Error {
  constructor() { super("The template does not match its registered form structure"); this.name = "MappedFormTemplateError"; }
}

function fillText(field: PDFTextField, value: string, font: PDFFont, path: string) {
  const widgets = field.acroField.getWidgets();
  if (!widgets.length) throw new MappedFormTemplateError();
  let unitWidth: number;
  try { unitWidth = font.widthOfTextAtSize(value, 1); } catch {
    throw new MappedFormRenderError([{ path, message: "This PDF cannot display some characters in this value. Do not change the legal information; complete the form manually." }]);
  }
  const width = Math.min(...widgets.map(widget => widget.getRectangle().width - 2 * ((widget.getBorderStyle()?.getWidth() ?? 0) + 1) - 1));
  const height = Math.min(...widgets.map(widget => widget.getRectangle().height - 2));
  const size = Math.min(10, unitWidth ? width / unitWidth : 10, height / font.heightAtSize(1));
  if (!Number.isFinite(size) || size < 7) {
    if (value) throw new MappedFormRenderError([{ path, message: "This value will not fit legibly on the form. Do not abbreviate legal information; complete this field manually." }]);
    // Blank legacy fields can be unusually short; use a sane future-edit size.
  }
  field.setText(value);
  const fontSize = Math.max(7, size);
  field.acroField.setDefaultAppearance(`0 g\n/${font.name} ${fontSize} Tf`);
  field.setFontSize(fontSize);
  for (const widget of widgets) widget.setDefaultAppearance(field.acroField.getDefaultAppearance()!);
}

/** Only called with a validated draft and a checksum-verified, versioned blank. */
export async function fillMappedPdf(spec: MappedFormSpec, template: Uint8Array, draft: MappedDraft): Promise<Uint8Array> {
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(template); } catch { throw new MappedFormTemplateError(); }
  if (pdf.getPageCount() !== spec.definition.template.pageCount || pdf.getForm().getFields().length !== spec.definition.template.fieldCount) throw new MappedFormTemplateError();
  if (spec.repair) {
    const repair = MAPPED_TEMPLATE_REPAIRS.find(candidate => candidate.id === spec.repair);
    if (!repair) throw new MappedFormTemplateError();
    repair.repair(pdf);
  }
  const form = pdf.getForm();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const acroForm = pdf.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
  const resources = acroForm.lookupMaybe(PDFName.of("DR"), PDFDict) ?? pdf.context.obj({});
  const fonts = resources.lookupMaybe(PDFName.of("Font"), PDFDict) ?? pdf.context.obj({});
  fonts.set(PDFName.of(font.name), font.ref);
  resources.set(PDFName.of("Font"), fonts);
  acroForm.set(PDFName.of("DR"), resources);
  for (const field of form.getFields()) {
    if (spec.preserveFields?.includes(field.getName())) continue;
    if (field instanceof PDFSignature) {
      if (field.acroField.V() !== undefined) throw new MappedFormTemplateError();
      continue;
    }
    field.disableReadOnly();
    // A partially prepared draft cannot claim that every conditional field is
    // mandatory. Applicable requirements are checked through the signing process.
    field.disableRequired();
    if (field instanceof PDFTextField) fillText(field, "", font, "form");
    else if (field instanceof PDFCheckBox) field.uncheck();
    else if (field instanceof PDFRadioGroup) field.clear();
    else throw new MappedFormTemplateError();
  }
  for (const input of mappedInputs(spec)) {
    const value = draft.fields[input.key] ?? "";
    if (input.kind === "choice") {
      for (const option of input.options ?? []) for (const name of option.pdfFields) {
        const field = form.getFieldMaybe(name);
        if (option.pdfValue !== undefined) {
          if (!(field instanceof PDFRadioGroup) || !field.getOptions().includes(option.pdfValue)) throw new MappedFormTemplateError();
          if (option.value === value) field.select(option.pdfValue);
        } else {
          if (!(field instanceof PDFCheckBox)) throw new MappedFormTemplateError();
          if (option.value === value) field.check();
        }
      }
    } else {
      const names = input.pdfFields ?? [];
      if (!names.length || (input.characterBoxes && value && value.length !== names.length)) throw new MappedFormTemplateError();
      for (const [index, name] of names.entries()) {
        const field = form.getFieldMaybe(name);
        if (!(field instanceof PDFTextField)) throw new MappedFormTemplateError();
        fillText(field, input.characterBoxes ? value[index] ?? "" : value, font, input.key);
      }
    }
  }
  form.updateFieldAppearances(font);
  pdf.setTitle(spec.definition.name);
  pdf.setSubject("Incomplete form for human review. Complete applicable fields and obtain authorization through the existing signing process. No submission.");
  pdf.setProducer("Always-On Advice form library");
  return pdf.save({ useObjectStreams: false });
}
